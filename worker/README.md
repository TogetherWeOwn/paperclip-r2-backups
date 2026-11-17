# r2-backup-console

A Cloudflare Worker that serves [R2-Explorer](https://github.com/G4brym/R2-Explorer)
(`r2-explorer@1.2.0`, MIT) as a web console for the backup bucket: browse, folders,
upload, download, delete, rename/move. Files are plain objects (no client-side encryption).

Security layers:

1. A Cloudflare Access self-hosted app in front of the custom domain (identity provider and policy).
2. This Worker validates the `Cf-Access-Jwt-Assertion` header on **every** request (static
   files included): RS256 signature against the team certs, `iss`, `aud`, `exp`, and numeric
   `nbf` when present (`exp` and `nbf` allow 30 seconds of clock skew). A missing token or
   failed validation is denied; the Worker fails closed if Access settings are unset.
   R2-Explorer's own `cfAccessTeamName` option is not used because it only covers `/api/*`
   and does not check the AUD.
3. Public share links (`/share/*`, share create/list/delete) and the email API are disabled,
   since a share link would bypass Access.
4. Writes are limited to `WRITE_PREFIXES` (default `db/,instance/,status/`), so the console
   cannot modify other objects in the bucket by accident. Reads and listing see the whole bucket.
   Set `WRITE_PREFIXES=*` to lift the prefix restriction only, not the control bounds below.
5. CSRF: every request other than GET/HEAD/OPTIONS must be same-origin (`Sec-Fetch-Site:
   same-origin`, or `Origin` equal to the Worker origin when that header is absent), and the
   JSON write routes require an `application/json` content type (charset parameters are supported).
   Otherwise 403.
6. Static dashboard files are served by the Worker itself (`env.ASSETS.fetch`) after the
   checks above, because R2-Explorer 1.2.0 does not serve them and `run_worker_first`
   bypasses the asset layer. Only `/api/*` goes to R2-Explorer.

`workers_dev` and `preview_urls` are false, so there is no public `*.workers.dev` URL.
The config contains no routes, domains or account ids.

## Dependency policy

Use stable npm 11.19.0 or newer for dependency work; 11.19.0 is the verified
baseline. The Worker configuration sets `min-release-age=3` days and
`ignore-scripts=true`, with no lifecycle-script exceptions. CI verifies the
actual npm version and effective settings before its clean install; managed
hosts are expected to use the same supported policy. The age setting does not
retroactively audit versions already present in the lockfile.

Unsupported local npm clients are outside this enforcement boundary. The
`engines` declaration advertises the minimum version, and newer clients may
refuse unsupported versions, but this is not universal pre-resolution
protection: older npm can resolve dependencies before checking engines. A
warning or later refusal does not undo that resolution.

## Non-deploy verification

[Backup CI](../.github/workflows/ci.yml) runs **Worker verification (no deploy)**
for PRs that touch `worker/` (including drafts), full-run PRs, and non-PR runs.
It selects preinstalled Node 24 and checks for supported npm and the effective
policy above before running `npm ci --no-audit --no-fund`. It checks that the
manifest and lockfile stay unchanged, then runs the finite control and
integration fixtures in `test/`, `npm run typecheck`, and `npm run build`
(`wrangler deploy --dry-run --outdir dist`). The wrapper and pinned Explorer
fixtures use mocked Access certs and R2, not a live bucket. Use a successful
Worker job for the exact revision under review; a skipped job is not evidence.
CI does not deploy, configure Access, or refresh dependencies.

## Deploy (authorized operators only)

Production deployment requires separate release qualification and approval.
These are manual instructions, not evidence that a Worker, domain, Access app,
or credentials are in place. Use Node 24 and stable npm 11.19.0 or newer. Check
the actual versions (`node --version`, `npm --version`) before installing. From
the repo root, verify the effective policy and install from the lockfile:

```bash
cd worker &&
  test "$(npm config get min-release-age)" = 3 &&
  test "$(npm config get ignore-scripts)" = true &&
  npm ci --no-audit --no-fund
```

Proceed only after that succeeds. From `worker/`, use the installed, locked
Wrangler, not a CLI fetched on demand. Use existing authorized Cloudflare
credentials or, if interactive login is authorized, `./node_modules/.bin/wrangler login`.
Run deployment and secret updates only when separately authorized:

```bash
./node_modules/.bin/wrangler deploy
./node_modules/.bin/wrangler secret put ACCESS_TEAM_NAME
./node_modules/.bin/wrangler secret put ACCESS_AUD
```

Supply the values at the CLI prompts. Configure the Access app before exposing
the Worker on a custom domain (Worker → Settings → Domains and Routes, or the
Workers Domains API). See the setup below.

## Cloudflare Access setup

1. Zero Trust, Settings, Custom pages: note the **team domain**. `ACCESS_TEAM_NAME` is the
   subdomain part only (`<TEAM_NAME>.cloudflareaccess.com`).
2. Zero Trust, Access, Applications, Add, **Self-hosted**:
   - Application domain: the exact hostname you attach to the Worker.
   - Identity providers: the "Login with Cloudflare" provider (restrict to account members); disable others.
   - Policy: Allow, include only the owner identity (an email, or the account-members group).
   - Cookie settings (same screen): **SameSite = Lax** (or Strict), **HttpOnly** on, and
     **Enable binding cookie** on. These settings complement the Worker's CSRF check.
   - Use a short session duration (for example, 8 hours).
3. Open the application, Overview: copy **Application Audience (AUD) Tag**. That is `ACCESS_AUD`.
   Via API it is the `aud` field of the Access application object.
4. The Worker domain must have **no other route that skips Access** (no bypass policies).

## Request limits and supported inputs

After Access and CSRF checks, the wrapper validates API queries and recognized
controls before handing requests to R2-Explorer. These checks still apply with
`WRITE_PREFIXES=*`.

- **JSON controls:** The bucket `POST` routes for move, copy, folder creation,
  delete, multipart completion, and metadata edits accept JSON objects. The
  [reader](src/control-reader.ts) accepts up to **4 MiB (4,194,304 bytes)** of
  actual body data, inclusive, with a **10-second body-read deadline**. The limit
  still applies when `Content-Length` is absent or understates the body size.
  `Content-Encoding` must be absent or `identity`. The wrapper validates the
  parsed object and replays the original bytes, without the original length or
  encoding header, to Explorer. Metadata edits require `customMetadata` and
  `httpMetadata` objects; the wrapper does not recursively validate their values.
- **API queries:** The [routing checks](src/control-routing.ts) cap the serialized
  query string at **8,192 UTF-8 bytes**, excluding `?`. Use repeated names for
  `include` (for example, `include=httpMetadata&include=customMetadata`), not CSV
  or a JSON array. The wrapper accepts at most **16** values of at most **64 UTF-8
  bytes** each, and only `httpMetadata` and `customMetadata` are supported.
- **Keys:** The [validation checks](src/control-validation.ts) cap Base64 control
  keys at **4,096 UTF-8 bytes** encoded and **1,024 UTF-8 bytes** decoded. The
  decoded folder budget includes the `/` Explorer adds if missing. Metadata
  edits use a URL-escaped Base64 key in the path, with the same encoded byte cap
  applied to the normalized path segment before decoding it; the pinned routing
  also supports double-escaped metadata keys.
- **Multipart:** Completion requires **1–10,000** `parts`, each with an integer
  `partNumber` from **1–10,000** and an opaque `etag` string of at most **256
  UTF-8 bytes**. The wrapper preserves entry order and etag contents. The
  `uploadId` is capped at **2,048 UTF-8 bytes** for completion and part uploads.
  Part uploads carry `partNumber` as a decimal query value in the same range.

Wrapper control rejections use a fixed `Control request rejected` response with
`Cache-Control: no-store` and do not log request contents. Invalid controls
return `400`, read timeouts `408`, oversized body lengths or streams `413`, and
unsupported control-body encodings `415`. Access, CSRF, prefix authorization, and
Explorer's own errors are separate from those responses.

### Streaming and scope

The `POST` object upload, multipart creation, and part upload routes bypass the
JSON body reader. Their query inputs are still checked, and object and part
bodies pass through as streams. Multipart **completion** is a bounded JSON
control, not a part upload. The wrapper passes Explorer download responses
through without buffering them. Cloudflare and R2 limits still apply to transfers.

These are per-request control limits, not a total isolate memory budget,
concurrency cap, rate limit, or end-to-end deadline. They do not establish the
identity or safety of a deployed Worker or remediate a dependency advisory.
When changing the pinned R2-Explorer or its Chanfana router, re-check the
[wrapper's write targets](src/index.ts), [control routes and query representation](src/control-routing.ts),
and [pinned Explorer fixtures](test/explorer.test.mjs) against the new version.

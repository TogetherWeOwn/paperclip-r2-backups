# r2-backup-console

A Cloudflare Worker that serves [R2-Explorer](https://github.com/G4brym/R2-Explorer)
(`r2-explorer@1.2.0`, MIT) as a web console for the backup bucket: browse, folders,
upload, download, delete, rename/move. Files are plain objects (no client-side encryption).

Security layers:

1. A Cloudflare Access self-hosted app in front of the custom domain (identity provider and policy).
2. This Worker validates the `Cf-Access-Jwt-Assertion` header on **every** request (static
   files included): RS256 signature against the team certs, `iss`, `aud`, `exp`, `nbf`.
   Missing or invalid token gives 403. If the secrets below are unset it fails closed (500).
   R2-Explorer's own `cfAccessTeamName` option is not used because it only covers `/api/*`
   and does not check the AUD.
3. Public share links (`/share/*`, share create/list/delete) and the email API are disabled,
   since a share link would bypass Access.
4. Writes are limited to `WRITE_PREFIXES` (default `db/,instance/,status/`), so the console
   cannot modify other objects in the bucket by accident. Reads and listing see the whole bucket.
   Set `WRITE_PREFIXES=*` to lift this.

5. CSRF: every request other than GET/HEAD/OPTIONS must be same-origin (`Sec-Fetch-Site:
   same-origin`, or `Origin` equal to the Worker origin when that header is absent), and the
   JSON write routes require `Content-Type: application/json`. Otherwise 403.
6. Static dashboard files are served by the Worker itself (`env.ASSETS.fetch`) after the
   checks above, because R2-Explorer 1.2.0 does not serve them and `run_worker_first`
   bypasses the asset layer. Only `/api/*` goes to R2-Explorer.

`workers_dev` and `preview_urls` are false, so there is no public `*.workers.dev` URL.
The config contains no routes, domains or account ids.

## Deploy

```bash
cd worker
npm ci
npx tsc --noEmit                         # typecheck
npx wrangler deploy --dry-run --outdir dist   # build check, no network deploy

# Access settings (see below), then:
npx wrangler login                        # or export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
npx wrangler deploy
printf '%s' '<TEAM_NAME>' | npx wrangler secret put ACCESS_TEAM_NAME
printf '%s' '<AUD_TAG>'   | npx wrangler secret put ACCESS_AUD
```

Then attach a custom domain to the Worker (dashboard: Worker, Settings, Domains and Routes,
or the Workers Domains API) for a hostname in a zone on your account.

## Cloudflare Access setup

1. Zero Trust, Settings, Custom pages: note the **team domain**. `ACCESS_TEAM_NAME` is the
   subdomain part only (`<TEAM_NAME>.cloudflareaccess.com`).
2. Zero Trust, Access, Applications, Add, **Self-hosted**:
   - Application domain: the exact hostname you attach to the Worker.
   - Identity providers: the "Login with Cloudflare" provider (restrict to account members); disable others.
   - Policy: Allow, include only the owner identity (an email, or the account-members group).
   - Cookie settings (same screen): **SameSite = Lax** (or Strict), **HttpOnly** on, and
     **Enable binding cookie** on. The Access default is SameSite=None, which sends the
     session cookie on cross-site requests; the Worker's CSRF check is defence in depth.
   - Session duration: short (for example 8h) is fine; the Worker accepts only unexpired tokens.
3. Open the application, Overview: copy **Application Audience (AUD) Tag**. That is `ACCESS_AUD`.
   Via API it is the `aud` field of the Access application object.
4. The Worker domain must have **no other route that skips Access** (no bypass policies).

## Limits and behaviour

- Uploads from the browser go through the Worker. R2-Explorer uses a single `PUT` for small
  files and R2 multipart upload (create, part, complete) for large ones, sending each part
  through the Worker. The Workers request body limit applies per request (100 MB on Free
  and Pro, 200 MB Business, 500 MB Enterprise), so parts must stay under it; the dashboard
  chunks files itself. Verify with one large test upload on the plan in use.
  Multi-GB uploads work but are slow and happen from the browser tab, which must stay open.
- Downloads stream the R2 body through the Worker (no buffering), so multi-GB files do not
  hit memory limits. Range requests are supported by the object GET. The ~230 MB DB dumps
  and growing are fine. A dropped connection means restart, so for very large restores prefer
  `rclone` against the S3 endpoint.
- Worker CPU limit is irrelevant for streaming (I/O wait is not billed as CPU); free plan
  request counts (100k/day) are ample here.
- Folder rename is not implemented by R2-Explorer (roadmap). Rename/move works per file,
  moving a "folder" means moving each object. Move is copy then delete.
- Listings are paginated by R2 (1000 keys per page).
- The dashboard UI still shows Share, Email and "public URL" entries; the Worker answers 404 for them.
- R2-Explorer is pinned exactly; upgrade deliberately and re-check that write routes
  (`writeTargets` in `src/index.ts`) still match `node_modules/r2-explorer/dist/index.mjs`.

# r2-backup-console

A native Cloudflare Worker API (`backup-console-api-v1`) and an explicitly disclosed
email-constructor and preview-layout derivative of the MIT-licensed
[R2-Explorer](https://github.com/G4brym/R2-Explorer) **1.2.0 dashboard** for the backup
bucket. The byte-identical upstream snapshot remains immutable provenance, not a
claim about the served derivative. The adapter has **zero npm runtime dependencies**. It does
not run Explorer's server, Chanfana, Zod, email receiver or generated API docs.
Files remain ordinary R2 objects; there is no storage migration or client-side encryption.

## Access and storage boundaries

1. A Cloudflare Access self-hosted app protects the custom domain. The Worker also
   validates `Cf-Access-Jwt-Assertion` on **every request**, including assets: RS256
   signature, issuer, audience, expiry and not-before. Missing/invalid tokens return
   403; missing configuration fails closed (500); unavailable Access key verification
   returns 503. No request body is read before authentication succeeds.
2. Public share links, share create/list/delete aliases and the email API stay 404
   before body handling. The pinned UI can still display those optional features;
   that does not enable them on the server.
3. Only the `BACKUPS` binding is selectable. Other environment bindings are never
   enumerated or resolved from user input. Reads/listing can see the entire bucket;
   `showHiddenFiles: false` retains the dashboard's client-side hidden-file filter,
   **not** an object authorization boundary.
4. Writes are limited to `WRITE_PREFIXES`, default `db/,instance/,status/`. Move checks
   both source and destination; copy checks only its destination. `*` widens write
   prefixes but does **not** disable byte, query, collection or metadata validation.
5. Every method other than GET/HEAD/OPTIONS requires `Sec-Fetch-Site: same-origin`,
   or an Origin equal to the Worker origin when fetch-site is absent. JSON control
   routes require the `application/json` media type (parameters are accepted).
   Raw uploads accept the pinned client's `multipart/form-data` header: the body
   is already the object's bytes, **not a MIME multipart document to parse**.
6. `run_worker_first: true` keeps assets behind these checks. Only GET/HEAD can reach
   `ASSETS`. Unknown API paths/methods fail boundedly, without a generic fallback.

`workers_dev` and `preview_urls` remain false. The configuration has no public
workers.dev URL, route, custom domain or account identifier.

## Preview response policy — candidate, not a safety verdict

Every response carries enforced CSP and `X-Content-Type-Options: nosniff` after
metadata handling. Documents/static responses allow only the eight exact pinned
`/assets/*.preview-layout-v1.js` URLs and the original loader's unchanged SHA256
inline-script hash. No script `self`, inline handlers, eval, real workers, external
scripts or optional GitHub update connection is allowed. Trusted script requests
are fetched without redirects/ranges/conditional reuse, checked for JavaScript
MIME, exact selected length and SHA256, then served without altering their bytes.
Legacy root/SPA script URLs still return verified original bytes behind Access,
but are no longer executable CSP sources. No derivative SPA script aliases exist.
Navigation aliases and recognized SPA fallback HTML select the separately pinned
`preview-layout-v1/index.html` via an internal `/preview-layout-v1/` asset
fetch, without redirecting the browser URL; `Content-Location` discloses that
identity. Superseded `/email-constructor-v1` documents and constructor-only script
URLs return authenticated 404s without ASSETS or SPA fallback; their files remain
immutable on-disk evidence, not a second executable graph. Document fetches also reject redirects, partial/cache responses, wrong
MIME and changed bytes; HEAD validates the full representation before omitting its
body. Only pinned static representations are buffered; R2 objects remain streams. Static
responses are no-store, including errors. This does not repair already-open or
cached documents retroactively. HTTPS effective URL origins
are required outside the non-deploy loopback fixture; forwarded headers are not
policy inputs.

API responses have a separate non-executable document-navigation policy with
`sandbox allow-downloads`, preserving attachment bytes and metadata. This does not
constrain content fetched into the parent document. The pinned preview renderers
still interpret untrusted markup with innerHTML. CSP is **not sanitization**, an
inert-text renderer, a PDF.js patch or a privilege boundary. Inline styling and
same-origin frames remain for the shipped client; remote email resources are
intentionally blocked. The shipped PDF fake-worker/non-eval path, real preview
behavior, client enforcement and residual DOM/UI integrity risks require exact-head
Actions qualification and independent Security then QA acceptance before readiness.
No inherited preview finding is cleared by these headers alone.

## Supported contracts

All bucket routes use `/api/buckets/BACKUPS`. Keys are base64-encoded UTF-8;
path keys may be URL-escaped once. Malformed encodings have no fallback decoder.

| Method | Path | Result / operation |
|---|---|---|
| GET | `/api/server/config` | config, single bucket, separate adapter/dashboard versions |
| GET | bucket root | one paginated R2 list result |
| POST | `/move` | stream copy preserving metadata, then delete source |
| POST | `/copy` | stream copy preserving metadata |
| POST | `/folder` | empty object with exactly one trailing slash |
| POST | `/delete` | one object only; `{success:true}` |
| POST | `/upload` | raw streaming upload; R2 object result |
| POST | `/multipart/create` | native key/uploadId result |
| POST | `/multipart/upload` | raw part stream; partNumber/opaque etag result |
| POST | `/multipart/complete` | `{success:true,str:<R2 object>}` |
| GET | `/:key` | streamed download with HTTP metadata, etag, size, safe filename |
| HEAD | `/:key` | object existence/metadata check without response body |
| GET | `/:key/head` | native object metadata JSON |
| POST | `/:key` | replace metadata while streaming the existing object body |

Control bodies strip unknown top-level fields by selecting only the supported
fields. Multipart item extras are likewise not forwarded. Unknown query names and
repeated scalar query names are rejected; `include` is the supported repeated name.
List `prefix` is base64; `startAfter` is passed through as the original server did.
The pinned client sends `include=customMetadata&include=httpMetadata`, with cursor
pagination and base64-JSON query metadata for upload/create. There is no recursive
server-side list aggregation, folder rename or recursive delete. Move remains a
copy then delete, not an atomic transaction; concurrent updates can race as before.
Downloads do not add range processing or full-object buffering.

## Permanent finite-work bounds

- Actual JSON body bytes: **4,194,304 inclusive**, with a **10-second absolute read
  deadline**, cancellation and timer cleanup. Missing/misleading Content-Length does
  not bypass accounting. Unsupported Content-Encoding is rejected. One bounded byte
  buffer handles tiny/empty chunks; the body is parsed once for authorization and use.
- Binary upload/download and metadata-rewrite bodies stay streams. The control-JSON
  cap never applies to object bytes. Platform request/object-size limits still apply.
- Completion: **1–10,000** parts, count/type before item access; integer partNumber
  **1–10,000**, etag **256 UTF-8 bytes**, key **1,024 decoded / 4,096 encoded bytes**,
  uploadId **2,048 bytes**. Opaque etags, numbering and order are preserved: no sorting,
  renumbering, unquoting or invented uniqueness check.
- Raw query: **8,192 UTF-8 bytes** before decoding, repeats included. Include has at
  most **16** values, each **64 bytes**, restricted to customMetadata/httpMetadata.
  Encoded query metadata is at most **4,096 bytes**, decoded JSON **3,072 bytes**.
- Custom metadata: at most **128 own entries**, checked before values; keys **128
  bytes**, scalar representations **2,048 bytes**, custom total **8,192 bytes**.
  Supported JSON scalars convert explicitly to R2 strings; nested arrays/objects
  and non-finite numbers are rejected. Dates serialized on the wire remain ISO text.
- HTTP metadata allows only contentType (**1,024 bytes**), contentLanguage (**256**),
  contentDisposition (**2,048**), contentEncoding (**256**), cacheControl (**2,048**),
  cacheExpiry (**64**). Expiry ISO strings convert to native Date; invalid values and
  header control characters are rejected. HTTP metadata total is **8,192 bytes**.
  Both metadata records together must also fit R2's [8,192-byte object metadata
  limit](https://developers.cloudflare.com/r2/platform/limits/). Tighter platform
  restrictions continue to apply; these bounds are not permission to exceed them.
- First failure stops processing. Fixed no-store error envelopes are under **1,024
  bytes**; at most one constant safe log under **512 bytes** is emitted. Internal
  exceptions and request body/keys/tokens/etags/uploadIds are never reflected.
- List pages are **1–1,000** objects, default 1,000. Cursor pagination is retained.

These are **per-request application bounds**, not a guarantee about total isolate
memory, host/concurrency limits, rate limiting, CPU billing or general DoS resistance.
They remain useful independently of the removed server libraries.

## Pinned assets and supply chain

`dashboard/` contains the original 56 files / 4,937,484 bytes, including its `spa/`
subtree. See `dashboard/PROVENANCE.md`, `EXPLORER-LICENSE` and `checksums.json` for
artifact integrity, attribution and every asset digest. No install/build fetches
`latest` assets or rebuilds the UI. Static/browser embedded-component review is
separate from the npm graph and release-age policy; source subtraction alone is
not a whole-advisory or deployed-remediation claim.

`dashboard/email-constructor-v1/manifest.json` separately retains nine prior
payloads (1,666,162 bytes): one main bundle correcting only
`new PostalMime.default().parse(this.filedata)` to
`new PostalMime().parse(this.filedata)`, seven referencing module copies and one
HTML entrypoint. The main carries a modification notice. Its parser, inputs,
options, sinks and error handling otherwise remain unchanged. The manifest records
all source/derivative paths, lengths, hashes and deterministic byte operations;
original `checksums.json`, provenance and all notices remain unchanged. This is
not a parser update, sanitization fix or clean-SBOM claim. Exact-head Actions must
qualify semantic email parsing/reopening and the full preview/client matrix.
The email correction adds no PDF renderer changes and does not waive image checks.

`dashboard/preview-layout-v1/manifest.json` identifies the selected nine-payload
representation (1,666,261 bytes), derived from those exact prior payloads. Its sole
behavioral change adds Quasar's existing `no-wrap` utility to the unique FilePreview
QCard (`flex column` → `flex column no-wrap`), plus a modification notice and the
necessary eight-module/HTML reference closure. This shared preview-shell layout
candidate adds no CSS, renderer/sensor changes, dependencies or CSP capabilities.
The manifest retains original and parent paths/hashes and every deterministic
operation; no original or prior derivative is overwritten. The eight new script
pins replace, never union with, the old executable sources.

Exact-head Actions must qualify real section/container/sensor/canvas contraction
and restoration at 1366×768 → 900×700 → restore, both painted PDF pages, font and
cached eval-probe semantics, annotation images and all shared preview/edit modes.
The test also serves the exact retained wrapping representation through a
fixture-only compiled handler selecting its old document/script pins. The same
resize helper must reject that representation with unchanged section/canvas width;
no bundle-byte, DOM CSS or Vue-scale injection is used. Separate original-wrap and
candidate screenshots/geometry survive failures. Candidate source support is not
proof of repair, full compatibility, finding acceptance or advisory remediation.

`dashboard/pdf-note-v1/` separately retains the original 1,083-byte
`pdfjs-dist@2.5.207` Note SVG, unchanged Apache-2.0 root LICENSE and pinned
`provenance.json`. These three files are not additions to either immutable
inventory and do not establish the compiled PDF renderer's version or security.
Only authenticated GET/HEAD `/BACKUPS/files/<folder-param>/annotation-note.svg`
serves it. The root sentinel is `IA==`; other parameters must be canonical padded
UTF-8 base64 (only alphabet `/` becomes uppercase `%2F`), at most 4,096 serialized
characters / 1,024 decoded bytes. Relative folders end `/`, with nonempty components,
no dot components, absolute paths, backslash, percent or ASCII controls. These are
image-route limits, not changes to the API's opaque object-key contract.

The helper maps every admitted folder to one fixed internal ASSETS path, never R2
or a folder-selected target. It strips range/conditional headers, requests identity
encoding and validates full 200 status, SVG MIME, no redirect/Location or encoding,
EOF, exact length and full SHA256 before success. Storage is bounded to 1,084 bytes,
with a 10-second absolute read deadline and bounded empty-chunk work. GET returns
exact bytes; HEAD performs the same validation without a body. Both have clean
no-store/nosniff headers; no backend cookies, validators, 206 or 304 survive.
Observable aliases, other annotation/SVG file subresources and the direct public
`/pdf-note-v1` namespace are 404 without ASSETS/R2 or SPA fallback. Backend failure
is a fixed non-HTML 500, never a fallback icon/document. API dispatch, normal file
navigation, existing CSP and object streams stay unchanged. Request URL normalization
may erase raw dot/backslash forms before the handler; tests record actual Request URLs,
not fictitious raw-wire rejection. Exact-head Actions must qualify image response
hashes/lengths/headers and decoded dimensions at root and selected folders, including
canonical base64-slash, plus missing/corrupt/MIME/redirect/HTML rejection controls.
This single Note resource does not add CMaps, fonts, real workers, other annotation
images or a claim of general PDF compatibility; broader PDF/F6/F7 review remains open.

Retained tools are exact: workers-types 5.20261101.1, TypeScript 7.0.2, Wrangler
4.156.1 and their unchanged locked dependency objects. Use npm **11.19.0** with the
project `.npmrc`: `min-release-age=3`, `ignore-scripts=true`. Root lifecycle hooks
are absent. Locked install-hook candidates esbuild 0.28.2, fsevents 2.3.3 and workerd
1.20261101.1 are **not exemptions**: no hook execution, rebuild or release-age bypass
is authorized by this repository. Existing locks are not retrospective provenance
or publication-age evidence. Review an indispensable narrow exception separately
rather than enabling scripts globally.

## Verification and deployment

Full tests, clean install, typecheck and non-deploy build run in **GitHub Actions**,
not on the shared development host. The additive Worker job uses the exact PR SHA,
checks native npm policy, installs with hooks refused, verifies the native lock,
runs Node finite-work/mocked-R2 fixtures, ephemeral native R2 fixtures and the real
pinned browser client's API calls, then runs `wrangler deploy --dry-run`. Chrome
availability is a qualification prerequisite, never a skipped compatibility pass.
Ephemeral fixture servers, native runtimes and Chrome profiles/processes are cleaned
up on success/failure. No production bucket, token, domain or deployment is used.

`npm run typecheck`, `npm test` and `npm run build` are the reviewed Actions commands.
`npm run deploy` remains a **separate, explicitly authorized production operation**;
a source merge or green CI is not deployment approval. Do not change secrets or
publish a preview as part of verification. Any preview must be authorized, bounded,
on-demand, zero-idle-cost and cleaned up after failure/cancellation as well as use.

Rollback has no storage migration to reverse, but restoring the previous server
bundle can reintroduce its removed dependency graph. Preserve containment and get
the normal exact-artifact release decision; never call that a clean security rollback.

## Cloudflare Access setup

1. `ACCESS_TEAM_NAME` is only the subdomain of `<TEAM_NAME>.cloudflareaccess.com`.
2. Protect the exact custom domain with an Access **Self-hosted** application and a
   policy restricted to the intended owner identity/account-members group.
3. Disable unused identity providers. Use SameSite=Lax (or Strict), HttpOnly and
   binding cookies; short sessions are preferable. Worker CSRF checks are defense
   in depth, not a substitute for the Access policy.
4. `ACCESS_AUD` is the application's Audience tag. The domain must have no other
   route or bypass policy that skips Access. Provision secrets/domain bindings only
   through the authorized operational process, never from the CI fixture job.

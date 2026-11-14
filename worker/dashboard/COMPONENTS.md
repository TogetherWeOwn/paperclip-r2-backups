# Pinned browser component evidence

This is a bounded attribution inventory, **not an exhaustive or clean SBOM**.
Removing the npm server graph does not remove browser preview parsers. API client
qualification does not establish parser/preview security or advisory applicability.

## Source provenance and evidence levels

The publisher's [attestation metadata](https://registry.npmjs.org/-/npm/v1/attestations/r2-explorer@1.2.0)
points to [source commit d8fefacf3eef29dcd9eb12bd911f2e8fa7da692e](https://github.com/G4brym/R2-Explorer/tree/d8fefacf3eef29dcd9eb12bd911f2e8fa7da692e).
Its statements were inspected, but signatures/transparency were not cryptographically
verified. This is a source pointer, not independently reproduced build provenance.
The publisher run has no retained artifacts; the tarball has no maps, SBOM or complete
third-party notice inventory.

- Original `packages/dashboard/package.json` SHA256:
  `3f953fc5fe8b004b3189e5e26aeb9c7a7ae7104cb34f532d6343bb75894f843b`.
- Original `pnpm-lock.yaml` SHA256:
  `eb6b47517dd2571a28e7c83ce5fbbe2f478e47c3ad640c4380374b40d014b1cf`.
- **B**: affirmative identifier/version or exact file identity in shipped bytes.
- **S**: original source import/lock candidate, not a verified compiled version.
- **U**: unresolved compiled identity, module completeness or attribution.

`source-notices.json` retains 28 original source candidates, their tarball URLs,
original-lock SHA512, observed tarball SHA256 and notice-file hashes.
`THIRD-PARTY-NOTICES.md` preserves the associated original license/notice texts.
Tarballs were read as data with no install, hooks or build. Conservatively including
a candidate's notice does not prove its whole package ships or resolve every U entry.
Only the two positively matched font sets and the extras package's root notice are
included from `@quasar/extras`; unrelated icon/font sets are not attributed as shipped.

## Browser inventory

Paths below are in the original snapshot; mirrored `spa/` files are identical.
Source paths are relative to `packages/dashboard` at the source commit above.

| Component | Evidence | Shipped path / original consumer |
| --- | --- | --- |
| Explorer application | 1.2.0 B (artifact identity) | Eight JS chunks plus mirrored SPA; original source manifest's 0.0.1 is not a dependency version |
| Vue shared/reactivity/runtime-core/runtime-dom | 3.5.13 B | `assets/index.97b9144c.js:2–20` MIT banners |
| Pinia / vue-demi | Pinia 2.2.8 B; vue-demi 0.14.10 S | Main JS:21–25; vue-demi compiled identity U |
| Vue Router | 4.5.0 B | Main JS:26–30 |
| Quasar | 2.17.5 B | Runtime identifier and `assets/index.74f0784c.css` banner |
| Axios | 1.7.8 B | Main JS:32; `src/boot/axios.js`, `src/appUtils.js` |
| PostalMime | Parser code B; 2.3.2 S, compiled version U | Main JS:54–78; `src/components/preview/EmailViewer.vue` |
| HTML-to-text | Converter/parser code B; 9.0.5 S, compiled version U | `EmailViewer.vue:62–82`; main JS converter implementation |
| HTML conversion closure | S; individual compiled identities/versions U | `@selderee/plugin-htmlparser2` 0.11.0, deepmerge 4.3.1, dom-serializer 2.0.0, htmlparser2 8.0.2, selderee 0.11.0, domhandler 5.0.3, domelementtype 2.3.0, domutils 3.1.0, entities 4.5.0, parseley 0.12.1, leac 0.6.0, peberminta 0.9.0 |
| PDF.js | 2.5.207 B, build 0974d605 | Main JS:81–87; `src/components/preview/PdfVuer.vue` imports pdfjs-dist API, worker entry and web/pdf_viewer |
| pdfvuer resize integration | 2.0.1 S, compiled identity U | Local PdfVuer imports `pdfvuer/src/resize.vue`; inspected original-lock tarball module imports only Vue and credits css-element-queries. This does not import the whole pdfvuer package |
| fflate | Decompression code B; 0.8.2 S, compiled version U | Main JS:88; `src/components/preview/logGz.vue` |
| Custom renderers/parsers | Original Explorer source, no independent npm version | `src/parsers/markdown.js`, FilePreview CSV/JSON/HTML/text, EmailViewer, logGz JSON; compiled rendering branches survive |
| Roboto | Name-table 2.137 / 2017 B; exact file identity B | All six WOFF files match `@quasar/extras@1.16.15/package/roboto-font/web-font/` byte-for-byte; original Apache-2.0 text retained |
| Material Icons | WOFF name-table 1.017 B; exact WOFF and WOFF2 identities B | Both files match original extras `material-icons/web-font/` byte-for-byte; original Apache-2.0 text retained. WOFF2 internal version remains U |
| Other bundled helpers/polyfills, images/logos | U | No publisher module map or exhaustive original attribution; Explorer MIT notice retained, but it alone does not establish all third-party origins |

The font matches are recorded individually with source path and SHA256 in
`source-notices.json`. Source-lock candidate versions must never be substituted for
unverified compiled versions. Browser PostalMime 2.3.2 S is **not** the removed
server package 2.7.6, nor the original publisher workspace's server copy 2.6.1.

## Explicit unresolved operations / boundaries

- Exact compiled versions and module completeness for S entries require a publisher
  module map or equivalent reproducible build evidence not supplied by the archive
  or retained publisher run. No dashboard rebuild, package update or upstream request
  is implied by this inventory. Preserve these U entries for specialist disposition.
- PDF worker/auxiliary CMap/font payload resolution and runtime fallback behavior
  are not qualified by API fixtures. No standalone PDF worker/map payload is listed
  among the 56 original assets. Source worker-entry imports are not proof of a
  separately emitted or successfully fetched worker. Preview-specific behavior,
  external resources and parser safety remain separate qualification surfaces.
- The original pdfvuer manifest also declares raw-loader 0.5.1 and
  vue-resize-sensor 2.0.0; the imported resize module itself imports neither.
  Manifest membership alone is not proof that either ships in these chunks.
- Disabled server share/email routes do **not** disable authenticated browser email,
  HTML, Markdown, CSV, PDF or gzip preview. Preserve all preview consumers in security
  review; do not erase them through a server reachability or native-lock argument.
- No zod/chanfana marker match in a minified browser chunk proves neither presence
  nor absence. Tool distributions can contain prebundled parsers despite the absence
  of separately installed nodes; inspect them separately from deployed Worker code.
- Exact-head Actions retains Wrangler/Miniflare distribution files and hashes,
  emitted Worker output and esbuild module metadata as separate build evidence.
  Those tools execute on the build/test host, not by default in the deployed adapter.
  The actual emitted paths, asset-serving support and any native/prebundled payload
  unknowns still require inspection; this document does not presume the build passed.

REA angle: integrity-pinned published bytes, affirmative signatures, original imports,
original-lock tarball notices and exact font matching; no copied server or rebuilt UI.

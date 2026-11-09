# Pinned Explorer dashboard

These static files are the byte-identical dashboard subtree from the MIT-licensed
`r2-explorer@1.2.0` npm artifact. This is not a fork or copy of its server library.
The repository's native Worker adapter is versioned independently as
`backup-console-api-v1`; the dashboard version remains `1.2.0`.

- Source: <https://registry.npmjs.org/r2-explorer/-/r2-explorer-1.2.0.tgz>
- Upstream: <https://github.com/G4brym/R2-Explorer>
- Artifact SHA256: `82b88b7a702bad32f24b203acc569c42cd7225a3191a33cc58de36c1c0061b27`
- Artifact SHA512 (npm lock integrity): `x9MKwkGLoOsxDBFj8khp1JhARUSh8lzoFiQuslvsJF3Jcmi7ftlg5k9kk5NW1E8VlApZThkY+OXUc5p3tB/xkQ==`
- License: `EXPLORER-LICENSE`, SHA256 `479887d33bb0120f0f8c21aab2062fb2434eba4c84b006edf255ceefe2d7e84c`
- Original asset count: **56 files**, **4,937,484 bytes**. This includes the
  supplied `spa/` subtree; no minification, rebuild, deduplication or redesign.
- `checksums.json` covers every original asset by relative path and SHA256.
  Provenance, checksums, license, `COMPONENTS.md`, `source-notices.json` and
  `THIRD-PARTY-NOTICES.md` are six additional evidence files, not original assets.

No install/build downloads dashboard assets, and no asset is fetched as `latest`.
The native npm release-age policy does not cover vendored files: tarball integrity,
license, per-file checksums and a separate embedded-component review are required.
Static integrity is not a claim that embedded browser dependencies are unaffected
by advisories. Browser SBOM/advisory reconciliation and real-client qualification
remain explicit release evidence, separate from removing npm server dependencies.

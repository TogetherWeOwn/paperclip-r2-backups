# paperclip-r2-backups

Offsite backups of a self-hosted [Paperclip](https://github.com/paperclipai/paperclip) instance to Cloudflare R2, and a small web console to browse and manage the bucket.

- **`backup/`**: a Python script (stdlib plus `rclone`), run once a day by a systemd user timer.
  - Native Paperclip dump and instance snapshot formats are preserved. Snapshots default off; with `SNAPSHOT_BACKUPS=true`, the run also captures snapshot-bound `pg_dump -Fc` bundles for Paperclip and Hindsight, each with its own acquisition interval and conservative <26-hour offsite freshness check. Any capture failure stops all uploads, including native ones, and skips retention; see [the availability tradeoff](docs/restore.md#snapshot-bound-offsite-drills-both-databases) before enabling. Recovery requires the validated upper bound strictly before the incident cutoff; invocation-dated legacy bundles remain retained without that guarantee.
  - On Sunday UTC, the existing daily invocation downloads both offsite bundles, restores them in isolated throwaway compatible containers and compares schema heads/exact table counts with the original source snapshot. Receipts include timestamps, dump/object SHA-256, schema heads, counts, image pins and cleanup results.
  - It then applies grandfather-father-son retention: 30 daily, 12 weekly and 12 monthly for database dumps, and 7 daily, 4 weekly and 3 monthly for instance snapshots.
  - Native retries reverify an existing exact dump key with the original size/checksum checks before reporting success or pruning. A different same-day key is not proof of this dump: it uploads and verifies the selected complete local dump instead. An unchanged dump is not reuploaded. No separate integrity receipt or scheduler is used.
  - Safety rails: nothing is deleted after a failed upload or verification or when the backups are stale, the newest 3 are always kept, deletions per run are capped, a prefix guard limits which keys can be touched, and `--dry-run` shows the plan without verifying remote contents. Cap and spend guards are also built in; a cap-denied run can prune only after verifying the selected native dump already offsite. Native-only runs also refresh observation time after upload/verification and reject detected clock steps before retention.
  - The aggregate cap counts the whole bucket, including unrelated objects and immutable ops archives, plus pending incoming bytes minus only the exact admitted db/instance deletions. Unrelated objects count once for admission and never become deletion candidates. It includes positive growth of `status/last-run.json` before admitting uploads. Every final status write (success or error), including restore receipts, rechecks complete whole-bucket inventory and exact replacement bytes. Missing, failed, partial or malformed inventory fails closed, never as zero; no cap/configuration or archive changes are implied. If inventory is unavailable or the receipt cannot fit, the previous status is retained and the run exits nonzero; inspect the service journal for the current error rather than treating an older successful status as current. No additional deletions are authorized to fit a receipt; successful retention still applies exactly the admitted plan.
- **`worker/`**: a Cloudflare Worker built on [R2-Explorer](https://github.com/G4brym/R2-Explorer).
  - It runs behind Cloudflare Access and checks the Access JWT itself, including `aud`.
  - It has CSRF checks, disables share links, and only allows writes under the backup prefixes.
- **`docs/restore.md`**: how to restore from these backups.
- **[Local measurement boundary](docs/local-measurement.md)**: separate capture-only CLI and fixture-tested cleanup/receipt lifecycle. Execution remains **NO-GO** until a reviewed native supervision/admission verifier proves the full backend, scratch, I/O and exclusion contract. No host preparation or live capture is authorized by this source.

Backups are stored as plain `.sql.gz` / `.tar.gz` objects. R2 encrypts them at rest, and access is limited to the bucket-scoped token and the Access-protected console. The instance master key is **not** included by default (`INCLUDE_SECRETS=false`). A restore needs both the dump and the master key, so keep the key in a password manager.

Recommended bucket settings:
- keep the bucket private (r2.dev disabled);
- add an R2 bucket lock on `db/` that is a little shorter than the daily window, for example 28 days, so recent dumps cannot be deleted even with valid credentials.

## Install (backup)

Operator-only after merge and applicable production approval. Follow
[the installation/rollback and live acceptance checklist](docs/restore.md#installupgrade-operator-only-after-merged-source-and-production-acceptance)
and [the offsite-backup host-exception entry](docs/host-exceptions.md).
Existing credentials and digest-pinned compatible restore images are prerequisites.
The original bucket cap is unchanged and now includes both new database prefixes.

```sh
bash backup/install.sh          # installs script + user units, enables (not starts) the timer
$EDITOR ~/.config/paperclip-r2-backup/env   # from backup/env.example
python3 ~/.local/share/paperclip-r2-backup/paperclip_r2_backup.py --dry-run   # with the env loaded
systemctl --user start paperclip-r2-backup.timer
```

## Deploy (console)
See `worker/README.md`.

## Tests

GitHub Actions is the CI of record. The Backup CI workflow runs Python unit/negative
coverage and real PostgreSQL/pgvector restore fixtures; it retains a fixture receipt
artifact for the tested head. Full suites/integration restores are not run on the
shared host. Only a focused reproduction of an individual failing test is local
diagnostic work. CI fixtures are not evidence of a successful live installation.

## License
MIT

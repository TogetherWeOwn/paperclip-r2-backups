# Restore

You need three things: a database dump, the instance master key, and (optionally) the instance snapshot.
Paperclip's own docs say a restore needs both the database dump and the master key file; either alone is
not enough (`doc/DATABASE.md`, "Secret storage", and `doc/DEVELOPING.md`, "Secrets in Dev").
Database backups do not include the master key or non-database instance files (`doc/DATABASE.md`, "Backups").

The master key is not in R2 unless you set `INCLUDE_SECRETS=true`. Get it from your password manager.

## Bucket layout

| Prefix | Content |
| --- | --- |
| `db/YYYY/MM/DD/paperclip-YYYYMMDD-HHMMSS.sql.gz` | Paperclip logical DB dump, uploaded as-is (plain gzip) |
| `instance/YYYY/MM/DD/paperclip-instance-YYYYMMDD-HHMMSS.tar.gz` | `config.json`, `companies/`, `skills/`, `accounting-receipts/` |
| `status/last-run.json` | Result of the last backup run |

Nothing is client-side encrypted. Files download and open as normal files.

## 1. Download

Console: open the console worker, browse to the file, download.

rclone (same `RCLONE_CONFIG_R2_*` variables as the backup job, see `backup/env.example`):

```sh
set -a; . ~/.config/paperclip-r2-backup/env; set +a
rclone lsf -R "R2:$BACKUP_BUCKET/db/" | tail -5
mkdir -p ~/restore && cd ~/restore
rclone copyto "R2:$BACKUP_BUCKET/db/2026/11/02/paperclip-20261102-003716.sql.gz" ./dump.sql.gz
rclone copyto "R2:$BACKUP_BUCKET/instance/2026/11/02/paperclip-instance-20261102-042000.tar.gz" ./instance.tar.gz
gzip -t dump.sql.gz && echo dump ok
```

## 2. Restore the instance files

Stop Paperclip first. Archive paths start with `instance/`.

```sh
INST=~/.paperclip/instances/default
mkdir -p "$INST"
tar -xzf instance.tar.gz -C "$INST" --strip-components=1
```

Put the master key back from the password manager at the path in `config.json`
(`secrets.localEncrypted.keyFilePath`, default `$INST/secrets/master.key`), mode 0600:

```sh
install -d -m 0700 "$INST/secrets"
install -m 0600 /path/from/password-manager/master.key "$INST/secrets/master.key"
```

Alternatively set `PAPERCLIP_SECRETS_MASTER_KEY` or `PAPERCLIP_SECRETS_MASTER_KEY_FILE`
(`doc/DATABASE.md`, "Secret storage").

## 3. Restore the database

The dump is a plain SQL file written by Paperclip's JavaScript backup path
(`runDatabaseRestore` in `packages/db/src/backup-lib.ts` restores it with `psql`, and falls back to
statement-by-statement replay). The docs describe `paperclipai db:backup` but I found no documented
user-facing restore command in `doc/DATABASE.md` or `doc/DEVELOPING.md`. So:

UNVERIFIED: this procedure has not been run end to end.

1. Start only the database (for the default embedded PostgreSQL, start Paperclip once so it creates an
   empty database, then stop the app but keep PostgreSQL available), or point at an empty external database.
2. Load the dump into an empty database:

   ```sh
   gunzip -c dump.sql.gz | PGSERVICE=paperclip-restore psql -v ON_ERROR_STOP=1
   ```

   Configure `paperclip-restore` in a protected libpq service file and keep any existing
   password in a mode-0600 pass file; never put the connection URL/password in argv or logs.
   For embedded PostgreSQL see `~/.paperclip/instances/default/config.json` under `database`;
   embedded port and credentials are UNVERIFIED here.
3. Start Paperclip. Pending migrations apply on startup. Check `/api/health` and open a known record.

Do a trial restore into a throwaway instance before you need it (`doc/DEVELOPING.md`,
`feature-map/instance-operations.md`: "A successful backup write does not prove restoration works").

## Snapshot-bound offsite drills (both databases)

With `SNAPSHOT_BACKUPS=true`, the daily run additionally creates:

| Key | Content |
| --- | --- |
| `paperclip/YYYY/MM/DD/paperclip-YYYYMMDD-HHMMSS.tar` | Supplemental custom-format Paperclip dump and source-snapshot manifest |
| `hindsight/YYYY/MM/DD/hindsight-YYYYMMDD-HHMMSS.tar` | Hindsight custom-format dump and source-snapshot manifest |
| `status/restore-last.json` | Latest drill result, including failure; never an implied live success |

Each uncompressed tar contains exactly `dump.pgcustom` (`pg_dump -Fc`, internally
compressed) and `manifest.json`. No master key is added. Native Paperclip `db/`
SQL uploads and instance snapshots continue unchanged. Legacy SQL dumps have no
source-snapshot manifest and are **not** claimed as snapshot-verified by this drill.
The supplemental Paperclip dump is necessary to compare independently measured
source counts rather than to derive the expected answer from a restored dump.

Capture opens a read-only repeatable-read transaction and exports its snapshot.
Both the exact per-table counts/schema-head query and `pg_dump --snapshot` import
that snapshot while the owning connection stays open. Later committed writes are
not included in either answer. Avoid migration/DDL windows during capture: PostgreSQL
snapshot semantics are not a global migration lock. Failure aborts the run before
retention, and no completed bundle is published until capture finishes. Same-day
retries recapture and reverify new database bundles: object presence alone is not
proof that an earlier upload passed verification. This may create several same-day
bundles, still governed by GFS, the newest-three floor and the aggregate cap.

Schema head means the migration ledger rows at capture: default
`drizzle.__drizzle_migrations(hash,created_at)` for Paperclip and
`public.alembic_version(version_num)` for Hindsight. Empty or missing ledgers fail
closed. Operator must verify the actual installed ledger schema and configure
`*_HEAD_TABLE`/`*_HEAD_COLUMNS` if it differs, including tenant-specific Hindsight
schemas. Every non-system ordinary/partitioned table is counted exactly, including
all tenant schemas; this is not a sample or an estimate. A head match proves parity
with the captured source, **not** that the source is at the newest release migration.

The weekly drill runs on Sunday UTC **inside the existing daily backup timer**,
after successful uploads and retention. It downloads each newest offsite bundle
(<26h old) into a fresh private directory, verifies object size and dump SHA-256,
then streams the dump to a new compatible Postgres container. It compares the entire
count map and schema head with the original manifest, never with today's mutable
source. Inventory keys use PostgreSQL's quoted qualified identifiers, including
application schemas beginning `pg` (only the reserved literal `pg_` prefix is excluded).
Source tablespaces are intentionally remapped to the target's default tmpfs tablespace
using `pg_restore --no-tablespaces`; the drill verifies data, not source storage paths.
Only two plain regular archive members are parsed; extended headers are rejected
before expansion and trailer/padding/manifest sizes are validated. No source connection
is used by `--restore-drill`.

Targets have no network, published ports, host bind mounts, Docker socket or
credentials. The root is read-only; data is bounded tmpfs, memory/swap/CPU/PIDs are
capped, and the target is removed with volumes before a success receipt is emitted.
Images are immutable digest pins and pre-pulled (`--pull=never`); PG18 Hindsight
requires pgvector and **every other extension actually installed in the source**.
A pgvector-only image cannot restore a source that also uses unavailable extensions.
The defaults permit only a 1 GiB data tmpfs and 2 GiB total memory. These are safe
small-fixture limits, **not suitable proof for a multi-GiB live database**. Before
installation, Operator must measure uncompressed DB/index size and available host
memory, set `RESTORE_DATA_MB` and `RESTORE_MEMORY_MB` with headroom, and retain the
admission evidence. Data must be smaller than total memory; the tool caps total
memory at 64 GiB. If the host cannot safely fit the live restore, do not weaken
isolation or skip verification: route the capacity prerequisite. Two databases are
restored sequentially, never with overlapping target memory allocations.

### Install/upgrade (Operator only, after merged-source and production acceptance)

1. Keep the current installation as the rollback target: record its revision and
   take a protected copy of installed scripts/unit/env (never attach env contents).
   Stop the timer and let any existing operation finish before replacing files.
2. Verify the existing source DB names, major versions, migration ledgers and
   installed extensions through the authorized Operator path. Use existing source
   credentials only; this implementation does not create users or change grants.
   Paperclip needs matching `psql`/`pg_dump` clients and an existing libpq service;
   Hindsight uses `docker exec --user postgres` and its local socket. If socket
   authentication does not permit this, configure an existing libpq service instead
   (`HINDSIGHT_DB_CONTAINER=` and `HINDSIGHT_PG_SERVICE=<service>`). Do not add trust
   authentication to a source or pass a connection URI/password on the command line.
3. Put existing connection parameters in mode-0600 `pg_service.conf`/`pgpass` files
   in the protected configuration directory; provide absolute `PGSERVICEFILE` and
   `PGPASSFILE` paths. Do not put passwords in a systemd command. No new credential
   or Docker access grant is authorized. Verify the existing unit user already has
   the required access; missing privilege is an installation prerequisite.
4. Review and pre-pull compatible digest-pinned restore images. Record image
   identities, extension compatibility, source versions and capacity admission.
   The CI image pins are fixtures, not an automatic choice for production.
5. Run `bash backup/install.sh` from the merged source. It copies both Python
   modules/unit files, preserves existing env and enables but does not start the
   timer. Merge the new settings from `backup/env.example` into that env, set
   `SNAPSHOT_BACKUPS=true`, both image pins and measured restore capacity. Retain
   `INCLUDE_SECRETS=false`, the private bucket and current cap. Never use shell
   tracing or print the environment. Existing installations without the new flag
   keep legacy-only behavior until explicitly configured; this is not completion.
6. Reconcile the installation-wide exception inventory with
   [the repository-owned registry entry](host-exceptions.md). Start a single
   authorized backup invocation through the user service, inspect its protected
   status, and confirm independent `snapshot_freshness` values for both databases.
   `--dry-run` reads no source DB and cannot estimate the size of a not-yet-created
   bundle; its projected cap estimate is therefore incomplete. Only a real run
   establishes whether all new objects fit. No cap increase is authorized here.
7. Run the first explicitly authorized isolated drill with the protected env loaded:
   `python3 ~/.local/share/paperclip-r2-backup/paperclip_r2_backup.py --restore-drill`.
   This is a live-data operation, not something the source author runs. Check both
   databases' source timestamps, schema heads, counts, dump/object hashes, image
   pins and `cleanup_ok`, then start the existing timer. Retain the first Hindsight
   offsite key and a successful live receipt for **each** database separately from
   Actions fixtures. These are post-install acceptance, not claims made by CI.

### Failures, evidence and cleanup

- Backup failures return 1; aggregate cap rejection returns 2. Upload/verification
  failure blocks retention. GFS/minimum-three/clock/delete-budget rails also cover
  the new prefixes. Cap rejection preserves the existing behavior of allowing
  bounded pruning of already-expired history; it never deletes the newest three.
  New bundles increase storage and exact counts increase source I/O: observe both.
- Independent freshness is written to `status/last-run.json` on successful snapshot
  processing. A failed overall backup is never a freshness attestation. A weekly
  restore failure returns 1 even when the preceding backup succeeded; inspect
  **both** `status/last-run.json` and `status/restore-last.json`, plus systemd Result.
- Each drill writes a timestamped private local JSON receipt under
  `~/.local/state/paperclip-r2-backup/receipts/` (override `RESTORE_RECEIPT_DIR`),
  then admits its exact replacement-byte delta against the aggregate bucket cap
  before replacing `status/restore-last.json` offsite. If admission fails, retain
  local failure evidence without publishing; the previous offsite receipt is not
  current-run success. Receipt-upload failure also fails the invocation; its local
  receipt remains. Receipts contain metadata/counts, not
  row content, connection strings or master keys. Treat counts/schema names as
  protected operational metadata. Local history is Operator-managed evidence;
  include it in existing evidence archival/retention rather than a new scheduler.
- Child stderr is suppressed because clients can echo connection strings or row
  data; failure receipts deliberately contain a safe error, not raw stderr.
  Do not enable client debug logging or attach DB logs to public CI artifacts.
- Temporary plaintext files are private and removed on success, exceptions and
  handled SIGTERM/SIGINT. The unit provides a two-minute SIGTERM cleanup window,
  a six-hour hard limit and no automatic restart. A shared nonblocking lock prevents
  overlapping backup/retention/drill invocations; overlap exits rather than queues.
- SIGKILL, daemon loss or a host crash cannot run Python cleanup. Operator checks
  `docker ps -a --filter label=offsite-restore=true`, inspects ownership before
  removing only the matching abandoned target with `docker rm -fv <name>`, and
  removes only verified abandoned `build-`/`drill-` directories after confirming
  no operation holds `operation.lock`. Never run global Docker or cache pruning.
  Cleanup failure yields no success receipt. A failed weekly drill needs an explicit
  authorized retry; the next daily backup does not erase its failure receipt.
- Actions fixtures exercise PG17 and pgvector/PG18, mutation after metadata but
  before dump, offsite corruption, manifest/path rejection, failure propagation
  and cleanup. Run/job links for the exact head and the
  `isolated-restore-fixture-receipts` artifact are CI evidence, never live receipts.

### Rollback

Stop the timer and current service, allow cleanup, and confirm no labeled target
or active lock remains. Restore the protected prior script/unit/env copy and reload
user units. Re-enable/start the prior timer only through the authorized Operator
path. Do not roll back source databases, delete offsite history, change the R2 token,
remove Access controls or increase the cap. Leave new bundles/receipts intact for
recovery; legacy code will not prune the new prefixes. Reconcile the exception
inventory and record the installed rollback revision. Setting `SNAPSHOT_BACKUPS=false`
is an explicit temporary return to legacy-only backups, **not** a healthy Hindsight
backup or successful restore drill; track that gap until repaired.

## Caveats

- Restoring an older database can roll back the stale-provider-Stop high-water mark; the disaster-recovery
  note in `doc/DATABASE.md` says not to assume stale provider Stop events are safe to reuse.
- `projects/`, `workspaces/` and git checkouts are not backed up. Recover them from their git remotes.
- Dump and snapshot file names carry UTC timestamps assuming the host clock is UTC.

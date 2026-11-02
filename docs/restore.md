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
   gunzip -c dump.sql.gz | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
   ```

   `DATABASE_URL` is the connection string of the target database (for embedded PostgreSQL see
   `~/.paperclip/instances/default/config.json` under `database`; embedded port and credentials are
   UNVERIFIED here).
3. Start Paperclip. Pending migrations apply on startup. Check `/api/health` and open a known record.

Do a trial restore into a throwaway instance before you need it (`doc/DEVELOPING.md`,
`feature-map/instance-operations.md`: "A successful backup write does not prove restoration works").

## Caveats

- Restoring an older database can roll back the stale-provider-Stop high-water mark; the disaster-recovery
  note in `doc/DATABASE.md` says not to assume stale provider Stop events are safe to reuse.
- `projects/`, `workspaces/` and git checkouts are not backed up. Recover them from their git remotes.
- Dump and snapshot file names carry UTC timestamps assuming the host clock is UTC.

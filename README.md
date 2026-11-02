# paperclip-r2-backups

Offsite backups of a self-hosted [Paperclip](https://github.com/paperclipai/paperclip) instance to Cloudflare R2, and a small web console to browse and manage the bucket.

- **`backup/`**: a Python script (stdlib plus `rclone`), run once a day by a systemd user timer.
  - Each run uploads the newest complete native Paperclip database dump and a snapshot of the instance's non-secret files.
  - It then applies grandfather-father-son retention: 30 daily, 12 weekly and 12 monthly for database dumps, and 7 daily, 4 weekly and 3 monthly for instance snapshots.
  - Safety rails: nothing is deleted after a failed upload or when the backups are stale, the newest 3 are always kept, deletions per run are capped, a prefix guard limits which keys can be touched, and `--dry-run` shows the plan. Cap and spend guards are also built in.
- **`worker/`**: a Cloudflare Worker built on [R2-Explorer](https://github.com/G4brym/R2-Explorer).
  - It runs behind Cloudflare Access and checks the Access JWT itself, including `aud`.
  - It has CSRF checks, disables share links, and only allows writes under the backup prefixes.
- **`docs/restore.md`**: how to restore from these backups.

Backups are stored as plain `.sql.gz` / `.tar.gz` objects. R2 encrypts them at rest, and access is limited to the bucket-scoped token and the Access-protected console. The instance master key is **not** included by default (`INCLUDE_SECRETS=false`). A restore needs both the dump and the master key, so keep the key in a password manager.

Recommended bucket settings:
- keep the bucket private (r2.dev disabled);
- add an R2 bucket lock on `db/` that is a little shorter than the daily window, for example 28 days, so recent dumps cannot be deleted even with valid credentials.

## Install (backup)
```sh
bash backup/install.sh          # installs script + user units, enables (not starts) the timer
$EDITOR ~/.config/paperclip-r2-backup/env   # from backup/env.example
python3 ~/.local/share/paperclip-r2-backup/paperclip_r2_backup.py --dry-run   # with the env loaded
systemctl --user start paperclip-r2-backup.timer
```

## Deploy (console)
See `worker/README.md`.

## Tests
```sh
cd backup && python3 -m unittest -v
```

## License
MIT

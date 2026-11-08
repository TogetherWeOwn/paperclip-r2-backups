# Offsite-backup host-exception registry

## offsite-backup — implementation scope updated 2026-11-08

This is the repository-owned entry for the existing offsite-backup host exception,
not permission to install, broaden host access, add a scheduler or change production.
Any installation-wide registry remains Operator-owned; reconcile that inventory with
this entry during installation. No live registry or host installation is changed by
merging this source.

| Field | Scope |
| --- | --- |
| Purpose | Recover Paperclip instance files and both Paperclip and Hindsight databases from private R2 storage; verify database recoverability independently |
| Source | `backup/paperclip_r2_backup.py`, `backup/database_snapshots.py` and `backup/systemd/paperclip-r2-backup.{timer,service}` |
| Clock | Existing daily user timer, 04:20 UTC plus its existing randomized delay; weekly drill inside that same invocation on Sunday UTC (`RESTORE_WEEKDAY=6`); no new host timer, cron, daemon or keep-alive |
| Owner | Operator installs, observes first live receipts, reconciles the installation-wide registry and performs rollback; DevOps maintains reviewed source |
| Reads | Existing native Paperclip SQL dumps and instance files; existing libpq service/pass files; read-only exported snapshots from Paperclip and existing `hindsight-db` container |
| Writes | Private temporary bundles, bounded throwaway restore containers, local receipts, private R2 managed prefixes only |
| R2 deletion boundary | `db/`, `instance/`, `paperclip/`, `hindsight/`; exact bundle names only in the new database prefixes; `status/` is never deleted |
| Retention | Existing database GFS 30 daily / 12 weekly / 12 monthly independently for native and supplemental databases; original instance windows unchanged; newest three and aggregate four-delete budget retained |
| Capacity | Existing aggregate bucket cap, including new prefixes and status objects; no cap increase or new paid service; fail rather than authorize spend |
| Isolation | `--network=none`, no published ports, no bind mount or socket in target, digest-pinned pre-pulled image, unprivileged container user, read-only root, bounded memory/data tmpfs/CPU/PIDs, no swap |
| Lifetime | Each database operation bounded to one hour; unit total bounded to six hours; SIGTERM cleanup allowance two minutes; sequential targets are deleted before the next target starts |
| Authentication | Existing source local socket or libpq service/pass file; bucket-scoped rclone environment; no password/URL in argv or logs; no new credential |
| Evidence | `status/last-run.json`, `status/restore-last.json`, timestamped local restore receipts, exact-head Actions run and fixture artifact |
| Rollback | Restore prior installed script/unit and environment from protected Operator rollback copy; stop the new invocation first; remove only its labeled leftover targets; never delete backup objects as rollback |
| Review | Review this entry whenever source container, source major/extensions, service units, image digest, schedule, capacity or authentication changes |

The permitted throwaway target uses trust authentication **only inside its isolated
network namespace/local Unix socket**, without a network route or published port;
it does not modify source authentication. The private bucket, R2 at-rest encryption,
Access JWT/CSRF checks, console write allowlist and master-key exclusion are unchanged.
New database prefixes can be read in the console; this change does not widen its
write allowlist. Bucket locks for the new prefixes require a separately reviewed
Operator action; this PR does not claim they already exist.

## Zero-idle-cost staging and preview

The restore fixtures are on-demand containers, not a standing staging service.
There are no Durable Objects, alarms, keep-alive loops, scheduled Workers, Stream
inputs or databases with idle compute introduced here. GitHub Actions owns fixture
startup, readiness and cleanup for the tested head. Its `always()` cleanup plus the
ephemeral hosted runner bound failure/cancellation lifetime. Receipts are test data,
not live restore receipts. Existing R2 storage is intentionally persistent and uses
the existing approved backup storage budget. Production and the console deployment
are not automatically changed by this repository's CI workflow.

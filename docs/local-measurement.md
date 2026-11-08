# Local capture measurement boundary (source only)

**Operational status: NO-GO.** This source adds a separate CLI boundary and a
fixture-tested post-admission lifecycle. It does **not** establish an approved
production supervision envelope. `native_envelope()` unconditionally refuses
admission. There is no environment flag, JSON attestation, command-line override,
or production adapter that enables capture. Do not patch out this check to size a
live database. Source merge and synthetic Actions results authorize no host work.

## Why a separate mode

Ordinary backup may capture, upload, traverse instance files, retain/delete remote
objects, publish status and dispatch a recurring restore drill. Dry-run does not
capture. Neither is a supported local measurement boundary; a zero deletion budget
is not one either. Recovery snippets are not measurement entrypoints.

The CLI shape is `paperclip_r2_backup.py --measure-local --source SOURCE
--scratch-parent PATH --receipt-dir PATH --lock-dir PATH`. This describes the
interface, **not instructions to create paths or execute it on a host**. Exactly
one source (`paperclip` or `hindsight`) and one of each argument is accepted.
Dry-run, restore-drill, extra/repeated arguments and other modes are rejected.
Dispatch happens before the legacy configuration loader, Rclone construction and
ordinary/weekly run paths. No remote capabilities are imported by the measurement
module; errors cannot fall back to ordinary backup.

Only the selected source's database/service/schema-head settings, explicit
`PGSERVICEFILE` / `PGPASSFILE` references and the configured `BACKUP_TMP_DIR`
operation-lock location are used. The references must already exist as private,
owned regular files. No env file is sourced, instance archive inspected, other
source configured, restore image required, password read by Python, or R2
credential required. Docker is intentionally unsupported: killing a `docker exec`
client does not establish termination of daemon-owned work. Existing libpq auth
and privileges still need independent operational qualification; the source does
not create a role/grant, pass file or service file or weaken authentication.

## Native one-shot supervision contract

Reuse an **existing approved native one-shot service**, not a watchdog, scheduler
or installer. systemd documents useful service/cgroup primitives, but their
presence is not proof of an installed, approved, complete envelope:

| Required control | Native primitive/reference | Supported versus unproved here |
| --- | --- | --- |
| Whole operation deadline, including counts, dump, hashing, tar, receipt and cleanup | [`RuntimeMaxSec`, `TimeoutStartSec`, `TimeoutStopSec`, `KillMode`, `SendSIGKILL`](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) and [`systemd.kill`](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html) | Native documentation exists. A true `Type=oneshot` start needs `TimeoutStartSec`; `RuntimeMaxSec` alone does not bound oneshot activation. No unit or current window is qualified here. TERM must begin before the hard stop, leaving measured cleanup reserve and bounded KILL grace. |
| Memory and CPU | [`MemoryMax`, `MemorySwapMax`, `CPUQuota`](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) | Useful client cgroup controls, not proof that PostgreSQL backend work is included. No database/container limits may be changed under this source work. |
| Aggregate scratch bytes/inodes, not one file | Existing filesystem/project quota or an approved size/inode-bounded mount; [`TemporaryFileSystem`](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) describes native private mount support | No aggregate filesystem-enforced reservation/quota or mount is established. A memory-backed mount also consumes memory and needs a complete memory envelope. `LimitFSIZE`/RLIMIT_FSIZE and free-space checks are not aggregate controls. |
| Hard device I/O bounds | [`IOReadBandwidthMax`, `IOWriteBandwidthMax`, `IOReadIOPSMax`, `IOWriteIOPSMax`](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html) | Must cover the actual underlying devices and PostgreSQL backend scans as well as clients. `nice`, idle I/O priority, client-only cgroups and nominal overlay paths do not suffice. No such backend/device binding is established. |
| Client/backend termination and residual reclamation after SIGKILL/host loss | Native service cgroup kill plus an existing bounded-lifetime scratch mount/approved residual cleanup procedure | Python process-group cleanup is not backend termination. An exported snapshot connection closing is not proof all associated backend work stopped. Private mount teardown, host-loss behavior and authorized residual cleanup are unproved. Do not introduce a new host cleanup service. |

An eventual native verifier must bind all evidence to the exact executing source
hashes/reviewed revision, selected database identity, unit/cgroup/device/mount,
fresh run scratch, numeric limits, approved admission identity and current window.
It must verify observations, not trust caller-supplied booleans or unsigned JSON.
Until a reviewed supported verifier and operational evidence exist, execution is
closed. This is an explicit missing prerequisite, not a claim that systemd
properties alone implement the complete contract.

### Admission and exclusion

Later authorized admission must prove **no active service or manual legacy
writer at entry**, no manual invocation during the window, and an unchanged next
legacy trigger strictly beyond the hard deadline **plus cleanup reserve**. The
installed old process has not been proved to use the revised lock. Do not stop,
disable, edit or delay its schedule to manufacture a window. Preserve existing
freshness and coverage. Each subsequent source needs a new valid window and
admission; invocations are sequential, not concurrent.

Host/backend authentication, exact-count and dump privileges, termination scope,
backend/device hard I/O, scratch reservation/reclamation and legacy exclusion
remain operational prerequisites. Historical sizes/headroom are not a current
reservation. No host inspection or preparation is performed by this source work.
No installation, rollback copy, live sizing/capture/restore, image pull, remote
object deletion or policy change is authorized. Existing secret inclusion and
retention settings are untouched. Staging/preview, if ever introduced separately,
must run on demand/scale to zero with no recurring always-on runtime charge;
this source creates no staging runtime and changes no production runtime.

## Post-admission lifecycle and failure semantics

Fixture tests enter below the closed admission boundary using synthetic clients;
this is not an executable host envelope. The lifecycle reuses `capture()` and the
same bounded tar parser/hash validation used by restore. Verification streams the
tar without extracting another plaintext dump. No restore container is created.

The revised backup, drill and measurement paths share a nonblocking `flock` at
`BACKUP_TMP_DIR/operation.lock`. Measurement creates a fresh private run directory
only after locking and writes/fsyncs a cleanup-pending latch **before** capture.
The lock directory entry is fsynced before capture. Plaintext unlink and run-directory
removal are directory-fsynced, including the scratch parent, before the latch is
cleared. Unsupported/failed directory fsync fails closed, including across separate
lock/scratch filesystems; no filesystem-independent host-loss guarantee is implied.
Client spawning and ownership registration defer TERM/INT handlers until the child
is registered, without passing a blocked signal mask to children. An uncertain
spawn prevents reconciliation even if no process handle was returned.
The process owns its snapshot session and client process groups. SIGTERM/SIGINT
unwind the snapshot, terminate/reap clients and remove only verified run-owned
regular files and that exact run directory. Cleanup is not recursive and never
removes the parent scratch/cache, receipt directory or lock file. No arbitrary
exception text, client stderr, table counts or schema-head values enter the
receipt/log. The dump, tar, manifest and receipt are all sensitive plaintext.

A failed cleanup or surviving client group is a failure, retains the latch and
requires authorized residual reconciliation. Revised writers refuse a nonempty
latch. OS lock release, process exit, a partial receipt, or another invocation do
not clear it. SIGKILL/host loss cannot run Python `finally`; only a proved native
reclamation contract and later authorized reconciliation can deal with that case.
Do not erase/recreate the lock to get past the latch. Recovery snippets and the
old installed writer are not retroactively made latch-aware by this source.

### Legacy operation-lock upgrade prerequisite

All revised backup, drill and measurement writers require
`BACKUP_TMP_DIR/operation.lock` to be a nonsymlink regular file, owned by the
executing effective user, with exactly one hard link and no group/other permission
bits (private mode `0600` is the intended read/write mode). The previous append-open
lock implementation did not validate these properties. An existing legacy lock
may therefore be rejected after upgrade; for example, mode `0640`, including one
inherited from a permissive directory default ACL, fails the private-file check.
The `0600` creation argument applies only to a new file; it does not repair an
existing file. This is a conditional compatibility prerequisite, not evidence of
any deployed lock's permissions or ACLs.

The error `operation lock must be a private owned regular file` is a file-property
failure **before** latch inspection. It does not establish whether residual
plaintext or a cleanup-pending marker exists. A later, separately authorized
Operator-owned reconciliation for an otherwise owned regular single-link legacy
lock may restrict its permissions to `0600` only after safe file identity and writer
exclusion have been established. It must preserve the same inode and every byte,
including any cleanup-pending marker. Do not automatically chmod, truncate, unlink,
replace or recreate the lock, change its ownership, or weaken the rejection. An
unexpected owner, symlink, file type or link count requires separate investigation,
not a permissions-only repair.

Permissions reconciliation does **not** reconcile residual cleanup. Once the file
passes validation and the lock is acquired, any nonempty content still produces
`operation lock requires authorized residual cleanup reconciliation`; only the
separately authorized client/plaintext cleanup reconciliation described above can
clear that latch. A permissions fix alone proves neither cleanup nor readiness
for another source. This document supplies no command or authorization to inspect
or change a host lock. All host preparation, installation and live-operation NO-GO
restrictions remain unchanged, and source merge does not authorize reconciliation.

## Local receipt and scratch accounting

Receipts are exclusive-create, mode 0600 under an existing private receipt
directory disjoint from scratch/lock directories. They are never uploaded or
published to remote status and are explicitly `LOCAL_MEASUREMENT_NOT_OFFSITE_OR_RESTORE`.
Successful admitted lifecycle fixtures record source-set SHA-256 revision/individual
file hashes, selected source identity, source-acquisition interval, dump/tar bytes
and hashes, duration, supplied native evidence/limits and cleanup result. Release
handoff must map the executing hashes to its reviewed commit; an environment SHA
is not accepted as identity. Receipts never assert next-source readiness or
backend exit.

Dump plus uncompressed outer tar duplicates the dump bytes. Budget both, manifest,
filesystem blocks/inodes/directory metadata, hashing/tar overhead, receipt space
and cleanup reserve on every relevant filesystem. Hashing and streaming tar
verification do not create an additional dump. Completion-time logical/allocated
bytes are an **observed lower bound**, not an exact peak. The admitted native
aggregate quota is the hard upper bound; `exact_peak_bytes` remains null absent an
authoritative high-water measurement. Error/ENOSPC partial files are cleaned;
no final sample is claimed to account for an unseen error peak. A quota is not a
reservation or available-capacity proof. Native admission must reserve sufficient
headroom including metadata/receipt/cleanup and establish exclusion independently.

With admission unproved, a valid invocation records `not_admitted`, no applied
limits, the exact missing controls and `not_needed_no_capture_started`. It neither
creates a run scratch directory nor opens a database or operation lock. Invalid
configuration/path or receipt-write failure returns failure without falling back
to remote status. Lack of a saved receipt is not success. Full suites and existing
synthetic restores run only on GitHub Actions for the exact PR head; they qualify
source behavior, never live supervision, sizing or offsite recoverability.

REA angle: reuse the shipped capture/format/lock mechanisms and documented native
service/resource controls; do not invent a second backup engine or host scheduler.

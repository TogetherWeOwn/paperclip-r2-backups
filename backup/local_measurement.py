"""Local capture lifecycle, deliberately closed pending native admission support.

No remote, instance archive, restore, Docker or scheduler capabilities are imported.
There is intentionally no CLI/environment switch around native_envelope().
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import time
import uuid

import database_snapshots as snapshots
from operation_lock import LockError, operation_lock


class MeasurementError(Exception):
    pass


class AdmissionError(MeasurementError):
    pass


PREREQUISITES = (
    "approved exact-revision/source/window admission and legacy-writer exclusion",
    "native end-to-end deadline, TERM/KILL grace and cleanup reserve",
    "native memory/CPU bounds covering clients and participating backend work",
    "filesystem-enforced aggregate run scratch quota including metadata/reserve",
    "device-scoped hard I/O coverage for clients AND PostgreSQL backends",
    "verified client/backend termination, hard-kill reclamation and residual cleanup",
)


@dataclasses.dataclass(frozen=True)
class Envelope:
    # Internal handoff type, not user-supplied evidence or a native verifier.
    deadline: float
    grace_seconds: int
    scratch_bytes: int
    cleanup_reserve_bytes: int
    evidence: dict

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise MeasurementError("measurement deadline expired")
        return remaining


def native_envelope(args, source):
    # systemd client limits alone cannot establish the backend/quota/reclamation
    # contract. Do not turn booleans, an env file or a purported receipt into proof.
    raise AdmissionError("native supervision unproved: " + "; ".join(PREREQUISITES))


def private_directory(value):
    path = Path(value)
    if not path.is_absolute() or str(path.resolve()) != str(path):
        raise MeasurementError("directories must be absolute and contain no symlink components")
    info = path.stat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or
            stat.S_IMODE(info.st_mode) & 0o077):
        raise MeasurementError("directories must already exist, private and owned")
    return path


def load_source(name, env):
    if name not in ("paperclip", "hindsight"):
        raise MeasurementError("select exactly one allowlisted source")
    tag = name.upper()
    service = env.get(tag + "_PG_SERVICE", "")
    # No default Docker socket or implicit HOME-based authentication discovery.
    if not service or env.get(tag + "_DB_CONTAINER"):
        raise MeasurementError("measurement requires an existing approved libpq service, not Docker")
    for key in ("PGSERVICEFILE", "PGPASSFILE"):
        path = Path(env.get(key, ""))
        if not path.is_absolute() or str(path.resolve()) != str(path):
            raise MeasurementError("existing explicit private libpq auth references required")
        info = path.stat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or
                info.st_nlink != 1 or stat.S_IMODE(info.st_mode) & 0o077):
            raise MeasurementError("libpq references must be private owned regular files")
    table, columns = (("drizzle.__drizzle_migrations", "hash,created_at")
                      if name == "paperclip" else ("public.alembic_version", "version_num"))
    source = snapshots.Source(name, env.get(tag + "_DB_NAME", name),
                              env.get(tag + "_HEAD_TABLE", table),
                              tuple(env.get(tag + "_HEAD_COLUMNS", columns).split(",")),
                              "", service=service)
    snapshots.validate_source(source, require_restore_image=False)
    return source


def revision():
    # Exact executing source identity, without trusting an environment-supplied SHA
    # or invoking git. Release/CI maps these hashes to the reviewed commit.
    files = ("local_measurement.py", "database_snapshots.py", "operation_lock.py",
             "paperclip_r2_backup.py")
    hashes = {name: snapshots.sha256(Path(__file__).with_name(name)) for name in files}
    digest = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    return {"algorithm": "sha256-source-set-v1", "digest": digest, "files": hashes}


class CaptureClient:
    """Own libpq client process groups; never claim this proves backend exit."""
    def __init__(self, envelope):
        self.envelope = envelope
        self.processes = []

    def popen(self, args, **kwargs):
        self.envelope.remaining()
        if args[0] not in ("psql", "pg_dump"):
            raise MeasurementError("only libpq capture clients permitted")
        # An explicit auth reference is validated before admission. No HOME or
        # inherited provider/R2 credentials, PGPASSWORD, URI or search-path options.
        kwargs["env"] = {k: v for k, v in snapshots.child_env().items()
                         if k not in ("HOME", "PGSYSCONFDIR")}
        kwargs["env"]["PGSERVICE"] = self.source.service
        proc = subprocess.Popen(args, start_new_session=True, **kwargs)
        self.processes.append(proc)
        return proc

    def stop(self, proc):
        # Kill the group even if its leader already exited; a descendant may remain.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait(timeout=self.envelope.grace_seconds)
        try:
            os.killpg(proc.pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise MeasurementError("client process group still exists")
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                stream.close()
        self.processes.remove(proc)

    def close(self):
        failures = []
        for proc in tuple(self.processes):
            try:
                self.stop(proc)
            except Exception:
                failures.append(proc)
        if failures:
            raise MeasurementError("client termination reconciliation failed")

    def execute(self, args, *, data=None, output=None, env=None):
        proc = self.popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL,
                          stdout=output if output is not None else subprocess.PIPE,
                          stderr=subprocess.DEVNULL)
        try:
            stdout, _ = proc.communicate(data, timeout=self.envelope.remaining())
            if proc.returncode:
                raise MeasurementError("capture client failed")
            return stdout
        except subprocess.TimeoutExpired:
            raise MeasurementError("capture client timed out") from None
        finally:
            self.stop(proc)

    def sql(self, source, text):
        return self.execute(snapshots.command(source, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"),
                            data=text.encode()).decode()


@contextlib.contextmanager
def cancellation():
    def interrupted(signum, frame):
        raise MeasurementError("measurement cancelled")

    previous = {sig: signal.signal(sig, interrupted) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def scratch_usage(root):
    # Bounds, not a sampled value masquerading as an exact filesystem high-water.
    entries = [root, *root.iterdir()]
    if any(not p.is_file() or p.is_symlink() for p in entries[1:]):
        raise MeasurementError("unexpected run scratch entry")
    return {"logical_bytes": sum(p.stat().st_size for p in entries[1:]),
            "allocated_bytes": sum(p.stat().st_blocks * 512 for p in entries)}


def remove_owned_scratch(root, identity):
    info = root.lstat()
    if ((info.st_dev, info.st_ino) != identity or not stat.S_ISDIR(info.st_mode) or
            info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise MeasurementError("scratch ownership changed; authorized cleanup required")
    entries = list(root.iterdir())
    # No recursive traversal, symlink following, shared cache or lock deletion.
    if any(not stat.S_ISREG(p.lstat().st_mode) or p.lstat().st_nlink != 1 for p in entries):
        raise MeasurementError("unexpected scratch entries; authorized cleanup required")
    for path in entries:
        path.unlink()
    root.rmdir()
    if root.exists():
        raise MeasurementError("plaintext cleanup not verified")


def measure(source, args, envelope, receipt):
    """Post-admission lifecycle. Tests inject synthetic clients, never live DBs."""
    root = None
    client = CaptureClient(envelope)
    client.source = source
    with operation_lock(Path(args.lock_dir) / "operation.lock") as lease:
        envelope.remaining()
        lease.mark_cleanup_pending()
        try:
            root = Path(tempfile.mkdtemp(prefix="local-measurement-", dir=args.scratch_parent))
            info = root.stat()
            identity = info.st_dev, info.st_ino
            receipt["scratch_run"] = root.name
            with cancellation():
                path, key = snapshots.capture(source, snapshots.utc_now(), root, client=client)
                envelope.remaining()
                _, manifest = snapshots.unpack(path, root, source, verify_only=True)
                dump = root / (source.name + ".dump")
                receipt["snapshot_acquisition"] = manifest["snapshot_acquisition"]
                receipt["dump"] = {"bytes": dump.stat().st_size, "sha256": snapshots.sha256(dump)}
                receipt["tar"] = {"bytes": os.path.getsize(path), "sha256": snapshots.sha256(path)}
                snapshots.validate_timing(manifest, key)
                if receipt["dump"]["sha256"] != manifest["dump_sha256"]:
                    raise MeasurementError("local dump/hash mismatch")
                usage = scratch_usage(root)
                receipt["scratch"] = {**receipt["scratch"], **usage}
                if usage["allocated_bytes"] + envelope.cleanup_reserve_bytes > envelope.scratch_bytes:
                    raise MeasurementError("scratch cleanup reserve exhausted")
                envelope.remaining()
                receipt["outcome"] = "captured_local_only"
        finally:
            # Further TERM/INT must not interrupt cleanup; the native hard deadline
            # still applies. SIGKILL/host loss leaves the durable lock latch intact.
            with contextlib.ExitStack() as stack:
                for sig in (signal.SIGTERM, signal.SIGINT):
                    previous = signal.signal(sig, signal.SIG_IGN)
                    stack.callback(signal.signal, sig, previous)
                try:
                    client.close()
                    if root is not None:
                        remove_owned_scratch(root, identity)
                    lease.reconcile()
                    receipt["cleanup"] = "verified_run_plaintext_removed_and_clients_reaped"
                    # Backend exit and admission for another source are NOT inferred.
                except Exception:
                    receipt["cleanup"] = "failed_requires_authorized_reconciliation"
                    receipt["outcome"] = "failed"
                    raise MeasurementError("cleanup failed; operation latch retained") from None


def write_receipt(directory, receipt):
    path = directory / ("local-measurement-" + uuid.uuid4().hex + ".json")
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        json.dump(receipt, stream, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # Bad argv may contain sensitive strings. Never echo it or argparse's value.
        raise MeasurementError("invalid local-measurement arguments")


def main(argv=None):
    started = time.monotonic()
    receipt = None
    try:
        parser = Parser(add_help=False, allow_abbrev=False)
        parser.add_argument("--measure-local", action="count", required=True)
        for flag in ("source", "scratch-parent", "receipt-dir", "lock-dir"):
            parser.add_argument("--" + flag, required=True, action="append")
        args = parser.parse_args(argv)
        if args.measure_local != 1:
            raise MeasurementError("select exactly one measurement mode")
        for field in ("source", "scratch_parent", "receipt_dir", "lock_dir"):
            values = getattr(args, field)
            if len(values) != 1:
                raise MeasurementError("select exactly one value for each measurement argument")
            setattr(args, field, values[0])
        os.umask(0o077)
        args.scratch_parent = private_directory(args.scratch_parent)
        args.receipt_dir = private_directory(args.receipt_dir)
        args.lock_dir = private_directory(args.lock_dir)
        expected_lock = Path(os.path.expanduser(os.environ.get("BACKUP_TMP_DIR") or
                             "~/.cache/paperclip-r2-backup"))
        if args.lock_dir != expected_lock:
            raise MeasurementError("measurement must use the configured backup operation lock")
        directories = (args.scratch_parent, args.receipt_dir, args.lock_dir)
        if any(a == b or a in b.parents or b in a.parents
               for i, a in enumerate(directories) for b in directories[i + 1:]):
            raise MeasurementError("scratch, receipts and lock directories must be disjoint")
        source = load_source(args.source, os.environ)
        receipt = {"version": 1, "kind": "LOCAL_MEASUREMENT_NOT_OFFSITE_OR_RESTORE",
                   "source_revision": revision(), "source": dataclasses.asdict(source),
                   "started_at": snapshots.timestamp(snapshots.utc_now()),
                   "outcome": "not_admitted", "cleanup": "not_needed_no_capture_started",
                   "next_source_ready": False, "applied_limits": None,
                   "snapshot_acquisition": None, "dump": None, "tar": None,
                   "scratch": {"exact_peak_bytes": None, "quota_upper_bound_bytes": None}}
        envelope = native_envelope(args, source)
        receipt["applied_limits"] = envelope.evidence
        receipt["scratch"]["quota_upper_bound_bytes"] = envelope.scratch_bytes
        receipt["outcome"] = "failed"
        measure(source, args, envelope, receipt)
        return 0
    except AdmissionError:
        if receipt is not None:
            receipt["unproved_controls"] = list(PREREQUISITES)
        print("local measurement NO-GO: native supervision/admission unproved; see docs/local-measurement.md")
        return 1
    except (Exception, KeyboardInterrupt):
        if receipt is not None:
            receipt["outcome"] = "failed"
        print("local measurement failed; no offsite/restore evidence or next-source admission")
        return 1
    finally:
        if receipt is not None:
            receipt["duration_seconds"] = time.monotonic() - started
            receipt["ended_at"] = snapshots.timestamp(snapshots.utc_now())
            try:
                write_receipt(args.receipt_dir, receipt)
            except Exception:
                print("local measurement failed: private receipt could not be saved")
                return 1

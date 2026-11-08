#!/usr/bin/env python3
"""Offsite backup of a Paperclip instance to Cloudflare R2 via rclone.

Python 3 standard library only. Configuration is read entirely from the
environment (see backup/env.example). The R2 remote is defined through rclone
environment config (RCLONE_CONFIG_R2_*); those values are never logged.

Exit codes: 0 ok, 1 error, 2 cap reached (nothing uploaded).
"""
from __future__ import annotations

import datetime as dt
import gzip
import signal
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass, field

import database_snapshots as snapshots
from operation_lock import LockError, operation_lock

REMOTE = "R2"
DB_PREFIX = "db/"
INSTANCE_PREFIX = "instance/"
STATUS_PREFIX = "status/"
STATUS_KEY = "status/last-run.json"
# Only these prefixes may ever be deleted from. Everything else in the bucket
# (for example legacy data/ and ops/) is off limits.
DELETABLE_PREFIXES = (DB_PREFIX, INSTANCE_PREFIX, *snapshots.PREFIXES)
MANAGED_PREFIXES = (*DELETABLE_PREFIXES, STATUS_PREFIX)

DB_NAME_RE = re.compile(r"^paperclip-\d{8}-\d{6}\.sql\.gz$")
TS_RE = re.compile(r"(\d{8})-(\d{6})")
DUMP_MIN_AGE_SECONDS = 600
STALE_NEWEST_SECONDS = 48 * 3600
MIN_KEEP_NEWEST = 3
# Clock sanity rails. Retention trusts timestamps from the host clock and from
# file names, so it refuses to act when they look wrong.
FUTURE_SKEW_SECONDS = 6 * 3600      # object dated later than now + this = bad clock
FRESH_DUMP_SECONDS = 26 * 3600      # Paperclip writes hourly; older = backups stopped
MAX_FORWARD_JUMP_SECONDS = 3 * 86400  # new dump vs previous newest remote object
DEFAULT_MAX_DELETES = 4             # steady state needs ~1 per prefix per day

INSTANCE_INCLUDE = ("config.json", "companies", "skills", "accounting-receipts")
SECRETS_DIR = "secrets"

EXIT_OK, EXIT_ERROR, EXIT_CAP = 0, 1, 2


class BackupError(Exception):
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------

def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _int(env: dict, name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        raise BackupError(f"{name} must be an integer")
    if value < 0:
        raise BackupError(f"{name} must be >= 0")
    return value


@dataclass
class Config:
    bucket: str
    backup_dir: str
    instance_dir: str
    cap_bytes: int = 10 * 1000**3
    retain_daily: int = 30
    retain_weekly: int = 12
    retain_monthly: int = 12
    instance_retain_daily: int = 7
    instance_retain_weekly: int = 4
    instance_retain_monthly: int = 3
    include_secrets: bool = False
    max_deletes: int = DEFAULT_MAX_DELETES
    tmp_dir: str = ""
    rclone_bin: str = "rclone"
    sources: tuple[snapshots.Source, ...] = ()
    receipt_dir: str = ""
    restore_weekday: int = 6  # Sunday UTC, inside the existing daily timer

    def retention_for(self, prefix: str) -> tuple[int, int, int]:
        if prefix == INSTANCE_PREFIX:
            return (self.instance_retain_daily, self.instance_retain_weekly,
                    self.instance_retain_monthly)
        return self.retain_daily, self.retain_weekly, self.retain_monthly


def load_config(env: dict | None = None) -> Config:
    env = dict(os.environ if env is None else env)
    bucket = env.get("BACKUP_BUCKET", "").strip()
    if not bucket:
        raise BackupError("BACKUP_BUCKET is required")
    home = os.path.expanduser("~")
    backup_dir = env.get("PAPERCLIP_BACKUP_DIR") or os.path.join(
        home, ".paperclip/instances/default/data/backups")
    instance_dir = env.get("PAPERCLIP_INSTANCE_DIR") or os.path.join(
        home, ".paperclip/instances/default")
    rd = _int(env, "RETAIN_DAILY", 30)
    rw = _int(env, "RETAIN_WEEKLY", 12)
    rm = _int(env, "RETAIN_MONTHLY", 12)
    weekday = _int(env, "RESTORE_WEEKDAY", 6)
    if weekday > 6:
        raise BackupError("RESTORE_WEEKDAY must be 0 (Monday) through 6 (Sunday)")
    return Config(
        bucket=bucket,
        backup_dir=os.path.expanduser(backup_dir),
        instance_dir=os.path.expanduser(instance_dir),
        cap_bytes=_int(env, "BACKUP_CAP_BYTES", 10 * 1000**3),
        retain_daily=rd, retain_weekly=rw, retain_monthly=rm,
        instance_retain_daily=_int(env, "INSTANCE_RETAIN_DAILY", 7),
        instance_retain_weekly=_int(env, "INSTANCE_RETAIN_WEEKLY", 4),
        instance_retain_monthly=_int(env, "INSTANCE_RETAIN_MONTHLY", 3),
        include_secrets=_bool(env.get("INCLUDE_SECRETS"), False),
        max_deletes=_int(env, "MAX_DELETES_PER_RUN", DEFAULT_MAX_DELETES),
        tmp_dir=os.path.expanduser(env.get("BACKUP_TMP_DIR") or
                                   os.path.join(home, ".cache/paperclip-r2-backup")),
        rclone_bin=env.get("RCLONE_BIN", "rclone"),
        sources=snapshots.load_sources(env) if _bool(env.get("SNAPSHOT_BACKUPS")) else (),
        restore_weekday=weekday,
        receipt_dir=os.path.expanduser(env.get("RESTORE_RECEIPT_DIR") or
                                      os.path.join(home, ".local/state/paperclip-r2-backup/receipts")),
    )


# --------------------------------------------------------------------------
# rclone wrapper (the only place that spawns rclone; tests replace it)
# --------------------------------------------------------------------------

@dataclass
class Obj:
    key: str
    size: int


def assert_managed(key: str, prefixes=MANAGED_PREFIXES) -> None:
    if (not key.startswith(prefixes) or ".." in key.split("/") or key.startswith("/")):
        raise BackupError("refusing key outside managed prefixes")


class Rclone:
    def __init__(self, bucket: str, binary: str = "rclone"):
        self.bucket = bucket
        self.binary = binary

    def _target(self, key: str) -> str:
        return f"{REMOTE}:{self.bucket}/{key}"

    def _run(self, args: list[str], stdin: bytes | None = None) -> str:
        try:
            proc = subprocess.run([self.binary, *args], input=stdin,
                                  capture_output=True, check=False, timeout=3600)
        except subprocess.TimeoutExpired:
            raise BackupError("rclone operation timed out") from None
        except OSError as exc:
            raise BackupError(f"cannot run rclone: {exc.strerror}")
        if proc.returncode != 0:
            # Backend errors can echo credentials or signed URLs. Never log stderr.
            raise BackupError(f"rclone {args[0]} failed (rc={proc.returncode})")
        return proc.stdout.decode("utf-8", "replace")

    def list(self, prefix: str) -> list[Obj]:
        assert_managed(prefix)
        try:
            out = self._run(["lsjson", "-R", "--files-only", "--no-mimetype",
                             "--no-modtime", self._target(prefix)])
        except BackupError as exc:
            if "rc=3)" in str(exc):  # rclone: directory not found == empty prefix
                return []
            raise
        items = json.loads(out or "[]")
        return [Obj(prefix + i["Path"], int(i["Size"])) for i in items]

    def upload(self, local: str, key: str) -> None:
        assert_managed(key)
        self._run(["copyto", local, self._target(key)])

    def verify(self, local: str, key: str) -> None:
        """Size match plus a one-way checksum comparison."""
        assert_managed(key)
        want = os.path.getsize(local)
        out = self._run(["lsjson", "--files-only", "--no-mimetype", "--no-modtime",
                         self._target(key)])
        items = json.loads(out or "[]")
        if len(items) != 1 or int(items[0]["Size"]) != want:
            raise BackupError("verify failed: remote size mismatch")
        src_dir, name = os.path.split(local)
        dst_dir = key.rsplit("/", 1)[0]
        self._run(["check", "--one-way", "--include", "/" + name,
                   src_dir, self._target(dst_dir)])

    def download(self, key: str, local: str, max_bytes: int) -> None:
        assert_managed(key, snapshots.PREFIXES)
        self._run(["copyto", "--max-transfer", str(max_bytes), "--cutoff-mode", "hard",
                   "--retries", "1", self._target(key), local])

    def delete(self, key: str) -> None:
        assert_managed(key, DELETABLE_PREFIXES)
        self._run(["deletefile", self._target(key)])

    def put_bytes(self, data: bytes, key: str) -> None:
        assert_managed(key)
        self._run(["rcat", self._target(key)], stdin=data)


# --------------------------------------------------------------------------
# pure logic
# --------------------------------------------------------------------------

def key_timestamp(key: str) -> dt.datetime | None:
    """UTC timestamp from the object's file name (YYYYMMDD-HHMMSS)."""
    m = TS_RE.search(key.rsplit("/", 1)[-1])
    if not m:
        return None
    try:
        return dt.datetime.strptime(m.group(1) + m.group(2), "%Y%m%d%H%M%S").replace(
            tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def _week_start(d: dt.date) -> dt.date:
    return d - dt.timedelta(days=d.weekday())  # Monday


def gfs_keep(items: list[tuple[str, dt.datetime]], now: dt.datetime,
             daily: int, weekly: int, monthly: int) -> set[str]:
    """Return keys to keep: newest per day / ISO week / month inside windows."""
    today = now.astimezone(dt.timezone.utc).date()
    day_min = today - dt.timedelta(days=daily - 1) if daily > 0 else None
    week_min = _week_start(today) - dt.timedelta(weeks=weekly - 1) if weekly > 0 else None
    month_idx = today.year * 12 + today.month - 1
    month_min = month_idx - (monthly - 1) if monthly > 0 else None

    best: dict[tuple, tuple[dt.datetime, str]] = {}

    def consider(bucket: tuple, ts: dt.datetime, key: str) -> None:
        cur = best.get(bucket)
        if cur is None or (ts, key) > cur:
            best[bucket] = (ts, key)

    for key, ts in items:
        d = ts.astimezone(dt.timezone.utc).date()
        if day_min is not None and day_min <= d <= today:
            consider(("d", d), ts, key)
        if week_min is not None and week_min <= _week_start(d) <= _week_start(today):
            iso = d.isocalendar()
            consider(("w", iso[0], iso[1]), ts, key)
        mi = d.year * 12 + d.month - 1
        if month_min is not None and month_min <= mi <= month_idx:
            consider(("m", d.year, d.month), ts, key)
    return {k for _, k in best.values()}


@dataclass
class RetentionPlan:
    delete: list[str] = field(default_factory=list)
    kept: int = 0
    skipped_reason: str = ""
    truncated: bool = False


def plan_retention(objs: list[Obj], now: dt.datetime, retention: tuple[int, int, int],
                   max_deletes: int, upload_ok: bool, prefix: str) -> RetentionPlan:
    """Decide deletions for one prefix, enforcing every safety rail."""
    if prefix not in DELETABLE_PREFIXES:
        raise BackupError("retention called for non-deletable prefix")
    if any(not o.key.startswith(prefix) for o in objs):
        raise BackupError("object outside prefix passed to retention")
    if prefix in snapshots.PREFIXES:
        # Legacy and malformed keys remain untouched, outside the timed GFS floor.
        items = [(o.key, ts) for o, ts in snapshots.timed_inventory(objs)]
    else:
        items = [(o.key, ts) for o in objs if (ts := key_timestamp(o.key)) is not None]
    plan = RetentionPlan(kept=len(items))
    if not upload_ok:
        plan.skipped_reason = "upload step did not succeed"
        return plan
    if not items:
        return plan
    items.sort(key=lambda it: (it[1], it[0]), reverse=True)
    if (items[0][1] - now).total_seconds() > FUTURE_SKEW_SECONDS:
        raise BackupError("retention aborted: object dated in the future "
                          "(host clock or file names look wrong)")
    if (now - items[0][1]).total_seconds() > STALE_NEWEST_SECONDS:
        plan.skipped_reason = "newest object older than 48h"
        return plan
    keep = gfs_keep(items, now, *retention)
    keep.update(k for k, _ in items[:MIN_KEEP_NEWEST])
    doomed = sorted((it for it in items if it[0] not in keep), key=lambda it: (it[1], it[0]))
    names = [k for k, _ in doomed]
    if len(names) > max_deletes:
        names = names[:max_deletes]
        plan.truncated = True
    plan.delete = names
    plan.kept = len(items) - len(names)
    return plan


def is_complete_dump(path: str, now_ts: float) -> bool:
    try:
        st = os.stat(path)
    except OSError:
        return False
    if now_ts - st.st_mtime < DUMP_MIN_AGE_SECONDS or st.st_size == 0:
        return False
    try:
        with gzip.open(path, "rb") as fh:  # full read == gzip -t
            while fh.read(1 << 20):
                pass
    except (OSError, EOFError):
        return False
    return True


def newest_complete_dump(backup_dir: str, now_ts: float) -> str | None:
    try:
        names = [n for n in os.listdir(backup_dir) if DB_NAME_RE.match(n)]
    except OSError:
        return None
    paths = [os.path.join(backup_dir, n) for n in names]
    paths.sort(key=lambda p: (os.stat(p).st_mtime, p), reverse=True)
    for p in paths:
        if is_complete_dump(p, now_ts):
            return p
        log(f"skip incomplete or corrupt dump: {os.path.basename(p)}")
    return None


def db_key_for(path: str) -> str:
    name = os.path.basename(path)
    ts = key_timestamp(name)
    if ts is None:
        raise BackupError("dump name has no timestamp")
    return f"{DB_PREFIX}{ts:%Y/%m/%d}/{name}"


def day_has_object(objs: list[Obj], day: dt.date) -> bool:
    for o in objs:
        ts = key_timestamp(o.key)
        if ts is not None and ts.date() == day:
            return True
    return False


def _copy_regular(tar: tarfile.TarFile, full: str, arcname: str, scratch_dir: str) -> None:
    """Add a regular file as a consistent member even if it changes while read.

    The bytes are copied to a scratch file first (up to the size seen on the open
    fd), and the tar header is written from what was actually copied. Errors
    before the header is written raise OSError and the caller skips the entry.
    """
    with open(full, "rb") as src, tempfile.TemporaryFile(dir=scratch_dir) as tmp:
        remaining = os.fstat(src.fileno()).st_size
        copied = 0
        while remaining > 0:
            chunk = src.read(min(1 << 20, remaining))
            if not chunk:  # file shrank while reading
                break
            tmp.write(chunk)
            copied += len(chunk)
            remaining -= len(chunk)
        info = tar.gettarinfo(arcname=arcname, fileobj=src)
        if info.isreg():
            info.size = copied
            tmp.seek(0)
            tar.addfile(info, tmp)  # any error from here on is fatal (header written)
        else:
            tar.addfile(info)


def validate_tar(path: str) -> None:
    """Read the whole archive; raise BackupError if it is not well formed."""
    try:
        with tarfile.open(path, "r:gz") as tar:
            for member in tar:
                if member.isreg():
                    fh = tar.extractfile(member)
                    while fh is not None and fh.read(1 << 20):
                        pass
    except (tarfile.TarError, OSError, EOFError) as exc:
        raise BackupError(f"instance snapshot failed validation: {type(exc).__name__}")


def build_instance_tar(cfg: Config, now: dt.datetime, dest_dir: str) -> str:
    name = f"paperclip-instance-{now:%Y%m%d-%H%M%S}.tar.gz"
    out = os.path.join(dest_dir, name)
    include = list(INSTANCE_INCLUDE) + ([SECRETS_DIR] if cfg.include_secrets else [])
    skipped = 0
    with tarfile.open(out, "w:gz") as tar:
        for entry in include:
            top = os.path.join(cfg.instance_dir, entry)
            if not os.path.lexists(top):
                continue
            stack = [entry]
            while stack:
                rel = stack.pop()
                full = os.path.join(cfg.instance_dir, rel)
                arc = os.path.join("instance", rel)
                try:
                    st = os.lstat(full)
                    if stat.S_ISREG(st.st_mode):
                        _copy_regular(tar, full, arc, dest_dir)
                    else:
                        tar.add(full, arcname=arc, recursive=False)
                        if stat.S_ISDIR(st.st_mode):
                            stack.extend(os.path.join(rel, c) for c in sorted(os.listdir(full)))
                except FileNotFoundError:
                    skipped += 1  # vanished mid-run
                except PermissionError:
                    skipped += 1
    if skipped:
        log(f"instance snapshot: skipped {skipped} unreadable entries")
    validate_tar(out)
    return out


# --------------------------------------------------------------------------
# orchestration
# --------------------------------------------------------------------------

def newest_ts(objs: list[Obj]) -> dt.datetime | None:
    stamps = [t for t in (key_timestamp(o.key) for o in objs) if t is not None]
    return max(stamps) if stamps else None


def compute_retention(cfg: Config, existing: dict, now: dt.datetime,
                      upload_ok: bool) -> dict:
    """Plan deletions for every deletable prefix within the per-run budget."""
    remaining = cfg.max_deletes
    plans = {}
    for prefix in DELETABLE_PREFIXES:
        plan = plan_retention(existing[prefix], now, cfg.retention_for(prefix),
                              remaining, upload_ok, prefix)
        remaining -= len(plan.delete)
        plans[prefix] = plan
    return plans


def apply_retention(plans: dict, rc, status: dict, dry_run: bool) -> None:
    for prefix, plan in plans.items():
        if plan.skipped_reason:
            log(f"retention {prefix}: skipped ({plan.skipped_reason})")
        if plan.truncated:
            log(f"retention {prefix}: capped at max deletes")
        for key in plan.delete:
            assert_managed(key, DELETABLE_PREFIXES)
            if dry_run:
                log(f"dry-run: would delete {key}")
            else:
                log(f"delete {key}")
                rc.delete(key)
            status["deleted"].append(key)
        status["kept"][prefix.rstrip("/")] = plan.kept


def check_dump_fresh(dump: str, dump_ts: dt.datetime, now: dt.datetime) -> None:
    """Fail loudly when Paperclip has stopped writing backups or clocks disagree."""
    if (dump_ts - now).total_seconds() > FUTURE_SKEW_SECONDS:
        raise BackupError("newest dump is dated in the future (host clock or file names wrong)")
    if (now - dump_ts).total_seconds() > FRESH_DUMP_SECONDS:
        raise BackupError("newest complete dump is older than 26h; "
                          "Paperclip backups appear to have stopped")
    if now.timestamp() - os.stat(dump).st_mtime > FRESH_DUMP_SECONDS:
        raise BackupError("newest complete dump file is older than 26h; "
                          "Paperclip backups appear to have stopped")


def check_offsite_freshness(cfg: Config, existing: dict, now: dt.datetime,
                            dry_run: bool) -> dict:
    newest_db = newest_ts(existing[DB_PREFIX])
    if newest_db is None or (now - newest_db).total_seconds() > FRESH_DUMP_SECONDS:
        raise BackupError("newest offsite database backup is older than 26h")
    freshness = {}
    if not dry_run:
        for source in cfg.sources:
            stamp = max((ts for _, ts in snapshots.timed_inventory(existing[source.prefix])), default=None)
            fresh = stamp is not None and 0 <= (now - stamp).total_seconds() < FRESH_DUMP_SECONDS
            freshness[source.name] = fresh
            if not fresh:
                raise BackupError(source.name + ": newest offsite dump is not fresh (<26h)")
    return freshness


def status_data(status: dict) -> bytes:
    return (json.dumps(status, indent=2, sort_keys=True) + "\n").encode()


def projected_with_status(status: dict, existing: dict, incoming: list[Obj],
                          plans: dict, projected: int) -> int:
    """Reserve positive replacement growth of the planned success receipt.

    Never credit status shrinkage to admit data. The actual receipt (including
    failure paths) is re-admitted from a fresh inventory before publication.
    """
    receipt = dict(status, ok=True, exit_code=EXIT_OK, error=None,
                   uploaded=[{"key": o.key, "size": o.size} for o in incoming],
                   deleted=[k for plan in plans.values() for k in plan.delete],
                   kept={p.rstrip("/"): plan.kept for p, plan in plans.items()})
    objects = [o for objs in existing.values() for o in objs]
    managed = sum(o.size for o in objects)
    total = projected
    while True:
        receipt["projected_bytes"] = total
        delta = max(0, snapshots.status_replacement_bytes(objects, STATUS_KEY,
                                                        status_data(receipt)) - managed)
        updated = projected + delta
        if updated == total:
            return total
        total = updated


def run(cfg: Config, rc, now: dt.datetime, dry_run: bool = False) -> int:
    now = now.astimezone(dt.timezone.utc)
    clock_start = snapshots.utc_now() if not dry_run else now
    start_tick = snapshots.time.monotonic()
    status = {
        "timestamp": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "ok": False, "error": None, "exit_code": EXIT_ERROR, "dry_run": dry_run,
        "uploaded": [], "deleted": [], "kept": {}, "managed_bytes": 0,
        "cap_bytes": cfg.cap_bytes,
    }
    tmp_root = None
    code = EXIT_ERROR
    try:
        existing = {p: rc.list(p) for p in MANAGED_PREFIXES}
        managed = sum(o.size for objs in existing.values() for o in objs)
        status["managed_bytes"] = managed
        today = now.date()

        # a) pick the database dump and make sure it is recent
        planned: list[tuple[str, str]] = []  # (local path, key)
        dump = newest_complete_dump(cfg.backup_dir, now.timestamp())
        if dump is None:
            raise BackupError("no complete database dump found")
        dump_key = db_key_for(dump)
        dump_ts = key_timestamp(dump_key)
        check_dump_fresh(dump, dump_ts, now)
        retention_block = ""
        prev_newest = newest_ts(existing[DB_PREFIX])
        if prev_newest is not None and \
                (dump_ts - prev_newest).total_seconds() > MAX_FORWARD_JUMP_SECONDS:
            retention_block = ("retention skipped: newest dump is more than 3 days "
                               "after the previous newest remote object (clock jump?)")
        native_verified = False
        native_present = any(o.key == dump_key for o in existing[DB_PREFIX])
        if native_present:
            # A prior upload may have succeeded before verification failed. Only
            # the exact local dump can substantiate this object's integrity.
            if dry_run:
                log(f"dry-run: would verify existing {dump_key}")
            else:
                log(f"verify existing {dump_key}")
                rc.verify(dump, dump_key)
                native_verified = True
        else:
            planned.append((dump, dump_key))

        # Snapshot-bound supplemental DB bundles. Native Paperclip SQL is unchanged.
        for source in cfg.sources:
            prior = max((ts for _, ts in snapshots.timed_inventory(existing[source.prefix])), default=None)
            if prior and (prior - now).total_seconds() > FUTURE_SKEW_SECONDS:
                raise BackupError(source.name + ": offsite snapshot dated in the future")
            if prior and (now - prior).total_seconds() > MAX_FORWARD_JUMP_SECONDS:
                retention_block = "retention skipped: snapshot clock jump or extended backup gap"
            # Presence is not evidence of successful verification: a previous
            # upload may have succeeded before its verify failed. Every invocation
            # captures and verifies fresh bundles, including same-day retries.
            if dry_run:
                # New dumps cannot be sized without reading the source. No DB access
                # in dry-run; the real run sizes all bundles before its cap decision.
                log(source.name + ": would capture snapshot (size unknown until capture)")
            else:
                if tmp_root is None:
                    tmp_root = tempfile.mkdtemp(prefix="build-", dir=_ensure_dir(cfg.tmp_dir))
                planned.append(snapshots.capture(source, now, tmp_root))

        # b) instance snapshot, once per UTC day
        want_instance = not day_has_object(existing[INSTANCE_PREFIX], today)
        if not want_instance:
            log(f"instance: snapshot for {today} already present")

        incoming_objs: list[Obj] = []
        if dry_run:
            for local, key in planned:
                log(f"dry-run: would upload {key} ({os.path.getsize(local)} bytes)")
                incoming_objs.append(Obj(key, os.path.getsize(local)))
            if want_instance:
                prior = sorted(existing[INSTANCE_PREFIX],
                               key=lambda o: (key_timestamp(o.key) or now, o.key))
                est = prior[-1].size if prior else 0
                log(f"dry-run: would upload instance snapshot (size estimated {est} bytes)")
                incoming_objs.append(Obj(
                    f"{INSTANCE_PREFIX}{now:%Y/%m/%d}/paperclip-instance-{now:%Y%m%d-%H%M%S}.tar.gz",
                    est))
        else:
            if want_instance:
                if tmp_root is None:
                    tmp_root = tempfile.mkdtemp(prefix="build-", dir=_ensure_dir(cfg.tmp_dir))
                tar_path = build_instance_tar(cfg, now, tmp_root)
                tar_key = f"{INSTANCE_PREFIX}{now:%Y/%m/%d}/{os.path.basename(tar_path)}"
                planned.append((tar_path, tar_key))
            incoming_objs = [Obj(k, os.path.getsize(p)) for p, k in planned]

        # Capture/upload may take hours. Freshness and retention use observation
        # time, not the invocation timestamp retained in the run receipt.
        invoked_at = now
        if not dry_run:
            now = snapshots.utc_now()
            if clock_start < invoked_at:
                raise BackupError("snapshot clock moved backward since invocation")
            snapshots.check_clock(clock_start, start_tick, now, snapshots.time.monotonic())

        # c) cap guard against the projected size: current + incoming - planned deletions
        incoming = sum(o.size for o in incoming_objs)
        projected_existing = {p: list(v) for p, v in existing.items()}
        for o in incoming_objs:
            projected_existing[o.key.split("/", 1)[0] + "/"].append(o)
        freed = 0
        plans = {}
        if not retention_block:
            try:
                plans = compute_retention(cfg, projected_existing, now, True)
                sizes = {o.key: o.size for v in projected_existing.values() for o in v}
                freed = sum(sizes[k] for pl in plans.values() for k in pl.delete)
            except BackupError as exc:
                retention_block = str(exc)
        projected = managed + incoming - freed
        # Dry-run reserves the real receipt too, without publishing it. New
        # instance/supplemental data sizes retain the documented estimates.
        receipt = dict(status, dry_run=False,
                       snapshot_freshness={source.name: True for source in cfg.sources})
        projected = projected_with_status(receipt, existing, incoming_objs, plans, projected)
        status["projected_bytes"] = projected
        if projected > cfg.cap_bytes:
            status["error"] = (f"cap reached: projected {projected} (managed {managed} + "
                               f"incoming {incoming} - freed {freed}, including status growth) > cap {cfg.cap_bytes}; "
                               "nothing uploaded")
            log(status["error"])
            code = EXIT_CAP
            # Cap-only pruning still needs a verified native backup. When this
            # dump is not offsite yet, admission cannot establish its integrity.
            if not retention_block:
                try:
                    # Rejected uploads cannot refresh any source, even in dry-run.
                    # Judge all enabled sources from actual existing inventory.
                    check_offsite_freshness(cfg, existing, now, dry_run=False)
                except BackupError as exc:
                    log(f"retention skipped: {exc}; cap recovery requires a fresh "
                        "offsite backup or reviewed manual cleanup; do not relax safety rails")
                else:
                    if native_verified or (dry_run and native_present):
                        try:
                            apply_retention(compute_retention(cfg, existing, now, True),
                                            rc, status, dry_run)
                        except BackupError as exc:
                            log(f"retention skipped: {exc}")
                    else:
                        log("retention skipped: selected native dump is not verified offsite")
            raise _Stop()

        if not dry_run:
            for local, key in planned:
                size = os.path.getsize(local)
                log(f"upload {key} ({size} bytes)")
                rc.upload(local, key)
                rc.verify(local, key)
                status["uploaded"].append({"key": key, "size": size})
                existing[key.split("/", 1)[0] + "/"].append(Obj(key, size))
        else:
            for o in incoming_objs:
                existing[o.key.split("/", 1)[0] + "/"].append(o)

        if not dry_run:
            observed = snapshots.utc_now()
            if observed < now:
                raise BackupError("snapshot clock moved backward during upload")
            snapshots.check_clock(clock_start, start_tick, observed, snapshots.time.monotonic())
            now = observed
        status["snapshot_freshness"] = check_offsite_freshness(cfg, existing, now, dry_run)

        # d) retention (only reached after every upload was verified)
        if retention_block:
            raise BackupError(retention_block)
        # Apply exactly the plan credited by capacity admission. The refreshed
        # freshness clock may cross a GFS boundary and change which bytes expire.
        apply_retention(plans, rc, status, dry_run)
        status["ok"] = True
        status["exit_code"] = code = EXIT_OK
    except _Stop:
        status["exit_code"] = code
    except Exception as exc:  # noqa: BLE001 - report everything via status/exit code
        status["error"] = status["error"] or str(exc)
        log(f"error: {status['error']}")
        code = EXIT_ERROR
        status["exit_code"] = code
    finally:
        if tmp_root:
            shutil.rmtree(tmp_root, ignore_errors=True)

    if not dry_run:
        try:
            data = status_data(status)
            # Re-list even on partial upload/delete or failed initial inventory.
            # The shared CLI lock excludes our other backup/drill writers. If the
            # exact replacement cannot be admitted, retain the previous object.
            objects = [o for prefix in MANAGED_PREFIXES for o in rc.list(prefix)]
            if snapshots.status_replacement_bytes(objects, STATUS_KEY, data) > cfg.cap_bytes:
                raise BackupError("status would exceed aggregate storage cap; previous status retained")
            rc.put_bytes(data, STATUS_KEY)
        except Exception as exc:  # noqa: BLE001
            log(f"error: could not write status: {exc}")
            if code == EXIT_OK:
                code = EXIT_ERROR
            status["ok"] = False
            status["exit_code"] = code
    log(f"done: ok={status['ok']} uploaded={len(status['uploaded'])} "
        f"deleted={len(status['deleted'])} managed_bytes={status['managed_bytes']}")
    return code


class _Stop(Exception):
    pass


def _ensure_dir(path: str) -> str:
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if "--measure-local" in argv:
        # Separate capability boundary: never load legacy config or construct Rclone.
        import local_measurement
        return local_measurement.main(argv)
    dry_run = "--dry-run" in argv
    if any(a not in ("--dry-run", "--restore-drill") for a in argv) or len(argv) > 1:
        print("usage: paperclip_r2_backup.py [--dry-run | --restore-drill]", file=sys.stderr)
        return EXIT_ERROR
    os.umask(0o077)

    def interrupted(signum, frame):
        raise snapshots.SnapshotError("operation interrupted")

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        cfg = load_config()
        rc = Rclone(cfg.bucket, cfg.rclone_bin)
        now = dt.datetime.now(dt.timezone.utc)
        if dry_run:
            return run(cfg, rc, now, True)
        # Shared lock protects retention/download and prevents overlapping source dumps.
        with operation_lock(os.path.join(_ensure_dir(cfg.tmp_dir), "operation.lock")):
            if "--restore-drill" in argv:
                return snapshots.drill(cfg, rc, now)
            code = run(cfg, rc, now)
            if code == EXIT_OK and cfg.sources and now.weekday() == cfg.restore_weekday:
                return snapshots.drill(cfg, rc, dt.datetime.now(dt.timezone.utc))
            return code
    except (BackupError, snapshots.SnapshotError, LockError) as exc:
        log(f"error: {exc}")
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())

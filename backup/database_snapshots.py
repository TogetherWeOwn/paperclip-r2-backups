"""Snapshot-bound pg_dump bundles and isolated offsite restore verification.

Standard library only. Source authentication stays in libpq files or the existing
container's local socket. Child stderr is deliberately never returned or logged.
"""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import selectors
import shutil
import subprocess
import tarfile
import tempfile
import time
import uuid
from dataclasses import dataclass

PREFIXES = ("paperclip/", "hindsight/")
TIMEOUT = 3600
MANIFEST_LIMIT = 4 * 1024**2
IDENT = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")
IMAGE = re.compile(r"^[a-zA-Z0-9./:_-]+@sha256:[0-9a-f]{64}$")
BUNDLE = re.compile(r"^(paperclip|hindsight)/\d{4}/\d{2}/\d{2}/\1-\d{8}-\d{6}(?:-snapshot)?\.tar$")
TIMED_BUNDLE = re.compile(r"^(paperclip|hindsight)/\d{4}/\d{2}/\d{2}/\1-\d{8}-\d{6}-snapshot\.tar$")
UTC_INSTANT = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$")
CLOCK = "host-utc-bracket-v1"


def utc_now():
    return dt.datetime.now(dt.timezone.utc)


def instant(value):
    if not isinstance(value, str) or not UTC_INSTANT.fullmatch(value):
        raise SnapshotError("invalid snapshot acquisition instant")
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        raise SnapshotError("invalid snapshot acquisition instant") from None


def timestamp(value):
    if value.tzinfo is None or value.utcoffset() != dt.timedelta(0):
        raise SnapshotError("snapshot clock must be UTC")
    return value.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def check_clock(start, start_tick, end, end_tick):
    timestamp(start)
    timestamp(end)
    elapsed = (end - start).total_seconds()
    # Detect backward clocks and observable wall/monotonic steps. This does not
    # prove UTC accuracy: the host must have a synchronized, stable clock.
    if elapsed < 0 or end_tick < start_tick or abs(elapsed - (end_tick - start_tick)) > 1:
        raise SnapshotError("snapshot clock moved backward or stepped")


def timing_key(source, lower):
    return f"{source}/{lower:%Y/%m/%d}/{source}-{lower:%Y%m%d-%H%M%S}-snapshot.tar"


def key_lower_bound(key):
    if not TIMED_BUNDLE.fullmatch(key):
        raise SnapshotError("legacy snapshot timing is uncertain")
    try:
        lower = dt.datetime.strptime(key.rsplit("/", 1)[1].split("-", 1)[1],
                                     "%Y%m%d-%H%M%S-snapshot.tar").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        raise SnapshotError("invalid snapshot key date") from None
    if timing_key(key.split("/", 1)[0], lower) != key:
        raise SnapshotError("snapshot key date mismatch")
    return lower


def timed_inventory(objects):
    # A malformed/legacy listed key is not evidence of timing and must not poison
    # unrelated uploads. Keep its bytes cap-accounted, but never select or prune it.
    result = []
    for obj in objects:
        try:
            lower = key_lower_bound(obj.key)
        except SnapshotError:
            continue
        result.append((obj, lower))
    return result


def validate_timing(manifest, key=None):
    if manifest.get("version") != 2:
        raise SnapshotError("legacy snapshot timing is uncertain; no pre-incident guarantee")
    timing = manifest.get("snapshot_acquisition")
    if not isinstance(timing, dict) or timing.get("clock") != CLOCK:
        raise SnapshotError("invalid snapshot acquisition interval")
    lower, upper = (instant(timing.get(k)) for k in ("not_before", "not_after"))
    if upper < lower or manifest.get("timestamp") != timestamp(lower):
        raise SnapshotError("invalid snapshot acquisition interval")
    if key is not None:
        key_lower_bound(key)
        if timing_key(manifest.get("database"), lower) != key:
            raise SnapshotError("snapshot key/manifest timing mismatch")
    return lower, upper


def require_preincident(manifest, key, cutoff):
    timestamp(cutoff)
    lower, upper = validate_timing(manifest, key)
    if upper >= cutoff:
        raise SnapshotError("snapshot is not provably before incident cutoff")
    return lower, upper


def require_fresh(manifest, key, now):
    lower, upper = validate_timing(manifest, key)
    if now < upper or not 0 <= (now - lower).total_seconds() < 26 * 3600:
        raise SnapshotError("offsite snapshot is not fresh (<26h) or clock moved backward")
    return lower, upper


class SnapshotError(Exception):
    pass


@dataclass(frozen=True)
class Source:
    name: str
    database: str
    head_table: str
    head_columns: tuple[str, ...]
    image: str
    container: str = ""
    service: str = ""

    @property
    def prefix(self):
        return self.name + "/"


def load_sources(env):
    sources = []
    for name, table, columns in (
        ("paperclip", "drizzle.__drizzle_migrations", "hash,created_at"),
        ("hindsight", "public.alembic_version", "version_num"),
    ):
        tag = name.upper()
        source = Source(
            name, env.get(tag + "_DB_NAME", name),
            env.get(tag + "_HEAD_TABLE", table),
            tuple(env.get(tag + "_HEAD_COLUMNS", columns).split(",")),
            env.get(tag + "_RESTORE_IMAGE", ""),
            env.get(tag + "_DB_CONTAINER", "hindsight-db" if name == "hindsight" else ""),
            env.get(tag + "_PG_SERVICE", ""),
        )
        validate_source(source)
        sources.append(source)
    return tuple(sources)


def validate_source(source):
    if source.name not in ("paperclip", "hindsight"):
        raise SnapshotError("unknown database source")
    parts = source.head_table.split(".")
    if (len(parts) != 2 or not source.head_columns or
            any(not IDENT.fullmatch(p) for p in (*parts, *source.head_columns))):
        raise SnapshotError("invalid schema-head identifiers")
    if not IMAGE.fullmatch(source.image):
        raise SnapshotError(source.name + ": restore image must be pinned by sha256")
    if bool(source.container) == bool(source.service):
        raise SnapshotError(source.name + ": configure exactly one container or libpq service")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*", source.container or source.service):
        raise SnapshotError("invalid source container/service name")
    if not IDENT.fullmatch(source.database):
        raise SnapshotError("invalid database name")


def child_env(source=None):
    # No R2, provider or Paperclip credentials reach database clients or Docker.
    env = {k: v for k, v in os.environ.items() if k in (
        "PATH", "HOME", "LANG", "PGSERVICEFILE", "PGPASSFILE", "PGSYSCONFDIR")}
    for key in ("PGSERVICEFILE", "PGPASSFILE", "PGSYSCONFDIR"):
        if key in env:
            env[key] = os.path.expanduser(env[key])
    env["PGCONNECT_TIMEOUT"] = "15"
    env["PGOPTIONS"] = "-c statement_timeout=3300000 -c idle_in_transaction_session_timeout=3600000"
    if source and source.service:
        env["PGSERVICE"] = source.service
    return env


def command(source, program, *args):
    if source.container:
        return ["docker", "exec", "-i", "--user", "postgres",
                "--env", "PGCONNECT_TIMEOUT=15", "--env",
                "PGOPTIONS=-c statement_timeout=3300000 -c idle_in_transaction_session_timeout=3600000",
                source.container,
                program, "--username=postgres", "--dbname=" + source.database, *args]
    return [program, "--dbname=" + source.database, *args]


def execute(args, *, data=None, output=None, env=None, timeout=TIMEOUT):
    try:
        result = subprocess.run(args, input=data, stdout=output or subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=env or child_env(),
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SnapshotError("database/container operation unavailable or timed out") from None
    if result.returncode:
        raise SnapshotError("database/container operation failed")
    return result.stdout


def sql(source, text):
    return execute(command(source, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"),
                   data=text.encode(), env=child_env(source)).decode()


def quote(identifier):
    return '"' + identifier.replace('"', '""') + '"'


def metadata(source, snapshot=None):
    begin = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
    if snapshot:
        if not re.fullmatch(r"[0-9A-Fa-f-]+", snapshot):
            raise SnapshotError("invalid exported snapshot id")
        begin += "SET TRANSACTION SNAPSHOT '" + snapshot + "';\n"
    # gexec quotes identifiers on the server; counts are exact, never estimates.
    text = begin + r"""
SELECT format('SELECT json_build_object(''table'', %L, ''count'', count(*)) FROM %I.%I;',
              format('%I.%I', n.nspname, c.relname), n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND left(n.nspname, 3) <> 'pg_'
  AND n.nspname <> 'information_schema'
ORDER BY n.nspname, c.relname
\gexec
"""
    table = ".".join(quote(p) for p in source.head_table.split("."))
    columns = ",".join(quote(p) for p in source.head_columns)
    text += ("SELECT json_build_object('schema_head', coalesce(jsonb_agg(to_jsonb(h) "
             "ORDER BY to_jsonb(h)::text), '[]'::jsonb)) FROM (SELECT " + columns +
             " FROM " + table + ") h;\nCOMMIT;\n")
    lines = [json.loads(line) for line in sql(source, text).splitlines() if line]
    tables = [line for line in lines if "table" in line]
    counts = {line["table"]: line["count"] for line in tables}
    if len(counts) != len(tables):
        raise SnapshotError("duplicate table inventory key")
    heads = [line["schema_head"] for line in lines if "schema_head" in line]
    if not counts or len(heads) != 1 or not heads[0]:
        raise SnapshotError("empty table inventory or schema head")
    return {"counts": counts, "schema_head": heads[0]}


@contextlib.contextmanager
def exported_snapshot(source):
    try:
        proc = subprocess.Popen(command(source, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"),
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=child_env(source))
    except OSError:
        raise SnapshotError("snapshot client unavailable") from None
    try:
        proc.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n"
                         b"SELECT pg_export_snapshot();\n")
        proc.stdin.flush()
        with selectors.DefaultSelector() as selector:
            selector.register(proc.stdout, selectors.EVENT_READ)
            if not selector.select(30):
                raise SnapshotError("snapshot export timed out")
        snapshot = proc.stdout.readline().decode().strip()
        if not re.fullmatch(r"[0-9A-Fa-f-]+", snapshot):
            raise SnapshotError("snapshot export failed")
        yield snapshot
        if proc.poll() is not None:
            raise SnapshotError("source snapshot session ended early")
    finally:
        # Closing the owning session releases the exported snapshot on every path.
        proc.stdin.close()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        proc.stdout.close()


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024**2), b""):
            digest.update(chunk)
    return digest.hexdigest()


def capture(source, now, dest):
    validate_source(source)
    dump = os.path.join(dest, source.name + ".dump")
    # Bracket connection + export, NOT invocation or dump completion. The first
    # server snapshot acquisition is inside this interval, even with slow startup.
    lower, start_tick = utc_now(), time.monotonic()
    if lower < now:
        raise SnapshotError("snapshot clock moved backward since invocation")
    # Both consumers import the SAME snapshot while its owner remains connected.
    with exported_snapshot(source) as snapshot:
        upper, end_tick = utc_now(), time.monotonic()
        check_clock(lower, start_tick, upper, end_tick)
        expected = metadata(source, snapshot)
        with open(dump, "wb") as stream:
            execute(command(source, "pg_dump", "-Fc", "--no-owner", "--no-acl",
                            "--snapshot=" + snapshot), output=stream, env=child_env(source))
    if os.path.getsize(dump) == 0:
        raise SnapshotError("empty database dump")
    manifest = {"version": 2, "database": source.name,
                "timestamp": timestamp(lower),
                "snapshot_acquisition": {"not_before": timestamp(lower),
                                         "not_after": timestamp(upper), "clock": CLOCK},
                "dump_sha256": sha256(dump), "head_table": source.head_table,
                "head_columns": list(source.head_columns), **expected}
    encoded = json.dumps(manifest, sort_keys=True).encode()
    if len(encoded) > MANIFEST_LIMIT:
        raise SnapshotError("snapshot manifest exceeds limit")
    manifest_path = os.path.join(dest, source.name + ".json")
    with open(manifest_path, "wb") as stream:
        stream.write(encoded)
    key = timing_key(source.name, lower)
    path = os.path.join(dest, os.path.basename(key))
    with tarfile.open(path, "w", format=tarfile.GNU_FORMAT) as archive:
        archive.add(dump, arcname="dump.pgcustom")
        archive.add(manifest_path, arcname="manifest.json")
    return path, key


def unpack(path, dest, source):
    # Read exactly two fixed-size headers ourselves. TarFile.next/getmembers can
    # expand arbitrarily large PAX/GNU metadata before exposing a member to validate.
    dump = os.path.join(dest, "dump.pgcustom")
    allowed = {"dump.pgcustom", "manifest.json"}
    seen = set()
    size = os.path.getsize(path)
    with open(path, "rb") as stream:
        for _ in range(2):
            header = stream.read(512)
            try:
                member = tarfile.TarInfo.frombuf(header, "utf-8", "strict")
            except (tarfile.HeaderError, UnicodeError):
                raise SnapshotError("invalid snapshot bundle header") from None
            if (member.name not in allowed - seen or
                    member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE) or
                    not 0 < member.size <= size - stream.tell() or
                    (member.name == "manifest.json" and member.size > MANIFEST_LIMIT)):
                raise SnapshotError("invalid snapshot bundle members")
            seen.add(member.name)
            if member.name == "manifest.json":
                manifest = json.loads(stream.read(member.size))
            else:
                with open(dump, "wb") as output:
                    remaining = member.size
                    while remaining:
                        chunk = stream.read(min(remaining, 1024**2))
                        if not chunk:
                            raise SnapshotError("truncated snapshot bundle")
                        output.write(chunk)
                        remaining -= len(chunk)
            padding = (-member.size) % 512
            if stream.read(padding) != b"\0" * padding:
                raise SnapshotError("invalid snapshot bundle padding")
        # A third member, extended header or non-zero trailing data is forbidden.
        trailer = stream.read(1024)
        if trailer != b"\0" * 1024:
            raise SnapshotError("invalid snapshot bundle trailer")
        for chunk in iter(lambda: stream.read(1024**2), b""):
            if chunk.strip(b"\0"):
                raise SnapshotError("invalid snapshot bundle trailer")
    if (manifest.get("version") not in (1, 2) or manifest.get("database") != source.name or
            manifest.get("head_table") != source.head_table or
            manifest.get("head_columns") != list(source.head_columns) or
            not manifest.get("schema_head") or not manifest.get("counts") or
            manifest.get("dump_sha256") != sha256(dump)):
        raise SnapshotError("snapshot manifest/hash mismatch")
    if manifest["version"] == 2:
        validate_timing(manifest)
    return dump, manifest


@contextlib.contextmanager
def restore_container(image):
    if not IMAGE.fullmatch(image):
        raise SnapshotError("restore image must be pinned by sha256")
    memory_mb = int(os.environ.get("RESTORE_MEMORY_MB", "2048"))
    data_mb = int(os.environ.get("RESTORE_DATA_MB", "1024"))
    if not 128 <= data_mb < memory_mb <= 65536:
        raise SnapshotError("restore memory/data bounds invalid")
    name = "offsite-restore-" + uuid.uuid4().hex
    # No network, published port, host mount, Docker socket, credentials or durable
    # volume. PG18's parent data path prevents an anonymous image-declared volume.
    try:
        execute(["docker", "run", "--detach", "--name", name,
                 "--label", "offsite-restore=true", "--network=none", "--pull=never",
                 f"--memory={memory_mb}m", f"--memory-swap={memory_mb}m",
                 "--cpus=2", "--pids-limit=256",
                 "--security-opt=no-new-privileges", "--cap-drop=ALL",
                 "--user=postgres", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
                 "--tmpfs", "/var/run/postgresql:rw,nosuid,nodev,mode=1777,size=16m",
                 "--tmpfs", f"/var/lib/postgresql:rw,nosuid,nodev,mode=1777,size={data_mb}m",
                 "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev,mode=1777,size=16m",
                 "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=restore",
                 "-e", "PGDATA=/var/lib/postgresql/drill", image], timeout=60)
        target = Source("paperclip", "restore", "public.placeholder", ("id",), image, name)
        # The image's initialization server is socket-only. Container-local TCP
        # distinguishes final startup without adding any external network route.
        execute(["docker", "exec", name, "sh", "-c",
                 "i=0; until pg_isready -h 127.0.0.1 -U postgres -d restore >/dev/null 2>&1; do "
                 "i=$((i+1)); [ $i -lt 60 ] || exit 1; sleep 1; done"], timeout=75)
        yield target
    finally:
        # Attempt cleanup even if run/start/readiness/restore fails. Cleanup failure
        # is itself a failed drill; never print a success receipt while it is live.
        execute(["docker", "rm", "--force", "--volumes", name], timeout=60)


def restore_and_compare(source, dump, manifest):
    with restore_container(source.image) as container:
        target = Source(source.name, "restore", source.head_table, source.head_columns,
                        source.image, container.container)
        # Stream over stdin; never mount local backup directories into the target.
        with open(dump, "rb") as stream:
            try:
                proc = subprocess.run(command(target, "pg_restore", "--exit-on-error",
                                              "--no-owner", "--no-acl", "--no-tablespaces"), stdin=stream,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      timeout=TIMEOUT, env=child_env(), check=False)
            except (OSError, subprocess.TimeoutExpired):
                raise SnapshotError("isolated restore unavailable or timed out") from None
        if proc.returncode:
            raise SnapshotError("isolated restore failed")
        actual = metadata(target)
        if actual != {k: manifest[k] for k in ("counts", "schema_head")}:
            raise SnapshotError("restored schema head or row counts differ from source snapshot")
    return actual


def drill(cfg, rc, now):
    clock_start = utc_now()
    start_tick = time.monotonic()
    checked = []
    receipt = {"timestamp": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "ok": False,
               "databases": {}, "error": None}
    try:
        if {s.name for s in cfg.sources} != {"paperclip", "hindsight"}:
            raise SnapshotError("restore drill requires both database sources")
        for source in cfg.sources:
            candidates = timed_inventory(rc.list(source.prefix))
            if not candidates:
                raise SnapshotError(source.name + ": no offsite snapshot with substantiated timing")
            obj, lower = max(candidates, key=lambda item: (item[1], item[0].key))
            # Reject obviously stale keys before download; the validated manifest
            # interval, not the key alone, governs eligibility after download.
            observed = utc_now()
            check_clock(clock_start, start_tick, observed, time.monotonic())
            if observed < now or not 0 <= (observed - lower).total_seconds() < 26 * 3600:
                raise SnapshotError(source.name + ": newest offsite snapshot is not fresh (<26h)")
            if not 0 < obj.size <= cfg.cap_bytes:
                raise SnapshotError("offsite snapshot exceeds download cap")
            with tempfile.TemporaryDirectory(prefix="drill-", dir=cfg.tmp_dir) as dest:
                path = os.path.join(dest, "offsite.tar")
                rc.download(obj.key, path, cfg.cap_bytes)
                if os.path.getsize(path) != obj.size:
                    raise SnapshotError("offsite download size mismatch")
                dump, manifest = unpack(path, dest, source)
                require_fresh(manifest, obj.key, observed)
                actual = restore_and_compare(source, dump, manifest)
                checked.append((manifest, obj.key))
                receipt["databases"][source.name] = {
                    "object_key": obj.key, "object_sha256": sha256(path),
                    "dump_sha256": manifest["dump_sha256"], "source_timestamp": manifest["timestamp"],
                    "snapshot_acquisition": manifest["snapshot_acquisition"],
                    "restore_image": source.image, "cleanup_ok": True, **actual}
        finished = utc_now()
        if finished < observed:
            raise SnapshotError("snapshot clock moved backward during restore")
        check_clock(clock_start, start_tick, finished, time.monotonic())
        for manifest, key in checked:
            require_fresh(manifest, key, finished)
        receipt["ok"] = True
    except Exception as exc:
        # Only our deliberately safe errors are reportable; raw client, parse and
        # filesystem exceptions may contain data, URLs or protected paths.
        receipt["error"] = (str(exc) if isinstance(exc, SnapshotError) else
                            "restore drill failed; inspect protected operator diagnostics")
    data = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
    publish = True
    try:
        # The shared CLI lock excludes backup retention/uploads. Admit the exact
        # replacement delta, including status objects, also for standalone drills.
        objects = [obj for prefix in ("db/", "instance/", *PREFIXES, "status/")
                   for obj in rc.list(prefix)]
        previous = sum(obj.size for obj in objects if obj.key == "status/restore-last.json")
        if sum(obj.size for obj in objects) + len(data) - previous > cfg.cap_bytes:
            raise SnapshotError("restore receipt would exceed aggregate storage cap")
    except Exception:
        receipt["ok"] = False
        receipt["error"] = "restore receipt storage admission failed; local evidence retained"
        data = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
        publish = False
    os.makedirs(cfg.receipt_dir, mode=0o700, exist_ok=True)
    local = os.path.join(cfg.receipt_dir, f"restore-{now:%Y%m%d-%H%M%S}.json")
    with open(local, "xb") as stream:
        stream.write(data)
    if publish:
        rc.put_bytes(data, "status/restore-last.json")
    return 0 if receipt["ok"] else 1

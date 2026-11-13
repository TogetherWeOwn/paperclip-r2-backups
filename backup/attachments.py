"""Incremental offsite mirror of Paperclip attachment objects.

Copies new or changed objects from a read-only source remote (Paperclip's object
storage bucket) into ``attachments/`` of the backup bucket. Never deletes: a
backup copy whose source object disappeared is kept and only counted, so the
retention floor for vanished sources is unbounded (at least 30 days by design).

The source remote is defined only in the rclone child environment from
ATTACH_R2_ACCESS_KEY_ID / ATTACH_R2_SECRET_ACCESS_KEY (bucket-scoped read token)
and the existing R2 endpoint. Credentials never appear in argv or logs.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass

DEST_PREFIX = "attachments/"
SOURCE_REMOTE = "ATTACHSRC"
_SOURCE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*/(?:[A-Za-z0-9._-]+/)*")


class AttachmentError(Exception):
    pass


@dataclass(frozen=True)
class SrcObj:
    key: str   # path relative to the source prefix
    size: int
    md5: str


def parse_source(value: str) -> tuple[str, str]:
    """``bucket/prefix/`` -> (bucket, prefix). The prefix may be empty."""
    if not _SOURCE_RE.fullmatch(value or "") or ".." in value.split("/"):
        raise AttachmentError("ATTACHMENTS_SOURCE must look like bucket/ or bucket/prefix/")
    bucket, _, prefix = value.partition("/")
    return bucket, prefix


def source_env(env: dict) -> dict:
    """Child environment adding the read-only source remote. Values are never logged."""
    key_id, secret = env.get("ATTACH_R2_ACCESS_KEY_ID"), env.get("ATTACH_R2_SECRET_ACCESS_KEY")
    endpoint = env.get("RCLONE_CONFIG_R2_ENDPOINT")
    if not (key_id and secret and endpoint):
        raise AttachmentError("attachment source credentials or R2 endpoint missing")
    child = dict(env)
    child.update({
        f"RCLONE_CONFIG_{SOURCE_REMOTE}_TYPE": "s3",
        f"RCLONE_CONFIG_{SOURCE_REMOTE}_PROVIDER": "Cloudflare",
        f"RCLONE_CONFIG_{SOURCE_REMOTE}_ACCESS_KEY_ID": key_id,
        f"RCLONE_CONFIG_{SOURCE_REMOTE}_SECRET_ACCESS_KEY": secret,
        f"RCLONE_CONFIG_{SOURCE_REMOTE}_ENDPOINT": endpoint,
        f"RCLONE_CONFIG_{SOURCE_REMOTE}_NO_CHECK_BUCKET": "true",
    })
    return child


def _rclone(binary: str, args: list[str], env: dict) -> str:
    try:
        proc = subprocess.run([binary, *args], capture_output=True, check=False,
                              timeout=6 * 3600, env=env)
    except subprocess.TimeoutExpired:
        raise AttachmentError("rclone attachment operation timed out") from None
    except OSError as exc:
        raise AttachmentError(f"cannot run rclone: {exc.strerror}")
    if proc.returncode != 0:
        # Backend errors can echo credentials or signed URLs. Never log stderr.
        raise AttachmentError(f"rclone {args[0]} failed (rc={proc.returncode})")
    return proc.stdout.decode("utf-8", "replace")


def parse_listing(out: str) -> dict[str, SrcObj]:
    try:
        items = json.loads(out or "[]")
        if not isinstance(items, list):
            raise ValueError
        result = {}
        for item in items:
            key, size = item["Path"], item["Size"]
            if not isinstance(key, str) or not key or type(size) is not int or size < 0 or key in result:
                raise ValueError
            result[key] = SrcObj(key, size, (item.get("Hashes") or {}).get("md5", "") or "")
        return result
    except (ValueError, TypeError, KeyError):
        raise AttachmentError("invalid attachment listing") from None


def plan_copy(src: dict[str, SrcObj], dst: dict[str, SrcObj]) -> tuple[list[SrcObj], int]:
    """Objects to copy (missing or differing) and the count of orphaned backup copies."""
    todo = []
    for key, o in sorted(src.items()):
        have = dst.get(key)
        if have is None or have.size != o.size or (o.md5 and have.md5 and o.md5 != have.md5):
            todo.append(o)
    orphans = sum(1 for key in dst if key not in src)
    return todo, orphans


class Mirror:
    """The only place that spawns rclone for attachments; tests replace it."""

    def __init__(self, source: str, dest_bucket: str, env: dict, binary: str = "rclone"):
        self.src_bucket, self.src_prefix = parse_source(source)
        self.dest = f"R2:{dest_bucket}/{DEST_PREFIX}"
        self.src = f"{SOURCE_REMOTE}:{self.src_bucket}/{self.src_prefix}"
        self.env, self.binary = source_env(env), binary

    def _list(self, target: str) -> dict[str, SrcObj]:
        try:
            out = _rclone(self.binary, ["lsjson", "-R", "--files-only", "--no-mimetype",
                                        "--no-modtime", "--hash", "--hash-type", "md5", target], self.env)
        except AttachmentError as exc:
            if "rc=3)" in str(exc) and target == self.dest:  # empty destination prefix
                return {}
            raise
        return parse_listing(out)

    def list_source(self) -> dict[str, SrcObj]:
        return self._list(self.src)

    def list_dest(self) -> dict[str, SrcObj]:
        return self._list(self.dest)

    def copy(self, keys: list[str], tmp_dir: str) -> None:
        if any(k.startswith("/") or ".." in k.split("/") for k in keys):
            raise AttachmentError("refusing unsafe attachment key")
        with tempfile.NamedTemporaryFile("w", dir=tmp_dir, suffix=".list") as fh:
            fh.write("\n".join(keys) + "\n")
            fh.flush()
            # copy never deletes; --checksum compares size + md5 where available.
            _rclone(self.binary, ["copy", "--checksum", "--no-traverse", "--files-from-raw",
                                  fh.name, self.src, self.dest], self.env)


def mirror(m, cap_bytes: int, bucket_bytes: int, tmp_dir: str, dry_run: bool, log,
           reserve=lambda summary: 0) -> dict:
    """Plan, admit against the cap, copy and verify. Returns a status summary.

    ``reserve(summary)`` returns extra bytes to admit alongside the copy, such as
    positive growth of the final status receipt that will carry this summary.
    """
    src = m.list_source()
    if not src:
        # An empty or unreadable source is unknown, never "everything was deleted".
        raise AttachmentError("attachment source listing is empty")
    dst = m.list_dest()
    todo, orphans = plan_copy(src, dst)
    incoming = sum(o.size for o in todo)
    summary = {"source_objects": len(src), "source_bytes": sum(o.size for o in src.values()),
               "backup_objects": len(dst), "to_copy": len(todo), "to_copy_bytes": incoming,
               "orphaned_backup_copies_kept": orphans, "copied": 0}
    # Replacement of a differing copy is counted in full (conservative).
    extra = max(0, reserve(summary))
    if bucket_bytes + incoming + extra > cap_bytes:
        raise AttachmentError(f"cap reached: bucket {bucket_bytes} + attachments {incoming} + "
                              f"status growth {extra} > cap {cap_bytes}; no attachments copied")
    if dry_run:
        log(f"dry-run: would copy {len(todo)} attachment objects ({incoming} bytes); "
            f"{orphans} backup copies without source kept")
        return summary
    if todo:
        log(f"attachments: copy {len(todo)} objects ({incoming} bytes)")
        m.copy([o.key for o in todo], tmp_dir)
        after = m.list_dest()
        bad = [o.key for o in todo if (got := after.get(o.key)) is None or got.size != o.size or
               (o.md5 and got.md5 and got.md5 != o.md5)]
        if bad:
            raise AttachmentError(f"attachment verify failed for {len(bad)} objects")
        summary["copied"] = len(todo)
    return summary

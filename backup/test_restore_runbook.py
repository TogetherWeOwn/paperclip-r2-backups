import ast
import fcntl
import os
from pathlib import Path
import stat
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paperclip_r2_backup as backup  # noqa: E402


class RecoveryRunbookTests(unittest.TestCase):
    def test_documented_gate_uses_interval_before_restore(self):
        import datetime as dt
        import database_snapshots as snapshots
        doc = (Path(__file__).resolve().parents[1] / "docs/restore.md").read_text()
        snippet = doc.split("<<'PY'\n", 1)[1].split("\n   PY", 1)[0]
        tree = ast.parse(textwrap.dedent(snippet))
        lock = next(node for node in tree.body if isinstance(node, ast.With))
        gate_index = next(i for i, node in enumerate(lock.body)
                          if "snapshots.require_preincident(" in ast.unparse(node))
        restore_index = next(i for i, node in enumerate(lock.body)
                             if "snapshots.restore_and_compare(" in ast.unparse(node))
        self.assertLess(gate_index, restore_index)
        gate = lock.body[gate_index]
        code = compile(ast.fix_missing_locations(ast.Module(body=[gate], type_ignores=[])),
                       "recovery-timing-gate", "exec")
        lower = dt.datetime(2026, 11, 8, 4, 59, 59, 999999, tzinfo=dt.timezone.utc)
        cutoff = lower + dt.timedelta(microseconds=1)
        manifest = {"version": 2, "database": "hindsight", "timestamp": snapshots.timestamp(lower),
                    "snapshot_acquisition": {"not_before": snapshots.timestamp(lower),
                                             "not_after": snapshots.timestamp(cutoff),
                                             "clock": snapshots.CLOCK}}
        scope = {"snapshots": snapshots, "manifest": manifest,
                 "key": snapshots.timing_key("hindsight", lower), "cutoff": cutoff}
        with self.assertRaises(snapshots.SnapshotError):
            exec(code, scope)
        manifest["snapshot_acquisition"]["not_after"] = snapshots.timestamp(lower)
        exec(code, scope)
        manifest["version"] = 1
        with self.assertRaises(snapshots.SnapshotError):
            exec(code, scope)

    def test_recovery_lock_on_fresh_host_and_existing_busy_lock(self):
        doc = (Path(__file__).resolve().parents[1] / "docs/restore.md").read_text()
        snippet = doc.split("<<'PY'\n", 1)[1].split("\n   PY", 1)[0]
        tree = ast.parse(textwrap.dedent(snippet))
        lock = next(node for node in tree.body if isinstance(node, ast.With))
        # Execute only the documented lock open and flock, never recovery clients.
        self.assertEqual(ast.unparse(lock.body[0]),
                         "fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)")
        lock.body = lock.body[:1]
        code = compile(ast.fix_missing_locations(ast.Module(body=[lock], type_ignores=[])),
                       "recovery-lock", "exec")
        with tempfile.TemporaryDirectory() as tmp:
            cfg = backup.load_config({"BACKUP_BUCKET": "fixture", "BACKUP_TMP_DIR":
                                      os.path.join(tmp, "new-cache")})
            scope = {"backup": backup, "cfg": cfg, "os": os, "fcntl": fcntl}
            self.assertFalse(os.path.exists(cfg.tmp_dir))
            previous_umask = os.umask(0o077)
            try:
                exec(code, scope)
                path = Path(cfg.tmp_dir) / "operation.lock"
                self.assertEqual(stat.S_IMODE(os.stat(cfg.tmp_dir).st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                path.write_text("existing lock sentinel")
                inode = path.stat().st_ino
                with path.open("a") as held:
                    fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    with self.assertRaises(BlockingIOError):
                        exec(code, scope)
                    self.assertEqual(path.stat().st_ino, inode)
                    self.assertEqual(path.read_text(), "existing lock sentinel")
                exec(code, scope)
                self.assertEqual(path.stat().st_ino, inode)
            finally:
                os.umask(previous_umask)

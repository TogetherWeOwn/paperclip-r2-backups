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

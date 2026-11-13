import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import attachments as a  # noqa: E402
import paperclip_r2_backup as b  # noqa: E402
from test_attachments import FakeMirror, objs  # noqa: E402
from test_paperclip_r2_backup import FakeRclone, RunFixture  # noqa: E402


class RunIntegrationTests(RunFixture):
    def test_status_records_attachments_and_prefix_never_deletable(self):
        rc = FakeRclone()
        m = FakeMirror(objs(p_a=10))
        self.assertEqual(b.run(self.cfg, rc, self.now, mirror=m), 0)
        st = rc.puts["status/last-run.json"]
        self.assertEqual(st["attachments"]["copied"], 1)
        self.assertNotIn(a.DEST_PREFIX, b.DELETABLE_PREFIXES)
        with self.assertRaises(b.BackupError):
            b.assert_managed("attachments/p/a", b.DELETABLE_PREFIXES)

    def test_mirror_failure_fails_run_after_db_upload(self):
        rc = FakeRclone()
        code = b.run(self.cfg, rc, self.now, mirror=FakeMirror(objs(p_a=1), fail_copy=True))
        self.assertEqual(code, b.EXIT_ERROR)
        self.assertIn("db/2026/11/02/paperclip-20261102-003716.sql.gz", rc.uploaded)
        self.assertIn("attachments:", rc.puts["status/last-run.json"]["error"])

    def test_mirror_skipped_when_db_backup_fails(self):
        m = FakeMirror(objs(p_a=1))
        self.assertEqual(b.run(self.cfg, FakeRclone(fail_upload=True), self.now, mirror=m), b.EXIT_ERROR)
        self.assertEqual(m.copied, [])

    def test_config_reads_source(self):
        cfg = b.load_config({"BACKUP_BUCKET": "bk", "ATTACHMENTS_SOURCE": "paperclip-workforce/paperclip/"})
        self.assertEqual(cfg.attachments_source, "paperclip-workforce/paperclip/")
        self.assertEqual(b.load_config({"BACKUP_BUCKET": "bk"}).attachments_source, "")


class ReviewRegressionTests(RunFixture):
    def capture(self):
        seen = {}
        real = a.mirror

        def spy(m, cap, base, tmp, dry, log, reserve=lambda s: 0):
            seen.update(base=base, reserve=reserve)
            return real(m, cap, base, tmp, dry, log, reserve)
        patcher = mock.patch.object(a, "mirror", side_effect=spy)
        patcher.start()
        self.addCleanup(patcher.stop)
        return seen

    def test_mirror_reserve_counts_against_cap(self):
        m = FakeMirror(objs(p_a=10))
        with self.assertRaises(a.AttachmentError):
            a.mirror(m, 100, 80, "/tmp", False, lambda _m: None, reserve=lambda s: 15)
        self.assertEqual(m.copied, [])
        a.mirror(m, 100, 80, "/tmp", False, lambda _m: None, reserve=lambda s: 10)
        self.assertEqual(m.copied, ["p/a"])

    def test_run_reserves_status_receipt_growth(self):
        seen = self.capture()
        self.assertEqual(b.run(self.cfg, FakeRclone(), self.now, mirror=FakeMirror(objs(p_a=1))), 0)
        small = seen["reserve"]({"n": 1})
        self.assertGreater(seen["reserve"]({"n": "x" * 5000}), small + 4000)

    def test_dry_run_admits_against_simulated_post_upload_size(self):
        seen = self.capture()
        rc = FakeRclone()
        self.assertEqual(b.run(self.cfg, rc, self.now, True, FakeMirror(objs(p_a=1))), 0)
        self.assertEqual(sum(rc.store.values()), 0)  # nothing physically uploaded
        self.assertGreater(seen["base"], 0)          # but the dump is counted

    def test_live_run_admits_against_physical_inventory(self):
        seen = self.capture()
        rc = FakeRclone()
        self.assertEqual(b.run(self.cfg, rc, self.now, mirror=FakeMirror(objs(p_a=1))), 0)
        uploaded = sum(s for k, s in rc.store.items() if not k.startswith(("status/", "attachments/")))
        self.assertEqual(seen["base"], uploaded)

    def test_restore_drill_never_needs_attachment_credentials(self):
        env = {"BACKUP_BUCKET": "bk", "ATTACHMENTS_SOURCE": "src/p/", "BACKUP_TMP_DIR": self.tmp}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(b.snapshots, "drill", return_value=0) as drill:
            self.assertEqual(b.main(["--restore-drill"]), 0)
            drill.assert_called_once()
            with mock.patch.object(b, "run", return_value=0) as run:
                self.assertEqual(b.main(["--dry-run"]), b.EXIT_ERROR)  # missing creds fail closed
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()

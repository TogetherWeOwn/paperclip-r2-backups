import contextlib
import datetime as dt
import io
import json
import os
import shutil
import tarfile
import tempfile
import unittest
from unittest import mock

import database_snapshots as s
import paperclip_r2_backup as b
from test_paperclip_r2_backup import FakeRclone, RunFixture

IMAGE = "postgres@sha256:" + "a" * 64
NOW = dt.datetime(2026, 11, 8, 4, 20, tzinfo=dt.timezone.utc)


def source(name="hindsight"):
    return s.Source(name, name, "public.alembic_version", ("version_num",), IMAGE,
                    "fixture-source")


def expected():
    return {"counts": {"public.alembic_version": 1, "public.items": 7},
            "schema_head": [{"version_num": "fixture-head"}]}


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name

    def bundle(self, name="hindsight"):
        @contextlib.contextmanager
        def snapshot(_):
            yield "00000003-000000A1-1"

        def dump(args, **kwargs):
            kwargs["output"].write(b"PGDMP-fixture")

        with mock.patch.object(s, "exported_snapshot", snapshot), \
                mock.patch.object(s, "metadata", return_value=expected()), \
                mock.patch.object(s, "execute", side_effect=dump):
            return s.capture(source(name), NOW, self.root)

    def test_dump_and_counts_import_same_snapshot(self):
        @contextlib.contextmanager
        def snapshot(_):
            yield "00000003-000000A1-1"

        def dump(args, **kwargs):
            self.assertIn("-Fc", args)
            self.assertIn("--snapshot=00000003-000000A1-1", args)
            kwargs["output"].write(b"PGDMP-fixture")

        with mock.patch.object(s, "exported_snapshot", snapshot), \
                mock.patch.object(s, "metadata", return_value=expected()) as metadata, \
                mock.patch.object(s, "execute", side_effect=dump):
            path, key = s.capture(source(), NOW, self.root)
        metadata.assert_called_once_with(source(), "00000003-000000A1-1")
        self.assertEqual(key, "hindsight/2026/11/08/hindsight-20261108-042000.tar")
        dump, manifest = s.unpack(path, self.root, source())
        self.assertEqual(manifest["dump_sha256"], s.sha256(dump))
        self.assertEqual(manifest["counts"], expected()["counts"])

    def test_corrupt_dump_hash_fails_closed(self):
        path, _ = self.bundle()
        with open(path, "r+b") as stream:
            data = stream.read().replace(b"PGDMP-fixture", b"PGDMP-corrupt")
            stream.seek(0)
            stream.write(data)
        with self.assertRaisesRegex(s.SnapshotError, "hash mismatch"):
            s.unpack(path, self.root, source())

    def test_bundle_rejects_traversal_symlink_and_extra_members(self):
        for name, kind in (("../escape", tarfile.REGTYPE),
                           ("dump.pgcustom", tarfile.SYMTYPE)):
            path = os.path.join(self.root, "bad.tar")
            with tarfile.open(path, "w") as archive:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = "/etc/passwd"
                archive.addfile(entry)
            with self.assertRaises(s.SnapshotError):
                s.unpack(path, self.root, source())
        self.assertFalse(os.path.exists(os.path.join(self.root, "escape")))

    def test_rejects_empty_schema_head(self):
        with mock.patch.object(s, "sql", return_value='{"table":"x","count":0}\n{"schema_head":[]}\n'):
            with self.assertRaisesRegex(s.SnapshotError, "empty"):
                s.metadata(source())

    def test_metadata_queries_use_repeatable_read_and_safe_identifiers(self):
        response = '{"table":"public.items","count":7}\n{"schema_head":[{"version_num":"h"}]}\n'
        with mock.patch.object(s, "sql", return_value=response) as sql:
            s.metadata(source(), "00000003-000000A1-1")
        text = sql.call_args.args[1]
        self.assertIn("REPEATABLE READ READ ONLY", text)
        self.assertIn("SET TRANSACTION SNAPSHOT '00000003-000000A1-1'", text)
        self.assertIn('"public"."alembic_version"', text)
        self.assertIn("%I.%I", text)

    def test_config_requires_immutable_image_and_safe_head_identifiers(self):
        for field, value in (("image", "postgres:latest"),
                             ("head_table", "public.head; DROP DATABASE x"),
                             ("database", "postgresql://secret@host/db")):
            values = dict(source().__dict__)
            values[field] = value
            with self.assertRaises(s.SnapshotError):
                s.validate_source(s.Source(**values))

    def test_child_environment_excludes_credentials(self):
        with mock.patch.dict(os.environ, {"RCLONE_CONFIG_R2_SECRET_ACCESS_KEY": "SECRET",
                                         "DATABASE_URL": "SECRET", "PGPASSWORD": "SECRET",
                                         "ANTHROPIC_AUTH_TOKEN": "SECRET"}):
            env = s.child_env(source())
        self.assertNotIn("SECRET", json.dumps(env))
        self.assertIn("PGCONNECT_TIMEOUT", env)
        self.assertNotIn("SECRET", " ".join(s.command(source(), "pg_dump", "-Fc")))

    def test_container_cleanup_after_failed_readiness(self):
        calls = []

        def execute(args, **kwargs):
            calls.append(args)
            if args[1] == "exec":
                raise s.SnapshotError("readiness failed")
            return b"fixture"

        with mock.patch.object(s, "execute", side_effect=execute):
            with self.assertRaises(s.SnapshotError):
                with s.restore_container(IMAGE):
                    self.fail("must not reach restore")
        self.assertEqual(calls[-1][1:4], ["rm", "--force", "--volumes"])
        run = calls[0]
        for option in ("--network=none", "--read-only", "--cap-drop=ALL", "--pull=never"):
            self.assertIn(option, run)
        self.assertFalse(any(x.startswith(("-v=", "--volume", "--publish")) for x in run))

    def test_container_cleanup_failure_is_not_success(self):
        with mock.patch.object(s, "execute", side_effect=[b"id", b"ready", s.SnapshotError("rm failed")]):
            with self.assertRaisesRegex(s.SnapshotError, "rm failed"):
                with s.restore_container(IMAGE):
                    pass

    def test_restore_mismatch_exits_context(self):
        path, _ = self.bundle()
        dump, manifest = s.unpack(path, self.root, source())
        cleaned = []

        @contextlib.contextmanager
        def container(_):
            try:
                yield source()
            finally:
                cleaned.append(True)

        with mock.patch.object(s, "restore_container", container), \
                mock.patch.object(s.subprocess, "run", return_value=mock.Mock(returncode=0)), \
                mock.patch.object(s, "metadata", return_value={"counts": {"x": 9}, "schema_head": []}):
            with self.assertRaisesRegex(s.SnapshotError, "differ"):
                s.restore_and_compare(source(), dump, manifest)
        self.assertEqual(cleaned, [True])

    def test_drill_downloads_offsite_and_writes_both_receipts(self):
        paths = {name: self.bundle(name) for name in ("paperclip", "hindsight")}
        store = mock.Mock()
        store.list.side_effect = lambda prefix: [b.Obj(paths[prefix[:-1]][1],
                                                            os.path.getsize(paths[prefix[:-1]][0]))]
        store.download.side_effect = lambda key, dest, limit: shutil.copyfile(paths[key.split('/')[0]][0], dest)
        cfg = b.Config("fixture", "", "", tmp_dir=self.root, receipt_dir=self.root,
                       sources=(source("paperclip"), source("hindsight")))
        with mock.patch.object(s, "restore_and_compare", return_value=expected()):
            self.assertEqual(s.drill(cfg, store, NOW), 0)
        receipt = json.loads(store.put_bytes.call_args.args[0])
        self.assertTrue(receipt["ok"])
        self.assertEqual(set(receipt["databases"]), {"paperclip", "hindsight"})
        self.assertEqual(store.download.call_count, 2)
        self.assertTrue(all(d["cleanup_ok"] for d in receipt["databases"].values()))
        self.assertFalse(any(name.startswith("drill-") for name in os.listdir(self.root)))

    def test_drill_failure_and_stale_boundary_have_no_success_receipt(self):
        path, key = self.bundle()
        for age in (dt.timedelta(hours=26), dt.timedelta(hours=1)):
            store = mock.Mock()
            store.list.return_value = [b.Obj(key, os.path.getsize(path))]
            store.download.side_effect = RuntimeError("SECRET signed URL")
            cfg = b.Config("fixture", "", "", tmp_dir=self.root, receipt_dir=self.root,
                           sources=(source("hindsight"), source("paperclip")))
            self.assertEqual(s.drill(cfg, store, NOW + age), 1)
            receipt = json.loads(store.put_bytes.call_args.args[0])
            self.assertFalse(receipt["ok"])
            self.assertNotIn("SECRET", json.dumps(receipt))
            if age == dt.timedelta(hours=26):
                store.download.assert_not_called()


class BackupSnapshotTests(RunFixture):
    def configure(self):
        self.cfg.sources = (source("paperclip"), source("hindsight"))

    def capture(self, source, now, dest):
        path = os.path.join(dest, source.name + ".tar")
        with open(path, "wb") as stream:
            stream.write(b"snapshot fixture")
        return path, f"{source.prefix}{now:%Y/%m/%d}/{source.name}-{now:%Y%m%d-%H%M%S}.tar"

    def test_native_backup_preserved_with_independent_snapshot_freshness(self):
        self.configure()
        rc = FakeRclone()
        with mock.patch.object(s, "capture", side_effect=self.capture):
            self.assertEqual(b.run(self.cfg, rc, self.now), 0)
        self.assertEqual(len(rc.uploaded), 4)
        self.assertEqual(rc.puts[b.STATUS_KEY]["snapshot_freshness"],
                         {"paperclip": True, "hindsight": True})
        self.assertFalse(os.listdir(self.tmp))

    def test_snapshot_capture_failure_does_not_delete_or_upload(self):
        self.configure()
        rc = FakeRclone()
        with mock.patch.object(s, "capture", side_effect=s.SnapshotError("capture failed")):
            self.assertEqual(b.run(self.cfg, rc, self.now), 1)
        self.assertEqual((rc.uploaded, rc.deleted), ([], []))
        self.assertFalse(os.listdir(self.tmp))

    def test_dry_run_never_reads_database(self):
        self.configure()
        rc = FakeRclone()
        with mock.patch.object(s, "capture") as capture:
            self.assertEqual(b.run(self.cfg, rc, self.now, True), 0)
        capture.assert_not_called()
        self.assertEqual(rc.puts, {})

    def test_snapshot_bytes_are_in_aggregate_cap(self):
        self.configure()
        self.cfg.cap_bytes = 1
        rc = FakeRclone()
        with mock.patch.object(s, "capture", side_effect=self.capture):
            self.assertEqual(b.run(self.cfg, rc, self.now), 2)
        self.assertEqual(rc.uploaded, [])
        self.assertFalse(os.listdir(self.tmp))

    def test_main_uses_existing_daily_invocation_for_weekly_drill(self):
        self.configure()
        self.cfg.restore_weekday = self.now.weekday()
        self.cfg.receipt_dir = self.root
        with mock.patch.object(b, "load_config", return_value=self.cfg), \
                mock.patch.object(b.dt, "datetime") as clock, \
                mock.patch.object(b.signal, "signal"), \
                mock.patch.object(b, "run", return_value=0) as backup, \
                mock.patch.object(s, "drill", return_value=1) as drill:
            clock.now.return_value = self.now
            self.assertEqual(b.main([]), 1)
        backup.assert_called_once()
        drill.assert_called_once()

    def test_failed_backup_never_starts_weekly_drill(self):
        self.configure()
        self.cfg.restore_weekday = self.now.weekday()
        with mock.patch.object(b, "load_config", return_value=self.cfg), \
                mock.patch.object(b.signal, "signal"), \
                mock.patch.object(b, "run", return_value=1), \
                mock.patch.object(s, "drill") as drill:
            self.assertEqual(b.main([]), 1)
        drill.assert_not_called()

    def test_snapshot_gfs_keeps_newest_three_and_shares_delete_budget(self):
        now = self.now
        objs = [b.Obj(f"hindsight/{stamp:%Y/%m/%d}/hindsight-{stamp:%Y%m%d-%H%M%S}.tar", 10)
                for stamp in (now - dt.timedelta(days=n) for n in range(8))]
        plan = b.plan_retention(objs, now, (0, 0, 0), 2, True, "hindsight/")
        self.assertEqual(len(plan.delete), 2)
        self.assertTrue(plan.truncated)
        self.assertFalse(set(plan.delete) & {o.key for o in objs[:3]})


if __name__ == "__main__":
    unittest.main()

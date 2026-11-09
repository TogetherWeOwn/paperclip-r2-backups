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
        clock = mock.patch.object(s, "utc_now", return_value=NOW)
        clock.start()
        self.addCleanup(clock.stop)

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
        self.assertEqual(key, "hindsight/2026/11/08/hindsight-20261108-042000-snapshot.tar")
        dump, manifest = s.unpack(path, self.root, source())
        self.assertEqual(manifest["dump_sha256"], s.sha256(dump))
        self.assertEqual(manifest["counts"], expected()["counts"])

    def test_delayed_second_source_uses_acquisition_not_invocation(self):
        # Invocation 04:20, second source cannot acquire its snapshot until 05:50.
        # These are controlled clocks; no waiting or live DB access is involved.
        later = NOW + dt.timedelta(hours=1, minutes=30, microseconds=123456)
        bounds = iter((NOW, NOW + dt.timedelta(seconds=1), later,
                       later + dt.timedelta(seconds=2)))

        @contextlib.contextmanager
        def snapshot(_):
            yield "00000003-000000A1-1"

        def dump(args, **kwargs):
            kwargs["output"].write(b"PGDMP-fixture")

        with mock.patch.object(s, "utc_now", side_effect=lambda: next(bounds), create=True), \
                mock.patch.object(s.time, "monotonic", side_effect=(0, 1, 2, 4)), \
                mock.patch.object(s, "exported_snapshot", snapshot), \
                mock.patch.object(s, "metadata", return_value=expected()), \
                mock.patch.object(s, "execute", side_effect=dump):
            first = s.capture(source("paperclip"), NOW, self.root)
            second = s.capture(source(), NOW, self.root)
        self.assertEqual(b.key_timestamp(second[1]), later.replace(microsecond=0))
        self.assertEqual(first[1], "paperclip/2026/11/08/paperclip-20261108-042000-snapshot.tar")
        self.assertEqual(second[1], "hindsight/2026/11/08/hindsight-20261108-055000-snapshot.tar")
        _, manifest = s.unpack(second[0], self.root, source())
        interval = s.validate_timing(manifest, second[1])
        self.assertEqual(interval, (later, later + dt.timedelta(seconds=2)))
        with self.assertRaisesRegex(s.SnapshotError, "before incident"):
            s.require_preincident(manifest, second[1], NOW.replace(hour=5, minute=0))

    def test_unpack_rejects_extended_headers_without_expanding_them(self):
        path = os.path.join(self.root, "extended.tar")
        header = tarfile.TarInfo("metadata")
        header.type = tarfile.XHDTYPE
        header.size = 1024**3
        with open(path, "wb") as stream:
            stream.write(header.tobuf())
        with self.assertRaises(s.SnapshotError):
            s.unpack(path, self.root, source())

    def test_inventory_rejects_duplicate_table_keys(self):
        response = ('{"table":"x","count":1}\n'
                    '{"table":"x","count":2}\n'
                    '{"schema_head":[{"version_num":"h"}]}\n')
        with mock.patch.object(s, "sql", return_value=response):
            with self.assertRaisesRegex(s.SnapshotError, "duplicate"):
                s.metadata(source())

    def test_readiness_requires_final_server_tcp(self):
        with mock.patch.object(s, "execute", return_value=b"ok") as execute:
            with s.restore_container(IMAGE):
                pass
        readiness = execute.call_args_list[1].args[0][-1]
        self.assertIn("-h 127.0.0.1", readiness)

    def test_receipt_publication_respects_cap_and_keeps_local_failure(self):
        store = mock.Mock()
        store.list.side_effect = lambda prefix: [b.Obj(prefix + "existing", 1)]
        cfg = b.Config("fixture", "", "", cap_bytes=1, tmp_dir=self.root,
                       receipt_dir=self.root, sources=())
        self.assertEqual(s.drill(cfg, store, NOW), 1)
        store.put_bytes.assert_not_called()
        receipts = [name for name in os.listdir(self.root)
                    if name.startswith("restore-") and name.endswith(".json")]
        self.assertEqual(len(receipts), 1)
        receipt_path = os.path.join(self.root, receipts[0])
        with open(receipt_path) as stream:
            self.assertFalse(json.load(stream)["ok"])

    def test_same_second_failed_drills_preserve_private_distinct_receipts(self):
        for failure in ("missing", "redacted", "admission"):
            with self.subTest(failure=failure):
                receipts = os.path.join(self.root, failure)
                error = ("restore drill failed; inspect protected operator diagnostics"
                         if failure == "redacted" else
                         "restore receipt storage admission failed; local evidence retained"
                         if failure == "admission" else
                         "paperclip: no offsite snapshot with substantiated timing")
                receipt = {"timestamp": "2026-11-08T04:20:00Z", "ok": False,
                           "databases": {}, "error": error}
                data = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
                cfg = b.Config("fixture", "", "", tmp_dir=self.root, receipt_dir=receipts,
                               cap_bytes=1 if failure == "admission" else len(data),
                               sources=(source("paperclip"), source("hindsight")))
                saved = {}
                old_umask = os.umask(0)
                try:
                    for invocation in range(2):
                        store = mock.Mock()
                        store.list.return_value = []
                        if failure == "redacted":
                            store.list.side_effect = [RuntimeError("SECRET signed URL"),
                                                      [], [], [], [], []]
                        self.assertEqual(s.drill(cfg, store, NOW), 1)
                        paths = os.listdir(receipts)
                        self.assertEqual(len(paths), invocation + 1)
                        for name in paths:
                            path = os.path.join(receipts, name)
                            with open(path, "rb") as stream:
                                actual = stream.read()
                            self.assertEqual(json.loads(actual), receipt)
                            self.assertEqual(actual, saved.get(name, data))
                            saved[name] = actual
                        if failure == "admission":
                            store.put_bytes.assert_not_called()
                        else:
                            # Admit at exactly the serialized byte cap, without a
                            # local filename leaking into the remote key/payload.
                            store.put_bytes.assert_called_once_with(data, "status/restore-last.json")
                    self.assertEqual(os.stat(receipts).st_mode & 0o777, 0o700)
                    for name in saved:
                        self.assertTrue(name.startswith("restore-20261108-042000-"))
                        self.assertTrue(name.endswith(".json"))
                        self.assertEqual(os.stat(os.path.join(receipts, name)).st_mode & 0o777, 0o600)
                finally:
                    os.umask(old_umask)

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
        store.list.side_effect = lambda prefix: ([
            b.Obj(paths[prefix[:-1]][1], os.path.getsize(paths[prefix[:-1]][0])),
            b.Obj(f"{prefix}2026/02/30/{prefix[:-1]}-20260230-042000-snapshot.tar", 1)]
            if prefix[:-1] in paths else [])
        store.download.side_effect = lambda key, dest, limit: shutil.copyfile(paths[key.split('/')[0]][0], dest)
        cfg = b.Config("fixture", "", "", tmp_dir=self.root, receipt_dir=self.root,
                       sources=(source("paperclip"), source("hindsight")))
        with mock.patch.object(s, "restore_and_compare", return_value=expected()):
            self.assertEqual(s.drill(cfg, store, NOW), 0)
        data, key = store.put_bytes.call_args.args
        self.assertEqual(key, "status/restore-last.json")
        receipts = [name for name in os.listdir(self.root)
                    if name.startswith("restore-") and name.endswith(".json")]
        self.assertEqual(len(receipts), 1)
        with open(os.path.join(self.root, receipts[0]), "rb") as stream:
            self.assertEqual(stream.read(), data)
        receipt = json.loads(data)
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
            with mock.patch.object(s, "utc_now", return_value=NOW + age):
                self.assertEqual(s.drill(cfg, store, NOW + age), 1)
            receipt = json.loads(store.put_bytes.call_args.args[0])
            self.assertFalse(receipt["ok"])
            self.assertNotIn("SECRET", json.dumps(receipt))
            if age == dt.timedelta(hours=26):
                store.download.assert_not_called()


class TimingTests(unittest.TestCase):
    def manifest(self, lower=NOW, upper=NOW):
        return {"version": 2, "database": "hindsight", "timestamp": s.timestamp(lower),
                "snapshot_acquisition": {"not_before": s.timestamp(lower),
                                         "not_after": s.timestamp(upper), "clock": s.CLOCK}}

    def test_cutoff_uses_upper_bound_strictly_and_preserves_microseconds(self):
        lower = NOW.replace(hour=4, minute=59, second=59, microsecond=999999)
        cutoff = NOW.replace(hour=5, minute=0)
        key = s.timing_key("hindsight", lower)
        for upper, safe in ((lower, True), (cutoff, False),
                            (cutoff + dt.timedelta(microseconds=1), False)):
            with self.subTest(upper=upper):
                manifest = self.manifest(lower, upper)
                if safe:
                    self.assertEqual(s.require_preincident(manifest, key, cutoff), (lower, upper))
                else:
                    with self.assertRaisesRegex(s.SnapshotError, "before incident"):
                        s.require_preincident(manifest, key, cutoff)

    def test_freshness_uses_lower_bound_and_excludes_26h_boundary(self):
        upper = NOW + dt.timedelta(hours=2)
        manifest = self.manifest(NOW, upper)
        key = s.timing_key("hindsight", NOW)
        s.require_fresh(manifest, key, NOW + dt.timedelta(hours=26, microseconds=-1))
        for observed in (NOW + dt.timedelta(hours=26), upper - dt.timedelta(microseconds=1)):
            with self.assertRaises(s.SnapshotError):
                s.require_fresh(manifest, key, observed)

    def test_interval_and_key_validation_fail_closed(self):
        key = s.timing_key("hindsight", NOW)
        for field, value in (("not_before", "2026-11-08T04:20:00Z"),
                             ("not_after", "2026-11-08T04:20:00.000000+00:00"),
                             ("not_after", "2026-02-30T04:20:00.000000Z"),
                             ("not_after", s.timestamp(NOW - dt.timedelta(microseconds=1))),
                             ("clock", "invocation")):
            manifest = self.manifest()
            manifest["snapshot_acquisition"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(s.SnapshotError):
                s.validate_timing(manifest, key)
        manifest = self.manifest()
        manifest["timestamp"] = s.timestamp(NOW + dt.timedelta(seconds=1))
        with self.assertRaises(s.SnapshotError):
            s.validate_timing(manifest, key)
        for bad_key in (key.replace("/08/", "/07/"),
                        s.timing_key("paperclip", NOW),
                        s.timing_key("hindsight", NOW + dt.timedelta(seconds=1)),
                        key.replace("20261108", "20260230"),
                        key.replace("-snapshot", "")):
            with self.subTest(key=bad_key), self.assertRaises(s.SnapshotError):
                s.validate_timing(self.manifest(), bad_key)

    def test_legacy_manifest_never_inherits_corrected_guarantee(self):
        manifest = self.manifest()
        manifest["version"] = 1
        key = s.timing_key("hindsight", NOW)
        with self.assertRaisesRegex(s.SnapshotError, "legacy"):
            s.require_preincident(manifest, key, NOW + dt.timedelta(hours=1))
        with self.assertRaisesRegex(s.SnapshotError, "legacy"):
            s.require_fresh(manifest, key, NOW)

    def test_clock_rails_detect_backward_invalid_and_observable_steps(self):
        s.check_clock(NOW, 10, NOW + dt.timedelta(seconds=2), 12)
        for end, tick in ((NOW - dt.timedelta(microseconds=1), 11),
                          (NOW + dt.timedelta(seconds=2), 9),
                          (NOW + dt.timedelta(seconds=20), 11)):
            with self.assertRaises(s.SnapshotError):
                s.check_clock(NOW, 10, end, tick)
        with self.assertRaises(s.SnapshotError):
            s.timestamp(NOW.replace(tzinfo=None))

    def test_midnight_key_and_gfs_use_conservative_lower_date(self):
        lower = NOW.replace(hour=23, minute=59, second=59, microsecond=999999)
        upper = lower + dt.timedelta(seconds=2)
        key = s.timing_key("hindsight", lower)
        self.assertIn("/2026/11/08/", key)
        self.assertEqual(s.validate_timing(self.manifest(lower, upper), key), (lower, upper))
        self.assertEqual(s.key_lower_bound(key), lower.replace(microsecond=0))


class BackupSnapshotTests(RunFixture):
    def setUp(self):
        super().setUp()
        clock = mock.patch.object(s, "utc_now", return_value=self.now)
        clock.start()
        self.addCleanup(clock.stop)

    def configure(self):
        self.cfg.sources = (source("paperclip"), source("hindsight"))

    def capture(self, source, now, dest):
        path = os.path.join(dest, source.name + ".tar")
        with open(path, "wb") as stream:
            stream.write(b"snapshot fixture")
        return path, s.timing_key(source.name, now)

    def test_native_backup_preserved_with_independent_snapshot_freshness(self):
        self.configure()
        rc = FakeRclone()
        with mock.patch.object(s, "capture", side_effect=self.capture):
            self.assertEqual(b.run(self.cfg, rc, self.now), 0)
        self.assertEqual(len(rc.uploaded), 4)
        self.assertEqual(rc.puts[b.STATUS_KEY]["snapshot_freshness"],
                         {"paperclip": True, "hindsight": True})
        self.assertFalse(os.listdir(self.tmp))

    def test_same_day_retry_recaptures_and_verifies_after_failed_verification(self):
        self.configure()
        rc = FakeRclone()

        def verify(local, key):
            # Keep native verification healthy so this test reaches the
            # supplemental retry path rather than stopping at the native gate.
            if key.startswith(s.PREFIXES):
                raise b.BackupError("snapshot verify failed")

        with mock.patch.object(rc, "verify", side_effect=verify) as verification, \
                mock.patch.object(s, "capture", side_effect=self.capture) as capture:
            self.assertEqual(b.run(self.cfg, rc, self.now), 1)
            # Simulate the snapshot object left behind by a failed verify. Merely
            # seeing this key must not let the retry bypass capture/verification.
            for src in self.cfg.sources:
                rc.store[s.timing_key(src.name, self.now)] = 1
            capture.reset_mock()
            verification.reset_mock()
            later = self.now + dt.timedelta(minutes=5)
            with mock.patch.object(s, "utc_now", return_value=later):
                self.assertEqual(b.run(self.cfg, rc, later), 1)
            self.assertEqual(capture.call_count, 2)
            self.assertTrue(verification.call_args_list[0].args[1].startswith(b.DB_PREFIX))
            self.assertTrue(any(call.args[1].startswith(s.PREFIXES)
                                for call in verification.call_args_list))
        self.assertEqual(rc.deleted, [])
        self.assertFalse(rc.puts[b.STATUS_KEY]["ok"])

    def test_template_keeps_snapshots_opt_in(self):
        path = os.path.join(os.path.dirname(__file__), "env.example")
        with open(path) as stream:
            env = dict(line.strip().split("=", 1) for line in stream
                       if line.strip() and not line.lstrip().startswith("#"))
        with mock.patch.object(s, "load_sources") as load_sources:
            cfg = b.load_config(env)
        self.assertEqual(cfg.sources, ())
        load_sources.assert_not_called()

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

    def test_delayed_captures_refresh_observation_time_before_freshness(self):
        self.configure()
        rc = FakeRclone()
        later = self.now + dt.timedelta(minutes=90)
        observed = later + dt.timedelta(minutes=1)
        manifests = {}
        original_upload = rc.upload

        @contextlib.contextmanager
        def snapshot(_):
            yield "00000003-000000A1-1"

        def dump(args, **kwargs):
            kwargs["output"].write(b"PGDMP-fixture")

        def upload(path, key):
            if s.TIMED_BUNDLE.fullmatch(key):
                src = source(key.split("/")[0])
                _, manifest = s.unpack(path, self.root, src)
                manifests[src.name] = (key, manifest)
            original_upload(path, key)

        clocks = (self.now, self.now + dt.timedelta(minutes=10), self.now + dt.timedelta(minutes=10, seconds=2),
                  later, later + dt.timedelta(seconds=2), observed, observed)
        with mock.patch.object(s, "utc_now", side_effect=clocks), \
                mock.patch.object(s.time, "monotonic", side_effect=(0, 600, 602, 5400, 5402, 5460, 5460)), \
                mock.patch.object(s, "exported_snapshot", snapshot), \
                mock.patch.object(s, "metadata", return_value=expected()), \
                mock.patch.object(s, "execute", side_effect=dump), \
                mock.patch.object(rc, "upload", side_effect=upload):
            self.assertEqual(b.run(self.cfg, rc, self.now), 0)
        key, manifest = manifests["hindsight"]
        self.assertEqual(s.validate_timing(manifest, key)[0], later)
        with self.assertRaises(s.SnapshotError):
            s.require_preincident(manifest, key, self.now + dt.timedelta(minutes=40))
        self.assertTrue(rc.puts[b.STATUS_KEY]["snapshot_freshness"]["hindsight"])

    def test_midnight_upload_uses_admitted_deletion_plan(self):
        self.configure()
        before = NOW.replace(hour=23, minute=59, second=59)
        after = before + dt.timedelta(seconds=2)
        stamp = before - dt.timedelta(minutes=15)
        native = os.path.join(self.backups, f"paperclip-{stamp:%Y%m%d-%H%M%S}.sql.gz")
        import gzip
        with gzip.open(native, "wb") as stream:
            stream.write(b"fixture")
        os.utime(native, (stamp.timestamp(),) * 2)
        mib = 1024**2
        stamps = (before.replace(month=10, day=30), before.replace(day=3),
                  before.replace(day=6), before.replace(day=7), before.replace(hour=12))
        objs = [b.Obj(s.timing_key("hindsight", t), mib * size)
                for t, size in zip(stamps, (1, 100, 1, 1, 1))]
        # Native/instance already present: exactly two small supplemental uploads.
        objs += [b.Obj(b.db_key_for(native), 1),
                 b.Obj(f"instance/{before:%Y/%m/%d}/paperclip-instance-{before:%Y%m%d-%H%M%S}.tar.gz", 1),
                 b.Obj(b.STATUS_KEY, 8192)]  # existing receipt covers replacement without growth
        rc = FakeRclone(objs)
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 0, 2, 0
        self.cfg.max_deletes = 1
        self.cfg.cap_bytes = sum(o.size for o in objs) + 2 * len(b"snapshot fixture") - 100 * mib
        with mock.patch.object(s, "capture", side_effect=self.capture), \
                mock.patch.object(s, "utc_now", side_effect=(before, before, after)), \
                mock.patch.object(s.time, "monotonic", side_effect=(0, 0, 2)):
            self.assertEqual(b.run(self.cfg, rc, before), 0)
        self.assertEqual(rc.deleted, [objs[1].key])
        self.assertLessEqual(sum(rc.store.values()), self.cfg.cap_bytes)

    def test_malformed_timed_keys_do_not_block_upload_or_get_deleted(self):
        self.configure()
        malformed = ("hindsight/2026/02/30/hindsight-20260230-042000-snapshot.tar",
                     "paperclip/2026/11/01/paperclip-20261102-042000-snapshot.tar")
        rc = FakeRclone([b.Obj(key, 10) for key in malformed])
        with mock.patch.object(s, "capture", side_effect=self.capture):
            self.assertEqual(b.run(self.cfg, rc, self.now), 0)
        self.assertEqual(len(rc.uploaded), 4)
        self.assertFalse(set(malformed) & set(rc.deleted))
        self.assertTrue(set(malformed).issubset(rc.store))

    def test_backward_observation_clock_prevents_upload_and_retention(self):
        self.configure()
        rc = FakeRclone()
        with mock.patch.object(s, "capture", side_effect=self.capture), \
                mock.patch.object(s, "utc_now", return_value=self.now - dt.timedelta(seconds=1)):
            self.assertEqual(b.run(self.cfg, rc, self.now), 1)
        self.assertEqual((rc.uploaded, rc.deleted), ([], []))

    def test_legacy_history_is_never_pruned_or_used_as_timed_floor(self):
        timed = [b.Obj(s.timing_key("hindsight", self.now - dt.timedelta(days=n)), 10)
                 for n in range(8)]
        legacy = [b.Obj(o.key.replace("-snapshot", ""), 10) for o in timed]
        plan = b.plan_retention(timed + legacy, self.now, (0, 0, 0), 10, True, "hindsight/")
        self.assertEqual(len(plan.delete), 5)
        self.assertTrue(set(plan.delete).issubset({o.key for o in timed[3:]}))
        self.assertFalse(set(plan.delete) & {o.key for o in legacy})

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
        objs = [b.Obj(s.timing_key("hindsight", stamp), 10)
                for stamp in (now - dt.timedelta(days=n) for n in range(8))]
        plan = b.plan_retention(objs, now, (0, 0, 0), 2, True, "hindsight/")
        self.assertEqual(len(plan.delete), 2)
        self.assertTrue(plan.truncated)
        self.assertFalse(set(plan.delete) & {o.key for o in objs[:3]})


if __name__ == "__main__":
    unittest.main()

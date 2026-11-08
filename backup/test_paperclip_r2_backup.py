import datetime as dt
import gzip
import json
import os
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import paperclip_r2_backup as b  # noqa: E402

UTC = dt.timezone.utc


def T(y, m, d, hh=3, mm=0, ss=0):
    return dt.datetime(y, m, d, hh, mm, ss, tzinfo=UTC)


def dbkey(ts):
    return f"db/{ts:%Y/%m/%d}/paperclip-{ts:%Y%m%d-%H%M%S}.sql.gz"


def objs_for(tss, size=10):
    return [b.Obj(dbkey(t), size) for t in tss]


def keep_set(tss, now, d, w, m):
    items = [(dbkey(t), t) for t in tss]
    return b.gfs_keep(items, now, d, w, m)


class FakeRclone:
    def __init__(self, objs=None, fail_upload=False, fail_verify=False):
        self.store = {o.key: o.size for o in (objs or [])}
        self.deleted, self.uploaded, self.puts = [], [], {}
        self.fail_upload, self.fail_verify = fail_upload, fail_verify

    def list(self, prefix):
        b.assert_managed(prefix)
        return [b.Obj(k, s) for k, s in self.store.items() if k.startswith(prefix)]

    def upload(self, local, key):
        b.assert_managed(key)
        if self.fail_upload:
            raise b.BackupError("boom")
        self.store[key] = os.path.getsize(local)
        self.uploaded.append(key)

    def verify(self, local, key):
        if self.fail_verify:
            raise b.BackupError("verify failed")

    def delete(self, key):
        b.assert_managed(key, b.DELETABLE_PREFIXES)
        self.deleted.append(key)
        self.store.pop(key)

    def put_bytes(self, data, key):
        self.puts[key] = json.loads(data)
        self.store[key] = len(data)


class GfsTests(unittest.TestCase):
    NOW = T(2026, 11, 2, 5)

    def test_daily_window_boundaries(self):
        days = [T(2026, 11, 2) - dt.timedelta(days=i) for i in range(0, 6)]
        k = keep_set(days, self.NOW, 3, 0, 0)
        self.assertEqual(k, {dbkey(d) for d in days[:3]})  # today + 2 prior

    def test_daily_newest_per_day(self):
        a, c = T(2026, 11, 2, 1), T(2026, 11, 2, 4)
        self.assertEqual(keep_set([a, c], self.NOW, 5, 0, 0), {dbkey(c)})

    def test_weekly_newest_per_iso_week(self):
        # Mon 2026-11-02 is ISO week 45. Prior weeks: 10-26 (44), 10-19 (43).
        tss = [T(2026, 10, 27), T(2026, 10, 29), T(2026, 10, 20), T(2026, 10, 13)]
        k = keep_set(tss, self.NOW, 0, 2, 0)
        # window is this week + 1 prior => weeks 45, 44 only
        self.assertEqual(k, {dbkey(T(2026, 10, 29))})

    def test_iso_week_year_edge(self):
        # 2026-12-31 (Thu) and 2027-01-01 (Fri) are both ISO week 53 of 2026.
        now = T(2027, 1, 4, 5)  # Monday, ISO 2027-W01
        a, c = T(2026, 12, 31), T(2027, 1, 1)
        k = keep_set([a, c], now, 0, 3, 0)
        self.assertEqual(k, {dbkey(c)})  # same ISO week => only newest
        # and 2026-12-28 (Mon, week 53) also same week
        k = keep_set([T(2026, 12, 28), a, c], now, 0, 3, 0)
        self.assertEqual(k, {dbkey(c)})

    def test_week_vs_calendar_year_split(self):
        # 2025-12-29 .. 2026-01-02 share ISO week 1 of 2026
        now = T(2026, 1, 5, 5)
        k = keep_set([T(2025, 12, 30), T(2026, 1, 2)], now, 0, 2, 0)
        self.assertEqual(k, {dbkey(T(2026, 1, 2))})

    def test_monthly_boundaries(self):
        now = T(2026, 11, 2, 5)
        tss = [T(2026, 11, 1), T(2026, 10, 30), T(2026, 10, 3), T(2026, 9, 30), T(2026, 8, 31)]
        k = keep_set(tss, now, 0, 0, 3)  # Nov, Oct, Sep
        self.assertEqual(k, {dbkey(T(2026, 11, 1)), dbkey(T(2026, 10, 30)),
                             dbkey(T(2026, 9, 30))})

    def test_monthly_year_wrap(self):
        now = T(2027, 1, 15, 5)
        tss = [T(2026, 12, 31), T(2026, 11, 30), T(2026, 10, 31)]
        k = keep_set(tss, now, 0, 0, 2)  # Jan, Dec
        self.assertEqual(k, {dbkey(T(2026, 12, 31))})

    def test_zero_windows_keep_nothing(self):
        self.assertEqual(keep_set([T(2026, 11, 2)], self.NOW, 0, 0, 0), set())

    def test_future_dated_ignored_by_windows(self):
        k = keep_set([T(2026, 12, 20)], self.NOW, 5, 5, 5)
        self.assertEqual(k, set())


class RetentionRailTests(unittest.TestCase):
    NOW = T(2026, 11, 2, 5)

    def daily_objs(self, n):
        return objs_for([T(2026, 11, 2, 4) - dt.timedelta(days=i) for i in range(n)])

    def plan(self, objs, ret=(3, 0, 0), maxd=40, ok=True, prefix="db/"):
        return b.plan_retention(objs, self.NOW, ret, maxd, ok, prefix)

    def test_deletes_outside_windows(self):
        objs = self.daily_objs(10)
        p = self.plan(objs, (5, 0, 0))
        self.assertEqual(len(p.delete), 5)
        self.assertEqual(p.delete[0], objs[-1].key)  # oldest first

    def test_no_delete_when_upload_failed(self):
        p = self.plan(self.daily_objs(10), ok=False)
        self.assertEqual(p.delete, [])
        self.assertTrue(p.skipped_reason)

    def test_no_delete_when_newest_stale(self):
        objs = objs_for([T(2026, 10, 25), T(2026, 10, 24), T(2026, 10, 23),
                         T(2026, 10, 22), T(2026, 10, 21)])
        p = self.plan(objs)
        self.assertEqual(p.delete, [])
        self.assertIn("48h", p.skipped_reason)

    def test_newest_exactly_within_48h_allows(self):
        newest = self.NOW - dt.timedelta(hours=47)
        objs = objs_for([newest - dt.timedelta(days=i) for i in range(8)])
        self.assertTrue(self.plan(objs, (1, 0, 0)).delete)

    def test_always_keep_newest_three(self):
        objs = self.daily_objs(5)
        p = self.plan(objs, (0, 0, 0))
        self.assertEqual(set(p.delete), {o.key for o in objs[3:]})
        self.assertEqual(p.kept, 3)

    def test_keep_three_even_within_same_day(self):
        objs = objs_for([T(2026, 11, 2, h) for h in (1, 2, 3, 4)])
        p = self.plan(objs, (1, 0, 0))
        self.assertEqual(p.delete, [objs[0].key])

    def test_max_deletes(self):
        p = self.plan(self.daily_objs(30), (3, 0, 0), maxd=4)
        self.assertEqual(len(p.delete), 4)
        self.assertTrue(p.truncated)
        # the oldest are removed first
        all_old = sorted(o.key for o in self.daily_objs(30))
        self.assertEqual(p.delete, all_old[:4])

    def test_max_deletes_zero(self):
        self.assertEqual(self.plan(self.daily_objs(30), maxd=0).delete, [])

    def test_unparseable_keys_untouched(self):
        objs = self.daily_objs(6) + [b.Obj("db/notes.txt", 1)]
        p = self.plan(objs, (3, 0, 0))
        self.assertNotIn("db/notes.txt", p.delete)

    def test_non_deletable_prefix_rejected(self):
        for prefix in ("status/", "data/", "ops/", ""):
            with self.assertRaises(b.BackupError):
                b.plan_retention([], self.NOW, (1, 1, 1), 5, True, prefix)

    def test_object_outside_prefix_rejected(self):
        with self.assertRaises(b.BackupError):
            self.plan([b.Obj("data/paperclip-20261101-010101.sql.gz", 1)])

    def test_empty_prefix(self):
        self.assertEqual(self.plan([]).delete, [])


class PrefixGuardTests(unittest.TestCase):
    def test_assert_managed(self):
        b.assert_managed("db/2026/x")
        b.assert_managed("status/last-run.json")
        for bad in ("data/x", "ops/x", "/db/x", "db/../data/x", "dbx/y", ""):
            with self.assertRaises(b.BackupError, msg=bad):
                b.assert_managed(bad)

    def test_delete_guard_excludes_status(self):
        with self.assertRaises(b.BackupError):
            b.assert_managed("status/last-run.json", b.DELETABLE_PREFIXES)

    def test_real_wrapper_refuses_before_spawning(self):
        rc = b.Rclone("bucket", binary="/nonexistent/rclone")
        with self.assertRaises(b.BackupError) as cm:
            rc.delete("data/legacy")
        self.assertIn("managed prefixes", str(cm.exception))
        with self.assertRaises(b.BackupError) as cm:
            rc.list("ops/")
        self.assertIn("managed prefixes", str(cm.exception))


class DumpSelectionTests(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.d, ignore_errors=True))
        self.now = time.time()

    def mk(self, name, age_s, good=True, content=b"data" * 100):
        p = os.path.join(self.d, name)
        if good:
            with gzip.open(p, "wb") as f:
                f.write(content)
        else:
            with open(p, "wb") as f:
                f.write(b"not gzip at all")
        os.utime(p, (self.now - age_s, self.now - age_s))
        return p

    def test_picks_newest_complete(self):
        self.mk("paperclip-20261101-010000.sql.gz", 7200)
        new = self.mk("paperclip-20261101-020000.sql.gz", 3600)
        self.assertEqual(b.newest_complete_dump(self.d, self.now), new)

    def test_skips_mid_write(self):
        old = self.mk("paperclip-20261101-010000.sql.gz", 7200)
        self.mk("paperclip-20261101-020000.sql.gz", 60)  # < 10 min
        self.assertEqual(b.newest_complete_dump(self.d, self.now), old)

    def test_skips_corrupt_gzip(self):
        old = self.mk("paperclip-20261101-010000.sql.gz", 7200)
        self.mk("paperclip-20261101-020000.sql.gz", 3600, good=False)
        self.assertEqual(b.newest_complete_dump(self.d, self.now), old)

    def test_skips_truncated_gzip(self):
        old = self.mk("paperclip-20261101-010000.sql.gz", 7200)
        p = self.mk("paperclip-20261101-020000.sql.gz", 3600,
                    content=os.urandom(200000))
        data = open(p, "rb").read()
        open(p, "wb").write(data[: len(data) // 2])
        os.utime(p, (self.now - 3600,) * 2)
        self.assertEqual(b.newest_complete_dump(self.d, self.now), old)

    def test_ignores_other_names_and_empty(self):
        self.mk("random.sql.gz", 7200)
        self.mk("paperclip-20261101-010000.sql.gz.tmp", 7200)
        self.assertIsNone(b.newest_complete_dump(self.d, self.now))

    def test_missing_dir(self):
        self.assertIsNone(b.newest_complete_dump(self.d + "/nope", self.now))

    def test_db_key(self):
        self.assertEqual(b.db_key_for("/x/paperclip-20261101-233716.sql.gz"),
                         "db/2026/11/01/paperclip-20261101-233716.sql.gz")


class RunFixture(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.backups = os.path.join(self.root, "backups")
        self.inst = os.path.join(self.root, "inst")
        self.tmp = os.path.join(self.root, "tmp")
        os.makedirs(self.backups)
        os.makedirs(os.path.join(self.inst, "companies/a"))
        os.makedirs(os.path.join(self.inst, "secrets"))
        os.makedirs(os.path.join(self.inst, "projects"))
        for rel, data in (("config.json", "{}"), ("companies/a/f.txt", "hi"),
                          ("secrets/master.key", "KEY"), ("projects/big", "x"),
                          (".env", "S=1")):
            with open(os.path.join(self.inst, rel), "w") as f:
                f.write(data)
        self.now = T(2026, 11, 2, 4, 20)
        clock = mock.patch.object(b.snapshots, "utc_now", return_value=self.now)
        self.clock = clock.start()
        self.addCleanup(clock.stop)
        p = os.path.join(self.backups, "paperclip-20261102-003716.sql.gz")
        with gzip.open(p, "wb") as f:
            f.write(b"sql" * 100)
        age = self.now.timestamp() - 3600
        os.utime(p, (age, age))
        self.cfg = b.Config(bucket="bk", backup_dir=self.backups, instance_dir=self.inst,
                            tmp_dir=self.tmp, cap_bytes=10**9)



class RunTests(RunFixture):
    def test_happy_path_uploads_and_status(self):
        rc = FakeRclone()
        code = b.run(self.cfg, rc, self.now)
        self.assertEqual(code, 0)
        self.assertEqual(len(rc.uploaded), 2)
        self.assertIn("db/2026/11/02/paperclip-20261102-003716.sql.gz", rc.uploaded)
        self.assertTrue(any(k.startswith("instance/2026/11/02/paperclip-instance-20261102-042000")
                            for k in rc.uploaded))
        st = rc.puts["status/last-run.json"]
        self.assertTrue(st["ok"])
        self.assertEqual(st["exit_code"], 0)
        self.assertEqual(len(st["uploaded"]), 2)
        self.assertFalse(os.listdir(self.tmp))  # temp removed

    def test_idempotent_second_run(self):
        rc = FakeRclone()
        b.run(self.cfg, rc, self.now)
        n = len(rc.uploaded)
        self.clock.return_value = self.now + dt.timedelta(minutes=5)
        self.assertEqual(b.run(self.cfg, rc, self.clock.return_value), 0)
        self.assertEqual(len(rc.uploaded), n)

    def test_instance_tar_excludes_secrets_by_default(self):
        out = b.build_instance_tar(self.cfg, self.now, self.root)
        with tarfile.open(out) as t:
            names = t.getnames()
        self.assertIn("instance/config.json", names)
        self.assertIn("instance/companies/a/f.txt", names)
        self.assertFalse([n for n in names if "secrets" in n or "projects" in n
                          or n.endswith(".env")])

    def test_instance_tar_include_secrets_opt_in(self):
        self.cfg.include_secrets = True
        out = b.build_instance_tar(self.cfg, self.now, self.root)
        with tarfile.open(out) as t:
            self.assertIn("instance/secrets/master.key", t.getnames())

    def test_include_secrets_env_default_off(self):
        env = {"BACKUP_BUCKET": "x"}
        self.assertFalse(b.load_config(env).include_secrets)
        env["INCLUDE_SECRETS"] = "true"
        self.assertTrue(b.load_config(env).include_secrets)

    def test_cap_reached_no_upload_exit_2_status_cannot_grow_over_cap(self):
        self.cfg.cap_bytes = 100
        old = objs_for([T(2026, 10, 1) + dt.timedelta(days=i) for i in range(10)], size=50)
        rc = FakeRclone(old)
        code = b.run(self.cfg, rc, self.now)
        self.assertEqual(code, 2)
        self.assertEqual(rc.uploaded, [])
        self.assertEqual(rc.deleted, [])
        self.assertNotIn(b.STATUS_KEY, rc.puts)
        self.assertEqual(sum(rc.store.values()), 500)
        self.assertFalse(os.listdir(self.tmp))

    def test_upload_failure_blocks_retention_exit_1(self):
        old = objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(60)])
        rc = FakeRclone(old, fail_upload=True)
        self.assertEqual(b.run(self.cfg, rc, self.now), 1)
        self.assertEqual(rc.deleted, [])
        self.assertFalse(rc.puts["status/last-run.json"]["ok"])

    def test_verify_failure_blocks_retention(self):
        old = objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(60)])
        rc = FakeRclone(old, fail_verify=True)
        self.assertEqual(b.run(self.cfg, rc, self.now), 1)
        self.assertEqual(rc.deleted, [])

    def test_retention_runs_and_never_touches_foreign_keys(self):
        old = objs_for([T(2026, 9, 1, 4) + dt.timedelta(days=i) for i in range(60)])
        foreign = [b.Obj("data/legacy-20250101-000000.bin", 5), b.Obj("ops/x", 5)]
        rc = FakeRclone(old + foreign)
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 5, 0, 0
        self.assertEqual(b.run(self.cfg, rc, self.now), 0)
        self.assertTrue(rc.deleted)
        self.assertTrue(all(k.startswith(("db/", "instance/")) for k in rc.deleted))
        self.assertIn("data/legacy-20250101-000000.bin", rc.store)
        self.assertIn("ops/x", rc.store)

    def test_max_deletes_across_prefixes(self):
        old = objs_for([T(2026, 9, 1, 4) + dt.timedelta(days=i) for i in range(60)])
        rc = FakeRclone(old)
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        self.cfg.instance_retain_daily = 3
        self.cfg.max_deletes = 7
        b.run(self.cfg, rc, self.now)
        self.assertEqual(len(rc.deleted), 7)

    def test_dry_run_touches_nothing(self):
        old = objs_for([T(2026, 9, 1, 4) + dt.timedelta(days=i) for i in range(60)])
        rc = FakeRclone(old)
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        before = dict(rc.store)
        self.assertEqual(b.run(self.cfg, rc, self.now, dry_run=True), 0)
        self.assertEqual(rc.store, before)
        self.assertEqual((rc.uploaded, rc.deleted, rc.puts), ([], [], {}))
        self.assertFalse(os.path.exists(self.tmp))

    def test_no_dump_is_error_without_deletes(self):
        os.remove(os.path.join(self.backups, os.listdir(self.backups)[0]))
        old = objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(60)])
        rc = FakeRclone(old)
        self.assertEqual(b.run(self.cfg, rc, self.now), 1)
        self.assertEqual(rc.deleted, [])

    def test_status_has_no_env_or_host_fields(self):
        rc = FakeRclone()
        b.run(self.cfg, rc, self.now)
        blob = json.dumps(rc.puts["status/last-run.json"])
        for needle in (self.root, "ubuntu", "ACCESS"):
            self.assertNotIn(needle, blob)

    def test_config_requires_bucket(self):
        with self.assertRaises(b.BackupError):
            b.load_config({})
        with self.assertRaises(b.BackupError):
            b.load_config({"BACKUP_BUCKET": "x", "RETAIN_DAILY": "abc"})


class NativeIntegrityRclone(FakeRclone):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.verified = []
        self.data = {}

    def upload(self, local, key):
        super().upload(local, key)
        with open(local, "rb") as fh:
            self.data[key] = fh.read()

    def verify(self, local, key):
        self.verified.append(key)
        super().verify(local, key)
        if self.store.get(key) != os.path.getsize(local):
            raise b.BackupError("verify failed: remote size mismatch")
        with open(local, "rb") as fh:
            if key in self.data and self.data[key] != fh.read():
                raise b.BackupError("verify failed: checksum mismatch")


class NativeRetryTests(RunFixture):
    def setUp(self):
        super().setUp()
        self.dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        self.key = b.db_key_for(self.dump)
        self.old = objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(20)], 50)
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        self.cfg.max_deletes = 2

    def test_same_day_retry_requires_native_verification(self):
        instance = b.Obj("instance/2026/11/02/paperclip-instance-20261102-040000.tar.gz", 10)
        rc = NativeIntegrityRclone(self.old + [instance], fail_verify=True)
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.assertIn(self.key, rc.store)  # upload succeeded before verify failed
        self.assertEqual(rc.deleted, [])
        uploaded = list(rc.uploaded)
        rc.verified.clear()

        self.clock.return_value = self.now + dt.timedelta(minutes=5)
        self.assertEqual(b.run(self.cfg, rc, self.clock.return_value), b.EXIT_ERROR)
        self.assertEqual(rc.verified, [self.key])
        self.assertEqual(rc.uploaded, uploaded)
        self.assertEqual(rc.deleted, [])
        self.assertFalse(rc.puts[b.STATUS_KEY]["ok"])
        self.assertEqual(rc.puts[b.STATUS_KEY]["exit_code"], b.EXIT_ERROR)

        rc.fail_verify = False
        rc.verified.clear()
        self.clock.return_value = self.now + dt.timedelta(minutes=10)
        self.assertEqual(b.run(self.cfg, rc, self.clock.return_value), b.EXIT_OK)
        self.assertEqual(rc.verified[0], self.key)
        self.assertEqual(rc.uploaded.count(self.key), 1)  # verified without reuploading
        self.assertTrue(rc.puts[b.STATUS_KEY]["ok"])
        self.assertEqual(len(rc.deleted), self.cfg.max_deletes)

    def test_damaged_and_wrong_size_leftovers_block_success_and_retention(self):
        for damage in ("checksum", "size"):
            with self.subTest(damage=damage):
                rc = NativeIntegrityRclone(self.old, fail_verify=True)
                self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
                data = rc.data[self.key]
                rc.data[self.key] = bytes([data[0] ^ 1]) + data[1:] if damage == "checksum" else data[:-1]
                rc.store[self.key] = len(rc.data[self.key])
                rc.fail_verify = False
                rc.verified.clear()
                uploaded = list(rc.uploaded)

                self.assertEqual(b.run(self.cfg, rc, self.now + dt.timedelta(minutes=5)), b.EXIT_ERROR)
                self.assertEqual(rc.verified, [self.key])
                self.assertEqual(rc.uploaded, uploaded)
                self.assertEqual(rc.deleted, [])
                self.assertFalse(rc.puts[b.STATUS_KEY]["ok"])
                self.assertIn(damage, rc.puts[b.STATUS_KEY]["error"])

    def test_different_same_day_key_requires_upload_and_verification(self):
        rc = NativeIntegrityRclone(self.old + objs_for([T(2026, 11, 2, 0)]))
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_OK)
        self.assertIn(self.key, rc.uploaded)
        self.assertIn(self.key, rc.verified)
        self.assertTrue(rc.puts[b.STATUS_KEY]["ok"])

    def test_cap_retry_verifies_native_before_any_pruning(self):
        rc = NativeIntegrityRclone(self.old, fail_verify=True)
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.cfg.cap_bytes = 1
        rc.verified.clear()
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.assertEqual(rc.verified, [self.key])
        self.assertEqual(rc.deleted, [])
        self.assertFalse(rc.puts[b.STATUS_KEY]["ok"])

        rc.fail_verify = False
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_CAP)
        self.assertEqual(len(rc.deleted), self.cfg.max_deletes)
        self.assertFalse(rc.puts[b.STATUS_KEY]["ok"])

    def test_cap_without_verified_native_never_prunes(self):
        self.cfg.cap_bytes = 1
        for same_day in ([], objs_for([T(2026, 11, 2, 0)])):
            with self.subTest(same_day=bool(same_day)):
                rc = NativeIntegrityRclone(self.old + same_day)
                before = dict(rc.store)
                self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_CAP)
                self.assertEqual(rc.verified, [])
                self.assertEqual(rc.uploaded, [])
                self.assertEqual(rc.deleted, [])
                self.assertNotIn(b.STATUS_KEY, rc.puts)
                self.assertEqual(rc.store, before)

    def test_real_verifier_rejects_size_and_checksum_failures(self):
        from unittest import mock
        rc = b.Rclone("fixture", binary="/nonexistent/rclone")
        size = os.path.getsize(self.dump)
        with mock.patch.object(rc, "_run", return_value=json.dumps([{"Size": size - 1}])) as run:
            with self.assertRaisesRegex(b.BackupError, "size mismatch"):
                rc.verify(self.dump, self.key)
            self.assertEqual(run.call_count, 1)

        listing = json.dumps([{"Size": size}])
        with mock.patch.object(rc, "_run", side_effect=[listing, b.BackupError("rclone check failed")]) as run:
            with self.assertRaisesRegex(b.BackupError, "check failed"):
                rc.verify(self.dump, self.key)
            self.assertEqual(run.call_args.args[0], [
                "check", "--one-way", "--include", "/" + os.path.basename(self.dump),
                self.backups, rc._target(self.key.rsplit("/", 1)[0])])

        with mock.patch.object(rc, "_run", side_effect=[listing, ""]) as run:
            rc.verify(self.dump, self.key)
            self.assertEqual(run.call_count, 2)

    def test_dry_run_does_not_verify_existing_native(self):
        rc = NativeIntegrityRclone()
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_OK)
        rc.verified.clear()
        uploaded, deleted, puts = list(rc.uploaded), list(rc.deleted), dict(rc.puts)
        self.assertEqual(b.run(self.cfg, rc, self.now, dry_run=True), b.EXIT_OK)
        self.assertEqual(rc.verified, [])
        self.assertEqual((rc.uploaded, rc.deleted, rc.puts), (uploaded, deleted, puts))


class ClockSanityTests(RunFixture):
    def pruned_store(self, n=41, size=10):
        # steady state: n db objects, one per day ending the day before now
        return objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(n)], size)

    def test_future_dated_objects_abort_retention(self):
        # host clock jumped back to January: every remote object is "in the future"
        now = T(2026, 1, 10, 4, 20)
        self.clock.return_value = now
        p = os.path.join(self.backups, "paperclip-20260110-003716.sql.gz")
        with gzip.open(p, "wb") as f:
            f.write(b"sql")
        os.utime(p, (now.timestamp() - 3600,) * 2)
        os.remove(os.path.join(self.backups, "paperclip-20261102-003716.sql.gz"))
        rc = FakeRclone(self.pruned_store())
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 30, 12, 12
        code = b.run(self.cfg, rc, now)
        self.assertEqual(code, 1)
        self.assertEqual(rc.deleted, [])
        self.assertFalse(rc.puts["status/last-run.json"]["ok"])

    def test_clock_jump_forward_skips_retention_and_exits_nonzero(self):
        now = T(2028, 11, 2, 4, 20)
        self.clock.return_value = now
        p = os.path.join(self.backups, "paperclip-20281102-003716.sql.gz")
        with gzip.open(p, "wb") as f:
            f.write(b"sql")
        os.utime(p, (now.timestamp() - 3600,) * 2)
        rc = FakeRclone(self.pruned_store())
        code = b.run(self.cfg, rc, now)
        self.assertEqual(code, 1)
        self.assertEqual(rc.deleted, [])
        self.assertIn("db/2028/11/02/paperclip-20281102-003716.sql.gz", rc.uploaded)
        self.assertFalse(rc.puts["status/last-run.json"]["ok"])

    def test_default_max_deletes_is_small(self):
        self.assertLessEqual(b.load_config({"BACKUP_BUCKET": "x"}).max_deletes, 4)
        # even a "bad" run can only delete max_deletes objects from the 41-object history
        self.cfg.retain_daily = 3
        self.cfg.max_deletes = b.DEFAULT_MAX_DELETES
        rc = FakeRclone(self.pruned_store())
        b.run(self.cfg, rc, self.now)
        self.assertLessEqual(len(rc.deleted), 4)

    def test_stale_dump_fails_even_if_day_present(self):
        now = self.now + dt.timedelta(days=5)
        rc = FakeRclone(objs_for([T(2026, 11, 2, 0, 37)]))
        code = b.run(self.cfg, rc, now)
        self.assertEqual(code, 1)
        self.assertEqual(rc.uploaded, [])
        st = rc.puts["status/last-run.json"]
        self.assertFalse(st["ok"])
        self.assertIn("26h", st["error"])

    def test_dump_age_boundary(self):
        # dump named 00:37, 25h later is still accepted
        rc = FakeRclone()
        self.clock.return_value = T(2026, 11, 2, 0, 37) + dt.timedelta(hours=25)
        self.assertEqual(b.run(self.cfg, rc, self.clock.return_value), 0)


class CapProjectionTests(RunFixture):
    def test_retention_frees_space_so_run_proceeds(self):
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 7, 0, 0
        self.cfg.instance_retain_daily = 7
        self.cfg.max_deletes = 100
        rc = FakeRclone(objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(39)], 100))
        self.cfg.cap_bytes = 3950
        for day in range(3):
            now = self.now + dt.timedelta(days=day)
            self.clock.return_value = now
            name = f"paperclip-{now - dt.timedelta(hours=4):%Y%m%d-%H%M%S}.sql.gz"
            p = os.path.join(self.backups, name)
            with gzip.open(p, "wb") as f:
                f.write(b"sql" * 100)
            os.utime(p, (now.timestamp() - 3600,) * 2)
            code = b.run(self.cfg, rc, now)
            self.assertEqual(code, 0, f"run {day}")
        self.assertTrue(rc.deleted)
        self.assertTrue(any(k.startswith("db/2026/11/02/") for k in rc.store))

    def test_cap_still_blocks_when_retention_cannot_help(self):
        self.cfg.cap_bytes = 100
        rc = FakeRclone(objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(3)], 50))
        self.assertEqual(b.run(self.cfg, rc, self.now), 2)
        self.assertEqual(rc.uploaded, [])

    def test_cap_breach_still_prunes_after_native_verification(self):
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        self.cfg.max_deletes = 2
        self.cfg.cap_bytes = 100
        rc = NativeIntegrityRclone(objs_for(
            [T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(20)], 50))
        dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        key = b.db_key_for(dump)
        rc.upload(dump, key)
        rc.uploaded.clear()
        self.assertEqual(b.run(self.cfg, rc, self.now), 2)
        self.assertEqual(rc.verified, [key])
        self.assertEqual(len(rc.deleted), 2)
        self.assertEqual(rc.uploaded, [])

    def test_dry_run_reports_cap(self):
        self.cfg.cap_bytes = 100
        rc = FakeRclone(objs_for([T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(3)], 50))
        self.assertEqual(b.run(self.cfg, rc, self.now, dry_run=True), 2)
        self.assertEqual((rc.uploaded, rc.deleted), ([], []))


class InheritedBoundaryTests(RunFixture):
    def test_native_only_upload_ages_dump_from_25h_to_27h(self):
        invoked = T(2026, 11, 2, 0, 37, 16) + dt.timedelta(hours=25)
        finished = invoked + dt.timedelta(hours=2)
        rc = FakeRclone(objs_for([invoked - dt.timedelta(hours=25, days=i) for i in range(9)]))
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 0, 0, 0
        with mock.patch.object(b.snapshots, "utc_now", side_effect=(invoked, invoked, finished)), \
                mock.patch.object(b.snapshots.time, "monotonic", side_effect=(0, 0, 7200)):
            self.assertEqual(b.run(self.cfg, rc, invoked), b.EXIT_ERROR)
        self.assertIn("26h", rc.puts[b.STATUS_KEY]["error"])
        self.assertFalse(rc.puts[b.STATUS_KEY]["ok"])
        self.assertEqual(rc.deleted, [])

    def test_exact_data_cap_reserves_status_growth_before_upload(self):
        instance = f"instance/{self.now:%Y/%m/%d}/paperclip-instance-{self.now:%Y%m%d-%H%M%S}.tar.gz"
        rc = FakeRclone([b.Obj(instance, 10), b.Obj(b.STATUS_KEY, 2)])
        dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        self.cfg.cap_bytes = sum(rc.store.values()) + os.path.getsize(dump)
        with mock.patch.object(b.snapshots, "utc_now", return_value=self.now):
            self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_CAP)
        self.assertEqual(rc.uploaded, [])
        self.assertLessEqual(sum(rc.store.values()), self.cfg.cap_bytes)

    def test_no_upload_cap_recovery_never_prunes_stale_offsite_backups(self):
        invoked = T(2026, 11, 3, 2, 30)
        stamp = T(2026, 11, 2, 23)
        local = os.path.join(self.backups, f"paperclip-{stamp:%Y%m%d-%H%M%S}.sql.gz")
        with gzip.open(local, "wb") as stream:
            stream.write(b"sql")
        os.utime(local, (invoked.timestamp() - 3600,) * 2)
        self.clock.return_value = invoked
        stale = T(2026, 11, 2, 0)
        objs = objs_for([stale - dt.timedelta(days=i) for i in range(9)])
        objs += [b.Obj(f"instance/{invoked:%Y/%m/%d}/paperclip-instance-{invoked:%Y%m%d-%H%M%S}.tar.gz", 10),
                 b.Obj(b.STATUS_KEY, 2)]
        rc = FakeRclone(objs)
        self.cfg.cap_bytes = sum(rc.store.values())
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 0, 0, 0
        with mock.patch.object(b, "log") as logged:
            self.assertEqual(b.run(self.cfg, rc, invoked), b.EXIT_CAP)
        self.assertIn("cap recovery requires a fresh offsite backup or reviewed manual cleanup",
                      "\n".join(call.args[0] for call in logged.call_args_list))
        self.assertEqual(rc.uploaded, [])
        self.assertEqual(rc.deleted, [])

    def test_cap_recovery_dry_run_requires_existing_exact_native_dump(self):
        dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        key = b.db_key_for(dump)
        history = objs_for([self.now - dt.timedelta(days=i) for i in range(1, 10)], 50)
        self.cfg.cap_bytes = 1
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        self.cfg.max_deletes = 2
        for exact in (False, True):
            expected = [obj.key for obj in reversed(history[-2:])] if exact else []
            for dry_run in (False, True):
                with self.subTest(exact=exact, dry_run=dry_run):
                    rc = NativeIntegrityRclone(history)
                    if exact:
                        rc.upload(dump, key)
                        rc.uploaded.clear()
                    before = dict(rc.store)
                    with mock.patch.object(b, "log") as logged:
                        self.assertEqual(b.run(self.cfg, rc, self.now, dry_run), b.EXIT_CAP)
                    proposed = [call.args[0].removeprefix("dry-run: would delete ")
                                for call in logged.call_args_list
                                if call.args[0].startswith("dry-run: would delete ")]
                    self.assertEqual(rc.uploaded, [])
                    self.assertEqual(rc.puts, {})
                    if dry_run:
                        self.assertEqual(proposed, expected)
                        self.assertEqual(rc.verified, [])
                        self.assertEqual(rc.deleted, [])
                        self.assertEqual(rc.store, before)
                    else:
                        self.assertEqual(rc.verified, [key] if exact else [])
                        self.assertEqual(rc.deleted, expected)

    def test_cap_recovery_dry_run_matches_supplemental_freshness(self):
        dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        instance = f"instance/{self.now:%Y/%m/%d}/paperclip-instance-{self.now:%Y%m%d-%H%M%S}.tar.gz"
        self.cfg.cap_bytes = 1
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        self.cfg.max_deletes = 4
        for name in ("paperclip", "hindsight"):
            self.cfg.sources = (b.snapshots.Source(name, name, "public.fixture", ("id",), "fixture"),)
            for age in (27, 26, 25):
                stamp = self.now - dt.timedelta(hours=age)
                history = [b.snapshots.timing_key(name, stamp - dt.timedelta(days=i))
                           for i in range(9)]
                objs = [b.Obj(b.db_key_for(dump), 10), b.Obj(instance, 10)]
                objs += [b.Obj(key, 50) for key in history]
                expected = list(reversed(history[-4:])) if age < 26 else []
                for dry_run in (False, True):
                    with self.subTest(source=name, age=age, dry_run=dry_run):
                        rc = FakeRclone(objs)
                        before = dict(rc.store)
                        captured = (dump, b.snapshots.timing_key(name, self.now))
                        with mock.patch.object(b.snapshots, "capture", return_value=captured) as capture, \
                                mock.patch.object(b, "log") as logged:
                            self.assertEqual(b.run(self.cfg, rc, self.now, dry_run), b.EXIT_CAP)
                        messages = [call.args[0] for call in logged.call_args_list]
                        proposed = [line.removeprefix("dry-run: would delete ") for line in messages
                                    if line.startswith("dry-run: would delete ")]
                        self.assertEqual(rc.uploaded, [])
                        self.assertEqual(rc.puts, {})
                        if dry_run:
                            capture.assert_not_called()
                            self.assertEqual(rc.store, before)
                            self.assertEqual(rc.deleted, [])
                            self.assertEqual(proposed, expected)
                        else:
                            capture.assert_called_once()
                            self.assertEqual(rc.deleted, expected)
                            self.assertEqual(rc.store, {k: v for k, v in before.items()
                                                        if k not in expected})
                        if age >= 26:
                            self.assertTrue(any(name + ": newest offsite dump is not fresh"
                                                in line for line in messages))

    def test_cap_recovery_delete_failure_does_not_advise_fresh_backup(self):
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 3, 0, 0
        self.cfg.max_deletes = 2
        self.cfg.cap_bytes = 100
        dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        rc = NativeIntegrityRclone(objs_for(
            [T(2026, 11, 1, 4) - dt.timedelta(days=i) for i in range(20)], 50))
        rc.upload(dump, b.db_key_for(dump))
        rc.uploaded.clear()
        before = dict(rc.store)
        with mock.patch.object(rc, "delete", side_effect=b.BackupError("deletion denied")) as delete, \
                mock.patch.object(b, "log") as logged:
            self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_CAP)
        messages = "\n".join(call.args[0] for call in logged.call_args_list)
        self.assertIn("retention skipped: deletion denied", messages)
        self.assertNotIn("cap recovery requires a fresh", messages)
        delete.assert_called_once()
        self.assertEqual(rc.uploaded, [])
        self.assertEqual(rc.store, before)

    def test_dry_run_reserves_real_status_growth_without_writes(self):
        dump = os.path.join(self.backups, os.listdir(self.backups)[0])
        instance = f"instance/{self.now:%Y/%m/%d}/paperclip-instance-{self.now:%Y%m%d-%H%M%S}.tar.gz"
        rc = FakeRclone([b.Obj(b.db_key_for(dump), 10), b.Obj(instance, 10), b.Obj(b.STATUS_KEY, 2)])
        before = dict(rc.store)
        self.cfg.cap_bytes = sum(rc.store.values()) + 10
        self.assertEqual(b.run(self.cfg, rc, self.now, dry_run=True), b.EXIT_CAP)
        self.assertEqual(rc.store, before)
        self.assertEqual((rc.uploaded, rc.deleted, rc.puts), ([], [], {}))

    def test_native_only_clock_faults_fail_before_retention(self):
        for observed, ticks in ((self.now - dt.timedelta(seconds=1), (0, 0, 1)),
                                (self.now + dt.timedelta(seconds=20), (0, 0, 1))):
            with self.subTest(observed=observed):
                rc = FakeRclone()
                with mock.patch.object(b.snapshots, "utc_now", side_effect=(self.now, self.now, observed)), \
                        mock.patch.object(b.snapshots.time, "monotonic", side_effect=ticks):
                    self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
                self.assertEqual(rc.deleted, [])
                self.assertIn("clock", rc.puts[b.STATUS_KEY]["error"])

    def test_status_replacement_exact_cap_and_one_byte_over(self):
        # Fixed serialized bytes isolate the replacement arithmetic from JSON length.
        data = b'{"ok":true}'
        for previous in (0, 2, len(data), 2048):
            for spare in (0, -1):
                with self.subTest(previous=previous, spare=spare):
                    dump = os.path.join(self.backups, os.listdir(self.backups)[0])
                    instance = f"instance/{self.now:%Y/%m/%d}/paperclip-instance-{self.now:%Y%m%d-%H%M%S}.tar.gz"
                    objs = [b.Obj(b.db_key_for(dump), 10), b.Obj(instance, 10),
                            b.Obj("status/restore-last.json", 5)]
                    if previous:
                        objs.append(b.Obj(b.STATUS_KEY, previous))
                    rc = FakeRclone(objs)
                    # No shrink credit at admission, but exact replacement at publication.
                    self.cfg.cap_bytes = 25 + max(previous, len(data)) + spare
                    with mock.patch.object(b, "status_data", return_value=data):
                        code = b.run(self.cfg, rc, self.now)
                    self.assertEqual(code, b.EXIT_OK if spare == 0 else b.EXIT_CAP)
                    self.assertLessEqual(sum(rc.store.values()), max(self.cfg.cap_bytes, 25 + previous))
                    self.assertEqual(rc.uploaded, [])
                    self.assertEqual(rc.store["status/restore-last.json"], 5)

    def test_actual_serialized_success_is_reserved(self):
        rc = FakeRclone()
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_OK)
        status = rc.puts[b.STATUS_KEY]
        self.assertEqual(status["projected_bytes"], sum(rc.store.values()))
        self.assertEqual(rc.store[b.STATUS_KEY], len(b.status_data(status)))

    def test_error_status_is_written_when_it_fits(self):
        self.cfg.cap_bytes = 4096
        rc = FakeRclone([b.Obj(b.STATUS_KEY, 4096)])
        # Upload admission fails, but replacing the old receipt with the cap error fits.
        self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_CAP)
        self.assertEqual(rc.uploaded, [])
        self.assertEqual(rc.puts[b.STATUS_KEY]["exit_code"], b.EXIT_CAP)
        self.assertIn("cap reached", rc.puts[b.STATUS_KEY]["error"])
        self.assertLessEqual(sum(rc.store.values()), self.cfg.cap_bytes)

    def test_partial_upload_error_cannot_overwrite_status_past_cap(self):
        rc = FakeRclone([b.Obj(b.STATUS_KEY, 2)], fail_verify=True)
        # The verify error is larger than the reserved success receipt.
        with mock.patch.object(rc, "verify", side_effect=b.BackupError("x" * 5000)):
            self.cfg.cap_bytes = 4096
            self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.assertEqual(len(rc.uploaded), 1)
        self.assertEqual(rc.deleted, [])
        self.assertEqual(rc.store[b.STATUS_KEY], 2)
        self.assertNotIn(b.STATUS_KEY, rc.puts)
        self.assertLessEqual(sum(rc.store.values()), self.cfg.cap_bytes)

    def test_status_admission_rechecks_inventory_after_partial_delete(self):
        old = objs_for([self.now - dt.timedelta(days=i) for i in range(1, 10)], 10)
        rc = FakeRclone(old)
        self.cfg.retain_daily, self.cfg.retain_weekly, self.cfg.retain_monthly = 0, 0, 0
        original = rc.delete

        def delete(key):
            if rc.deleted:
                raise b.BackupError("delete failed")
            original(key)

        with mock.patch.object(rc, "delete", side_effect=delete):
            self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.assertEqual(len(rc.deleted), 1)
        self.assertIn("delete failed", rc.puts[b.STATUS_KEY]["error"])
        self.assertLessEqual(sum(rc.store.values()), self.cfg.cap_bytes)

    def test_status_inventory_failure_retains_previous_status(self):
        rc = FakeRclone([b.Obj(b.STATUS_KEY, 1000)])
        original = rc.list
        calls = 0

        def inventory(prefix):
            nonlocal calls
            calls += 1
            if calls > len(b.MANAGED_PREFIXES):
                raise b.BackupError("inventory failed")
            return original(prefix)

        with mock.patch.object(rc, "list", side_effect=inventory):
            self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.assertEqual(rc.store[b.STATUS_KEY], 1000)
        self.assertNotIn(b.STATUS_KEY, rc.puts)

    def test_status_write_failure_returns_error(self):
        rc = FakeRclone()
        with mock.patch.object(rc, "put_bytes", side_effect=b.BackupError("write failed")):
            self.assertEqual(b.run(self.cfg, rc, self.now), b.EXIT_ERROR)
        self.assertNotIn(b.STATUS_KEY, rc.puts)


class TarIntegrityTests(RunFixture):
    def test_file_shrinking_during_read_still_yields_valid_archive(self):
        big = os.path.join(self.inst, "companies/a/live.bin")
        with open(big, "wb") as f:
            f.write(b"x" * 5000)
        real = os.fstat

        def fake(fd):
            st = real(fd)
            if st.st_size == 5000:  # claim it is bigger than what can be read
                vals = list(st)
                vals[6] = 9000
                return os.stat_result(vals)
            return st
        from unittest import mock
        with mock.patch.object(b.os, "fstat", side_effect=fake):
            out = b.build_instance_tar(self.cfg, self.now, self.root)
        b.validate_tar(out)
        with tarfile.open(out) as t:
            self.assertEqual(t.getmember("instance/companies/a/live.bin").size, 5000)

    def test_write_failure_after_header_is_fatal(self):
        from unittest import mock
        with mock.patch.object(b.tarfile.TarFile, "addfile", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                b.build_instance_tar(self.cfg, self.now, self.root)

    def test_unreadable_file_is_skipped_cleanly(self):
        p = os.path.join(self.inst, "companies/a/secret.txt")
        with open(p, "w") as f:
            f.write("zzz")
        from unittest import mock
        real_open = open

        def fake_open(path, *a, **k):
            if str(path).endswith("secret.txt"):
                raise PermissionError(13, "denied")
            return real_open(path, *a, **k)
        with mock.patch("builtins.open", side_effect=fake_open):
            out = b.build_instance_tar(self.cfg, self.now, self.root)
        b.validate_tar(out)
        with tarfile.open(out) as t:
            self.assertNotIn("instance/companies/a/secret.txt", t.getnames())

    def test_validate_rejects_truncated_archive(self):
        out = b.build_instance_tar(self.cfg, self.now, self.root)
        with open(out, "rb") as fh:
            data = fh.read()
        bad = os.path.join(self.root, "bad.tar.gz")
        with open(bad, "wb") as fh:
            fh.write(data[: len(data) // 2])
        with self.assertRaises(b.BackupError):
            b.validate_tar(bad)


if __name__ == "__main__":
    unittest.main()

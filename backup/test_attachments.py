import os
import re
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import attachments as a  # noqa: E402


def objs(**sizes):
    return {k.replace("_", "/"): a.SrcObj(k.replace("_", "/"), s, f"md5-{k}-{s}") for k, s in sizes.items()}


class FakeMirror:
    def __init__(self, src, dst=None, fail_copy=False, drop_on_copy=False):
        self.src, self.dst = dict(src), dict(dst or {})
        self.fail_copy, self.drop_on_copy, self.copied = fail_copy, drop_on_copy, []

    def list_source(self):
        return dict(self.src)

    def list_dest(self):
        return dict(self.dst)

    def copy(self, keys, tmp_dir):
        if self.fail_copy:
            raise a.AttachmentError("rclone copy failed (rc=1)")
        self.copied.extend(keys)
        if not self.drop_on_copy:
            for k in keys:
                self.dst[k] = self.src[k]


class PlanTests(unittest.TestCase):
    def test_copies_missing_and_changed_only(self):
        src = objs(x_a=1, x_b=2, x_c=3)
        dst = {"x/a": src["x/a"], "x/b": a.SrcObj("x/b", 2, "other"), "x/gone": a.SrcObj("x/gone", 9, "")}
        todo, orphans = a.plan_copy(src, dst)
        self.assertEqual([o.key for o in todo], ["x/b", "x/c"])
        self.assertEqual(orphans, 1)

    def test_missing_hash_falls_back_to_size(self):
        src = {"k": a.SrcObj("k", 5, "")}
        self.assertEqual(a.plan_copy(src, {"k": a.SrcObj("k", 5, "h")})[0], [])
        self.assertEqual(len(a.plan_copy(src, {"k": a.SrcObj("k", 4, "h")})[0]), 1)

    def test_parse_source(self):
        self.assertEqual(a.parse_source("paperclip-workforce/paperclip/"), ("paperclip-workforce", "paperclip/"))
        self.assertEqual(a.parse_source("bkt/"), ("bkt", ""))
        for bad in ("", "bkt", "bkt/x", "/bkt/", "bkt/../x/", "R2:bkt/"):
            with self.assertRaises(a.AttachmentError):
                a.parse_source(bad)

    def test_parse_listing_rejects_malformed(self):
        self.assertEqual(a.parse_listing('[{"Path":"p","Size":1,"Hashes":{"md5":"m"}}]')["p"].md5, "m")
        for bad in ('{}', '[{"Path":"p"}]', '[{"Path":"p","Size":-1}]', '[{"Path":"p","Size":1},{"Path":"p","Size":1}]'):
            with self.assertRaises(a.AttachmentError):
                a.parse_listing(bad)


class CredentialTests(unittest.TestCase):
    ENV = {"ATTACH_R2_ACCESS_KEY_ID": "kid", "ATTACH_R2_SECRET_ACCESS_KEY": "sek",
           "RCLONE_CONFIG_R2_ENDPOINT": "https://acct.r2.cloudflarestorage.com"}

    def test_source_remote_only_in_child_env(self):
        child = a.source_env(self.ENV)
        self.assertEqual(child["RCLONE_CONFIG_ATTACHSRC_ACCESS_KEY_ID"], "kid")
        self.assertNotIn("RCLONE_CONFIG_ATTACHSRC_TYPE", os.environ)

    def test_missing_credentials_refused(self):
        with self.assertRaises(a.AttachmentError):
            a.source_env({"RCLONE_CONFIG_R2_ENDPOINT": "e"})

    def test_secrets_never_in_argv_or_errors(self):
        m = a.Mirror("src/p/", "bk", self.ENV, binary="rclone")
        proc = mock.Mock(returncode=1, stdout=b"", stderr=b"sek kid")
        with mock.patch.object(a.subprocess, "run", return_value=proc) as run:
            with self.assertRaises(a.AttachmentError) as ctx:
                m.list_source()
        argv = run.call_args.args[0]
        self.assertFalse(any("sek" in x or "kid" in x for x in argv))
        self.assertNotIn("sek", str(ctx.exception))
        self.assertEqual(argv[-1], "ATTACHSRC:src/p/")


class MirrorTests(unittest.TestCase):
    def run_mirror(self, m, cap=10**6, bucket=0, dry=False):
        return a.mirror(m, cap, bucket, "/tmp", dry, lambda _msg: None)

    def test_copies_and_verifies(self):
        m = FakeMirror(objs(p_a=10, p_b=20), {"p/a": objs(p_a=10)["p/a"]})
        s = self.run_mirror(m)
        self.assertEqual(m.copied, ["p/b"])
        self.assertEqual((s["copied"], s["to_copy_bytes"]), (1, 20))

    def test_dry_run_copies_nothing(self):
        m = FakeMirror(objs(p_a=10))
        s = self.run_mirror(m, dry=True)
        self.assertEqual((m.copied, s["to_copy"]), ([], 1))

    def test_cap_blocks_copy(self):
        m = FakeMirror(objs(p_a=10))
        with self.assertRaises(a.AttachmentError):
            self.run_mirror(m, cap=100, bucket=95)
        self.assertEqual(m.copied, [])

    def test_empty_source_is_an_error_not_deletion(self):
        m = FakeMirror({}, objs(p_a=10))
        with self.assertRaises(a.AttachmentError):
            self.run_mirror(m)

    def test_orphans_kept_and_counted(self):
        m = FakeMirror(objs(p_a=1), objs(p_a=1, p_old=5))
        s = self.run_mirror(m)
        self.assertEqual(s["orphaned_backup_copies_kept"], 1)
        self.assertIn("p/old", m.dst)

    def test_verify_failure_raises(self):
        with self.assertRaises(a.AttachmentError):
            self.run_mirror(FakeMirror(objs(p_a=1), drop_on_copy=True))


class InstallTests(unittest.TestCase):
    def test_install_script_ships_every_runtime_module(self):
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "install.sh")) as fh:
            installed = set(re.findall(r'"\$here/([a-z0-9_]+\.py)"', fh.read()))
        runtime = {f for f in os.listdir(here)
                   if f.endswith(".py") and not f.startswith(("test_", "integration_"))}
        self.assertIn("attachments.py", runtime)
        self.assertEqual(runtime - installed, set())


if __name__ == "__main__":
    unittest.main()

import contextlib
import dataclasses
import errno
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock

import database_snapshots as s
import local_measurement as m
import paperclip_r2_backup as b
from operation_lock import LockError, operation_lock


class FixtureClient:
    def __init__(self, envelope):
        self.envelope = envelope

    def execute(self, args, *, output=None, **kwargs):
        output.write(b"PGDMP-synthetic-only")

    def sql(self, source, text):
        return ('{"table":"public.items","count":7}\n'
                '{"schema_head":[{"version_num":"fixture-head"}]}\n')

    def close(self):
        pass


class MeasurementTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in ("scratch", "receipts", "lock"):
            (self.root / name).mkdir(mode=0o700)
        self.env = {"HINDSIGHT_PG_SERVICE": "fixture", "BACKUP_TMP_DIR": str(self.root / "lock")}
        for name in ("PGSERVICEFILE", "PGPASSFILE"):
            path = self.root / name
            path.write_text("synthetic, not a credential")
            path.chmod(0o600)
            self.env[name] = str(path)
        patch = mock.patch.dict(os.environ, self.env, clear=True)
        patch.start()
        self.addCleanup(patch.stop)
        self.args = ["--measure-local", "--source", "hindsight",
                     "--scratch-parent", str(self.root / "scratch"),
                     "--receipt-dir", str(self.root / "receipts"),
                     "--lock-dir", str(self.root / "lock")]
        self.envelope = m.Envelope(time.monotonic() + 60, 1, 1024**2, 4096,
                                   {"fixture_only": True, "not_operational_evidence": True})
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.forbidden = []
        for owner, names in ((b, ("load_config", "Rclone", "run", "build_instance_tar",
                                  "compute_retention", "status_data")),
                             (s, ("drill", "restore_container", "execute"))):
            for name in names:
                trap = self.stack.enter_context(mock.patch.object(
                    owner, name, side_effect=AssertionError("forbidden capability reached")))
                self.forbidden.append(trap)
        self.stack.enter_context(mock.patch.object(subprocess, "Popen", side_effect=AssertionError("no live clients")))

    def receipt(self):
        paths = list((self.root / "receipts").iterdir())
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0].stat().st_mode & 0o777, 0o600)
        return json.loads(paths[0].read_text())

    @contextlib.contextmanager
    def admitted_fixture(self):
        @contextlib.contextmanager
        def snapshot(source, *, client=None):
            self.assertIsInstance(client, FixtureClient)
            try:
                yield "00000003-000000A1-1"
            finally:
                self.session_closed = True

        self.session_closed = False
        with mock.patch.object(m, "native_envelope", return_value=self.envelope), \
                mock.patch.object(m, "CaptureClient", FixtureClient), \
                mock.patch.object(s, "exported_snapshot", snapshot):
            yield

    def tearDown(self):
        for trap in self.forbidden:
            trap.assert_not_called()

    def test_source_packaging_includes_required_modules_without_installing(self):
        script = Path(b.__file__).with_name("install.sh").read_text()
        for name in ("database_snapshots.py", "operation_lock.py", "local_measurement.py"):
            self.assertIn('"$here/' + name + '" "$bin_dir/' + name + '"', script)

    def test_wrong_lock_location_rejected_before_admission(self):
        with mock.patch.dict(os.environ, {"BACKUP_TMP_DIR": str(self.root / "different")}), \
                mock.patch.object(m, "native_envelope") as admission:
            self.assertEqual(b.main(self.args), 1)
        admission.assert_not_called()

    def test_real_cli_is_no_go_even_with_self_asserted_flags(self):
        with mock.patch.dict(os.environ, {"MEASUREMENT_APPROVED": "true", "BACKUP_BUCKET": "unused"}), \
                mock.patch.object(s, "capture") as capture:
            self.assertEqual(b.main(self.args), 1)
        capture.assert_not_called()
        receipt = self.receipt()
        self.assertEqual(receipt["outcome"], "not_admitted")
        self.assertEqual(receipt["unproved_controls"], list(m.PREREQUISITES))
        self.assertIsNone(receipt["applied_limits"])
        self.assertFalse((self.root / "lock" / "operation.lock").exists())
        self.assertFalse(list((self.root / "scratch").iterdir()))

    def test_success_is_local_private_verified_and_cleaned(self):
        with self.admitted_fixture():
            self.assertEqual(b.main(self.args), 0)
        receipt = self.receipt()
        self.assertTrue(self.session_closed)
        self.assertEqual(receipt["outcome"], "captured_local_only")
        self.assertIn("LOCAL_MEASUREMENT", receipt["kind"])
        self.assertEqual(receipt["cleanup"], "verified_run_plaintext_removed_and_clients_reaped")
        self.assertFalse(receipt["next_source_ready"])
        self.assertGreater(receipt["tar"]["bytes"], receipt["dump"]["bytes"])
        self.assertEqual(len(receipt["dump"]["sha256"]), 64)
        self.assertEqual(len(receipt["source_revision"]["digest"]), 64)
        self.assertIn("snapshot_acquisition", receipt)
        self.assertIsNone(receipt["scratch"]["exact_peak_bytes"])
        self.assertFalse(list((self.root / "scratch").iterdir()))
        self.assertEqual((self.root / "lock" / "operation.lock").read_bytes(), b"")

    def test_invalid_modes_sources_and_duplicates_never_capture(self):
        variants = (["--dry-run"], ["--restore-drill"], ["--source", "paperclip"],
                    ["--source", "unknown"], ["--measure-local"], ["--upload"],
                    ["--scratch-parent", "/untrusted"])
        # Repeated measure-local is also a conflicting/ambiguous invocation.
        for extra in variants:
            with self.subTest(extra=extra), mock.patch.object(s, "capture") as capture:
                self.assertEqual(b.main(self.args + extra), 1)
                capture.assert_not_called()
        unknown = self.args.copy()
        unknown[unknown.index("hindsight")] = "unknown"
        self.assertEqual(b.main(unknown), 1)

    def test_no_restore_image_or_other_source_config_needed(self):
        source = m.load_source("hindsight", self.env)
        self.assertEqual(source.image, "")
        self.assertEqual(source.container, "")
        with self.assertRaises(s.SnapshotError):
            s.validate_source(source)  # Restore configuration still requires a pin.

    def test_implicit_auth_container_and_nonprivate_auth_rejected(self):
        for delta in ({"PGPASSFILE": ""}, {"HINDSIGHT_PG_SERVICE": ""},
                      {"HINDSIGHT_DB_CONTAINER": "fixture"}):
            with self.subTest(delta=delta), self.assertRaises((m.MeasurementError, OSError)):
                m.load_source("hindsight", {**self.env, **delta})
        Path(self.env["PGPASSFILE"]).chmod(0o644)
        self.assertEqual(b.main(self.args), 1)

    def test_nonprivate_symlink_and_overlapping_directories_rejected(self):
        (self.root / "scratch").chmod(0o755)
        self.assertEqual(b.main(self.args), 1)
        (self.root / "scratch").chmod(0o700)
        link = self.root / "link"
        link.symlink_to(self.root / "scratch")
        bad = self.args.copy()
        bad[bad.index(str(self.root / "scratch"))] = str(link)
        self.assertEqual(b.main(bad), 1)
        bad[bad.index(str(link))] = str(self.root / "receipts")
        self.assertEqual(b.main(bad), 1)

    def test_lock_contention_never_opens_snapshot(self):
        with operation_lock(self.root / "lock" / "operation.lock"), self.admitted_fixture():
            self.assertEqual(b.main(self.args), 1)
            self.assertFalse(self.session_closed)
        self.assertEqual(self.receipt()["outcome"], "failed")

    def test_failed_capture_and_scratch_exhaustion_cleanup(self):
        for error in (s.SnapshotError("private failure"), OSError(errno.ENOSPC, "no space")):
            with self.subTest(error=type(error).__name__), self.admitted_fixture(), \
                    mock.patch.object(FixtureClient, "execute", side_effect=error):
                self.assertEqual(b.main(self.args), 1)
                self.assertTrue(self.session_closed)
                self.assertFalse(list((self.root / "scratch").iterdir()))
            receipt_path = next((self.root / "receipts").iterdir())
            receipt = json.loads(receipt_path.read_text())
            self.assertNotIn("private failure", receipt_path.read_text())
            self.assertEqual(receipt["outcome"], "failed")
            self.assertIn("verified", receipt["cleanup"])
            receipt_path.unlink()

    def test_deadline_and_cleanup_reserve_fail_closed(self):
        self.envelope = dataclasses.replace(self.envelope, scratch_bytes=1)
        with self.admitted_fixture():
            self.assertEqual(b.main(self.args), 1)
        self.assertIn("verified", self.receipt()["cleanup"])
        next((self.root / "receipts").iterdir()).unlink()
        self.envelope = dataclasses.replace(self.envelope, deadline=time.monotonic() - 1)
        with self.admitted_fixture():
            self.assertEqual(b.main(self.args), 1)
            self.assertFalse(self.session_closed)

    def test_sigterm_and_sigint_unwind_snapshot_and_cleanup(self):
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous = signal.getsignal(sig)
            def cancel(*args, **kwargs):
                signal.raise_signal(sig)
            with self.subTest(sig=sig), self.admitted_fixture(), \
                    mock.patch.object(FixtureClient, "execute", side_effect=cancel):
                self.assertEqual(b.main(self.args), 1)
                self.assertTrue(self.session_closed)
            self.assertEqual(signal.getsignal(sig), previous)
            self.assertIn("verified", self.receipt()["cleanup"])
            next((self.root / "receipts").iterdir()).unlink()

    def test_cleanup_failure_latches_all_revised_operations(self):
        for cleanup in ("remove_owned_scratch",):
            with self.admitted_fixture(), mock.patch.object(m, cleanup, side_effect=OSError("private")):
                self.assertEqual(b.main(self.args), 1)
        receipt = self.receipt()
        self.assertEqual(receipt["cleanup"], "failed_requires_authorized_reconciliation")
        self.assertFalse(receipt["next_source_ready"])
        with self.assertRaisesRegex(LockError, "reconciliation"):
            with operation_lock(self.root / "lock" / "operation.lock"):
                self.fail("dirty lease admitted")
        self.assertTrue(list((self.root / "scratch").iterdir()))

    def test_unexpected_scratch_never_recursively_deleted(self):
        root = self.root / "scratch" / "owned"
        root.mkdir(mode=0o700)
        identity = root.stat().st_dev, root.stat().st_ino
        (root / "foreign").symlink_to(self.env["PGPASSFILE"])
        with self.assertRaises(m.MeasurementError):
            m.remove_owned_scratch(root, identity)
        self.assertTrue(Path(self.env["PGPASSFILE"]).exists())
        with self.assertRaises(m.MeasurementError):
            m.remove_owned_scratch(root, (identity[0], identity[1] + 1))

    def test_receipt_write_failure_is_failure_not_success(self):
        with self.admitted_fixture(), mock.patch.object(m, "write_receipt", side_effect=OSError):
            self.assertEqual(b.main(self.args), 1)
        self.assertFalse(list((self.root / "scratch").iterdir()))

    def test_client_timeout_kills_group_and_reaps_without_leaking_env(self):
        client = m.CaptureClient(self.envelope)
        client.source = m.load_source("hindsight", self.env)
        proc = mock.Mock(pid=12345, returncode=None, stdin=None, stdout=None, stderr=None)
        proc.communicate.side_effect = subprocess.TimeoutExpired("psql", 1)
        with mock.patch.dict(os.environ, {"RCLONE_CONFIG_R2_SECRET_ACCESS_KEY": "PRIVATE",
                                         "PGPASSWORD": "PRIVATE", "HOME": "PRIVATE"}), \
                mock.patch.object(subprocess, "Popen", return_value=proc) as spawn, \
                mock.patch.object(os, "killpg", side_effect=(None, ProcessLookupError)) as kill:
            with self.assertRaisesRegex(m.MeasurementError, "timed out"):
                client.execute(["psql", "--dbname=hindsight"])
        self.assertEqual(kill.call_args_list, [mock.call(12345, signal.SIGKILL), mock.call(12345, 0)])
        proc.wait.assert_called_once_with(timeout=1)
        self.assertEqual(client.processes, [])
        self.assertNotIn("PRIVATE", json.dumps(spawn.call_args.kwargs["env"]))
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])

    def test_session_cleanup_failure_is_retained_for_outer_reconciliation(self):
        client = m.CaptureClient(self.envelope)
        proc = mock.Mock(pid=12345, stdin=None, stdout=None, stderr=None)
        proc.wait.side_effect = subprocess.TimeoutExpired("psql", 1)
        client.processes.append(proc)
        with mock.patch.object(os, "killpg"), self.assertRaises(m.MeasurementError):
            client.close()
        self.assertEqual(client.processes, [proc])

    def test_verify_only_checks_format_without_a_third_dump(self):
        with self.admitted_fixture(), mock.patch.object(m, "remove_owned_scratch") as cleanup:
            self.assertEqual(b.main(self.args), 0)
        root = cleanup.call_args.args[0]
        self.assertEqual(len(list(root.iterdir())), 3)
        self.assertFalse((root / "dump.pgcustom").exists())
        tar = next(root.glob("*.tar"))
        data = tar.read_bytes().replace(b"PGDMP-synthetic-only", b"PGDMP-synthetic-FAIL")
        tar.write_bytes(data)
        with self.assertRaisesRegex(s.SnapshotError, "hash mismatch"):
            s.unpack(tar, root, m.load_source("hindsight", self.env), verify_only=True)


if __name__ == "__main__":
    unittest.main()

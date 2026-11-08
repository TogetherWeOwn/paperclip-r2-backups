"""Actions-only fixture: real exported snapshots, offsite boundary and pgvector restore."""
import contextlib
import datetime as dt
import gzip
import json
import os
import shutil
import tempfile
import uuid
from unittest import mock

import database_snapshots as s
import paperclip_r2_backup as b


def run():
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("integration restore fixtures run only in GitHub Actions")
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    images = {"paperclip": os.environ["PAPERCLIP_RESTORE_IMAGE"],
              "hindsight": os.environ["HINDSIGHT_RESTORE_IMAGE"]}
    sources = []
    with contextlib.ExitStack() as stack, tempfile.TemporaryDirectory() as root:
        for name, image in images.items():
            container = stack.enter_context(s.restore_container(image))
            source = s.Source(name, "restore", "public.alembic_version", ("version_num",),
                              image, container.container)
            s.sql(source, "CREATE TABLE alembic_version(version_num text PRIMARY KEY);\n"
                          "INSERT INTO alembic_version VALUES ('fixture-head');\n"
                          "CREATE TABLE items(id integer PRIMARY KEY, content text);\n"
                          "INSERT INTO items SELECT i, 'snapshot' FROM generate_series(1,7) i;\n")
            if name == "hindsight":
                s.sql(source, "CREATE EXTENSION vector;\n"
                              "CREATE TABLE embeddings(id integer, embedding vector(3));\n"
                              "INSERT INTO embeddings VALUES (1, '[1,2,3]');\n")
            s.execute(["docker", "exec", source.container, "mkdir", "/tmp/fixture-tablespace"])
            s.sql(source, """
CREATE TABLESPACE fixture_space LOCATION '/tmp/fixture-tablespace';
CREATE TABLE placed(id integer) TABLESPACE fixture_space;
INSERT INTO placed VALUES (1);
CREATE SCHEMA pgmq;
CREATE TABLE pgmq.queue(id integer);
INSERT INTO pgmq.queue VALUES (1);
CREATE SCHEMA a;
CREATE SCHEMA "a.b";
CREATE TABLE a."b.c"(id integer);
CREATE TABLE "a.b".c(id integer);
INSERT INTO a."b.c" VALUES (1);
INSERT INTO "a.b".c VALUES (1), (2);
""")
            sources.append(source)

        # Filesystem object-store fixture deliberately holds independent bytes;
        # restoring the local capture instead cannot pass the corrupted-object case.
        store_dir = os.path.join(root, "objects")
        os.mkdir(store_dir)

        class ObjectStore:
            def list(self, prefix):
                result = []
                for parent, _, names in os.walk(store_dir):
                    for name in names:
                        path = os.path.join(parent, name)
                        key = os.path.relpath(path, store_dir)
                        if key.startswith(prefix):
                            result.append(b.Obj(key, os.path.getsize(path)))
                return result

            def upload(self, local, key):
                dest = os.path.join(store_dir, key)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                shutil.copyfile(local, dest)

            def verify(self, local, key):
                assert s.sha256(local) == s.sha256(os.path.join(store_dir, key))

            def download(self, key, local, max_bytes):
                shutil.copyfile(os.path.join(store_dir, key), local)

            def put_bytes(self, data, key):
                dest = os.path.join(store_dir, key)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as stream:
                    stream.write(data)

            def delete(self, key):
                os.unlink(os.path.join(store_dir, key))

        backups = os.path.join(root, "native")
        instance = os.path.join(root, "instance")
        tmp = os.path.join(root, "tmp")
        receipts = os.path.join(root, "receipts")
        for path in (backups, instance, tmp):
            os.mkdir(path)
        stamp = now - dt.timedelta(minutes=15)
        native = os.path.join(backups, f"paperclip-{stamp:%Y%m%d-%H%M%S}.sql.gz")
        with gzip.open(native, "wb") as stream:
            stream.write(b"-- native backup remains unchanged\n")
        os.utime(native, (stamp.timestamp(),) * 2)
        cfg = b.Config("fixture", backups, instance, tmp_dir=tmp, receipt_dir=receipts,
                       sources=tuple(sources))
        store = ObjectStore()

        original_metadata = s.metadata
        mutated = set()

        def concurrent_metadata(source, snapshot=None):
            result = original_metadata(source, snapshot)
            if snapshot and source.name not in mutated:
                # A committed live write BETWEEN metadata and pg_dump must not
                # appear in the dump. Both import the original exported snapshot.
                s.sql(source, "INSERT INTO items VALUES (8, 'later mutable source');\n")
                mutated.add(source.name)
            return result

        with mock.patch.object(s, "metadata", side_effect=concurrent_metadata):
            assert b.run(cfg, store, now) == 0, "backup failed"
        for source in sources:
            assert original_metadata(source)["counts"]["public.items"] == 8
        assert s.drill(cfg, store, now) == 0, "offsite restore drill failed"
        with open(os.path.join(store_dir, "status/restore-last.json")) as stream:
            receipt = json.load(stream)
        assert receipt["ok"] and set(receipt["databases"]) == {"paperclip", "hindsight"}
        for database in receipt["databases"].values():
            assert database["counts"]["public.items"] == 7
            assert database["cleanup_ok"]
            assert database["counts"]["pgmq.queue"] == 1
            assert database["counts"]['a."b.c"'] == 1
            assert database["counts"]['"a.b".c'] == 2
            assert database["counts"]["public.placed"] == 1
        assert receipt["databases"]["hindsight"]["counts"]["public.embeddings"] == 1
        os.makedirs("artifacts", exist_ok=True)
        with open("artifacts/restore-fixture-receipt.json", "w") as stream:
            json.dump(receipt, stream, indent=2)

        # Tamper only with the offsite object. Same-length mutation defeats a
        # size-only check but must fail the dump sha256 check before any restore.
        obj = store.list("hindsight/")[0]
        path = os.path.join(store_dir, obj.key)
        with open(path, "r+b") as stream:
            raw = stream.read()
            position = raw.index(b"PGDMP")
            stream.seek(position)
            stream.write(b"XXXXX")
        assert s.drill(cfg, store, now + dt.timedelta(seconds=1)) == 1
        with open(os.path.join(store_dir, "status/restore-last.json")) as stream:
            assert not json.load(stream)["ok"]
        assert not any(name.startswith(("drill-", "build-")) for name in os.listdir(tmp))
    print("PASS: both offsite restores, pgvector, concurrent writes, corruption rejection and cleanup")


if __name__ == "__main__":
    run()

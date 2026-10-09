import hashlib
import http.client
import json
from pathlib import Path
import queue
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from service import CHUNK, MAX_FILE, Rejected, Storage, make_server


def metadata(size=5):
    return {"postId": "123", "fileId": "file:abc", "fileName": "日本語.txt", "expectedSize": size}


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.storage = Storage(self.tmp.name, min_free=0)

    def tearDown(self):
        self.storage.close()
        self.tmp.cleanup()

    def save(self, content=b"hello", meta=None):
        session = self.storage.begin(meta or metadata(len(content)))
        if content:
            self.storage.append(session["uploadId"], 0, content)
        return self.storage.finish(session["uploadId"], len(content)), session

    def test_exact_bytes_hash_and_no_eagle_state(self):
        receipt, _ = self.save()
        self.assertEqual(receipt["sha256"], hashlib.sha256(b"hello").hexdigest())
        self.assertEqual(receipt["eagleState"], "not_submitted")
        self.assertEqual((Path(self.tmp.name) / "objects" / (receipt["receiptId"] + ".bin")).read_bytes(), b"hello")
        self.assertFalse(list(Path(self.tmp.name).rglob("*.part")))

    def test_saved_duplicate_after_restart(self):
        receipt, _ = self.save()
        self.storage.close()
        self.storage = Storage(self.tmp.name, min_free=0)
        self.assertEqual(self.storage.begin(metadata()), receipt)
        self.assertEqual(self.storage.db.execute("SELECT count(*) FROM receipts").fetchone()[0], 1)

    def test_interrupted_upload_is_never_saved_and_can_restart(self):
        session = self.storage.begin(metadata())
        self.storage.append(session["uploadId"], 0, b"he")
        self.storage.close()
        self.storage = Storage(self.tmp.name, min_free=0)
        next_session = self.storage.begin(metadata())
        with self.assertRaises(Rejected):
            self.storage.append(session["uploadId"], 2, b"llo")
        self.storage.append(next_session["uploadId"], 0, b"hello")
        self.assertEqual(self.storage.finish(next_session["uploadId"], 5)["state"], "saved")

    def test_repeated_chunk_is_idempotent_but_conflicting_chunk_fails(self):
        session = self.storage.begin(metadata())
        upload = session["uploadId"]
        self.assertEqual(self.storage.append(upload, 0, b"he"), {"offset": 2})
        self.assertEqual(self.storage.append(upload, 0, b"he"), {"offset": 2})
        with self.assertRaises(Rejected):
            self.storage.append(upload, 0, b"no")
        with self.assertRaises(Rejected):
            self.storage.append(upload, 3, b"x")

    def test_incomplete_or_overlong_file_cannot_commit(self):
        session = self.storage.begin(metadata())
        upload = session["uploadId"]
        self.storage.append(upload, 0, b"he")
        with self.assertRaises(Rejected):
            self.storage.finish(upload, 2)
        with self.assertRaises(Rejected):
            self.storage.append(upload, 2, b"toolong")
        self.assertEqual(self.storage.row(upload)["state"], "uploading")

    def test_finalize_intent_recovers_before_rename(self):
        session = self.storage.begin(metadata())
        self.storage.append(session["uploadId"], 0, b"hello")
        with patch("service.os.replace", side_effect=OSError("simulated crash")):
            with self.assertRaises(OSError):
                self.storage.finish(session["uploadId"], 5)
        self.storage.close()
        self.storage = Storage(self.tmp.name, min_free=0)
        receipt = self.storage.begin(metadata())
        self.assertEqual(receipt["state"], "saved")
        self.assertEqual(len(list(Path(self.tmp.name).rglob("*.bin"))), 1)

    def test_finalize_intent_recovers_after_rename_before_db_completion(self):
        receipt, session = self.save()
        with self.storage.db:
            self.storage.db.execute("UPDATE receipts SET state='committing'")
        self.storage.close()
        self.storage = Storage(self.tmp.name, min_free=0)
        self.assertEqual(self.storage.finish(session["uploadId"], 5), receipt)

    def test_corruption_and_missing_original_never_return_saved(self):
        receipt, session = self.save()
        final = self.storage.paths(receipt["receiptId"])[1]
        final.write_bytes(b"other")
        with self.assertRaises(Rejected):
            self.storage.begin(metadata())
        self.assertEqual(final.read_bytes(), b"other")
        final.unlink()
        with self.assertRaises(Rejected):
            self.storage.finish(session["uploadId"], 5)

    def test_metadata_conflict_and_urls_rejected_without_overwriting(self):
        self.save()
        for changes in ({"fileName": "other.txt"}, {"expectedSize": 4}, {"url": "https://example.invalid/secret"}):
            with self.assertRaises(Rejected):
                self.storage.begin({**metadata(), **changes})
        row = self.storage.db.execute("SELECT * FROM receipts").fetchone()
        self.assertEqual(row["state"], "saved")
        self.assertEqual(row["name"], "日本語.txt")

    def test_names_never_control_disk_paths(self):
        meta = {**metadata(), "fileName": "../../outside.txt"}
        receipt, _ = self.save(meta=meta)
        self.assertEqual(len(receipt["receiptId"]), 64)
        self.assertFalse((Path(self.tmp.name).parent / "outside.txt").exists())

    def test_capacity_denial_retains_partial_file(self):
        session = self.storage.begin(metadata())
        self.storage.append(session["uploadId"], 0, b"he")
        with patch("service.shutil.disk_usage", return_value=type("Usage", (), {"free": 0})()):
            with self.assertRaises(Rejected) as error:
                self.storage.append(session["uploadId"], 2, b"llo")
            self.assertEqual(error.exception.status, 507)
        self.assertEqual(self.storage.paths(self.storage.row(session["uploadId"])["key"])[0].read_bytes(), b"he")

    def test_unknown_size_and_empty_files(self):
        receipt, _ = self.save(b"", metadata(None))
        self.assertEqual(receipt["size"], 0)
        self.assertEqual(receipt["sha256"], hashlib.sha256(b"").hexdigest())

    def test_file_and_chunk_limits(self):
        with self.assertRaises(Rejected):
            self.storage.begin(metadata(MAX_FILE + 1))
        upload = self.storage.begin(metadata(None))["uploadId"]
        with self.assertRaises(Rejected):
            self.storage.append(upload, 0, b"x" * (CHUNK + 1))


class HTTPTests(unittest.TestCase):
    def test_authenticated_http_roundtrip_and_origin_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            started = queue.Queue()
            token = "a" * 40
            extension = "b" * 32

            def serve():
                storage = Storage(root, min_free=0)
                try:
                    with make_server(storage, token, extension, port=0) as server:
                        started.put(server)
                        server.serve_forever(poll_interval=0.05)
                finally:
                    storage.close()

            worker = threading.Thread(target=serve)
            worker.start()
            server = started.get(timeout=5)

            def request(method, path, body=None, headers=None):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                try:
                    connection.request(method, path, body=body, headers=headers or {"Authorization": "Bearer " + token})
                    response = connection.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    connection.close()

            try:
                self.assertEqual(request("GET", "/v1/health", headers={"Authorization": "wrong"})[0], 401)
                self.assertEqual(request("GET", "/v1/health", headers={"Authorization": "Bearer " + token, "Origin": "https://www.fanbox.cc"})[0], 403)
                self.assertFalse(request("GET", "/v1/health")[1]["eagleEnabled"])
                status, session = request("POST", "/v1/uploads", json.dumps(metadata()))
                self.assertEqual(status, 200)
                path = "/v1/uploads/" + session["uploadId"]
                self.assertEqual(request("PUT", path, b"hello", {"Authorization": "Bearer " + token, "X-Offset": "0"})[0], 200)
                status, receipt = request("POST", path + "/commit", '{"size":5}')
                self.assertEqual(status, 200)
                self.assertEqual(receipt["sha256"], hashlib.sha256(b"hello").hexdigest())
                self.assertEqual(request("POST", "/v1/uploads", '[]')[0], 400)
                self.assertEqual(request("GET", "/arbitrary/path")[0], 404)
            finally:
                server.shutdown()
                worker.join(timeout=5)
                self.assertFalse(worker.is_alive())


if __name__ == "__main__":
    unittest.main()

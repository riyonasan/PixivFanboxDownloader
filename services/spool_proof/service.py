"""Local-only, single-file FANBOX storage proof. No Eagle or downloader code."""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlsplit
import uuid

MAX_FILE = 64 * 1024 * 1024
CHUNK = 1024 * 1024
MIN_FREE = 10 * 1024**3


class Rejected(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def sync_directory(path):
    if os.name != "nt":
        descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class Storage:
    def __init__(self, root, min_free=MIN_FREE):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.objects = self.root / "objects"
        self.objects.mkdir(exist_ok=True, mode=0o700)
        self.min_free = min_free
        self.db = sqlite3.connect(self.root / "receipts.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS receipts (
            key TEXT PRIMARY KEY, post_id TEXT NOT NULL, file_id TEXT NOT NULL,
            name TEXT NOT NULL, expected_size INTEGER, upload_id TEXT UNIQUE,
            state TEXT NOT NULL, size INTEGER, sha256 TEXT)""")
        self.db.commit()
        sync_directory(self.root)

    def close(self):
        self.db.close()

    def paths(self, key):
        return self.objects / (key + ".part"), self.objects / (key + ".bin")

    def row(self, upload_id):
        row = self.db.execute("SELECT * FROM receipts WHERE upload_id=?", (upload_id,)).fetchone()
        if row is None:
            raise Rejected("Unknown upload", 404)
        return row

    def check_space(self, additional):
        if shutil.disk_usage(self.root).free < self.min_free + additional:
            raise Rejected("Storage is below the free-space limit", 507)

    def receipt(self, row):
        return {"receiptId": row["key"], "state": "saved", "eagleState": "not_submitted",
                "size": row["size"], "sha256": row["sha256"], "fileName": row["name"]}

    def recover(self, row):
        part, final = self.paths(row["key"])
        source = final if row["state"] == "saved" or final.exists() else part
        if not source.is_file() or source.stat().st_size != row["size"] or digest(source) != row["sha256"]:
            raise Rejected("Stored file failed verification; preserve it for inspection", 409)
        if row["state"] == "committing":
            if source == part:
                os.replace(part, final)
            sync_directory(self.objects)
            with self.db:
                self.db.execute("UPDATE receipts SET state='saved' WHERE key=?", (row["key"],))
        return self.receipt(row)

    def begin(self, metadata):
        if not isinstance(metadata, dict) or set(metadata) != {"postId", "fileId", "fileName", "expectedSize"}:
            raise Rejected("Invalid upload metadata")
        post, file_id, name, size = (metadata[k] for k in ("postId", "fileId", "fileName", "expectedSize"))
        if not isinstance(post, str) or not re.fullmatch(r"[0-9]{1,30}", post):
            raise Rejected("Invalid post ID")
        if not isinstance(file_id, str) or not re.fullmatch(r"(?:file|image):[A-Za-z0-9_-]{1,120}", file_id):
            raise Rejected("Invalid file ID")
        if not isinstance(name, str) or not 1 <= len(name) <= 512 or any(ord(c) < 32 for c in name):
            raise Rejected("Invalid file name")
        if size is not None and (type(size) is not int or not 0 <= size <= MAX_FILE):
            raise Rejected("The proof accepts files up to 64 MiB", 413)
        key = hashlib.sha256((post + "\0" + file_id).encode()).hexdigest()
        row = self.db.execute("SELECT * FROM receipts WHERE key=?", (key,)).fetchone()
        if row is not None:
            if row["name"] != name or row["expected_size"] != size:
                raise Rejected("The same file ID has conflicting metadata", 409)
            if row["state"] in ("saved", "committing"):
                return self.recover(row)
        self.check_space(size if size is not None else MAX_FILE)
        upload_id = uuid.uuid4().hex
        # Commit the new session first: an interrupted restart invalidates old senders.
        with self.db:
            self.db.execute("""INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, 'uploading', NULL, NULL)
                ON CONFLICT(key) DO UPDATE SET upload_id=excluded.upload_id, state='uploading', size=NULL, sha256=NULL""",
                            (key, post, file_id, name, size, upload_id))
        part, _ = self.paths(key)
        with part.open("wb") as stream:
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(self.objects)
        return {"state": "uploading", "uploadId": upload_id, "chunkSize": CHUNK, "maxSize": MAX_FILE}

    def append(self, upload_id, offset, content):
        row = self.row(upload_id)
        if row["state"] != "uploading":
            raise Rejected("Upload is already committed", 409)
        if type(offset) is not int or offset < 0 or not 0 < len(content) <= CHUNK:
            raise Rejected("Invalid chunk")
        end = offset + len(content)
        if end > MAX_FILE or (row["expected_size"] is not None and end > row["expected_size"]):
            raise Rejected("File exceeds its permitted size", 413)
        part, _ = self.paths(row["key"])
        current = part.stat().st_size
        if offset < current:
            with part.open("rb") as stream:
                stream.seek(offset)
                if end > current or stream.read(len(content)) != content:
                    raise Rejected("Conflicting repeated chunk", 409)
            return {"offset": current}
        if offset != current:
            raise Rejected("Unexpected chunk offset", 409)
        self.check_space(len(content))
        with part.open("ab") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        return {"offset": end}

    def finish(self, upload_id, size):
        row = self.row(upload_id)
        if row["state"] in ("saved", "committing"):
            if type(size) is not int or size != row["size"]:
                raise Rejected("Conflicting committed size", 409)
            return self.recover(row)
        part, _ = self.paths(row["key"])
        if type(size) is not int or not 0 <= size <= MAX_FILE or part.stat().st_size != size:
            raise Rejected("Incomplete upload", 409)
        if row["expected_size"] is not None and size != row["expected_size"]:
            raise Rejected("File size does not match metadata", 409)
        checksum = digest(part)
        with self.db:
            self.db.execute("UPDATE receipts SET state='committing', size=?, sha256=? WHERE key=?",
                            (size, checksum, row["key"]))
        return self.recover(self.row(upload_id))


class Handler(BaseHTTPRequestHandler):
    server_version = "FanboxSpoolProof"

    def log_message(self, *_):
        pass  # Never log headers, tokens or file metadata.

    def reply(self, status, value):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def handle_request(self):
        try:
            self.connection.settimeout(30)
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + self.server.token):
                raise Rejected("Unauthorized", 401)
            # No CORS: requests must come from the extension service worker.
            if self.headers.get("Origin") not in (None, "chrome-extension://" + self.server.extension_id):
                raise Rejected("Origin is not allowed", 403)
            if self.headers.get("Transfer-Encoding"):
                raise Rejected("Content-Length is required", 411)
            path = urlsplit(self.path).path
            if self.command == "GET" and path == "/v1/health":
                self.reply(200, {"mode": "file-proof", "eagleEnabled": False, "maxSize": MAX_FILE})
                return
            if self.command == "GET":
                raise Rejected("Unknown endpoint", 404)
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                raise Rejected("Invalid Content-Length")
            limit = CHUNK if self.command == "PUT" else 4096
            if not 0 <= length <= limit:
                raise Rejected("Request is too large or has no length", 413)
            content = self.rfile.read(length)
            if len(content) != length:
                raise Rejected("Incomplete request body")
            if self.command == "POST" and path == "/v1/uploads":
                result = self.server.storage.begin(json.loads(content))
            elif match := re.fullmatch(r"/v1/uploads/([a-f0-9]{32})(/commit)?", path):
                upload_id, suffix = match.groups()
                if self.command == "PUT" and suffix is None:
                    result = self.server.storage.append(upload_id, int(self.headers.get("X-Offset", "-1")), content)
                elif self.command == "POST" and suffix == "/commit":
                    body = json.loads(content)
                    if not isinstance(body, dict) or set(body) != {"size"}:
                        raise Rejected("Invalid commit metadata")
                    result = self.server.storage.finish(upload_id, body["size"])
                else:
                    raise Rejected("Unknown endpoint", 404)
            else:
                raise Rejected("Unknown endpoint", 404)
            self.reply(200, result)
        except Rejected as error:
            self.reply(error.status, {"error": str(error)})
        except (ValueError, UnicodeError):
            self.reply(400, {"error": "Invalid request"})
        except (OSError, sqlite3.Error):
            self.reply(503, {"error": "Local storage unavailable; no save confirmation"})

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request


def make_server(storage, token, extension_id, port=18096):
    if not re.fullmatch(r"[a-p]{32}", extension_id):
        raise ValueError("Specify the installed extension ID")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("Use a random URL-safe token of at least 32 characters")
    server = HTTPServer(("127.0.0.1", port), Handler)
    server.storage, server.token, server.extension_id = storage, token, extension_id
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--extension-id", required=True)
    args = parser.parse_args()
    storage = Storage(args.data_dir)
    try:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
        with make_server(storage, token, args.extension_id) as server:
            print("FANBOX file proof listening on 127.0.0.1:18096; Eagle disabled", flush=True)
            server.serve_forever()
    finally:
        storage.close()


if __name__ == "__main__":
    main()

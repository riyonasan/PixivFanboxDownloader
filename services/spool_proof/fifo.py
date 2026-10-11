"""FANBOX-only durable registration FIFO and verified local-file cleanup."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
from urllib.parse import urlsplit
from service import sync_directory


class Unavailable(Exception):
    """No item POST was attempted, or the read-only check cannot run now."""


class Held(Exception):
    """A particular item needs human inspection."""


def checksum(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_file(path, job):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != job['size'] or checksum(path) != job['sha256']:
        raise Held('original_mismatch')


def validate_spec(spec, post_id):
    required = {'fileName', 'website', 'tags'}
    if not isinstance(spec, dict) or not required <= spec.keys() or not spec.keys() <= required | {'imageIndex'}:
        raise ValueError('Invalid registration information')
    if 'imageIndex' in spec and (type(spec['imageIndex']) is not int or spec['imageIndex'] < 0):
        raise ValueError('Invalid image index')
    name, website, tags = (spec[key] for key in ('fileName', 'website', 'tags'))
    if not isinstance(name, str) or not 1 <= len(name) <= 4096:
        raise ValueError('Invalid registration name')
    parts = name.split('/')
    if any(not p or p in ('.', '..') or re.search(r'[\\\x00-\x1f:]', p) for p in parts):
        raise ValueError('Invalid registration path')
    if not re.fullmatch(r'[A-Za-z0-9]{1,12}', parts[-1].rsplit('.', 1)[-1]):
        raise ValueError('Invalid registration extension')
    if not isinstance(website, str):
        raise ValueError('Invalid post website')
    url = urlsplit(website)
    if url.scheme != 'https' or url.hostname != 'www.fanbox.cc' or url.username or url.password or url.query or url.fragment or not re.fullmatch(r'/@[^/]+/posts/'+re.escape(post_id), url.path):
        raise ValueError('Invalid post website')
    if not isinstance(tags, list) or len(tags) > 100 or any(not isinstance(t, str) or len(t) > 200 for t in tags):
        raise ValueError('Invalid registration tags')
    return json.dumps(spec, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


class Queue:
    def __init__(self, db, objects, spool, client, clock=time.time, retry_seconds=30, checking_seconds=300):
        self.db, self.objects, self.spool, self.client = db, Path(objects), Path(spool), client
        self.clock, self.retry_seconds, self.checking_seconds = clock, retry_seconds, checking_seconds
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS registration_specs (
                receipt_key TEXT PRIMARY KEY, spec TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS eagle_order_bases (
                post_id TEXT PRIMARY KEY, base_time INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS eagle_queue (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, receipt_key TEXT NOT NULL UNIQUE,
                state TEXT NOT NULL, next_attempt REAL NOT NULL DEFAULT 0,
                attempt INTEGER NOT NULL DEFAULT 0, intent TEXT, item_id TEXT,
                checking_until REAL, reason TEXT, completed_at REAL);
            CREATE TABLE IF NOT EXISTS eagle_attempts (
                receipt_key TEXT NOT NULL, attempt INTEGER NOT NULL, intent TEXT NOT NULL,
                PRIMARY KEY(receipt_key, attempt));
            CREATE TABLE IF NOT EXISTS local_cleanup (
                receipt_key TEXT PRIMARY KEY, state TEXT NOT NULL,
                reason TEXT, next_attempt REAL NOT NULL DEFAULT 0, deleted_at REAL,
                deletion_started INTEGER NOT NULL DEFAULT 0);
        ''')
        self.db.commit()

    def remember(self, key, spec, post_id):
        encoded = validate_spec(spec, post_id)
        # The first accepted import specification is immutable, including across config changes.
        with self.db:
            self.db.execute('INSERT OR IGNORE INTO registration_specs VALUES (?,?)', (key, encoded))
            if 'imageIndex' in spec:
                self.db.execute('INSERT OR IGNORE INTO eagle_order_bases VALUES (?,?)',
                                (post_id, int(self.clock()*1000)))

    def enqueue_saved(self, key):
        with self.db:
            self.db.execute('''INSERT OR IGNORE INTO eagle_queue(receipt_key,state)
                SELECT receipts.key,'pending' FROM receipts
                JOIN registration_specs ON registration_specs.receipt_key=receipts.key
                WHERE receipts.key=? AND receipts.state='saved' ''', (key,))

    def recover_saved(self):
        for row in self.db.execute("SELECT key FROM receipts WHERE state='saved'").fetchall():
            self.enqueue_saved(row['key'])

    def job(self, key):
        row = self.db.execute('''SELECT q.*, r.size,r.sha256,s.spec FROM eagle_queue q
            JOIN receipts r ON r.key=q.receipt_key
            JOIN registration_specs s ON s.receipt_key=q.receipt_key WHERE q.receipt_key=?''', (key,)).fetchone()
        if row is None:
            return None
        result = dict(row)
        result['spec'] = json.loads(result['spec'])
        result['intent'] = json.loads(result['intent']) if result['intent'] else None
        return result

    def change(self, key, **fields):
        allowed = {'state','next_attempt','attempt','intent','item_id','checking_until','reason','completed_at'}
        if not fields or not fields.keys() <= allowed:
            raise ValueError('Invalid queue update')
        with self.db:
            self.db.execute('UPDATE eagle_queue SET '+','.join(name+'=?' for name in fields)+' WHERE receipt_key=?', (*fields.values(), key))

    def stage(self, job):
        original = self.objects/(job['receipt_key']+'.bin')
        verify_file(original, job)
        suffix = job['spec']['fileName'].rsplit('.',1)[-1].lower()
        target = self.spool/(job['receipt_key']+'.'+suffix)
        if target.exists() or target.is_symlink():
            verify_file(target, job)
            return target
        # The approved share directory has a setgid group and permits only owner writes.
        self.spool.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.spool/(job['receipt_key']+'.part')
        if temporary.is_symlink():
            raise Held('staging_path_mismatch')
        with original.open('rb') as source, temporary.open('wb') as destination:
            shutil.copyfileobj(source, destination, 1024*1024)
            destination.flush()
            os.fsync(destination.fileno())
        temporary.chmod(0o640)
        verify_file(temporary, job)
        os.replace(temporary, target)
        if os.name != 'nt':
            descriptor = os.open(self.spool, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        return target

    def mark_done(self, job, item):
        self.change(job['receipt_key'], state='done', item_id=item['id'], reason=None, completed_at=self.clock())

    def check(self, job):
        key, intent = job['receipt_key'], job['intent']
        try:
            self.client.ready()
            items = self.client.find(intent['payload'], marker=intent['marker'])
            if len(items) > 1:
                raise Held('ambiguous_registration')
            if items:
                verify_file(self.objects/(key+'.bin'), job)
                self.client.verify(items[0], job, intent['payload'], intent['library'])
                self.mark_done(job, items[0])
                return
            if self.clock() >= job['checking_until']:
                raise Held('registration_unconfirmed')
            self.change(key, state='checking', next_attempt=self.clock()+self.retry_seconds)
        except Unavailable:
            if self.clock() >= job['checking_until']:
                self.change(key, state='held', reason='registration_unconfirmed')
            else:
                self.change(key, state='checking', next_attempt=self.clock()+self.retry_seconds)
        except Held as error:
            self.change(key, state='held', reason=str(error))

    def step(self):
        row = self.db.execute("SELECT receipt_key FROM eagle_queue WHERE state NOT IN ('done','held') ORDER BY seq LIMIT 1").fetchone()
        if row is None:
            return
        job = self.job(row['receipt_key'])
        if self.clock() < job['next_attempt']:
            return  # A head retry also waits for all subsequent jobs.
        if job['intent'] is not None:
            self.check(job)  # Even a crash immediately before POST must never auto-POST again.
            return
        key = job['receipt_key']
        try:
            self.client.ready()
            staged = self.stage(job)
            payload, library = self.client.prepare(job['spec'], staged)
            existing = self.client.find(payload)
            if len(existing) > 1:
                raise Held('ambiguous_duplicate')
            if existing:
                self.client.verify(existing[0], job, payload, library)
                self.mark_done(job, existing[0])
                return
        except (Unavailable, OSError):
            self.change(key, state='retry', reason='destination_unavailable', next_attempt=self.clock()+self.retry_seconds)
            return
        except Held as error:
            self.change(key, state='held', reason=str(error))
            return
        attempt = job['attempt']+1
        marker = 'fanbox-spool:'+key+':'+str(attempt)
        payload = {**payload, 'annotation':marker}
        if 'imageIndex' in job['spec']:
            base = self.db.execute('''SELECT base_time FROM eagle_order_bases
                WHERE post_id=(SELECT post_id FROM receipts WHERE key=?)''', (key,)).fetchone()
            # Eagle calls its import/addition date modificationTime. Newest-first
            # display puts the smallest image index first, regardless of completion order.
            payload['modificationTime'] = base['base_time'] - job['spec']['imageIndex']*1000
        intent = json.dumps({'payload':payload,'library':library,'marker':marker},ensure_ascii=False,sort_keys=True)
        with self.db:
            self.db.execute('INSERT INTO eagle_attempts VALUES (?,?,?)',(key,attempt,intent))
            self.db.execute("UPDATE eagle_queue SET state='submitting',attempt=?,intent=?,checking_until=?,reason=NULL WHERE receipt_key=?",
                (attempt,intent,self.clock()+self.checking_seconds,key))
        # Everything needed for reconciliation is durable before the item POST.
        try:
            self.client.post(payload)
        except Exception:
            self.change(key, state='checking', reason='post_outcome_unknown')
        else:
            self.change(key, state='checking', reason=None)

    def resubmit(self, key, confirm_not_registered):
        job = self.job(key)
        if confirm_not_registered is not True or job is None or job['state'] != 'held':
            raise ValueError('Explicit unregistered confirmation is required for a held item')
        self.change(key, state='pending', intent=None, next_attempt=0, reason=None, checking_until=None)

    def cleanup_change(self, key, state, reason=None, next_attempt=0):
        with self.db:
            self.db.execute('''INSERT INTO local_cleanup(receipt_key,state,reason,next_attempt,deleted_at,deletion_started)
                VALUES (?,?,?,?,?,?) ON CONFLICT(receipt_key) DO UPDATE SET
                state=excluded.state,reason=excluded.reason,next_attempt=excluded.next_attempt,
                deleted_at=excluded.deleted_at,
                deletion_started=MAX(local_cleanup.deletion_started,excluded.deletion_started)''',
                (key,state,reason,next_attempt,self.clock() if state=='deleted' else None,
                 int(state in ('deleting','deleted'))))

    def cleanup_step(self):
        # Cleanup is separate from the registration FIFO; a failure never reopens a done job.
        row = self.db.execute('''SELECT q.receipt_key,c.state AS cleanup_state FROM eagle_queue q
            LEFT JOIN local_cleanup c ON c.receipt_key=q.receipt_key
            WHERE q.state='done' AND (c.state IS NULL OR
                (c.state IN ('retry','deleting') AND c.next_attempt<=?)) ORDER BY q.seq LIMIT 1''',
                (self.clock(),)).fetchone()
        if row is None:
            return
        key, previous = row['receipt_key'], row['cleanup_state']
        job = self.job(key)
        paths = [self.objects/(key+'.bin'),
                 self.spool/(key+'.'+job['spec']['fileName'].rsplit('.',1)[-1].lower())]
        try:
            # GET-only recheck of the recorded Eagle item, destination and library hash.
            self.client.verify_done(job, paths[1])
            for path in paths:
                if previous != 'deleting' or path.exists() or path.is_symlink():
                    verify_file(path, job)
            # This durable tombstone precedes both unlinks, so repeat intake/restarts
            # keep the original receipt even if only one unlink completed.
            self.cleanup_change(key, 'deleting')
            for path in paths:
                if path.exists() or path.is_symlink():
                    verify_file(path, job)
                    path.unlink()
                sync_directory(path.parent)
            self.cleanup_change(key, 'deleted')
        except Held as error:
            self.cleanup_change(key, 'held', str(error))
        except (Unavailable, OSError):
            # Preserve deleting across partial removal; the next try rechecks Eagle.
            current = self.db.execute('SELECT state FROM local_cleanup WHERE receipt_key=?', (key,)).fetchone()
            state = 'deleting' if current and current['state']=='deleting' else 'retry'
            self.cleanup_change(key, state, 'cleanup_unavailable', self.clock()+self.retry_seconds)

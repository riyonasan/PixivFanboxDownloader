"""FANBOX file intake and durable FIFO. No source URL, cookie or arbitrary-path API."""
import argparse
from collections import Counter
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import sqlite3
import threading
import time
import urllib.request
from urllib.parse import urlsplit

from service import Storage, Handler, Rejected, CHUNK, make_server
from fifo import Queue, validate_spec
from eagle_client import EagleClient

GIB = 1024**3
MAX_FILE = 1024 * GIB  # Streaming; capacity is checked before and during transfer.
BOOLEAN_SETTINGS = '''image music video compressed ps other free pay feeSwitch idRangeSwitch
postDate saveLink saveText saveComment autoStartDownload savePostCover zeroPadding deduplication
unifiedURL titleMustTextSwitch titleCannotTextSwitch fileNameIncludeSwitch fileNameExcludeSwitch
totalDownloadLimitSwitch'''.split()
NUMBER_SETTINGS = '''fee idRangeInput postDateStart postDateEnd downloadThread zeroPaddingLength
downloadInterval crawlInterval totalDownloadLimit totalDownloadLimitByte'''.split()
STRING_SETTINGS = '''feeRange idRange textFormat userSetName dateFormat nameruleForNonImages imageSize'''.split()
ARRAY_SETTINGS = '''titleMustText titleCannotText fileNameInclude fileNameExclude'''.split()


def validate_config(value):
    if not isinstance(value, dict) or set(value) != {'settings','profiles'}:
        raise Rejected('Only acquisition settings and creator conditions can be applied')
    settings, profiles = value['settings'], value['profiles']
    allowed = set(BOOLEAN_SETTINGS+NUMBER_SETTINGS+STRING_SETTINGS+ARRAY_SETTINGS)
    if not isinstance(settings, dict) or not settings.keys() <= allowed:
        raise Rejected('Unknown setting or progress field')
    for key, item in settings.items():
        valid = (key in BOOLEAN_SETTINGS and type(item) is bool
                 or key in NUMBER_SETTINGS and type(item) in (int,float) and 0 <= item <= 2**53-1
                 or key in STRING_SETTINGS and isinstance(item,str) and len(item) <= 4096
                 or key in ARRAY_SETTINGS and isinstance(item,list) and len(item) <= 1000 and all(isinstance(x,str) and len(x)<=1000 for x in item))
        if not valid:
            raise Rejected('Invalid acquisition setting')
    for key, choices in {'feeRange':['>=','=','<='],'idRange':['>','<'],'textFormat':['txt','html'],'imageSize':['original','thumbnail']}.items():
        if key in settings and settings[key] not in choices:
            raise Rejected('Invalid acquisition setting')
    if ('downloadThread' in settings and (type(settings['downloadThread']) is not int or not 1<=settings['downloadThread']<=3)
            or any(key in settings and not 0<=settings[key]<=3600 for key in ('downloadInterval','crawlInterval'))):
        raise Rejected('Invalid acquisition interval or thread count')
    if not isinstance(profiles,list) or len(profiles)>1000:
        raise Rejected('Invalid creator conditions')
    ids = set()
    for profile in profiles:
        if (not isinstance(profile,dict) or set(profile) != {'creatorId','name','free','pay','minFee','maxFee'}
                or not isinstance(profile['creatorId'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}',profile['creatorId'])
                or profile['creatorId'] in ids or not isinstance(profile['name'],str) or len(profile['name'])>200
                or type(profile['free']) is not bool or type(profile['pay']) is not bool
                or any(profile[k] is not None and (type(profile[k]) is not int or not 0<=profile[k]<=100000000) for k in ('minFee','maxFee'))
                or profile['minFee'] is not None and profile['maxFee'] is not None and profile['minFee']>profile['maxFee']):
            raise Rejected('Invalid creator condition')
        ids.add(profile['creatorId'])
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)


class SpoolStorage(Storage):
    def __init__(self, root, spool, client, disk_usage=shutil.disk_usage, deletion_enabled=False):
        self.deletion_enabled = deletion_enabled
        super().__init__(root, min_free=0, max_file=MAX_FILE)
        self.disk_usage = disk_usage
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS runtime_state(name TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS configuration(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision TEXT NOT NULL,body TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS notifications(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,body TEXT NOT NULL,sent INTEGER NOT NULL DEFAULT 0);
            CREATE INDEX IF NOT EXISTS notifications_kind_sent ON notifications(kind,sent);
        ''')
        self.queue = Queue(self.db, self.objects, spool, client)
        for row in self.db.execute("SELECT * FROM receipts WHERE state='committing'").fetchall():
            self.recover(row)
        self.queue.recover_saved()

    def transition(self, name, value, message=None):
        old = self.db.execute('SELECT value FROM runtime_state WHERE name=?',(name,)).fetchone()
        if old is not None and old[0] == value:
            return
        with self.db:
            self.db.execute('INSERT INTO runtime_state VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value',(name,value))
            if message:
                self.db.execute('INSERT INTO notifications(kind,body) VALUES (?,?)',(name,message))

    def capacity(self):
        free = self.disk_usage(self.root).free
        row = self.db.execute("SELECT value FROM runtime_state WHERE name='capacity'").fetchone()
        stopped = bool(row and row[0] == 'paused')
        stopped = free < (20*GIB if stopped else 10*GIB)
        self.transition('capacity','paused' if stopped else 'ready',
            'FANBOX: 空き容量不足のため新規取得を停止しました。登録待ちは継続します。' if stopped
            else ('FANBOX: 空き容量が20 GiB以上に回復し、新規取得を再開できます。' if row and row[0]=='paused' else None))
        return {'freeBytes':free,'acquisitionPaused':stopped}

    def check_space(self, additional):
        state = self.capacity()
        if state['acquisitionPaused']:
            raise Rejected('Storage paused; resume at 20 GiB free',507)
        if state['freeBytes'] < 10*GIB+additional:
            raise Rejected('Insufficient free space for this file',507)

    def receipt(self, row):
        self.queue.enqueue_saved(row['key'])
        result = super().receipt(row)
        job = self.queue.job(row['key'])
        if job:
            result['eagleState'] = job['state']
        return result

    def recover(self, row):
        def cleaned():
            return self.db.execute('''SELECT 1 FROM local_cleanup c JOIN eagle_queue q
                ON q.receipt_key=c.receipt_key WHERE c.receipt_key=? AND q.state='done'
                AND c.deletion_started=1''', (row['key'],)).fetchone() is not None
        if row['state']=='saved' and cleaned():
            return self.receipt(row)
        try:
            return super().recover(row)
        except (Rejected, OSError):
            # The worker may commit its tombstone while this connection verifies.
            if row['state']=='saved' and cleaned():
                return self.receipt(row)
            raise

    def begin(self, metadata):
        if not isinstance(metadata,dict):
            raise Rejected('Invalid upload metadata')
        metadata = dict(metadata)
        spec = metadata.pop('registration',None)
        if spec is not None:
            try:
                validate_spec(spec,metadata.get('postId',''))
            except (ValueError,TypeError):
                raise Rejected('Invalid registration information') from None
        result = super().begin(metadata)
        if spec is not None:
            key = hashlib.sha256((metadata['postId']+'\0'+metadata['fileId']).encode()).hexdigest()
            self.queue.remember(key,spec,metadata['postId'])
            self.queue.enqueue_saved(key)
            if result['state']=='saved':
                result['eagleState'] = self.queue.job(key)['state']
        return result

    def apply_config(self, value):
        body = validate_config(value)
        revision = hashlib.sha256(body.encode()).hexdigest()
        with self.db:
            self.db.execute('INSERT INTO configuration VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision,body=excluded.body',(revision,body))
        return self.config()

    def config(self):
        row = self.db.execute('SELECT revision,body FROM configuration WHERE singleton=1').fetchone()
        return {'revision':row[0],'value':json.loads(row[1])} if row else {'revision':None,'value':None}

    def status(self):
        rows = self.db.execute('''SELECT r.key AS receiptId,r.name AS fileName,r.size,r.sha256,r.state AS saveState,
            COALESCE(q.state,'not_submitted') AS eagleState,q.reason,q.item_id AS itemId,q.seq,
            COALESCE(c.state,'retained') AS localFileState,c.reason AS cleanupReason
            FROM receipts r LEFT JOIN eagle_queue q ON r.key=q.receipt_key
            LEFT JOIN local_cleanup c ON c.receipt_key=r.key ORDER BY COALESCE(q.seq,0) DESC LIMIT 200''').fetchall()
        counts = {row[0]:row[1] for row in self.db.execute('SELECT state,count(*) FROM eagle_queue GROUP BY state')}
        applied = self.db.execute("SELECT value FROM runtime_state WHERE name='applied_configuration'").fetchone()
        return {**self.capacity(),'counts':counts,'items':[dict(row) for row in rows],
                'configurationRevision':self.config()['revision'],'appliedRevision':applied[0] if applied else None,
                'deletionEnabled':self.deletion_enabled}


class SpoolHandler(Handler):
    server_version = 'FanboxSpool'

    def origin_allowed(self, origin):
        if ipaddress.ip_address(self.client_address[0]).is_loopback:
            return super().origin_allowed(origin)
        # The main PC's unpacked extension has a different installation ID.
        # Its exact Tailnet peer and bearer token are checked separately.
        return origin is None or re.fullmatch(r'chrome-extension://[a-p]{32}',origin) is not None

    def handle_request(self):
        path = urlsplit(self.path).path
        local = ipaddress.ip_address(self.client_address[0]).is_loopback
        if not local and self.client_address[0] != self.server.management_peer:
            self.reply(403,{'error':'Peer is not allowed'})
            return
        if not local and path.startswith('/v1/uploads'):
            self.reply(403,{'error':'File intake is local to the mini PC'})
            return
        super().handle_request()

    def extra_request(self, path, content):
        if self.command=='GET' and path=='/v1/health':
            return {'mode':'spool','eagleEnabled':True,'maxSize':MAX_FILE,**self.server.storage.capacity()}
        if self.command=='GET' and path=='/v1/config':
            return self.server.storage.config()
        if self.command=='GET' and path=='/v1/status':
            return self.server.storage.status()
        if self.command=='POST' and path=='/v1/config':
            return self.server.storage.apply_config(json.loads(content))
        if self.command=='POST' and path=='/v1/config/applied':
            body = json.loads(content)
            if (not ipaddress.ip_address(self.client_address[0]).is_loopback or not isinstance(body,dict)
                    or set(body)!={'revision'} or body['revision'] != self.server.storage.config()['revision']):
                raise Rejected('Only the local collector can confirm the current configuration',409)
            self.server.storage.transition('applied_configuration',body['revision'])
            return {'revision':body['revision']}
        if self.command=='POST' and (match:=re.fullmatch(r'/v1/held/([a-f0-9]{64})/resubmit',path)):
            body = json.loads(content)
            if not isinstance(body,dict) or set(body)!={'confirmNotRegistered'}:
                raise Rejected('Explicit confirmation is required')
            try:
                self.server.storage.queue.resubmit(match[1],body['confirmNotRegistered'])
            except ValueError:
                raise Rejected('Only held items with explicit confirmation can be resubmitted',409) from None
            return {'state':'pending'}
        return None

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request


def notification_step(storage, url):
    if not url:
        return
    # Discard resolved holds and repeats, including unsent notifications from older versions.
    with storage.db:
        storage.db.execute('''UPDATE notifications SET sent=1 WHERE sent=0 AND kind LIKE 'eagle:%'
            AND (NOT EXISTS (SELECT 1 FROM eagle_queue q WHERE q.receipt_key=substr(notifications.kind,7) AND q.state='held')
                OR EXISTS (SELECT 1 FROM notifications old WHERE old.kind=notifications.kind AND old.sent=1))''')
    pending = storage.db.execute('''SELECT n.kind,q.reason FROM notifications n
        JOIN eagle_queue q ON q.receipt_key=substr(n.kind,7)
        WHERE n.sent=0 AND n.kind LIKE 'eagle:%' AND q.state='held' GROUP BY n.kind,q.reason''').fetchall()
    due = storage.db.execute("SELECT value FROM runtime_state WHERE name='eagle_notification_due'").fetchone()
    now = time.time()
    with storage.db:
        if not pending:
            storage.db.execute("DELETE FROM runtime_state WHERE name='eagle_notification_due'")
        elif due is None:
            storage.db.execute("INSERT INTO runtime_state VALUES ('eagle_notification_due',?)", (str(now+1800),))
    # Capacity and cleanup notices keep their immediate delivery and cannot wait behind a digest.
    row = storage.db.execute("SELECT seq,body FROM notifications WHERE sent=0 AND kind NOT LIKE 'eagle:%' ORDER BY seq LIMIT 1").fetchone()
    if row is not None:
        body = row['body']
    elif pending and due is not None and now >= float(due['value']):
        reasons = Counter('登録結果未確認' if item['reason']=='registration_unconfirmed'
                          else '照合不一致' if 'mismatch' in (item['reason'] or '')
                          else '重複判定不明' if 'ambiguous' in (item['reason'] or '')
                          else 'その他' for item in pending)
        detail = '、'.join(f'{name}{count}件' for name,count in sorted(reasons.items()))
        body = f'FANBOX: Eagle登録の確認待ちが新たに{len(pending)}件あります（{detail}）。原本は保持しています。状態一覧で確認してください。'
    else:
        return
    request = urllib.request.Request(url,body.encode(),{'Content-Type':'text/plain; charset=utf-8'})
    try:
        # The destination is a private local configuration, never an API field.
        with urllib.request.urlopen(request,timeout=10) as response:
            if response.status<200 or response.status>=300:
                return
        with storage.db:
            if row is not None:
                storage.db.execute('UPDATE notifications SET sent=1 WHERE seq=?',(row['seq'],))
            else:
                storage.db.executemany('UPDATE notifications SET sent=1 WHERE kind=?', ((item['kind'],) for item in pending))
                storage.db.execute("DELETE FROM runtime_state WHERE name='eagle_notification_due'")
    except OSError:
        pass


def worker(root, spool, client, stop, notification_url, deletion_enabled=False):
    storage = SpoolStorage(root,spool,client,deletion_enabled=deletion_enabled)
    try:
        while not stop.is_set():
            try:
                storage.capacity()
                storage.queue.step()
                if deletion_enabled:
                    storage.queue.cleanup_step()
                for cleanup in storage.db.execute("SELECT receipt_key,state FROM local_cleanup").fetchall():
                    storage.transition('cleanup:'+cleanup['receipt_key'],cleanup['state'],
                        'FANBOX: 登録済み原本の自動削除を保留しました。状態一覧で確認してください。' if cleanup['state']=='held' else None)
                for job in storage.db.execute("SELECT receipt_key,state FROM eagle_queue").fetchall():
                    storage.transition('eagle:'+job['receipt_key'],job['state'],
                        'FANBOX: Eagle登録に確認待ちがあります。状態一覧で確認してください。' if job['state']=='held' else None)
                notification_step(storage,notification_url)
            except Exception:
                print('FANBOX FIFO storage unavailable; durable records retained',flush=True)
            stop.wait(5)
    finally:
        storage.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local-config',required=True)
    args = parser.parse_args()
    # Contains paths/endpoints only; secrets stay in separate private files.
    config = json.loads(Path(args.local_config).read_text(encoding='utf-8'))
    deletion_enabled = config.get('deletionEnabled', False)
    if type(deletion_enabled) is not bool:
        raise ValueError('deletionEnabled must be a local boolean setting')
    os.umask(0o077)
    root = Path(config['dataDir'])
    root.mkdir(mode=0o700,parents=True,exist_ok=True)
    import fcntl  # Production runtime is Linux; protects against two FIFO workers.
    with (root/'service.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        client = EagleClient(config['eagleApi'],config['eagleTokenFile'],config['uncRoot'],config['eagleLibraryPath'],config['eagleLibraryMount'])
        storage = SpoolStorage(root,config['spoolDir'],client,deletion_enabled=deletion_enabled)
        token = Path(config['tokenFile']).read_text(encoding='utf-8').strip()
        stop = threading.Event()
        thread = threading.Thread(target=worker,args=(root,config['spoolDir'],client,stop,config.get('notificationURL'),deletion_enabled),daemon=True)
        servers = []
        try:
            # Both listeners use one intake connection. The worker has a separate SQLite connection.
            for host in ['127.0.0.1', *([config['managementBind']] if config.get('managementBind') else [])]:
                server = make_server(storage,token,config['extensionId'],port=0)
                server.server_close()
                from http.server import HTTPServer
                server = HTTPServer((host,18096),SpoolHandler)
                server.storage,server.token,server.extension_id = storage,token,config['extensionId']
                server.management_peer = config.get('managementPeer')
                server.metadata_limit = 1024*1024
                servers.append(server)
            thread.start()
            with selectors.DefaultSelector() as selector:
                for server in servers:
                    selector.register(server,selectors.EVENT_READ)
                print('FANBOX spool started; verified cleanup '+('enabled' if deletion_enabled else 'disabled'),flush=True)
                while True:
                    for key,_ in selector.select(timeout=1):
                        key.fileobj.handle_request()
        finally:
            stop.set()
            for server in servers:
                server.server_close()
            if thread.is_alive():
                thread.join(timeout=45)
            storage.close()


if __name__=='__main__':
    main()

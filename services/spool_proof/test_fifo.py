import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import http.client
from http.server import HTTPServer
import queue
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from fifo import Held, Unavailable, Queue
from runtime import SpoolStorage, SpoolHandler, GIB, validate_config
from eagle_client import EagleClient, same_name, folder_path
from service import Rejected


class Crash(BaseException):
    pass


class FakeEagle:
    def __init__(self):
        self.available, self.items, self.posts, self.mode = True, [], [], 'normal'

    def ready(self):
        if not self.available:
            raise Unavailable()
        return 'library'

    def prepare(self,spec,staged):
        return {'path':str(staged),'name':spec['fileName'].split('/')[-1].rsplit('.',1)[0],
                'folderId':'folder','website':spec['website'],'tags':spec['tags']},'library'

    def find(self,payload,marker=None):
        return [x for x in self.items if x['name']==payload['name'] and (marker is None or x.get('annotation')==marker)]

    def verify(self,item,job,payload,library):
        if item.get('mismatch'):
            raise Held('eagle_original_mismatch')

    def post(self,payload):
        if self.mode=='before_post_crash':
            raise Crash()
        self.posts.append(payload.copy())
        if self.mode!='lost_no_item':
            self.items.append({**payload,'id':str(len(self.posts))})
        if self.mode in ('lost_response','lost_no_item'):
            raise OSError('response lost')


def meta(file_id='abc'):
    return {'postId':'123','fileId':'image:'+file_id,'fileName':file_id+'.png','expectedSize':5,
            'registration':{'fileName':'fanbox/作者/2026-10-10-投稿/投稿-001.png',
            'website':'https://www.fanbox.cc/@creator/posts/123','tags':['tag']}}


class FifoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)/'data'
        self.spool = Path(self.tmp.name)/'spool'
        self.eagle = FakeEagle()
        self.free = 100*GIB
        self.now = 1000
        self.open()

    def open(self):
        self.storage = SpoolStorage(self.root,self.spool,self.eagle,lambda _:SimpleNamespace(free=self.free))
        self.queue = self.storage.queue
        self.queue.clock = lambda:self.now

    def restart(self):
        self.storage.close()
        self.open()

    def tearDown(self):
        self.storage.close()
        self.tmp.cleanup()

    def save(self,value=None):
        session = self.storage.begin(value or meta())
        self.storage.append(session['uploadId'],0,b'hello')
        return self.storage.finish(session['uploadId'],5)

    def state(self,key):
        return self.queue.job(key)['state']

    def test_save_is_pending_not_registered_and_duplicate_does_not_enqueue_twice(self):
        receipt = self.save()
        self.assertEqual(receipt['eagleState'],'pending')
        self.assertEqual(self.storage.begin(meta()),receipt)
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM eagle_queue').fetchone()[0],1)
        self.assertEqual(len(list((self.root/'objects').glob('*.bin'))),1)

    def test_normal_registration_verified_then_done_with_originals_retained(self):
        key = self.save()['receiptId']
        self.queue.step()
        self.assertEqual(self.state(key),'checking')
        self.restart()
        self.queue.step()
        self.assertEqual(self.state(key),'done')
        self.assertEqual(len(self.eagle.posts),1)
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())
        self.assertTrue((self.spool/(key+'.png')).exists())

    def test_crash_immediately_before_post_never_reposts_after_restart(self):
        key = self.save()['receiptId']
        self.eagle.mode = 'before_post_crash'
        with self.assertRaises(Crash):
            self.queue.step()
        self.assertEqual(self.state(key),'submitting')
        self.restart()
        self.eagle.mode = 'normal'
        self.queue.step()
        self.now += 400
        self.queue.step()
        self.assertEqual(self.state(key),'held')
        self.assertEqual(len(self.eagle.posts),0)

    def test_accepted_response_lost_is_reconciled_without_second_post(self):
        key = self.save()['receiptId']
        self.eagle.mode = 'lost_response'
        self.queue.step()
        self.restart()
        self.queue.step()
        self.assertEqual(self.state(key),'done')
        self.assertEqual(len(self.eagle.posts),1)

    def test_done_database_update_failure_reconciles_without_second_post(self):
        key = self.save()['receiptId']
        self.queue.step()
        with patch.object(self.queue,'mark_done',side_effect=sqlite3.OperationalError('disk full')):
            with self.assertRaises(sqlite3.Error):
                self.queue.step()
        self.restart()
        self.queue.step()
        self.assertEqual(self.state(key),'done')
        self.assertEqual(len(self.eagle.posts),1)

    def test_intent_database_failure_prevents_post(self):
        self.save()
        self.storage.db.execute("CREATE TRIGGER crash_intent BEFORE INSERT ON eagle_attempts BEGIN SELECT RAISE(ABORT,'simulated'); END")
        with self.assertRaises(sqlite3.Error):
            self.queue.step()
        self.assertFalse(self.eagle.posts)

    def test_mismatch_holds_and_original_is_retained(self):
        key = self.save()['receiptId']
        self.queue.step()
        self.eagle.items[0]['mismatch'] = True
        self.queue.step()
        self.assertEqual(self.state(key),'held')
        self.assertEqual((self.root/'objects'/(key+'.bin')).read_bytes(),b'hello')

    def test_ambiguous_marker_holds_without_repost(self):
        key = self.save()['receiptId']
        self.queue.step()
        self.eagle.items.append(self.eagle.items[0].copy())
        self.queue.step()
        self.assertEqual(self.state(key),'held')
        self.assertEqual(len(self.eagle.posts),1)

    def test_retry_head_blocks_followers_and_held_releases_followers(self):
        first = self.save()['receiptId']
        second_meta = meta('def')
        second_meta['registration']['fileName'] = 'FANBOX/作者/投稿-002.png'
        second = self.save(second_meta)['receiptId']
        self.eagle.available = False
        self.queue.step()
        self.assertEqual(self.state(first),'retry')
        self.eagle.available = True
        self.queue.step()
        self.assertEqual(self.state(second),'pending')
        self.queue.change(first,state='held')
        self.queue.step()
        self.assertEqual(self.state(second),'checking')

    def test_unknown_result_requires_explicit_resubmit(self):
        key = self.save()['receiptId']
        self.eagle.mode = 'lost_no_item'
        self.queue.step()
        self.now += 400
        self.queue.step()
        self.assertEqual(self.state(key),'held')
        with self.assertRaises(ValueError):
            self.queue.resubmit(key,False)
        self.queue.resubmit(key,True)
        self.eagle.mode = 'normal'
        self.queue.step()
        self.queue.step()
        self.assertEqual(self.state(key),'done')
        self.assertEqual(len(self.eagle.posts),2)
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM eagle_attempts').fetchone()[0],2)

    def test_existing_duplicate_is_verified_without_post(self):
        key = self.save()['receiptId']
        self.eagle.items = [{'name':'投稿-001','id':'existing'}]
        self.queue.step()
        self.assertEqual(self.state(key),'done')
        self.assertEqual(len(self.eagle.posts),0)

    def test_configuration_and_repeat_save_cannot_rename_accepted_item(self):
        key = self.save()['receiptId']
        changed = meta()
        changed['registration']['fileName'] = 'FANBOX/別名.png'
        self.storage.begin(changed)
        self.assertEqual(self.queue.job(key)['spec']['fileName'],meta()['registration']['fileName'])

    def test_saved_receipt_before_enqueue_failure_recovers(self):
        session = self.storage.begin(meta())
        self.storage.append(session['uploadId'],0,b'hello')
        with patch.object(self.queue,'enqueue_saved',side_effect=sqlite3.OperationalError('simulated')):
            with self.assertRaises(sqlite3.Error):
                self.storage.finish(session['uploadId'],5)
        self.restart()
        self.assertEqual(self.storage.begin(meta())['eagleState'],'pending')

    def test_interrupted_transfer_never_queues(self):
        session = self.storage.begin(meta())
        self.storage.append(session['uploadId'],0,b'he')
        self.restart()
        self.assertFalse(self.storage.db.execute('SELECT * FROM eagle_queue').fetchall())
        self.save()
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM eagle_queue').fetchone()[0],1)

    def test_space_hysteresis_persists_and_queue_continues(self):
        key = self.save()['receiptId']
        self.free = 9*GIB
        with self.assertRaises(Rejected):
            self.storage.begin(meta('new'))
        self.queue.step()
        self.assertEqual(self.state(key),'checking')
        self.free = 15*GIB
        self.restart()
        self.assertTrue(self.storage.capacity()['acquisitionPaused'])
        self.free = 20*GIB
        self.assertFalse(self.storage.capacity()['acquisitionPaused'])
        self.assertEqual(self.storage.db.execute("SELECT count(*) FROM notifications WHERE kind='capacity'").fetchone()[0],2)

    def test_large_reservation_failure_does_not_oscillate_capacity_notifications(self):
        self.free = 30*GIB
        with self.assertRaises(Rejected):
            self.storage.begin({**meta(),'expectedSize':40*GIB})
        self.assertFalse(self.storage.capacity()['acquisitionPaused'])
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM notifications').fetchone()[0],0)

    def test_configuration_failed_transaction_preserves_previous_and_queue(self):
        key = self.save()['receiptId']
        initial = self.storage.apply_config({'settings':{'userSetName':'FANBOX/{user}/{index}'},'profiles':[]})
        self.storage.db.execute("CREATE TRIGGER fail_config BEFORE UPDATE ON configuration BEGIN SELECT RAISE(ABORT,'simulated'); END")
        with self.assertRaises(sqlite3.Error):
            self.storage.apply_config({'settings':{},'profiles':[]})
        self.assertEqual(self.storage.config(),initial)
        self.assertEqual(self.state(key),'pending')
        for value in ({'settings':{},'profiles':[],'progress':{}},{'settings':{'spoolProofToken':'secret'},'profiles':[]}):
            with self.assertRaises(Rejected):
                self.storage.apply_config(value)

    def test_invalid_registration_cannot_enter_file_intake(self):
        for name in ('../x.png','FANBOX//x.png','FANBOX/a\\b.png'):
            value = meta()
            value['registration']['fileName'] = name
            with self.assertRaises(Rejected):
                self.storage.begin(value)
        self.assertFalse(self.storage.db.execute('SELECT * FROM receipts').fetchall())

    def test_corrupt_original_never_posts(self):
        key = self.save()['receiptId']
        (self.root/'objects'/(key+'.bin')).write_bytes(b'wrong')
        self.queue.step()
        self.assertEqual(self.state(key),'held')
        self.assertFalse(self.eagle.posts)


class NamingTests(unittest.TestCase):
    def test_existing_hierarchy_and_zero_padding(self):
        self.assertEqual(folder_path('fanbox/作者/日付-投稿/日付-投稿-001.png'),['FANBOX','作者','日付-投稿'])
        self.assertEqual(folder_path('作者/x.png'),['FANBOX','作者'])
        self.assertTrue(same_name('投稿-1','投稿-001'))
        self.assertFalse(same_name('別名-1','投稿-001'))

    def test_eagle_original_size_hash_metadata_and_library_are_checked(self):
        with tempfile.TemporaryDirectory() as root:
            mount = Path(root)
            original = mount/'images'/'item.info'/'投稿-001.png'
            original.parent.mkdir(parents=True)
            original.write_bytes(b'hello')
            client = EagleClient('http://127.0.0.1:41595/api',mount/'token','\\\\host\\FanboxSpool','library',mount)
            client.ready = lambda:'library'
            payload = {'path':'\\\\host\\FanboxSpool\\key.png','name':'投稿-1','website':'https://www.fanbox.cc/@creator/posts/123','folderId':'folder','tags':['tag'],'annotation':'marker'}
            item = {'id':'item','name':'投稿-001','ext':'png','size':5,'url':payload['website'],'folders':['folder'],'tags':['tag'],'annotation':'marker'}
            job = {'size':5,'sha256':hashlib.sha256(b'hello').hexdigest()}
            client.verify(item,job,payload,'library')
            for changes in ({'url':'wrong'},{'size':6},{'tags':[]},{'folders':[]},{'id':'../x'}):
                with self.assertRaises(Held):
                    client.verify({**item,**changes},job,payload,'library')
            original.write_bytes(b'wrong')
            with self.assertRaises(Held):
                client.verify(item,job,payload,'library')


class ApiTests(unittest.TestCase):
    def test_authenticated_api_and_local_only_upload_boundary(self):
        with tempfile.TemporaryDirectory() as root:
            started = queue.Queue()
            token,extension = 't'*40,'a'*32
            class Handler(SpoolHandler):
                def handle_request(self):
                    if self.headers.get('X-Test-Peer'):
                        self.client_address = (self.headers['X-Test-Peer'],1)
                    super().handle_request()
                do_GET = handle_request
                do_POST = handle_request
                do_PUT = handle_request
            def serve():
                storage = SpoolStorage(Path(root)/'data',Path(root)/'spool',FakeEagle(),lambda _:SimpleNamespace(free=100*GIB))
                with HTTPServer(('127.0.0.1',0),Handler) as server:
                    server.storage,server.token,server.extension_id = storage,token,extension
                    server.management_peer,server.metadata_limit = '100.64.0.2',1024*1024
                    started.put(server)
                    server.serve_forever(poll_interval=.05)
                storage.close()
            thread = threading.Thread(target=serve)
            thread.start()
            server = started.get(timeout=5)
            def request(method,path,body=None,extra=None):
                connection = http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
                try:
                    headers = {'Authorization':'Bearer '+token,**(extra or {})}
                    connection.request(method,path,None if body is None else json.dumps(body),headers)
                    response = connection.getresponse()
                    return response.status,json.loads(response.read())
                finally:
                    connection.close()
            try:
                self.assertEqual(request('GET','/v1/status',extra={'Authorization':'wrong'})[0],401)
                self.assertEqual(request('GET','/v1/status',extra={'Origin':'https://www.fanbox.cc'})[0],403)
                remote = {'X-Test-Peer':'100.64.0.2','Origin':'chrome-extension://'+'b'*32}
                self.assertEqual(request('GET','/v1/status',extra=remote)[0],200)
                self.assertEqual(request('POST','/v1/uploads',meta(),remote)[0],403)
                self.assertEqual(request('GET','/v1/status',extra={'X-Test-Peer':'100.64.0.3'})[0],403)
                self.assertEqual(request('POST','/v1/delete',{'path':'anything'})[0],404)
                self.assertEqual(request('GET','/v1/files?path=anything')[0],404)
                value = {'settings':{'userSetName':'FANBOX/{user}/{index}'},'profiles':[]}
                code,config = request('POST','/v1/config',value,remote)
                self.assertEqual(code,200)
                self.assertEqual(request('GET','/v1/config',extra=remote)[1],config)
                self.assertEqual(request('POST','/v1/config/applied',{'revision':config['revision']},remote)[0],409)
                self.assertEqual(request('POST','/v1/config/applied',{'revision':config['revision']})[0],200)
                self.assertEqual(request('GET','/v1/status')[1]['appliedRevision'],config['revision'])
                _,session = request('POST','/v1/uploads',meta())
                connection = http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
                connection.request('PUT','/v1/uploads/'+session['uploadId'],b'hello',{'Authorization':'Bearer '+token,'X-Offset':'0'})
                response = connection.getresponse()
                self.assertEqual(response.status,200)
                response.read()
                connection.close()
                _,saved = request('POST','/v1/uploads/'+session['uploadId']+'/commit',{'size':5})
                self.assertEqual(saved['eagleState'],'pending')
                status = request('GET','/v1/status')[1]
                self.assertEqual(status['counts'],{'pending':1})
                self.assertFalse(status['deletionEnabled'])
                self.assertEqual(request('POST','/v1/held/'+saved['receiptId']+'/resubmit',{'confirmNotRegistered':True})[0],409)
            finally:
                server.shutdown()
                thread.join(timeout=5)
                self.assertFalse(thread.is_alive())


if __name__=='__main__':
    unittest.main()

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
from runtime import SpoolStorage, SpoolHandler, GIB, validate_config, notification_step
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

    def verify_done(self, job, staged):
        self.ready()
        matches = [item for item in self.items if item['id']==job['item_id']]
        if len(matches)!=1:
            raise Held('cleanup_registration_changed')
        self.verify(matches[0], job, {}, 'library')


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

    def test_image_addition_dates_follow_index_despite_reverse_receipt_order_and_restart(self):
        keys = []
        for index in (3, 1, 2):
            value = meta(str(index))
            value['registration']['imageIndex'] = index
            # A custom filename need not end in the index.
            value['registration']['fileName'] = f'FANBOX/作者/{index:03d}-投稿.png'
            keys.append(self.save(value)['receiptId'])
            self.now += 60
        self.restart()
        for _ in keys:
            self.queue.step()
            self.queue.step()
        self.assertTrue(all(self.state(key) == 'done' for key in keys))
        self.assertEqual([p['modificationTime'] for p in self.eagle.posts],
                         [997000, 999000, 998000])
        self.assertEqual([p['name'] for p in sorted(self.eagle.posts,
                         key=lambda p:p['modificationTime'], reverse=True)],
                         ['001-投稿', '002-投稿', '003-投稿'])
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM eagle_order_bases').fetchone()[0], 1)

    def test_addition_date_survives_unknown_result_and_explicit_resubmit(self):
        value = meta()
        value['registration']['imageIndex'] = 1
        key = self.save(value)['receiptId']
        self.eagle.mode = 'lost_no_item'
        self.queue.step()
        first_time = self.eagle.posts[0]['modificationTime']
        self.restart()
        self.now += 400
        self.queue.step()
        self.assertEqual(self.state(key), 'held')
        self.queue.resubmit(key, True)
        self.eagle.mode = 'normal'
        self.queue.step()
        self.assertEqual(self.eagle.posts[1]['modificationTime'], first_time)

    def test_legacy_registration_keeps_default_addition_date(self):
        self.save()
        self.queue.step()
        self.assertNotIn('modificationTime', self.eagle.posts[0])

    def test_invalid_image_index_rejected_before_receipt(self):
        for index in (-1, True, 1.5, '1', None):
            value = meta()
            value['registration']['imageIndex'] = index
            with self.assertRaises(Rejected):
                self.storage.begin(value)
        self.assertFalse(self.storage.db.execute('SELECT * FROM receipts').fetchall())

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

    def completed(self):
        receipt = self.save()
        self.queue.step()
        self.queue.step()
        self.assertEqual(self.state(receipt['receiptId']), 'done')
        return receipt

    def cleanup_state(self, key):
        return self.storage.db.execute('SELECT state FROM local_cleanup WHERE receipt_key=?', (key,)).fetchone()[0]

    def test_cleanup_deletes_only_verified_done_and_repeat_receipt_survives_restart(self):
        receipt = self.completed()
        key = receipt['receiptId']
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'deleted')
        self.assertFalse((self.root/'objects'/(key+'.bin')).exists())
        self.assertFalse((self.spool/(key+'.png')).exists())
        self.restart()
        self.assertEqual(self.storage.begin(meta())['receiptId'], key)
        self.assertEqual(self.storage.finish(self.storage.db.execute('SELECT upload_id FROM receipts').fetchone()[0],5)['receiptId'], key)
        self.queue.step()
        self.queue.cleanup_step()
        self.assertEqual(len(self.eagle.posts), 1)
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM receipts').fetchone()[0], 1)

    def test_cleanup_pending_and_unknown_registration_never_delete(self):
        key = self.save()['receiptId']
        self.queue.cleanup_step()
        self.queue.step()
        self.queue.cleanup_step()
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())
        self.assertFalse(self.storage.db.execute('SELECT * FROM local_cleanup').fetchall())

    def test_cleanup_eagle_offline_retries_without_blocking_registration(self):
        key = self.completed()['receiptId']
        self.eagle.available = False
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'retry')
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())
        self.eagle.available = True
        self.now += 31
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'deleted')

    def test_cleanup_changed_eagle_or_local_content_holds_without_delete(self):
        key = self.completed()['receiptId']
        self.eagle.items[0]['mismatch'] = True
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'held')
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())
        self.assertTrue((self.spool/(key+'.png')).exists())

    def test_cleanup_changed_staged_content_retains_both_files(self):
        key = self.completed()['receiptId']
        (self.spool/(key+'.png')).write_bytes(b'wrong')
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'held')
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())

    def test_cleanup_missing_local_file_without_tombstone_is_held(self):
        key = self.completed()['receiptId']
        (self.root/'objects'/(key+'.bin')).unlink()
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'held')
        self.assertTrue((self.spool/(key+'.png')).exists())
        with self.assertRaises(Rejected):
            self.storage.begin(meta())

    def test_cleanup_intent_db_failure_deletes_nothing(self):
        key = self.completed()['receiptId']
        self.storage.db.execute("CREATE TRIGGER fail_cleanup BEFORE INSERT ON local_cleanup BEGIN SELECT RAISE(ABORT,'simulated'); END")
        with self.assertRaises(sqlite3.Error):
            self.queue.cleanup_step()
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())
        self.assertTrue((self.spool/(key+'.png')).exists())

    def test_cleanup_partial_unlink_crash_recovers_and_does_not_repost(self):
        key = self.completed()['receiptId']
        original_unlink = Path.unlink
        def crash(path, *args, **kwargs):
            if path.parent==self.spool:
                raise Crash()
            return original_unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', crash):
            with self.assertRaises(Crash):
                self.queue.cleanup_step()
        self.restart()
        self.assertEqual(self.storage.begin(meta())['receiptId'], key)
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'deleted')
        self.assertEqual(len(self.eagle.posts), 1)

    def test_cleanup_partial_removal_then_mismatch_preserves_receipt(self):
        key = self.completed()['receiptId']
        self.queue.cleanup_change(key, 'deleting')
        (self.root/'objects'/(key+'.bin')).unlink()
        self.eagle.items[0]['mismatch'] = True
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'held')
        self.assertEqual(self.storage.begin(meta())['receiptId'], key)
        self.assertTrue((self.spool/(key+'.png')).exists())

    def test_cleanup_final_db_failure_recovers(self):
        key = self.completed()['receiptId']
        self.storage.db.execute("CREATE TRIGGER fail_deleted BEFORE UPDATE ON local_cleanup WHEN NEW.state='deleted' BEGIN SELECT RAISE(ABORT,'simulated'); END")
        with self.assertRaises(sqlite3.Error):
            self.queue.cleanup_step()
        self.restart()
        self.assertEqual(self.storage.begin(meta())['receiptId'], key)
        self.storage.db.execute('DROP TRIGGER fail_deleted')
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'deleted')

    def test_cleanup_unlink_failure_preserves_deleting_until_retry(self):
        key = self.completed()['receiptId']
        with patch.object(Path, 'unlink', side_effect=PermissionError()):
            self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'deleting')
        self.restart()
        self.now += 31
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'deleted')

    @unittest.skipIf(__import__('os').name=='nt', 'Linux deployment symlink boundary')
    def test_cleanup_symlink_never_deletes_external_target(self):
        key = self.completed()['receiptId']
        target = Path(self.tmp.name)/'outside.png'
        target.write_bytes(b'hello')
        staged = self.spool/(key+'.png')
        staged.unlink()
        staged.symlink_to(target)
        self.queue.cleanup_step()
        self.assertEqual(self.cleanup_state(key), 'held')
        self.assertEqual(target.read_bytes(), b'hello')
        self.assertTrue((self.root/'objects'/(key+'.bin')).exists())


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.open_storage()
        self.now = 1000
        self.clock = patch('runtime.time.time', side_effect=lambda:self.now)
        self.clock.start()
        self.http = patch('runtime.urllib.request.urlopen')
        self.send = self.http.start()
        self.send.return_value.__enter__.return_value.status = 200

    def open_storage(self):
        self.storage = SpoolStorage(self.root/'data',self.root/'spool',FakeEagle(),
                                    lambda _:SimpleNamespace(free=100*GIB))

    def tearDown(self):
        self.http.stop()
        self.clock.stop()
        self.storage.close()
        self.tmp.cleanup()

    def hold(self, key, reason='registration_unconfirmed'):
        with self.storage.db:
            self.storage.db.execute("INSERT INTO eagle_queue(receipt_key,state,reason) VALUES (?,'held',?)", (key,reason))
        self.storage.transition('eagle:'+key,'held','old individual notice')

    def step(self):
        notification_step(self.storage,'https://example.invalid/notifications')

    def test_holds_wait_thirty_minutes_and_send_one_reason_summary(self):
        self.hold('a')
        self.step()
        self.now += 1799
        self.hold('b')
        self.hold('c','eagle_metadata_mismatch')
        self.step()
        self.send.assert_not_called()
        self.now += 1
        self.step()
        self.assertEqual(self.send.call_count,1)
        body = self.send.call_args.args[0].data.decode()
        self.assertIn('新たに3件',body)
        self.assertIn('登録結果未確認2件',body)
        self.assertIn('照合不一致1件',body)
        self.now += 3600
        self.step()
        self.assertEqual(self.send.call_count,1)

    def test_resolved_before_delivery_is_excluded_and_empty_batch_resets(self):
        self.hold('a')
        self.step()
        self.storage.queue.change('a',state='done')
        self.now += 1800
        self.step()
        self.send.assert_not_called()
        self.assertIsNone(self.storage.db.execute("SELECT value FROM runtime_state WHERE name='eagle_notification_due'").fetchone())
        self.hold('b')
        self.step()
        self.send.assert_not_called()

    def test_restart_keeps_due_time_and_notified_items(self):
        self.hold('a')
        self.step()
        self.now += 1800
        self.storage.close()
        self.open_storage()
        self.step()
        self.assertEqual(self.send.call_count,1)
        self.storage.close()
        self.open_storage()
        self.now += 3600
        self.step()
        self.assertEqual(self.send.call_count,1)

    def test_only_new_items_enter_next_batch(self):
        self.hold('a')
        self.step()
        self.now += 1800
        self.step()
        self.hold('b','ambiguous_duplicate')
        self.step()
        self.assertEqual(self.send.call_count,1)
        self.now += 1800
        self.step()
        self.assertIn('新たに1件',self.send.call_args.args[0].data.decode())
        self.assertIn('重複判定不明1件',self.send.call_args.args[0].data.decode())

    def test_same_receipt_is_not_notified_again_after_state_changes(self):
        self.hold('a')
        self.step()
        self.now += 1800
        self.step()
        self.storage.queue.change('a',state='pending')
        self.storage.transition('eagle:a','pending')
        self.storage.queue.change('a',state='held')
        self.storage.transition('eagle:a','held','repeat')
        self.now += 3600
        self.step()
        self.assertEqual(self.send.call_count,1)

    def test_legacy_pending_duplicates_and_already_sent_holds_are_not_repeated(self):
        self.hold('a')
        self.hold('b')
        with self.storage.db:
            self.storage.db.execute("UPDATE notifications SET sent=1 WHERE kind='eagle:a'")
            self.storage.db.execute("INSERT INTO notifications(kind,body) VALUES ('eagle:a','repeat')")
            self.storage.db.execute("INSERT INTO notifications(kind,body) VALUES ('eagle:b','repeat')")
        self.step()
        self.now += 1800
        self.step()
        self.assertEqual(self.send.call_count,1)
        self.assertIn('新たに1件',self.send.call_args.args[0].data.decode())
        self.step()
        self.assertEqual(self.send.call_count,1)

    def test_capacity_and_cleanup_notices_do_not_wait_for_held_digest(self):
        self.hold('a')
        for kind in ['capacity','cleanup:a']:
            self.storage.transition(kind,'held','immediate '+kind)
            self.step()
            self.assertEqual(self.send.call_args.args[0].data.decode(),'immediate '+kind)
        self.assertEqual(self.send.call_count,2)

    def test_failed_send_retries_only_still_held_items(self):
        self.hold('a')
        self.hold('b')
        self.step()
        self.now += 1800
        self.send.side_effect = OSError('offline')
        self.step()
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM notifications WHERE sent=0').fetchone()[0],2)
        self.send.side_effect = None
        self.send.return_value.__enter__.return_value.status = 503
        self.step()
        self.assertEqual(self.storage.db.execute('SELECT count(*) FROM notifications WHERE sent=0').fetchone()[0],2)
        self.storage.queue.change('a',state='done')
        self.send.return_value.__enter__.return_value.status = 200
        self.step()
        self.assertIn('新たに1件',self.send.call_args.args[0].data.decode())

    def test_no_url_keeps_notifications_without_network_access(self):
        self.hold('a')
        notification_step(self.storage,None)
        self.send.assert_not_called()
        self.assertEqual(self.storage.db.execute('SELECT sent FROM notifications').fetchone()[0],0)


class NamingTests(unittest.TestCase):
    def test_cleanup_resolves_existing_destination_without_post_and_checks_recorded_id(self):
        with tempfile.TemporaryDirectory() as root:
            mount = Path(root)
            original = mount/'images'/'item.info'/'投稿-001.png'
            original.parent.mkdir(parents=True)
            original.write_bytes(b'hello')
            client = EagleClient('http://127.0.0.1:41595/api', mount/'token', '\\\\host\\FanboxSpool', 'library', mount)
            client.ready = lambda:'library'
            spec = meta()['registration']
            item = {'id':'item','name':'投稿-001','ext':'png','size':5,'url':spec['website'],
                    'folders':['folder'],'tags':['tag']}
            folders = [{'name':'FANBOX','id':'root','children':[{'name':'作者','id':'creator',
                       'children':[{'name':'2026-10-10-投稿','id':'folder'}]}]}]
            calls = []
            def request(endpoint, payload=None):
                self.assertIsNone(payload)  # GET-only, never create or submit.
                calls.append(endpoint)
                return folders if endpoint=='folder/list' else [item]
            client.request = request
            job = {'spec':spec,'intent':None,'item_id':'item','size':5,
                   'sha256':hashlib.sha256(b'hello').hexdigest()}
            client.verify_done(job, mount/'key.png')
            item['id'] = 'different'
            with self.assertRaises(Held):
                client.verify_done(job, mount/'key.png')
            item['id'] = 'item'
            original.write_bytes(b'wrong')
            with self.assertRaises(Held):
                client.verify_done(job, mount/'key.png')
            self.assertFalse(any('create' in call or 'addFromPath' in call for call in calls))

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

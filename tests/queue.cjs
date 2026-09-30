const { strict: assert } = require('node:assert')
require('fake-indexeddb/auto')
const { DurableQueue, Delivery, marker } = require('../.test-build/queue/DurableQueue')
const { claim } = require('../.test-build/queue/Ownership')
const { sha256 } = require('@noble/hashes/sha256')
const meta = n => ({ recordKey: `fixture:${n}`, filename: `fanbox/creator/post/${n}.mov`, website: 'https://www.fanbox.cc/@fixture/posts/1', mime: 'video/quicktime' })
const add = async (q, n, bytes = Uint8Array.of(1, 2, 3)) => {
  const j = await q.begin(meta(n)); await q.append(j.id, 0, bytes); return q.accept(j.id, bytes.length)
}
async function main() {
  let q = await DurableQueue.open('restart', 10)
  const a = await add(q, 'a')
  assert.equal(a.state, 'ready'); assert.equal(a.hash, Buffer.from(sha256(Uint8Array.of(1,2,3))).toString('hex'))
  assert.deepEqual(await q.begin(meta('a')), a)
  q.close(); q = await DurableQueue.open('restart', 10)
  assert.equal((await q.get(a.id)).filename, a.filename)
  const stage = await q.begin(meta('capacity'))
  await assert.rejects(q.append(stage.id, 0, new Uint8Array(8)), /Queue full/)
  assert.equal((await q.get(stage.id)).size, 0)
  assert.equal((await q.get(a.id)).size, 3)
  await assert.rejects(q.accept(stage.id, 2), /Incomplete/)
  await q.append(stage.id, 0, Uint8Array.of(7))
  await assert.rejects(q.accept(stage.id, 1, 'wrong'), /Source changed/)
  assert.equal((await q.get(stage.id)).state, 'staging')
  await q.update(a.id, { state: 'sending' }); await q.recover()
  assert.equal((await q.get(a.id)).state, 'unknown')
  let sends = 0, found
  const adapter = { reconcile: async () => found, submit: async () => { sends++ } }
  await new Delivery(q, adapter).run(); assert.equal(sends, 0)
  found = { itemId: 'original-a' }; await new Delivery(q, adapter).run()
  assert.equal((await q.get(a.id)).state, 'pending-verification')
  const proof = { jobId:a.id,itemId:'original-a',marker:marker(a),size:a.size,sha256:a.hash,originalFile:true }
  await assert.rejects(q.verify({...proof, size:0}, true), /proof/)
  await assert.rejects(q.verify({...proof, originalFile:false}, true), /proof/)
  await assert.rejects(q.verify({...proof, itemId:'unrelated-filename'}, true), /proof/)
  let bytes = 0; for await (const b of q.bytes(a)) bytes += b.length; assert.equal(bytes, 3)
  const concurrentProofs = await Promise.allSettled([q.verify(proof,true),q.verify(proof,true)]); assert.equal(concurrentProofs.filter(r=>r.status==='fulfilled').length,1); assert.equal((await q.get(a.id)).state, 'registered')
  await assert.rejects(async () => { for await (const b of q.bytes(a)) {} }, /bytes missing/)
  q.close()
  q = await DurableQueue.open('fifo')
  const b = await add(q, 'b'), c = await add(q, 'c')
  const order = []
  const delivery = new Delivery(q, { reconcile: async () => undefined, submit: async j => { order.push(j.id); await new Promise(r=>setTimeout(r,5)) } })
  await Promise.all([delivery.run(),delivery.run(), new Delivery(q, { reconcile: async () => undefined, submit: async j => { order.push(j.id) } }).run()])
  assert.deepEqual(order, [b.id,c.id]); assert.equal((await q.get(b.id)).state, 'pending-verification')
  let count = 0
  await add(q, 'lost'); const d = new Delivery(q, { reconcile:async()=>undefined, submit:async()=>{count++;throw Error('Lost response')} })
  await d.run(); await d.run(); assert.equal(count,1)
  assert.equal((await q.list()).filter(j=>j.state==='unknown').length,1)
  // Actual larger-than-32-MiB MOV bytes, chunked and hashed without full-file buffering.
  const large = await q.begin(meta('large'))
  const chunk = new Uint8Array(256*1024)
  for(let i=0;i<129;i++) await q.append(large.id,i,chunk)
  const largeAccepted = await q.accept(large.id,129*chunk.length)
  assert.equal(largeAccepted.size,33816576)
  q.close()
  let session = {}, live = new Map([[1,{url:'https://www.fanbox.cc/@fixture/posts/1'}],[2,{url:'https://fixture.fanbox.cc/posts/1'}]])
  global.chrome = { storage:{session:{get:async()=>structuredClone(session),set:async v=>{session=structuredClone(v)}}}, tabs:{get:async id=>{if(!live.has(id))throw Error('closed');return live.get(id)}} }
  const sender = id=>({tab:{id},url:live.get(id).url,documentId:`doc-${id}`})
  assert.deepEqual(await Promise.all([claim(sender(1)),claim(sender(2))]),[true,false])
  assert.equal(await claim(sender(1)),true) // suspension retains session ownership
  live.delete(1); assert.equal(await claim(sender(2)),true)
  session={}; assert.equal(await claim(sender(2)),true) // browser restart, no stale ownership
  console.log('PASS: atomic acceptance, restart, capacity, changed-source resume, FIFO, unknown response, exact proof retention/cleanup, 33 MiB MOV, concurrent tabs/session recovery')
}
main().catch(e=>{console.error(e);process.exitCode=1})

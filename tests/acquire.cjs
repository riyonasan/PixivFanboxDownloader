const assert = require('node:assert/strict')
require('fake-indexeddb/auto')
const { DurableQueue } = require('../.test-build/queue/DurableQueue')
const { acquire } = require('../.test-build/queue/Acquire')
async function main() {
  const queue = await DurableQueue.open('acquire-fixtures', 1000)
  let calls=0, source=Uint8Array.of(1,2,3), contentType='image/png'
  global.fetch=async()=>{calls++;return new Response(source,{headers:{'content-type':contentType}})}
  global.chrome={runtime:{sendMessage:async m=>{
    if(m.msg==='queue_begin')return {job:await queue.begin(m.metadata)}
    if(m.msg==='queue_chunk'){await queue.append(m.jobId,m.index,new Uint8Array(Buffer.from(m.base64,'base64')));return {committed:true}}
    if(m.msg==='queue_accept')return {accepted:true,job:await queue.accept(m.jobId,m.size,m.hash)}
  }}}
  const meta=n=>({filename:`fixture/${n}.png`,website:'https://www.fanbox.cc/@fixture/posts/1',recordKey:`fixture:${n}`})
  const a=await acquire('https://downloads.fanbox.cc/fixture',meta('complete'))
  assert.equal(a.state,'ready');assert.equal(a.size,3)
  await acquire('https://downloads.fanbox.cc/fixture',meta('complete'));assert.equal(calls,1)
  const partial=await queue.begin({...meta('partial'),mime:'image/png'});await queue.append(partial.id,0,Uint8Array.of(1))
  assert.equal((await acquire('https://downloads.fanbox.cc/fixture',meta('partial'))).state,'ready')
  const changed=await queue.begin({...meta('changed'),mime:'image/png'});await queue.append(changed.id,0,Uint8Array.of(1));source=Uint8Array.of(9,2,3)
  await assert.rejects(acquire('https://downloads.fanbox.cc/fixture',meta('changed')),/Source changed/)
  assert.equal((await queue.get(changed.id)).state,'staging')
  source=Uint8Array.of(1,2,3);assert.equal((await acquire('https://downloads.fanbox.cc/fixture',meta('changed'))).state,'ready')
  contentType='text/html';await assert.rejects(acquire('https://downloads.fanbox.cc/fixture',meta('login-html')),/received HTML/)
  queue.close()
  console.log('PASS: accepted resume skips fetch, partial stream replay, changed prefix rejection/recovery, HTML login response rejection')
}
main().catch(e=>{console.error(e);process.exitCode=1})

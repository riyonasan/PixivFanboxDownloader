const assert = require('node:assert/strict')
const { LocalEagle } = require('../.test-build/queue/LocalEagle')
const { marker } = require('../.test-build/queue/DurableQueue')
async function main() {
  const job={id:'fixture-job',hash:'fixture-hash',website:'https://www.fanbox.cc/@fixture/posts/1'}
  const candidate={id:'candidate',name:'same-filename',annotation:marker(job),url:job.website,isDeleted:false}
  let items=[{...candidate,annotation:'unrelated'}], detail=candidate, calls=[]
  global.fetch=async(url,options)=>{
    assert.equal(options.cache,'no-store');assert.ok(!options.method || options.method==='GET')
    calls.push(url);return {ok:true,json:async()=>({status:'success',data:url.includes('/item/info')?detail:items})}
  }
  const adapter=new LocalEagle()
  assert.equal(await adapter.reconcile(job),undefined)
  items=[candidate];assert.deepEqual(await adapter.reconcile(job),{itemId:'candidate'})
  assert.ok(calls.some(url=>url.includes('/item/info')))
  detail={...candidate,annotation:'changed'};assert.equal(await adapter.reconcile(job),undefined)
  detail=candidate;items=[candidate,{...candidate,id:'competing'}]
  await assert.rejects(adapter.reconcile(job),/Multiple/)
  await assert.rejects(adapter.prepare({...job,size:129*1024**2}),/transport budget/)
  console.log('PASS: fresh list/detail, unrelated same filename, delayed/changed candidate, competing duplicates, transport backpressure. No POSTs.')
}
main().catch(e=>{console.error(e);process.exitCode=1})

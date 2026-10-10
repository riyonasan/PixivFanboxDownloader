const {test} = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const compile = name => ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/ts',name+'.ts'),'utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText

function runtimeHarness({role='collector',enabled=true,fail=false,paused=false}={}) {
  const stored = {spoolCollectionEnabled:enabled,fanboxSetting:{saveToEagle:true,userSetName:'old'},
    autoCreatorProfiles:[{creatorId:'a',name:'A',free:true,pay:true,minFee:null,maxFee:500,since:123}],
    autoPendingPosts:[{postId:'9',restricted:true}],autoDownloadStatus:{lastCompletedAt:456},
    spoolProofToken:'t'.repeat(40)}
  const config={revision:'revision',value:{settings:{userSetName:'FANBOX/{user}/{index}',dateFormat:'YYMMDD'},
    profiles:[{creatorId:'a',name:'A2',free:true,pay:true,minFee:null,maxFee:600},{creatorId:'b',name:'B',free:true,pay:false,minFee:null,maxFee:null}]}}
  const requests=[]
  const exports={}
  vm.runInNewContext(compile('spool/SpoolRuntime'),{exports,URL,AbortSignal,Date,
    require:()=>({autoProfilesKey:'autoCreatorProfiles'}),
    chrome:{runtime:{getURL:name=>'extension://'+name},storage:{local:{
      get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(key=>[key,structuredClone(stored[key])])),
      set:async values=>{if(fail) throw Error('storage failed');Object.assign(stored,structuredClone(values))},
    }}},fetch:async(url,options)=>{
      requests.push({url,options})
      if(url==='extension://spool-proof-local.json') return {ok:true,json:async()=>({role,token:'t'.repeat(40)})}
      if(url==='extension://ntfy-config.json') return {ok:true,json:async()=>({url:'https://ntfy.sh/example-test'})}
      return {ok:true,json:async()=>url.endsWith('/v1/config')?config:{acquisitionPaused:paused}}
    },
  })
  return {stored,config,requests,...exports}
}

test('remote config changes only acquisition settings and conditions; cursors and pending progress survive',async()=>{
  const h=runtimeHarness()
  const pending=structuredClone(h.stored.autoPendingPosts)
  await h.prepareSpoolCollection()
  assert.equal(h.stored.autoCreatorProfiles[0].since,123)
  assert.ok(h.stored.autoCreatorProfiles[1].since>123)
  assert.equal(h.stored.fanboxSetting.saveToEagle,false)
  assert.equal(h.stored.fanboxSetting.saveToSpool,true)
  assert.deepEqual(h.stored.autoPendingPosts,pending)
  assert.deepEqual(h.stored.autoDownloadStatus,{lastCompletedAt:456})
  assert.equal(h.stored.spoolAppliedRevision,'revision')
  assert.ok(h.requests.some(x=>x.url.endsWith('/v1/config/applied')))
})
test('failed local apply never acknowledges a revision or overwrites progress',async()=>{
  const h=runtimeHarness({fail:true})
  await assert.rejects(h.prepareSpoolCollection())
  assert.equal(h.stored.spoolAppliedRevision,undefined)
  assert.equal(h.stored.autoCreatorProfiles[0].since,123)
  assert.ok(!h.requests.some(x=>x.url.endsWith('/applied')))
})
test('collector is off until explicitly enabled; capacity also gates new collection',async()=>{
  const disabled=runtimeHarness({enabled:false})
  assert.equal(await disabled.prepareSpoolCollection(),false)
  assert.ok(!disabled.requests.some(x=>x.url.startsWith('http:')))
  assert.equal(await runtimeHarness({paused:true}).canStartSpoolCollection(),false)
  // An ordinary extension installation keeps its existing scheduler behavior.
  const main=runtimeHarness({role:'main',enabled:false})
  assert.equal(await main.prepareSpoolCollection(),true)
})
test('management endpoint accepts only loopback or Tailnet IPv4 on the service port',()=>{
  const h=runtimeHarness()
  assert.equal(h.validateEndpoint('http://100.64.0.1:18096'),'http://100.64.0.1:18096')
  for(const url of ['http://example.com:18096','https://100.64.0.1:18096','http://100.64.0.1:80','http://100.63.0.1:18096','http://100.64.0.1:18096/path']) assert.throws(()=>h.validateEndpoint(url))
})
test('collector cannot start before a valid spool configuration has been applied',async()=>{
  const h=runtimeHarness()
  assert.equal(await h.canStartSpoolCollection(),false)
  h.config.value=null
  assert.equal(await h.prepareSpoolCollection(),false)
})
test('authentication notifications occur only on state changes',async()=>{
  const h=runtimeHarness()
  await h.notifySpoolAuthentication(true)
  await h.notifySpoolAuthentication(true)
  await h.notifySpoolAuthentication(false)
  await h.notifySpoolAuthentication(false)
  assert.equal(h.requests.filter(x=>x.url==='https://ntfy.sh/example-test').length,2)
})

function downloadHarness(spool=false,eagle=false) {
  const messages=[]
  const failures=[]
  const settings={saveToSpool:spool,deduplication:false}
  const dependencies={
    '../EVT':{EVT:{list:{downloadSuccess:'success'},fire(){}}},'../FileName':{fileName:{getFileName:()=> 'FANBOX/作者/日付-投稿/日付-投稿-001.png'}},
    '../ProgressBar':{progressBar:{setProgress(){}}},'./DownloadRecord':{downloadRecord:{checkDeduplication:async()=>false,getEagleRecordKey:()=> 'eagle:123:abc'}},
    '../Lang':{lang:{transl:x=>x}},'../Log':{log:{success:x=>failures.push(x),warning(){}}},'../States':{states:{downloading:true}},
    './DownloadInterval':{downloadInterval:{wait:async()=>{}}},'../setting/Settings':{settings},
  }
  const exports={}
  vm.runInNewContext(compile('download/Download'),{exports,require:name=>dependencies[name],
    window:{addEventListener(){}},chrome:{runtime:{sendMessage:async message=>{messages.push(message);return{receipt:{eagleState:'pending'}}}}},
  })
  return {Download:exports.Download,messages,failures,eagle}
}
test('mini save bypasses Eagle checks and uses the generated name with stable source identity',async()=>{
  const h=downloadHarness(true,true)
  const arg={id:'abc',taskBatch:10,saveToEagle:true,data:{postId:'123',createID:'creator',fileID:'abc',name:'abc',ext:'png',index:1,size:null,url:'https://downloads.fanbox.cc/images/post/123/abc.png',tags:'tag'}}
  const object=Object.create(h.Download.prototype)
  object.arg=arg;object.progressBarIndex=0
  await object.download(arg)
  assert.equal(h.messages.length,1)
  assert.equal(h.messages[0].msg,'spool_save')
  assert.equal(h.messages[0].file.fileId,'image:abc')
  assert.equal(h.messages[0].file.fileName,'123-abc.png')
  assert.equal(h.messages[0].file.registration.fileName,'FANBOX/作者/日付-投稿/日付-投稿-001.png')
  assert.match(h.failures[0],/保存済み.*登録待ち/)
})
for(const eagle of [false,true]) test('existing download route is preserved: Eagle='+eagle,async()=>{
  const h=downloadHarness(false,eagle)
  const arg={id:'abc',taskBatch:10,saveToEagle:eagle,data:{postId:'123',createID:'creator',fileID:'abc',url:'https://downloads.fanbox.cc/files/post/123/a.bin'}}
  const object=Object.create(h.Download.prototype)
  object.arg=arg;object.progressBarIndex=0
  await object.download(arg)
  assert.equal(h.messages[0].msg,eagle?'add_to_eagle':'send_download')
})

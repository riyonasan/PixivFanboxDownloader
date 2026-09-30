import {launch,root as pocRoot} from './helpers/launch.mjs';
import {connect,evaluate,attachWorker,sleep,closeBrowser} from './helpers/cdp.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:http';
const root=pocRoot, ext=path.join(root,'source','dist');
const run=process.argv[2]||'baseline';
const delay=run.includes('resume-tabs')?6000:run.includes('delayed')?1500:0;
const profile=path.join(root,`profile-${process.argv[3]||run}`), output=path.join(root,`downloads-${run}`);
mkdirSync(path.join(profile,'Default'),{recursive:true});mkdirSync(output,{recursive:true});
writeFileSync(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:output,prompt_for_download:false}}));
// Derive guarded runtime from the latest commit's untouched original bundle.
const original=readFileSync(path.join(ext,'js','background.js'),'utf8');
const anchor='/* harmony import */ var _auto_AutoScheduler__WEBPACK_IMPORTED_MODULE_2__ = __webpack_require__(/*! ./auto/AutoScheduler */ "./src/ts/auto/AutoScheduler.ts");';
if(!original.includes(anchor))throw Error('Scheduler guard anchor changed');
const guarded=original.replace(anchor,'/* fixture: no scheduler */').replace('chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {',`chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if(msg.msg==='poc_trace'){globalThis.pocTrace.push({...msg.trace,tab:sender.tab?.id});return false;}
  if(msg.msg==='auto_result'){globalThis.pocResult={success:msg.success,accepted:msg.accepted};return false;}
  if(['check_eagle','add_to_eagle','eagle_error','auto_check_now'].includes(msg.msg)){sendResponse({error:'fixture guard'});return false;}
  if(['send_download','save_file_no_replay'].includes(msg.msg)){if(globalThis.pocAuthorizedTabId!==null&&sender.tab?.id!==globalThis.pocAuthorizedTabId){globalThis.pocTrace.push({kind:'blockedOtherTab',tab:sender.tab?.id});sendResponse({error:'Exact owned tab guard'});return false;}globalThis.pocTrace.push({kind:'downloadRequest',id:msg.id,ext:msg.fileName.split('.').pop(),batch:msg.taskBatch,tab:sender.tab?.id});}
`).replace('chrome.tabs.sendMessage(data.tabId, { msg, data, err });',`globalThis.pocTrace.push({kind:'downloadEvent',msg,err,id:data.id,uuid:data.uuid});chrome.tabs.sendMessage(data.tabId, { msg, data, err });`);
writeFileSync(path.join(ext,'js','background-fixture.js'),guarded);
writeFileSync(path.join(ext,'fixture-worker.js'),`globalThis.pocTrace=[];globalThis.pocResult=null;globalThis.pocAuthorizedTabId=null;const f=fetch;globalThis.fetch=(i,o)=>{const u=new URL(typeof i==='string'?i:i.url);if(!['chrome-extension:'].includes(u.protocol))return Promise.reject(Error('fixture worker network blocked'));return f(i,o);};importScripts('js/background-fixture.js');void chrome.alarms.clearAll();`);
let content=readFileSync(path.join(ext,'js','content.js'),'utf8');
content=content.replace('async downloadSuccess(data) {',`async downloadSuccess(data) { chrome.runtime.sendMessage({msg:'poc_trace',trace:{kind:'downloadSuccess-enter',id:data.id,state:[..._DownloadStates__WEBPACK_IMPORTED_MODULE_12__.downloadStates.states]}});`);
// Instrument requests/instances without changing scheduling or event handling.
content=content.replace('new DownloadControl();',`chrome.runtime.sendMessage({msg:'poc_trace',trace:{kind:'controlInstance'}});new DownloadControl();`);
writeFileSync(path.join(ext,'js','content-fixture.js'),content);
const manifest=JSON.parse(readFileSync(path.join(ext,'manifest.json'),'utf8'));manifest.background.service_worker='fixture-worker.js';manifest.content_scripts[0].js[0]='js/content-fixture.js';writeFileSync(path.join(ext,'manifest.json'),JSON.stringify(manifest,null,2));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=','base64');
let hits=0;const server=createServer((req,res)=>{hits++;setTimeout(()=>{res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length});res.end(png);},delay);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const asset=`http://127.0.0.1:${server.address().port}/fixture.png`;
const post={id:'12690777',type:'image',title:'LOCAL FIXTURE',creatorId:'ouminoko',feeRequired:0,publishedDatetime:'2026-09-30T12:00:00Z',updatedDatetime:'2026-09-30T12:00:00Z',user:{name:'LOCAL FIXTURE',userId:'1',iconUrl:''},tags:[],coverImageUrl:null,isRestricted:false,commentCount:0,commentList:{items:[],nextUrl:null},body:{text:'Local fixture only',images:[{id:'fixture-image',extension:'png',width:1,height:1,originalUrl:asset,thumbnailUrl:asset}]}};
let c;const evidence={baseCommit:'20dec0a5de836507ae0352fd7153a76ba98213bf',implementation:true,run,fixtureOnly:true,autoStartCalls:0};
try{
 const {info}=await launch('headless','about:blank',{profilePath:profile,extensionPath:ext,runtimeStatePath:path.join(root,`running-${run}.json`)});c=await connect(info.websocket);const w=await attachWorker(c,'/fixture-worker.js');
 await sleep(1000);evidence.worker=await evaluate(c,w.sessionId,"({url:location.href,storageAvailable:!!chrome.storage,traceReady:Array.isArray(globalThis.pocTrace)})");console.log('worker',JSON.stringify(evidence.worker));
 const beforeIds=await evaluate(c,w.sessionId,"chrome.downloads.search({}).then(ds=>ds.map(d=>d.id))");evidence.existingDownloadCount=beforeIds.length;
 await evaluate(c,w.sessionId,"chrome.storage.local.set({autoCreatorProfiles:[],autoPendingPosts:[],fanboxSetting:{saveToEagle:true,showNotificationAfterDownloadComplete:false,saveComment:false,saveText:true,textFormat:'html',savePostCover:false,saveLink:false,downloadThread:1,downloadInterval:0,autoStartDownload:true,deduplication:false,userSetName:'fixture/{index}',nameruleForNonImages:'fixture/{name}',totalDownloadLimitSwitch:true,totalDownloadLimitByte:134217728}})");
 const tab=await evaluate(c,w.sessionId,"chrome.tabs.create({url:'about:blank#fixture-owned-tab',active:false})");const t=(await c.send('Target.getTargets')).targetInfos.find(t=>t.type==='page'&&t.url==='about:blank#fixture-owned-tab');const {sessionId:ps}=await c.send('Target.attachToTarget',{targetId:t.targetId,flatten:true});
 if(run.includes('guarded'))await evaluate(c,w.sessionId,`(globalThis.pocAuthorizedTabId=${tab.id})`);
 c.on(v=>{if(v.sessionId!==ps||v.method!=='Fetch.requestPaused')return;const {requestId,request}=v.params;const url=new URL(request.url);if(url.href===asset){hits++;setTimeout(()=>c.send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'},{name:'Access-Control-Allow-Origin',value:'https://www.fanbox.cc'},{name:'Access-Control-Allow-Credentials',value:'true'}],body:png.toString('base64')},ps).catch(()=>{}),delay);return;}if(url.protocol==='chrome-extension:'){c.send('Fetch.continueRequest',{requestId},ps);return;}let body,type='application/json';if(url.hostname==='www.fanbox.cc'){type='text/html';body='<!doctype html><html lang="en"><head><title>LOCAL FIXTURE</title></head><body></body></html>';}else if(url.pathname==='/post.info'){body=JSON.stringify({body:post});}else body=JSON.stringify({body:[]});c.send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:type},{name:'Access-Control-Allow-Origin',value:'https://www.fanbox.cc'},{name:'Access-Control-Allow-Credentials',value:'true'}],body:Buffer.from(body).toString('base64')},ps).catch(()=>{});});
 await c.send('Fetch.enable',{patterns:[{urlPattern:'*'}]},ps);await c.send('Page.navigate',{url:'https://www.fanbox.cc/@ouminoko/posts/12690777'},ps);await sleep(1200);
 evidence.autoStartCalls++;evidence.start=await evaluate(c,w.sessionId,`chrome.tabs.sendMessage(${tab.id},{msg:'auto_start',profile:{creatorId:'ouminoko',name:'LOCAL FIXTURE',free:true,pay:true,minFee:null,maxFee:null},postId:'12690777',startedAt:1})`);
 if(run.includes('resume-tabs')){
  await sleep(1500);evidence.extraResumeTabs=4;
  for(let n=0;n<4;n++){
   const marker=`about:blank#resume-fixture-${n}`;await evaluate(c,w.sessionId,`chrome.tabs.create({url:${JSON.stringify(marker)},active:false})`);
   const extra=(await c.send('Target.getTargets')).targetInfos.find(t=>t.url===marker);const {sessionId:es}=await c.send('Target.attachToTarget',{targetId:extra.targetId,flatten:true});
   c.on(v=>{if(v.sessionId!==es||v.method!=='Fetch.requestPaused')return;const {requestId,request}=v.params;const u=new URL(request.url);if(u.protocol==='chrome-extension:'){c.send('Fetch.continueRequest',{requestId},es);return;}const isPage=u.hostname==='www.fanbox.cc';const body=isPage?'<!doctype html><html lang="en"><head><title>LOCAL RESUME FIXTURE</title></head><body></body></html>':JSON.stringify(u.pathname==='/post.info'?{body:post}:{body:[]});c.send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:isPage?'text/html':'application/json'},{name:'Access-Control-Allow-Origin',value:'https://www.fanbox.cc'},{name:'Access-Control-Allow-Credentials',value:'true'}],body:Buffer.from(body).toString('base64')},es).catch(()=>{});});
   await c.send('Fetch.enable',{patterns:[{urlPattern:'*'}]},es);await c.send('Page.navigate',{url:'https://www.fanbox.cc/@ouminoko/posts/12690777'},es);await sleep(500);
  }
 }
 if(run.includes('duplicates')){
  let htmlId;for(let n=0;n<30;n++){const events=await evaluate(c,w.sessionId,'globalThis.pocTrace');htmlId=events.find(e=>e.kind==='downloadRequest'&&e.ext==='html')?.id;if(htmlId&&events.some(e=>e.kind==='downloadRequest'&&e.ext==='png'))break;await sleep(50);}
  evidence.injectedDuplicateCompletions=4;
  for(let n=0;n<4;n++)await evaluate(c,w.sessionId,`chrome.tabs.sendMessage(${tab.id},{msg:'downloaded',data:{id:${JSON.stringify(htmlId)},url:'blob:local-fixture',tabId:${tab.id},uuid:false,size:1505}}).catch(()=>null)`);
 }
 for(let n=0;n<30;n++){await sleep(1000);evidence.result=await evaluate(c,w.sessionId,'globalThis.pocResult');if(evidence.result)break;}
 await sleep(run.includes('resume-tabs')?5000:1000);evidence.trace=await evaluate(c,w.sessionId,'globalThis.pocTrace');evidence.downloads=await evaluate(c,w.sessionId,`chrome.downloads.search({}).then(ds=>ds.filter(d=>!${JSON.stringify(beforeIds)}.includes(d.id)).map(d=>({id:d.id,state:d.state,extension:d.filename.split('.').pop(),bytes:d.fileSize})))`);evidence.serverHits=hits;
 evidence.registrationRecordCount=await evaluate(c,ps,`new Promise(resolve=>{const r=indexedDB.open('DLRecord');r.onsuccess=()=>{const db=r.result;const q=db.transaction('record').objectStore('record').count();q.onsuccess=()=>{resolve(q.result);db.close()}}})`);
 evidence.queue = await evaluate(c,w.sessionId,`new Promise((resolve,reject)=>{const r=indexedDB.open('PFD-durable-queue');r.onsuccess=()=>{const db=r.result;const t=db.transaction('jobs').objectStore('jobs').getAll();t.onsuccess=()=>{resolve(t.result.map(j=>({id:j.id,state:j.state,size:j.size,hash:j.hash,filename:j.filename})));db.close()};t.onerror=()=>reject(t.error)};r.onerror=()=>reject(r.error)})`);
 evidence.assertions={oneStart:evidence.autoStartCalls===1, fiveControls:evidence.trace.filter(e=>e.kind==='controlInstance').length===5, oneAcquisition:hits===1, twoAccepted:evidence.queue.length===2&&evidence.queue.every(j=>j.state==='ready'), noBrowserDownloads:evidence.downloads.length===0,noFalseRegistrationHistory:evidence.registrationRecordCount===0, pngBytes:evidence.queue.some(j=>j.filename.endsWith('.png')&&j.size===68), success:evidence.result?.success===true,acceptedNotRegistered:evidence.result?.accepted===true};
 // Remove only disposable open fixture tabs, not their stored bytes/profile.
 await evaluate(c,w.sessionId,'chrome.tabs.query({}).then(ts=>Promise.all(ts.map(t=>chrome.tabs.remove(t.id))))');
 await closeBrowser(c);c=null;
 const restarted=await launch('headless','about:blank',{profilePath:profile,extensionPath:ext,runtimeStatePath:path.join(root,`running-${run}.json`)});c=await connect(restarted.info.websocket);const rw=await attachWorker(c,'/fixture-worker.js');
 const after=await evaluate(c,rw.sessionId,`new Promise(resolve=>{const r=indexedDB.open('PFD-durable-queue');r.onsuccess=()=>{const db=r.result;const a=db.transaction('jobs').objectStore('jobs').getAll();a.onsuccess=()=>{resolve(a.result.map(j=>({id:j.id,state:j.state,size:j.size,hash:j.hash,filename:j.filename})));db.close()}}})`);
 evidence.assertions.realProfileRestart=JSON.stringify(after)===JSON.stringify(evidence.queue);
 if(Object.values(evidence.assertions).some(v=>v!==true))throw Error('Queue fixture assertion failed');
 console.log(JSON.stringify(evidence,null,2));
}catch(e){evidence.error=e.message;console.error(e.message);process.exitCode=1;}finally{if(c)await closeBrowser(c);server.close();writeFileSync(path.join(root,`evidence-${run}.json`),JSON.stringify(evidence,null,2));}

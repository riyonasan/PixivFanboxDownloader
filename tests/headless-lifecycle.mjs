import {launch,root as pocRoot} from './helpers/launch.mjs';
import {connect,evaluate,attachWorker,sleep,closeBrowser} from './helpers/cdp.mjs';
import path from 'node:path';
import {writeFileSync} from 'node:fs';
const root=pocRoot;let c;
try {
 const {info}=await launch('headless','about:blank',{profilePath:path.join(root,'profile-queue'),extensionPath:path.join(root,'source','dist'),runtimeStatePath:path.join(root,'running-lifecycle.json')});
 c=await connect(info.websocket);const w=await attachWorker(c,'/fixture-worker.js'); const old=w.targetId;
 const extension=(await evaluate(c,w.sessionId,'location.origin'));
 await c.send('Target.detachFromTarget',{sessionId:w.sessionId});
 await sleep(38000);
 const before=(await c.send('Target.getTargets')).targetInfos.filter(t=>t.type==='service_worker'&&t.url.endsWith('/fixture-worker.js'));
 const {targetId}=await c.send('Target.createTarget',{url:extension+'/queue.html'});
 const {sessionId}=await c.send('Target.attachToTarget',{targetId,flatten:true});await sleep(2000);
 const status=await evaluate(c,sessionId,"({status:document.querySelector('#status').textContent,rows:document.querySelector('#jobs').children.length})");
 const after=(await c.send('Target.getTargets')).targetInfos.filter(t=>t.type==='service_worker'&&t.url.endsWith('/fixture-worker.js'));
 const evidence={fixtureOnly:true,idleWorkerCount:before.length,rewokenWorkerCount:after.length,optionsStatus:status,passed:before.length===0&&after.length===1&&status.rows===2};
 writeFileSync(path.join(root,'evidence-worker-lifecycle.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));if(!evidence.passed)throw Error('Worker lifecycle assertions failed');
} finally {if(c)await closeBrowser(c)}

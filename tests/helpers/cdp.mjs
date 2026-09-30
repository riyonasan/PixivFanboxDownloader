export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function connect(url) {
  const ws=new WebSocket(url); let id=0; const pending=new Map(),listeners=[];
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.onmessage=e=>{const v=JSON.parse(e.data); if(v.id){const p=pending.get(v.id);pending.delete(v.id);v.error?p?.reject(Error(v.error.message)):p?.resolve(v.result);}else listeners.forEach(f=>f(v));};
  return {ws,on:f=>listeners.push(f),send(method,params={},sessionId){return new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});}};
}
export async function evaluate(c,s,expression) {
  const r=await c.send('Runtime.evaluate',{expression:`(async()=>(${expression}))()`,awaitPromise:true,returnByValue:true},s);
  if(r.exceptionDetails) throw Error('Browser evaluation failed: '+(r.exceptionDetails.exception?.description?.split('\n')[0]||r.exceptionDetails.text));
  return r.result.value;
}
export async function attachWorker(c, expectedSuffix = '/poc-background.js') {
  for(let n=0;n<50;n++){const t=(await c.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith('chrome-extension://')&&t.url.endsWith(expectedSuffix));if(t){const {sessionId}=await c.send('Target.attachToTarget',{targetId:t.targetId,flatten:true});return {target:t,sessionId};}await sleep(100);}
  throw Error('Guarded extension worker unavailable');
}
export async function closeBrowser(c) {try{await c.send('Browser.close');}catch{} await sleep(1500);c.ws.close();}

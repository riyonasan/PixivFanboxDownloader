const assert = require('node:assert/strict')
const { mkdtemp, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { verifyEagleOriginal } = require('../tools/verify-eagle-original.cjs')
async function main() {
  const directory = await mkdtemp(path.join(tmpdir(),'pfd-verifier-fixture-'))
  const filePath = path.join(directory,'fixture.png'), bytes = Buffer.from('synthetic-original')
  const job = {id:'fixture',size:bytes.length,hash:createHash('sha256').update(bytes).digest('hex'),website:'https://www.fanbox.cc/@fixture/posts/1'}
  let item = {id:'eagle-fixture',filePath,annotation:`PFD:${job.id}:${job.hash}`,url:job.website,isDeleted:false}
  const eagle = {item:{getById:async()=>({...item})}}
  await assert.rejects(verifyEagleOriginal(eagle,job,item.id),/ENOENT/)
  await writeFile(filePath,bytes.subarray(0,4)); await assert.rejects(verifyEagleOriginal(eagle,job,item.id),/incomplete/)
  await writeFile(filePath,Buffer.alloc(bytes.length)); await assert.rejects(verifyEagleOriginal(eagle,job,item.id),/not verified/)
  await writeFile(filePath,bytes); const proof = await verifyEagleOriginal(eagle,job,item.id); assert.equal(proof.sha256,job.hash)
  item.annotation='unrelated same filename'; await assert.rejects(verifyEagleOriginal(eagle,job,item.id),/identity/)
  console.log('PASS: original missing, delayed/incomplete bytes, wrong equal-size bytes, exact byte proof, unrelated same filename. Synthetic files retained.')
}
main().catch(e=>{console.error(e);process.exitCode=1})

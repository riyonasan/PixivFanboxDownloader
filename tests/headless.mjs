// Explicit opt-in fixture test. Uses a new temp profile, blocks production
// scheduler/Eagle/ntfy traffic, and intercepts FANBOX with synthetic responses.
import { mkdtempSync, cpSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
if (!process.env.PFD_CFT) throw Error('Set PFD_CFT to an official Chrome for Testing executable')
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureParent = process.env.PFD_FIXTURE_PARENT || path.join(base, '.test-build')
mkdirSync(fixtureParent, { recursive: true })
process.env.PFD_FIXTURE_ROOT = mkdtempSync(path.join(fixtureParent, 'pfd-headless-fixture-'))
const fixtureDist = path.join(process.env.PFD_FIXTURE_ROOT,'source','dist')
mkdirSync(path.dirname(fixtureDist),{recursive:true})
async function run(script, args=[]) {
  const child=spawn(process.execPath,[path.join(base,'tests',script),...args],{stdio:'inherit',env:process.env,windowsHide:true})
  await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(`${script} failed ${code}`)))})
}
cpSync(path.join(base,'dist'),fixtureDist,{recursive:true})
await run('headless-browser.mjs',['resume-tabs','browser'])
cpSync(path.join(base,'dist'),fixtureDist,{recursive:true})
await run('headless-queue.mjs',['resume-tabs-queue','queue'])
await run('headless-lifecycle.mjs')
console.log(`PASS: browser ownership, queue acquisition/restart, worker suspension. Synthetic evidence retained: ${process.env.PFD_FIXTURE_ROOT}`)

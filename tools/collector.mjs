import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [key, ...value] = a.replace(/^--/, '').split('='); return [key, value.join('=')]
}))
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!args.browser || !args.profile || !['login', 'headless', 'headed'].includes(args.mode)) {
  throw Error('Usage: node tools/collector.mjs --browser=<Chrome-for-Testing executable> --profile=<dedicated directory> --mode=login|headless|headed')
}
const browser = path.resolve(args.browser), profile = path.resolve(args.profile)
if (!existsSync(browser)) throw Error('Browser executable missing')
if (/[\\/]Google[\\/]Chrome[\\/]User Data(?:[\\/]|$)/i.test(profile) ||
  /[\\/]\.config[\\/](google-chrome|chromium)(?:[\\/]|$)/i.test(profile)) throw Error('Use a dedicated collector profile')
mkdirSync(profile, { recursive: true })
if (process.platform === 'win32') {
  // Inspect only browser profile arguments; never print process command lines.
  const literal = profile.replaceAll("'", "''")
  const script = `$wanted='${literal}';$active=$false;Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | ForEach-Object {if($_.CommandLine -match '--user-data-dir(?:=| )(?:(?:"([^"]+)")|([^ ]+))'){$p=if($Matches[1]){$Matches[1]}else{$Matches[2]};if([IO.Path]::GetFullPath($p).Equals($wanted,[StringComparison]::OrdinalIgnoreCase)){$active=$true}}};[Console]::Write($active.ToString())`
  const active = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], {windowsHide:true,encoding:'utf8'}).trim()
  if (active !== 'False') throw Error('Dedicated profile is running or could not be checked; close it before switching modes')
} else {
  let lock
  try { lock = readlinkSync(path.join(profile,'SingletonLock')) } catch(e) { if(e.code !== 'ENOENT') throw e }
  if (lock) {
    const pid = Number(lock.split('-').pop())
    if (!Number.isInteger(pid) || pid <= 0) throw Error('Dedicated browser profile lock needs review')
    let alive = false
    try { process.kill(pid,0); alive=true } catch(e) { if(e.code!=='ESRCH') alive=true }
    if (alive) throw Error('Dedicated profile is running; close it before switching modes')
  }
}
const stateFile = path.join(profile, 'pfd-launch.json')
if (existsSync(stateFile)) {
  const previous = JSON.parse(readFileSync(stateFile, 'utf8'))
  let alive = false
  try { process.kill(previous.pid, 0); alive = true } catch (e) { if (e.code !== 'ESRCH') alive = true }
  if (alive) throw Error('Dedicated browser is already running; close it before switching modes')
}
const switches = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check']
if (args.mode === 'login') switches.push('--disable-extensions', 'https://www.fanbox.cc/')
else {
  switches.push(`--load-extension=${path.join(base, 'dist')}`)
  if (args.mode === 'headless') switches.push('--headless=new')
  switches.push('about:blank')
}
// Sandbox remains enabled. No remote debugging endpoint is opened.
const child = spawn(browser, switches, { windowsHide: args.mode === 'headless', stdio: 'inherit' })
writeFileSync(stateFile, JSON.stringify({ pid: child.pid, mode: args.mode }))
console.log(`Dedicated ${args.mode} browser started. Close it before switching modes.`)
child.on('error', e => { console.error(e.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code || 0 })
process.on('SIGINT', () => child.kill())
process.on('SIGTERM', () => child.kill())

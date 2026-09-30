import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = process.env.PFD_FIXTURE_ROOT;
if(!root || !process.env.PFD_CFT) throw Error('Fixture root and PFD_CFT executable must be supplied');
export const profile = path.join(root, 'profile');
export const extension = path.join(root, 'source', 'dist');
export const executable = process.env.PFD_CFT;
export async function launch(mode = 'headless', url = undefined, isolated = {}) {
  const activeProfile = isolated.profilePath || profile;
  const activeExtension = isolated.extensionPath || extension;
  if (!['headless', 'headed'].includes(mode)) throw Error('Use headless or headed');
  mkdirSync(activeProfile, { recursive: true });
  const portFile = path.join(activeProfile, 'DevToolsActivePort');
  if (existsSync(portFile)) {
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) throw Error('PROFILE_IN_USE'); }
    catch (e) { if (e.message === 'PROFILE_IN_USE') throw Error('Dedicated profile is already running. Close it before switching modes.'); }
  }
  const args = [`--user-data-dir=${activeProfile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--enable-automation', '--no-first-run', '--no-default-browser-check'];
  if (mode === 'headless') {
    args.push('--headless=new');
    args.push(isolated.disableExtensions ? '--disable-extensions' : `--load-extension=${activeExtension}`);
  }
  // Headed mode is login-only. Disable even previously installed extensions,
  // so extension startup alarms cannot collect or write to Eagle during login.
  else args.push('--disable-extensions');
  // No sandbox-disabling, permission-granting, or ordinary-profile flags.
  args.push(url || (mode === 'headed' ? 'https://www.fanbox.cc/' : 'about:blank'));
  const child = spawn(executable, args, { windowsHide: mode === 'headless', stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  for (let n = 0; n < 100; n++) {
    await new Promise(r => setTimeout(r, 100));
    if (child.exitCode !== null) throw Error(`CfT exited ${child.exitCode}: ${stderr.slice(-500)}`);
    if (!existsSync(portFile)) continue;
    const [port, endpoint] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const info = { pid: child.pid, mode, port: Number(port), browser: version.Browser, websocket: `ws://127.0.0.1:${port}${endpoint}` };
      writeFileSync(isolated.runtimeStatePath || path.join(root, 'running.json'), JSON.stringify(info, null, 2));
      return { child, info };
    } catch {}
  }
  child.kill(); throw Error('Dedicated CfT debugging endpoint did not start');
}

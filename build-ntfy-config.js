const fs = require('fs')
const path = require('path')

const root = __dirname
const envPath = path.join(root, '.env')
let ntfyURL = ''

if (fs.existsSync(envPath)) {
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((value) => /^\s*NTFY_URL\s*=/.test(value))
  if (line) ntfyURL = line.slice(line.indexOf('=') + 1).trim().replace(/^(["'])(.*)\1$/, '$2')
}

if (ntfyURL) {
  const url = new URL(ntfyURL)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'ntfy.sh' ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/[-_A-Za-z0-9]{1,64}$/.test(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error('NTFY_URL must be a single https://ntfy.sh/<topic> URL')
  }
}

fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
fs.writeFileSync(
  path.join(root, 'dist', 'ntfy-config.json'),
  JSON.stringify({ url: ntfyURL }),
)

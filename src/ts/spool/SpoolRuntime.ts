import { AutoCreatorProfile, autoProfilesKey } from '../auto/AutoTypes'

export const acquisitionKeys = (`image music video compressed ps other free pay feeSwitch idRangeSwitch
postDate saveLink saveText saveComment autoStartDownload savePostCover zeroPadding deduplication
unifiedURL titleMustTextSwitch titleCannotTextSwitch fileNameIncludeSwitch fileNameExcludeSwitch
totalDownloadLimitSwitch fee idRangeInput postDateStart postDateEnd downloadThread zeroPaddingLength
downloadInterval crawlInterval totalDownloadLimit totalDownloadLimitByte feeRange idRange textFormat
userSetName dateFormat nameruleForNonImages imageSize titleMustText titleCannotText fileNameInclude fileNameExclude`).split(/\s+/)

let local: Promise<{ role?: string; token?: string }> | undefined
export function localSpoolConfig() {
  local ??= fetch(chrome.runtime.getURL('spool-proof-local.json'), { credentials: 'omit', cache: 'no-store' })
    .then(async response => response.ok ? response.json() : {})
    .catch(() => ({}))
  return local
}

export function validateEndpoint(value: string) {
  const url = new URL(value)
  const parts = url.hostname.split('.').map(Number)
  if (url.protocol !== 'http:' || url.port !== '18096' || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/' || parts.length !== 4 ||
      parts.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
      !(url.hostname === '127.0.0.1' || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)) {
    throw new Error('補助サービスのTailnet IPv4アドレスとポート18096を指定してください')
  }
  return url.origin
}

export async function spoolRequest(path: string, body?: unknown, remote = false) {
  const stored = await chrome.storage.local.get(['spoolProofToken', 'spoolRemoteURL'])
  const config = await localSpoolConfig()
  const token = stored.spoolProofToken || config.token
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new Error('補助サービスのAPIトークンを設定してください')
  }
  const base = remote ? validateEndpoint(typeof stored.spoolRemoteURL === 'string' ? stored.spoolRemoteURL : '') : 'http://127.0.0.1:18096'
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000),
  })
  if (!response.ok) throw new Error(`補助サービスへの接続に失敗しました（HTTP ${response.status}）`)
  return response.json()
}

// Called before scanning, under the scheduler's existing checking flag.
export async function prepareSpoolCollection() {
  if ((await localSpoolConfig()).role !== 'collector') return true
  const stored = await chrome.storage.local.get('spoolCollectionEnabled')
  if (!stored.spoolCollectionEnabled) return false
  const configuration = await spoolRequest('/v1/config')
  if (!configuration.value || !configuration.revision) return false
  {
      const current = await chrome.storage.local.get(['spoolAppliedRevision', 'fanboxSetting', autoProfilesKey])
      const currentSettings = (current.fanboxSetting || {}) as Record<string, unknown>
      if (current.spoolAppliedRevision !== configuration.revision || !currentSettings.saveToSpool || currentSettings.saveToEagle) {
      const previous = (current[autoProfilesKey] || []) as AutoCreatorProfile[]
      const profiles = configuration.value.profiles.map((profile: Omit<AutoCreatorProfile, 'since'>) => ({
        ...profile, since: previous.find(item => item.creatorId === profile.creatorId)?.since ?? Date.now(),
      }))
      const filtered: Record<string, unknown> = {}
      for (const key of acquisitionKeys) {
        if (key in configuration.value.settings) filtered[key] = configuration.value.settings[key]
      }
      // Do not write pending posts, active tasks, download history or queue state.
      await chrome.storage.local.set({
        fanboxSetting: { ...currentSettings, ...filtered, saveToEagle: false, saveToSpool: true },
        [autoProfilesKey]: profiles, spoolAppliedRevision: configuration.revision,
      })
      }
  }
  await spoolRequest('/v1/config/applied', { revision: configuration.revision })
  return canStartSpoolCollection()
}

export async function canStartSpoolCollection() {
  if ((await localSpoolConfig()).role !== 'collector') return true
  const stored = await chrome.storage.local.get(['spoolCollectionEnabled','fanboxSetting'])
  const settings = stored.fanboxSetting as {saveToSpool?:boolean;saveToEagle?:boolean} | undefined
  if (!stored.spoolCollectionEnabled || !settings?.saveToSpool || settings.saveToEagle) return false
  try {
    return !(await spoolRequest('/v1/health')).acquisitionPaused
  } catch {
    return false
  }
}

export async function notifySpoolAuthentication(expired: boolean) {
  const value = expired ? 'expired' : 'ready'
  const previous = (await chrome.storage.local.get('spoolAuthenticationState')).spoolAuthenticationState
  if (previous === value) return
  await chrome.storage.local.set({ spoolAuthenticationState: value })
  if (!expired && previous === undefined) return
  try {
    const config = await fetch(chrome.runtime.getURL('ntfy-config.json'), { credentials: 'omit' })
    if (!config.ok) return
    const url = (await config.json()).url
    if (!url) return
    await fetch(url, { method:'POST', credentials:'omit', headers:{'Content-Type':'text/plain; charset=utf-8'},
      body: expired ? 'FANBOX: 認証が切れた可能性があります。専用ブラウザでログインと閲覧権限を確認してください。' : 'FANBOX: 認証付きファイル取得が再び成功しました。',
      signal:AbortSignal.timeout(10000) })
  } catch { /* A notification failure must not discard a saved file. */ }
}

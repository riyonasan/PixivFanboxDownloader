document.getElementById('extensionId').textContent = chrome.runtime.id
let collector = false
void (async () => {
  const stored = await chrome.storage.local.get(['spoolRemoteURL','spoolCollectionEnabled'])
  document.getElementById('remote').value = stored.spoolRemoteURL || ''
  try {
    const response = await fetch(chrome.runtime.getURL('spool-proof-local.json'), { credentials:'omit',cache:'no-store' })
    const local = response.ok ? await response.json() : {}
    collector = local.role === 'collector'
    if (stored.spoolRemoteURL === undefined) document.getElementById('remote').value = local.remoteURL || ''
  } catch { /* Local provisioning is optional. */ }
  document.getElementById('collector').hidden = !collector
  document.getElementById('enabled').checked = !!stored.spoolCollectionEnabled
})()
document.getElementById('config').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = document.getElementById('token')
  const status = document.getElementById('status')
  if (input.value && !/^[A-Za-z0-9_-]{32,128}$/.test(input.value)) {
    status.textContent = '32〜128文字のランダムな英数字・ハイフン・アンダースコアを入力してください。'
    return
  }
  try {
    const remote = document.getElementById('remote').value.trim()
    let endpoint = ''
    if (remote) {
      const url = new URL(remote)
      const parts = url.hostname.split('.').map(Number)
      if (url.protocol !== 'http:' || url.port !== '18096' || url.username || url.password ||
          url.search || url.hash || url.pathname !== '/' || parts.length !== 4 ||
          parts.some(part => !Number.isInteger(part) || part < 0 || part > 255) ||
          !(url.hostname === '127.0.0.1' || parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)) {
        status.textContent = '接続先にはミニPCのTailnet IPv4とポート18096を指定してください。'
        return
      }
      endpoint = url.origin
      if (!(await chrome.permissions.request({ origins:[endpoint+'/*'] }))) {
        status.textContent = '接続先への権限が許可されなかったため保存していません。'
        return
      }
    }
    await chrome.storage.local.set({ ...(input.value ? {spoolProofToken:input.value} : {}),
      spoolRemoteURL:endpoint, ...(collector ? {spoolCollectionEnabled:document.getElementById('enabled').checked} : {}) })
    input.value = ''
    status.textContent = '接続設定を保存しました。投稿ページの「ミニPCへの設定反映・保存／Eagle登録状況」から確認できます。'
  } catch {
    status.textContent = '設定を保存できませんでした。'
  }
})

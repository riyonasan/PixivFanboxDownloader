document.getElementById('extensionId').textContent = chrome.runtime.id
document.getElementById('config').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = document.getElementById('token')
  const status = document.getElementById('status')
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(input.value)) {
    status.textContent = '32〜128文字のランダムな英数字・ハイフン・アンダースコアを入力してください。'
    return
  }
  try {
    await chrome.storage.local.set({ spoolProofToken: input.value })
    input.value = ''
    status.textContent = '保存しました。投稿ページで「1件保存の実証」を開いてください。'
  } catch {
    status.textContent = '設定を保存できませんでした。'
  }
})

import { ProofFile, saveProofFile } from './SpoolClient'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.msg !== 'spool_proof_save' && message?.msg !== 'spool_proof_options') return false
  let source: URL
  try {
    source = new URL(sender.url || '')
    if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined ||
        source.protocol !== 'https:' ||
        !(source.hostname === 'fanbox.cc' || source.hostname.endsWith('.fanbox.cc'))) return false
  } catch { return false }
  if (message.msg === 'spool_proof_options') {
    void chrome.runtime.openOptionsPage()
    return false
  }
  const file = message.file as ProofFile | undefined
  const postId = /\/posts\/(\d+)(?:\/|$)/.exec(source.pathname)?.[1]
  if (!file || file.postId !== postId) {
    sendResponse({ error: '現在の投稿に属するファイルを選択してください' })
    return false
  }
  void saveProofFile(file)
    .then((receipt) => sendResponse({ receipt }))
    .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : '保存実証に失敗しました' }))
  return true
})

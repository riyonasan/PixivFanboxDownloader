import { ProofFile, SpoolFile, SpoolAuthError, saveProofFile, saveSpoolFile } from './SpoolClient'
import { localSpoolConfig, spoolRequest, acquisitionKeys, notifySpoolAuthentication } from './SpoolRuntime'
import { AutoCreatorProfile } from '../auto/AutoTypes'
import { totalDownload } from '../TotalDownload'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['spool_proof_save', 'spool_proof_options', 'spool_save', 'spool_apply', 'spool_status', 'spool_resubmit'].includes(message?.msg)) return false
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
  if (['spool_apply','spool_status','spool_resubmit'].includes(message.msg)) {
    const action = async () => {
      if (message.msg === 'spool_status') return spoolRequest('/v1/status', undefined, true)
      if (message.msg === 'spool_resubmit') {
        if (!/^[a-f0-9]{64}$/.test(message.receiptId) || message.confirmNotRegistered !== true) throw new Error('登録されていないことの確認が必要です')
        return spoolRequest(`/v1/held/${message.receiptId}/resubmit`, { confirmNotRegistered: true }, true)
      }
      const stored = await chrome.storage.local.get(['fanboxSetting','autoCreatorProfiles'])
      const localSettings = (stored.fanboxSetting || {}) as Record<string, unknown>
      const settings: Record<string, unknown> = {}
      for (const key of acquisitionKeys) if (key in localSettings) settings[key] = localSettings[key]
      const profiles = ((stored.autoCreatorProfiles || []) as AutoCreatorProfile[]).map(({ creatorId,name,free,pay,minFee,maxFee }) => ({ creatorId,name,free,pay,minFee,maxFee }))
      const applied = await spoolRequest('/v1/config', { settings, profiles }, true)
      const readback = await spoolRequest('/v1/config', undefined, true)
      if (!applied.revision || applied.revision !== readback.revision) throw new Error('設定の読み戻しが一致しません。もう一度確認してください')
      return readback
    }
    void action().then(result => sendResponse({ result })).catch(() => sendResponse({ error: 'ミニPCとの接続または設定の読み戻しに失敗しました。接続設定と状態を確認してください' }))
    return true
  }
  const file = message.file as ProofFile | undefined
  const postId = /\/posts\/(\d+)(?:\/|$)/.exec(source.pathname)?.[1]
  if (!file || file.postId !== postId) {
    sendResponse({ error: '現在の投稿に属するファイルを選択してください' })
    return false
  }
  const save = async () => {
    if (message.msg !== 'spool_save') return saveProofFile(file)
    if ((await localSpoolConfig()).role !== 'collector' ||
        !(await chrome.storage.local.get('spoolCollectionEnabled')).spoolCollectionEnabled) throw new Error('この専用環境の収集は停止中です')
    if (typeof message.id !== 'string' || !Number.isSafeInteger(message.taskBatch) || typeof message.originalURL !== 'string') throw new Error('保存タスクの情報が不正です')
    const receipt = await saveSpoolFile(file as SpoolFile, async bytes => {
      totalDownload.addDownload(bytes)
      await notifySpoolAuthentication(false)
    })
    await chrome.tabs.sendMessage(sender.tab!.id!, {
      msg: 'downloaded', data: { url: message.originalURL, id: message.id, tabId: sender.tab!.id!,
        uuid: false, size: receipt.size, source: 'spool', taskBatch: message.taskBatch },
    })
    return receipt
  }
  void save()
    .then((receipt) => sendResponse({ receipt }))
    .catch((error: unknown) => {
      if (error instanceof SpoolAuthError) void notifySpoolAuthentication(true)
      sendResponse({ error: error instanceof Error ? error.message : '保存に失敗しました' })
    })
  return true
})

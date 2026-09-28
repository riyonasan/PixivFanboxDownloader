import { AutoPendingPost } from './AutoTypes'

let configuredURL: Promise<string | null> | undefined

function getNtfyURL() {
  configuredURL ??= fetch(chrome.runtime.getURL('ntfy-config.json'))
    .then(async (response) => {
      if (!response.ok) throw new Error(`Notification config: HTTP ${response.status}`)
      const config = (await response.json()) as { url?: unknown }
      return typeof config.url === 'string' && config.url ? config.url : null
    })
  return configuredURL
}

export async function notifyAutoPost(task: AutoPendingPost, success: boolean) {
  const url = await getNtfyURL()
  if (!url) return

  const postURL = `https://www.fanbox.cc/@${encodeURIComponent(task.creatorId)}/posts/${encodeURIComponent(task.postId)}`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: success ? 'FANBOX auto task completed' : 'FANBOX auto task failed',
      Click: postURL,
    },
    body: `${task.creatorId}: ${success ? '自動取得の処理が完了しました。' : '自動取得に失敗しました。次回再試行します。'}\n${postURL}`,
    credentials: 'omit',
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`ntfy request failed (HTTP ${response.status})`)
}

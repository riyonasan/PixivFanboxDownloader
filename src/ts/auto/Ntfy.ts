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

export async function notifyAutoPost(
  task: AutoPendingPost,
  success: boolean,
  details?: { creatorName?: string; postTitle?: string },
) {
  const url = await getNtfyURL()
  if (!url) return

  const postURL = `https://www.fanbox.cc/@${encodeURIComponent(task.creatorId)}/posts/${encodeURIComponent(task.postId)}`
  if (success && (!details?.creatorName || !details.postTitle)) {
    throw new Error('FANBOX post notification is missing its name or title')
  }
  const headers: Record<string, string> = {
    'Content-Type': 'text/plain; charset=utf-8',
    Click: postURL,
  }
  if (!success) headers.Title = 'FANBOX auto task failed'
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: success
      ? `${details!.creatorName}\n${details!.postTitle}\n${postURL}`
      : `${task.creatorId}: 自動取得に失敗しました。次回再試行します。\n${postURL}`,
    credentials: 'omit',
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`ntfy request failed (HTTP ${response.status})`)
}

// Session storage survives worker suspension but expires with the browser.
// Claims are serialized through this one extension worker; no time-based lease
// can steal work from a live, slow tab.
let serial: Promise<unknown> = Promise.resolve()
export function canonical(url: string) {
  const u = new URL(url)
  const post = /\/posts\/(\d+)/.exec(u.pathname)
  return post ? `post:${post[1]}` : `${u.origin}${u.pathname}`
}
export function claim(sender: chrome.runtime.MessageSender) {
  const operation = serial
    .catch(() => {})
    .then(async () => {
      if (sender.tab?.id === undefined || !sender.url || !sender.documentId)
        throw new Error('Tab document identity required')
      if (
        (sender.frameId !== undefined && sender.frameId !== 0) ||
        (sender.documentLifecycle && sender.documentLifecycle !== 'active')
      )
        return false
      const key = canonical(sender.url)
      const data = await chrome.storage.session.get('pfdOwners')
      const owners = (data.pfdOwners || {}) as Record<
        string,
        { tab: number; document: string }
      >
      const existing = owners[key]
      if (
        existing &&
        (existing.tab !== sender.tab.id ||
          existing.document !== sender.documentId)
      ) {
        const tab = await chrome.tabs.get(existing.tab).catch(() => undefined)
        if (
          tab?.url &&
          canonical(tab.url) === key &&
          existing.tab !== sender.tab.id
        )
          return false
        // Navigation creates a new document in the same tab; old requests cannot
        // claim ownership again because their document is no longer current.
      }
      owners[key] = { tab: sender.tab.id, document: sender.documentId }
      await chrome.storage.session.set({ pfdOwners: owners })
      return true
    })
  serial = operation
  return operation
}

export async function ownTask() {
  const response = await chrome.runtime.sendMessage({ msg: 'pfd_claim' })
  if (!response?.owned) return false
  return true
}

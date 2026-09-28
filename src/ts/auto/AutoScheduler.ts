import {
  AutoCreatorProfile,
  AutoPendingPost,
  AutoStatus,
  autoActiveKey,
  autoPendingKey,
  autoProfilesKey,
  autoStatusKey,
  matchesAutoFee,
} from './AutoTypes'
import { notifyAutoPost } from './Ntfy'

interface ActivePost {
  tabId: number
  task: AutoPendingPost
  startedAt: number
}

const alarmName = 'fanboxAutoCheck'
let checking = false
let starting = false
let startAgain = false
async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'include' })
  if (!response.ok) {
    throw new Error(`FANBOX request failed (HTTP ${response.status})`)
  }
  const result = await response.json()
  if (result.error || result.status === 'error') {
    throw new Error(result.error?.message || result.message || 'Request failed')
  }
  return result as T
}

async function openScanTab() {
  const tab = await chrome.tabs.create({
    url: `https://www.fanbox.cc/?pfdAutoScan=${Date.now()}`,
    active: false,
  })
  if (tab.id === undefined) throw new Error('Automatic scan tab has no ID')
  return tab.id
}

async function findNewPosts(
  tabId: number,
  profile: AutoCreatorProfile,
  until: number,
  delayMs: number,
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === 'complete') {
      if (!tab.url?.startsWith('https://www.fanbox.cc/')) {
        throw new Error('FANBOX is not open in the automatic scan tab')
      }
      try {
        const response = await chrome.tabs.sendMessage(tabId, {
          msg: 'auto_scan',
          profile,
          until,
          delayMs,
        })
        if (response?.error) throw new Error(response.error)
        if (!Array.isArray(response?.posts)) {
          throw new Error('Automatic scan returned an unexpected result')
        }
        return response.posts as AutoPendingPost[]
      } catch (error) {
        if (
          attempt === 19 ||
          (error instanceof Error &&
            !error.message.includes('Receiving end does not exist'))
        )
          throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Automatic scan tab did not finish loading')
}

async function scanProfiles() {
  const stored = await chrome.storage.local.get([
    autoProfilesKey,
    'fanboxSetting',
  ])
  const interval = (
    stored.fanboxSetting as { crawlInterval?: number } | undefined
  )?.crawlInterval
  const delayMs = Math.max(1000, Number(interval || 1) * 1000)
  const profiles = (stored[autoProfilesKey] || []) as AutoCreatorProfile[]
  if (profiles.length === 0) return
  let tabId: number | undefined
  let scanError = ''
  try {
    tabId = await openScanTab()
    for (const profile of profiles) {
      const until = Date.now()
      try {
        const found = await findNewPosts(tabId, profile, until, delayMs)
        const latest = await chrome.storage.local.get([
          autoProfilesKey,
          autoPendingKey,
        ])
        const currentProfiles = (latest[autoProfilesKey] ||
          []) as AutoCreatorProfile[]
        const current = currentProfiles.find(
          (item) => item.creatorId === profile.creatorId,
        )
        if (!current) continue
        current.since = until
        const pending = (latest[autoPendingKey] || []) as AutoPendingPost[]
        for (const post of found.reverse()) {
          if (!pending.some((item) => item.postId === post.postId))
            pending.push(post)
        }
        await chrome.storage.local.set({
          [autoProfilesKey]: currentProfiles,
          [autoPendingKey]: pending,
        })
        const previousStatus = await chrome.storage.local.get(autoStatusKey)
        await chrome.storage.local.set({
          [autoStatusKey]: {
            ...(previousStatus[autoStatusKey] as AutoStatus | undefined),
            lastCheckedAt: Date.now(),
          },
        })
      } catch (error) {
        scanError = `${profile.name}: ${error instanceof Error ? error.message : String(error)}`
        console.error(
          `Automatic FANBOX check failed for ${profile.creatorId}`,
          error,
        )
      }
    }
  } catch (error) {
    scanError = error instanceof Error ? error.message : String(error)
    console.error('Automatic FANBOX scan tab failed', error)
  } finally {
    if (tabId !== undefined) {
      await chrome.tabs.remove(tabId).catch(() => {})
    }
    const previousStatus = await chrome.storage.local.get(autoStatusKey)
    await chrome.storage.local.set({
      [autoStatusKey]: {
        ...(previousStatus[autoStatusKey] as AutoStatus | undefined),
        lastError: scanError,
      },
    })
  }
}

async function getActive(): Promise<ActivePost | null> {
  const stored = await chrome.storage.local.get(autoActiveKey)
  return (stored[autoActiveKey] || null) as ActivePost | null
}

async function clearStaleActive() {
  const active = await getActive()
  if (!active) return false
  let tab: chrome.tabs.Tab | undefined
  try {
    tab = await chrome.tabs.get(active.tabId)
  } catch {
    // Browser restart or user closed the tab.
  }
  if (tab && Date.now() - active.startedAt < 60 * 60 * 1000) {
    return true
  }
  if (tab) await chrome.tabs.remove(active.tabId)
  await chrome.storage.local.remove(autoActiveKey)
  return false
}

async function sendStart(active: ActivePost, profile: AutoCreatorProfile) {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const tab = await chrome.tabs.get(active.tabId)
      if (tab.status === 'complete') {
        const response = await chrome.tabs.sendMessage(active.tabId, {
          msg: 'auto_start',
          profile,
          postId: active.task.postId,
          startedAt: active.startedAt,
        })
        if (response?.accepted) return
        throw new Error(response?.error || 'Automatic post start was rejected')
      }
    } catch (error) {
      if (attempt === 19) throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error('Automatic post tab did not finish loading')
}

async function startNextPostInternal() {
  if (await clearStaleActive()) return
  const stored = await chrome.storage.local.get([
    autoProfilesKey,
    autoPendingKey,
    'fanboxSetting',
  ])
  const profiles = (stored[autoProfilesKey] || []) as AutoCreatorProfile[]
  const pending = (stored[autoPendingKey] || []) as AutoPendingPost[]
  const remaining = pending.filter((item) => {
    const profile = profiles.find((value) => value.creatorId === item.creatorId)
    return profile && matchesAutoFee(profile, item.fee)
  })
  if (remaining.length !== pending.length) {
    await chrome.storage.local.set({ [autoPendingKey]: remaining })
  }
  const task = remaining.find(
    (item) => !item.retryAfter || item.retryAfter <= Date.now(),
  )
  if (!task) return
  const profile = profiles.find((item) => item.creatorId === task.creatorId)!
  const currentSettings = stored.fanboxSetting as
    { saveToEagle?: boolean } | undefined
  if (currentSettings?.saveToEagle) {
    try {
      await request('http://localhost:41595/api/application/info')
    } catch {
      console.warn('Automatic FANBOX import is waiting for Eagle')
      return
    }
  }
  const tab = await chrome.tabs.create({
    url: `https://www.fanbox.cc/@${encodeURIComponent(task.creatorId)}/posts/${encodeURIComponent(task.postId)}`,
    active: false,
  })
  if (tab.id === undefined) throw new Error('Automatic post tab has no ID')
  const active: ActivePost = { tabId: tab.id, task, startedAt: Date.now() }
  await chrome.storage.local.set({ [autoActiveKey]: active })
  try {
    await sendStart(active, profile)
  } catch (error) {
    await chrome.tabs.remove(active.tabId).catch(() => {})
    await chrome.storage.local.remove(autoActiveKey)
    const previousStatus = await chrome.storage.local.get(autoStatusKey)
    await chrome.storage.local.set({
      [autoStatusKey]: {
        ...(previousStatus[autoStatusKey] as AutoStatus | undefined),
        lastError: `${profile.name}: ${error instanceof Error ? error.message : String(error)}`,
      },
    })
    console.error('Automatic FANBOX post could not start', error)
    await notifyAutoPost(task, false).catch((notificationError) =>
      console.warn('Automatic FANBOX notification failed', notificationError),
    )
  }
}

async function startNextPost() {
  if (starting) {
    startAgain = true
    return
  }
  starting = true
  try {
    await startNextPostInternal()
  } finally {
    starting = false
    if (startAgain) {
      startAgain = false
      void startNextPost().catch((error) =>
        console.error('Automatic FANBOX import failed', error),
      )
    }
  }
}

async function runAutoCheck() {
  if (checking) return
  checking = true
  try {
    await scanProfiles()
    await startNextPost()
  } catch (error) {
    console.error('Automatic FANBOX check failed', error)
  } finally {
    checking = false
  }
}

async function finishPost(message: {
  creatorId: string
  postId: string
  startedAt: number
  success: boolean
}) {
  const active = await getActive()
  if (
    !active ||
    active.task.creatorId !== message.creatorId ||
    active.task.postId !== message.postId ||
    active.startedAt !== message.startedAt
  )
    return
  const stored = await chrome.storage.local.get(autoPendingKey)
  const pending = (stored[autoPendingKey] || []) as AutoPendingPost[]
  await chrome.storage.local.set({
    [autoPendingKey]: message.success
      ? pending.filter((item) => item.postId !== message.postId)
      : pending.map((item) =>
          item.postId === message.postId
            ? { ...item, retryAfter: Date.now() + 60 * 60 * 1000 }
            : item,
        ),
  })
  const previousStatus = await chrome.storage.local.get(autoStatusKey)
  await chrome.storage.local.set({
    [autoStatusKey]: {
      ...(previousStatus[autoStatusKey] as AutoStatus | undefined),
      ...(message.success
        ? { lastCompletedAt: Date.now(), lastError: '' }
        : {
            lastError: `${message.creatorId}: 取り込みに失敗しました。次回再試行します。`,
          }),
    },
  })
  await chrome.storage.local.remove(autoActiveKey)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  await chrome.tabs.remove(active.tabId).catch(() => {})
  await notifyAutoPost(active.task, message.success).catch((error) =>
    console.warn('Automatic FANBOX notification failed', error),
  )
  void startNextPost().catch((error) =>
    console.error('Automatic FANBOX import failed', error),
  )
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.msg === 'auto_result') {
    void finishPost(message).catch((error) =>
      console.error('Automatic FANBOX result could not be saved', error),
    )
  } else if (message.msg === 'auto_check_now') {
    void runAutoCheck()
  }
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName) void runAutoCheck()
})

async function ensureAlarm() {
  if (!(await chrome.alarms.get(alarmName))) {
    chrome.alarms.create(alarmName, { periodInMinutes: 60 })
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureAlarm().then(runAutoCheck)
})
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm().then(runAutoCheck)
})
void ensureAlarm()

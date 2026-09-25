import { lang } from './Lang'
import { Colors } from './Colors'
import { Tools } from './Tools'
import { InitPageBase } from './InitPageBase'
import { API } from './API'
import { Utils } from './utils/Utils'
import { EVT } from './EVT'
import { states } from './States'
import { log } from './Log'
import { crawlInterval } from './CrawlInterval'
import { AutoCreatorProfile } from './auto/AutoTypes'
import { getAutoProfile, setAutoProfile } from './auto/AutoSession'

class InitPostPage extends InitPageBase {
  private autoMessageListener?: Parameters<typeof chrome.runtime.onMessage.addListener>[0]
  private autoEventListeners: [string, EventListener][] = []
  constructor() {
    super()
    this.init()
  }

  // 添加中间按钮
  protected addCrawlBtns() {
    Tools.addBtn('crawlBtns', Colors.bgBlue, '_抓取这篇投稿').addEventListener(
      'click',
      () => {
        this.readyCrawl()
      },
    )
  }

  protected initAny(): void {
    EVT.bindOnce('quickCrawl', EVT.list.quickCrawl, () => {
      if (!states.busy) {
        this.readyCrawl()
      }
    })

    let active: {
      creatorId: string
      postId: string
      startedAt: number
    } | null = null
    const finish = (success: boolean) => {
      if (!active) return
      const task = active
      active = null
      setAutoProfile(null)
      chrome.runtime.sendMessage({ msg: 'auto_result', ...task, success })
    }
    this.autoEventListeners = [
      [EVT.list.downloadComplete, () => finish(true)],
      [EVT.list.crawlEmpty, () => finish(true)],
      [EVT.list.downloadStop, () => finish(false)],
      [EVT.list.downloadPause, () => finish(false)],
    ]
    for (const [event, listener] of this.autoEventListeners) {
      window.addEventListener(event, listener)
    }

    this.autoMessageListener = (message, _sender, sendResponse) => {
      if (message.msg !== 'auto_start') return
      const postId = Utils.getURLPathField(window.location.pathname, 'posts')
      if (active || states.busy || postId !== message.postId) {
        sendResponse({ accepted: false, error: 'Post is not ready' })
        return
      }
      const start = () => {
        active = {
          creatorId: message.profile.creatorId,
          postId,
          startedAt: message.startedAt,
        }
        setAutoProfile(message.profile as AutoCreatorProfile)
        states.quickCrawl = true
        EVT.fire('quickCrawl')
        sendResponse({ accepted: true })
      }
      if (states.settingInitialized) {
        start()
      } else {
        window.addEventListener(EVT.list.settingInitialized, start, {
          once: true,
        })
      }
      return true
    }
    chrome.runtime.onMessage.addListener(this.autoMessageListener)
  }

  protected destroy() {
    Tools.clearSlot('crawlBtns')
    if (this.autoMessageListener) {
      chrome.runtime.onMessage.removeListener(this.autoMessageListener)
    }
    for (const [event, listener] of this.autoEventListeners) {
      window.removeEventListener(event, listener)
    }
    setAutoProfile(null)
  }

  protected nextStep() {
    this.getPostDataThreadNum = 1
    this.fetchPost()
  }

  protected async fetchPost() {
    await crawlInterval.wait()

    try {
      const data = await API.getPost(
        Utils.getURLPathField(window.location.pathname, 'posts'),
      )
      crawlInterval.addTime()
      await this.fetchAllComments(data.body.post || data.body)
      this.afterFetchPost(data)
    } catch (error) {
      console.log(error)
      if ((error as Error).message) {
        log.error((error as Error).message)
      }
      if (getAutoProfile()) {
        EVT.fire('downloadStop')
        return
      }
      log.error(lang.transl('_请求失败下载器会重试这个请求'))
      crawlInterval.addTime('long')
      this.fetchPost()
    }
  }
}

export { InitPostPage }

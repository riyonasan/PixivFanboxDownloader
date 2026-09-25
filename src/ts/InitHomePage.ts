import { lang } from './Lang'
import { Colors } from './Colors'
import { Tools } from './Tools'
import { InitPageBase } from './InitPageBase'
import { ListFollowing, SupportPostList } from './CrawlResult.d'
import { API } from './API'
import { EVT } from './EVT'
import { log } from './Log'
import { pageType } from './PageType'
import { saveFanCard } from './download/SaveFanCard'
import {
  AutoCreatorProfile,
  AutoStatus,
  autoPendingKey,
  autoProfilesKey,
  autoStatusKey,
} from './auto/AutoTypes'

class InitHomePage extends InitPageBase {
  constructor() {
    super()
    this.init()
  }

  private crawlFlag: 'supporting' | 'following' = 'supporting'

  // 添加中间按钮
  protected addCrawlBtns() {
    if (pageType.type === pageType.list.Following) {
      const button = Tools.addBtn('crawlBtns', Colors.bgGreen)
      button.textContent = '自動取得の管理'
      button.addEventListener('click', () => {
        void this.showAutoManager(button)
      })
    }
    if (
      pageType.type === pageType.list.Home ||
      pageType.type === pageType.list.Supporting
    ) {
      Tools.addBtn(
        'crawlBtns',
        Colors.bgBlue,
        '_抓取赞助的所有用户的投稿',
      ).addEventListener('click', () => {
        this.crawlFlag = 'supporting'
        this.readyCrawl()
      })
    }

    if (
      pageType.type === pageType.list.Home ||
      pageType.type === pageType.list.Following
    ) {
      Tools.addBtn(
        'crawlBtns',
        Colors.bgBlue,
        '_抓取关注的所有用户的投稿',
      ).addEventListener('click', () => {
        const confirm = window.confirm(
          lang.transl('_抓取关注的所有用户的投稿的提示'),
        )
        if (!confirm) {
          return
        }
        this.crawlFlag = 'following'
        this.readyCrawl()
      })
    }

    if (
      pageType.type === pageType.list.Home ||
      pageType.type === pageType.list.Supporting
    ) {
      Tools.addBtn(
        'crawlBtns',
        Colors.bgGreen,
        '_保存所有粉丝卡',
      ).addEventListener('click', () => {
        saveFanCard.save('all')
      })
    }

    if (pageType.type === pageType.list.Home) {
      Tools.addBtn(
        'crawlBtns',
        Colors.bgGreen,
        '_清空已保存的抓取结果',
      ).addEventListener('click', () => {
        EVT.fire('clearSavedCrawl')
      })
    }
  }

  private async showAutoManager(button: HTMLButtonElement) {
    const slot = Tools.findSlot('crawlBtns')
    const existing = slot.querySelector('.autoCreatorManager')
    if (existing) {
      existing.remove()
      return
    }

    button.disabled = true
    try {
      const data: ListFollowing = await API.request(
        'https://api.fanbox.cc/creator.listFollowing',
      )
      const stored = await chrome.storage.local.get([
        autoProfilesKey,
        autoPendingKey,
        autoStatusKey,
      ])
      const profiles = (stored[autoProfilesKey] || []) as AutoCreatorProfile[]
      const creators = data.body.creators.map((item) => ({
        creatorId: item.creatorId,
        name: item.user.name,
      }))
      for (const profile of profiles) {
        if (!creators.some((item) => item.creatorId === profile.creatorId)) {
          creators.push({ creatorId: profile.creatorId, name: profile.name })
        }
      }
      if (pageType.type !== pageType.list.Following) return

      const manager = document.createElement('div')
      manager.className = 'autoCreatorManager'
      manager.style.cssText =
        'width:100%;max-height:420px;overflow:auto;text-align:left;padding:12px;box-sizing:border-box;font-size:14px'
      const hint = document.createElement('p')
      hint.textContent =
        '対象を選び、無料・有料と有料投稿の価格範囲を設定してください。初回登録以前の投稿は自動取得しません。'
      manager.append(hint)
      const status = (stored[autoStatusKey] || {}) as AutoStatus
      const statusLine = document.createElement('p')
      const pendingCount = ((stored[autoPendingKey] || []) as unknown[]).length
      const showStatus = (count: number) => {
        statusLine.textContent = `登録: ${count}人 / 未処理: ${pendingCount}件 / 前回確認: ${status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : '未実施'}${status.lastError ? ` / エラー: ${status.lastError}` : ''}`
      }
      showStatus(profiles.length)
      manager.append(statusLine)

      const addCheckbox = (label: HTMLLabelElement, checked: boolean) => {
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.checked = checked
        input.style.cssText =
          'display:inline-block;appearance:auto;opacity:1;visibility:visible;position:static;width:16px;height:16px;margin-right:3px;vertical-align:middle;cursor:pointer'
        const mark = document.createElement('span')
        const updateMark = () => {
          mark.textContent = input.checked ? '☑ ' : '☐ '
        }
        input.addEventListener('change', updateMark)
        updateMark()
        label.append(input, mark)
        return input
      }

      const rows: {
        creatorId: string
        name: string
        enabled: HTMLInputElement
        free: HTMLInputElement
        pay: HTMLInputElement
        min: HTMLInputElement
        max: HTMLInputElement
      }[] = []
      for (const creator of creators) {
        const saved = profiles.find(
          (item) => item.creatorId === creator.creatorId,
        )
        const row = document.createElement('div')
        row.style.cssText = 'padding:8px 0;border-bottom:1px solid #777'
        const title = document.createElement('label')
        const enabled = addCheckbox(title, !!saved)
        title.append(
          document.createTextNode(` ${creator.name} (@${creator.creatorId})`),
        )
        row.append(title, document.createElement('br'))

        const addCheck = (label: string, checked: boolean) => {
          const wrap = document.createElement('label')
          const input = addCheckbox(wrap, checked)
          wrap.append(document.createTextNode(` ${label} `))
          row.append(wrap)
          return input
        }
        const free = addCheck('無料', saved?.free ?? true)
        const pay = addCheck('有料', saved?.pay ?? true)
        const addAmount = (label: string, value: number | null) => {
          const wrap = document.createElement('label')
          wrap.textContent = `${label} `
          const input = document.createElement('input')
          input.type = 'number'
          input.min = '0'
          input.step = '1'
          input.placeholder = '指定なし'
          input.value = value === null ? '' : String(value)
          input.style.width = '6em'
          wrap.append(input)
          row.append(wrap)
          return input
        }
        const min = addAmount('下限', saved?.minFee ?? null)
        const max = addAmount('上限', saved?.maxFee ?? null)
        manager.append(row)
        rows.push({
          creatorId: creator.creatorId,
          name: creator.name,
          enabled,
          free,
          pay,
          min,
          max,
        })
      }

      const save = document.createElement('button')
      save.type = 'button'
      save.textContent = '自動取得の設定を保存'
      save.addEventListener('click', () => {
        const next: AutoCreatorProfile[] = []
        for (const row of rows) {
          if (!row.enabled.checked) continue
          const minFee = row.min.value === '' ? null : Number(row.min.value)
          const maxFee = row.max.value === '' ? null : Number(row.max.value)
          if (
            (!row.free.checked && !row.pay.checked) ||
            (row.pay.checked &&
              ((minFee !== null && (!Number.isInteger(minFee) || minFee < 0)) ||
                (maxFee !== null &&
                  (!Number.isInteger(maxFee) || maxFee < 0)) ||
                (minFee !== null && maxFee !== null && minFee > maxFee)))
          ) {
            window.alert(`${row.name}: 価格条件を確認してください`)
            return
          }
          const previous = profiles.find(
            (item) => item.creatorId === row.creatorId,
          )
          next.push({
            creatorId: row.creatorId,
            name: row.name,
            free: row.free.checked,
            pay: row.pay.checked,
            minFee,
            maxFee,
            since: previous?.since || Date.now(),
          })
        }
        save.disabled = true
        void chrome.storage.local
          .set({ [autoProfilesKey]: next })
          .then(() => {
            profiles.splice(0, profiles.length, ...next)
            showStatus(next.length)
            void chrome.runtime.sendMessage({ msg: 'auto_check_now' })
            window.alert('自動取得の設定を保存しました')
          })
          .catch((error) => {
            window.alert(`保存できませんでした: ${error instanceof Error ? error.message : String(error)}`)
          })
          .finally(() => {
            save.disabled = false
          })
      })
      manager.append(save)
      if (pageType.type === pageType.list.Following) slot.append(manager)
    } catch (error) {
      window.alert(
        `フォロー中のクリエイターを取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      button.disabled = false
    }
  }

  protected nextStep() {
    switch (this.crawlFlag) {
      case 'supporting':
        return this.getSupportingPostList()
      case 'following':
        return this.getFollowingPostList()
    }
  }

  /**获取赞助的所有用户的所有投稿 */
  protected async getSupportingPostList() {
    log.log(lang.transl('_抓取赞助的所有用户的投稿'))
    let data: SupportPostList
    if (this.nextUrl) {
      data = (await API.request(this.nextUrl)) as SupportPostList
    } else {
      data = await API.getPostListSupporting(300)
    }

    // 如果没有赞助任何创作者, 那么这里获取到的是空数据
    // {"body":{"items":[],"nextUrl":null}}
    if (data.body.items.length === 0 && data.body.nextUrl === null) {
      log.error(lang.transl('_没有赞助的用户'))
      return this.FetchPostListFinished()
    }

    this.afterFetchPostListOld(data)
  }

  /**获取关注的所有用户的所有投稿 */
  protected async getFollowingPostList() {
    log.log(lang.transl('_抓取关注的所有用户的投稿'))
    // 获取关注的用户列表
    const url = 'https://api.fanbox.cc/creator.listFollowing'
    const json: ListFollowing = await API.request(url)
    if (json?.body?.creators.length > 0) {
      const userList: {
        creatorId: string
        name: string
      }[] = json.body.creators.map((item) => {
        return {
          creatorId: item.creatorId,
          name: item.user.name,
        }
      })

      log.success(lang.transl('_正在关注的创作者') + ':')
      // 获取每个作者的文章列表分页网址
      for (const user of userList) {
        log.log(user.name)
        await this.getPostListURLs(user.creatorId)
      }
      // console.log(this.postListURLs)

      // 获取文章列表
      log.log(lang.transl('_开始获取投稿列表'))
      this.FetchPostList()
    } else {
      log.error(lang.transl('_没有找到关注的用户'))
      return this.FetchPostListFinished()
    }
  }
}

export { InitHomePage }

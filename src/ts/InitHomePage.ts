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
  AutoPendingPost,
  AutoStatus,
  autoPendingKey,
  autoProfilesKey,
  autoStatusKey,
  matchesAutoFee,
} from './auto/AutoTypes'

function getSupportingCreators(body: unknown) {
  const root = body as {
    supportingPlans?: unknown
    plans?: unknown
  } | null
  const entries = Array.isArray(body)
    ? body
    : Array.isArray(root?.supportingPlans)
      ? root.supportingPlans
      : Array.isArray(root?.plans)
        ? root.plans
        : null
  if (!entries) throw new Error('支援中の一覧の形式を読み取れませんでした')

  const creators: { creatorId: string; name: string }[] = []
  for (const entry of entries) {
    const plans = Array.isArray(entry?.plans) ? entry.plans : [entry]
    for (const plan of plans) {
      if (typeof plan?.creatorId !== 'string') continue
      creators.push({
        creatorId: plan.creatorId,
        name: plan.user?.name || entry?.user?.name || plan.creatorId,
      })
    }
  }
  if (entries.length > 0 && creators.length === 0) {
    throw new Error('支援中のクリエイター情報を読み取れませんでした')
  }
  return creators
}

class InitHomePage extends InitPageBase {
  constructor() {
    super()
    this.init()
  }

  private crawlFlag: 'supporting' | 'following' = 'supporting'
  private autoManagerListener?: Parameters<
    typeof chrome.storage.onChanged.addListener
  >[0]

  private clearAutoManagerListener() {
    if (this.autoManagerListener) {
      chrome.storage.onChanged.removeListener(this.autoManagerListener)
      this.autoManagerListener = undefined
    }
  }

  protected destroy() {
    this.clearAutoManagerListener()
    Tools.clearSlot('crawlBtns')
  }

  // 添加中间按钮
  protected addCrawlBtns() {
    if (
      pageType.type === pageType.list.Following ||
      pageType.type === pageType.list.Supporting
    ) {
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
    const currentPage = pageType.type
    const slot = Tools.findSlot('crawlBtns')
    const existing = slot.querySelector('.autoCreatorManager')
    if (existing) {
      this.clearAutoManagerListener()
      existing.remove()
      return
    }

    button.disabled = true
    try {
      const creators =
        currentPage === pageType.list.Following
          ? (
              (await API.request(
                'https://api.fanbox.cc/creator.listFollowing',
              )) as ListFollowing
            ).body.creators.map((item) => ({
              creatorId: item.creatorId,
              name: item.user.name,
            }))
          : getSupportingCreators((await API.getAllSupportingPlan()).body)
      const stored = await chrome.storage.local.get([
        autoProfilesKey,
        autoPendingKey,
        autoStatusKey,
      ])
      const profiles = (stored[autoProfilesKey] || []) as AutoCreatorProfile[]
      const uniqueCreators = Array.from(
        new Map(creators.map((item) => [item.creatorId, item])).values(),
      )
      for (const profile of profiles) {
        if (
          !uniqueCreators.some((item) => item.creatorId === profile.creatorId)
        ) {
          uniqueCreators.push({
            creatorId: profile.creatorId,
            name: profile.name,
          })
        }
      }
      if (pageType.type !== currentPage) return

      const manager = document.createElement('div')
      manager.className = 'autoCreatorManager'
      manager.style.cssText =
        'width:100%;max-height:420px;overflow:auto;text-align:left;padding:12px;box-sizing:border-box;font-size:14px'
      const hint = document.createElement('p')
      hint.textContent =
        '有料は支援中・支援予定のクリエイターだけオンにし、必要に応じて価格上限を設定してください。閲覧できない有料記事は保留し、約1日ごとに再確認します。初回登録以前の投稿は自動取得しません。'
      manager.append(hint)
      let status = (stored[autoStatusKey] || {}) as AutoStatus
      const statusLine = document.createElement('p')
      let pending = (stored[autoPendingKey] || []) as AutoPendingPost[]
      const showStatus = (count: number) => {
        const restrictedCount = pending.filter((item) => item.restricted).length
        statusLine.textContent = `登録: ${count}人 / 未処理: ${pending.length}件（閲覧制限で保留: ${restrictedCount}件） / 前回確認: ${status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : '未実施'}${status.lastError ? ` / エラー: ${status.lastError}` : ''}`
      }
      showStatus(profiles.length)
      manager.append(statusLine)
      const retryHint = document.createElement('p')
      retryHint.textContent =
        '再加入後は「保留記事を再確認」で待たずに再取得できます。再確認には保存済みの設定を使います。設定変更で対象外になった保留記事は、保存時に対象から外れます。'
      manager.append(retryHint)
      const retryUpdates: (() => void)[] = []
      let settingsDirty = false
      manager.addEventListener('input', () => {
        settingsDirty = true
        retryUpdates.forEach((update) => update())
      })

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
      for (const creator of uniqueCreators) {
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
        const pay = addCheck('有料', saved?.pay ?? false)
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
        const retry = document.createElement('button')
        retry.type = 'button'
        let retrying = false
        const updateRetry = () => {
          const profile = profiles.find(
            (item) => item.creatorId === creator.creatorId,
          )
          const count = pending.filter(
            (item) =>
              item.creatorId === creator.creatorId &&
              item.restricted &&
              profile &&
              matchesAutoFee(profile, item.fee),
          ).length
          retry.textContent = `保留記事を再確認（${count}件）`
          retry.disabled = retrying || settingsDirty || count === 0
          retry.title = settingsDirty
            ? '先に自動取得の設定を保存してください'
            : ''
        }
        retryUpdates.push(updateRetry)
        updateRetry()
        retry.addEventListener('click', () => {
          retrying = true
          updateRetry()
          void chrome.runtime
            .sendMessage({
              msg: 'auto_retry_restricted',
              creatorId: creator.creatorId,
            })
            .then((response) => {
              if (typeof response?.count !== 'number') {
                throw new Error(
                  response?.error || '再確認の受付を確認できませんでした',
                )
              }
              window.alert(
                `${response.count}件を再確認の対象にしました。ほかの記事の処理中やEagleの起動待ちは順次処理します。`,
              )
            })
            .catch((error) => {
              window.alert(
                `再確認できませんでした: ${error instanceof Error ? error.message : String(error)}`,
              )
            })
            .finally(() => {
              retrying = false
              updateRetry()
            })
        })
        row.append(document.createElement('br'), retry)
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
        settingsDirty = true
        retryUpdates.forEach((update) => update())
        const inputs = rows.flatMap((row) => [
          row.enabled,
          row.free,
          row.pay,
          row.min,
          row.max,
        ])
        inputs.forEach((input) => {
          input.disabled = true
        })
        void chrome.runtime
          .sendMessage({ msg: 'auto_save_profiles', profiles: next })
          .then((response) => {
            if (!Array.isArray(response?.profiles)) {
              throw new Error(
                response?.error || '設定の保存を確認できませんでした',
              )
            }
            profiles.splice(0, profiles.length, ...response.profiles)
            settingsDirty = false
            retryUpdates.forEach((update) => update())
            showStatus(profiles.length)
            void chrome.runtime.sendMessage({ msg: 'auto_check_now' })
            window.alert('自動取得の設定を保存しました')
          })
          .catch((error) => {
            window.alert(
              `保存できませんでした: ${error instanceof Error ? error.message : String(error)}`,
            )
          })
          .finally(() => {
            save.disabled = false
            inputs.forEach((input) => {
              input.disabled = false
            })
          })
      })
      manager.append(save)
      if (pageType.type === currentPage) {
        this.clearAutoManagerListener()
        this.autoManagerListener = (changes, area) => {
          if (area !== 'local') return
          if (changes[autoPendingKey]) {
            pending = (changes[autoPendingKey].newValue ||
              []) as AutoPendingPost[]
          }
          if (changes[autoStatusKey]) {
            status = changes[autoStatusKey].newValue || {}
          }
          if (changes[autoProfilesKey]) {
            profiles.splice(
              0,
              profiles.length,
              ...((changes[autoProfilesKey].newValue ||
                []) as AutoCreatorProfile[]),
            )
          }
          showStatus(profiles.length)
          retryUpdates.forEach((update) => update())
        }
        chrome.storage.onChanged.addListener(this.autoManagerListener)
        slot.append(manager)
      }
    } catch (error) {
      window.alert(
        `クリエイターを取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
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

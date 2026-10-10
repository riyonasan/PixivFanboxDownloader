// 下载文件，并发送给浏览器下载
import { EVT } from '../EVT'
import { fileName } from '../FileName'
import {
  downloadArgument,
  SendToBackEndData,
  DonwloadSuccessData,
  DonwloadSkipData,
} from './DownloadType'
import { progressBar } from '../ProgressBar'
import { downloadRecord } from './DownloadRecord'
import { lang } from '../Lang'
import { log } from '../Log'
import { states } from '../States'
import { downloadInterval } from './DownloadInterval'
import { settings } from '../setting/Settings'

class Download {
  constructor(progressBarIndex: number, data: downloadArgument) {
    this.progressBarIndex = progressBarIndex
    this.arg = data

    this.download(data)

    this.bindEvents()
  }

  private progressBarIndex: number
  private arg: downloadArgument

  private fileName = ''

  private bindEvents() {
    window.addEventListener(
      EVT.list.downloadSuccess,
      (event: CustomEventInit) => {
        const donwloadSuccessData = event.detail.data as DonwloadSuccessData

        if (donwloadSuccessData.url === this.arg.data.url) {
          this.setProgressBar(1024, 1024)
        }
      },
    )
  }

  // 跳过下载这个文件。可以传入用于提示的文本
  private skipDownload(data: DonwloadSkipData, msg?: string) {
    if (msg) {
      log.warning(msg)
    }
    if (states.downloading) {
      EVT.fire('skipDownload', data)
    }
  }

  // 设置进度条信息
  private setProgressBar(loaded: number, total: number) {
    progressBar.setProgress(this.progressBarIndex, {
      name: this.fileName,
      loaded: loaded,
      total: total,
    })
  }

  // 下载文件
  private async download(arg: downloadArgument) {
    this.fileName = fileName.getFileName(arg.data)
    if (settings.saveToSpool) {
      await downloadInterval.wait()
      this.setProgressBar(0, 0)
      try {
        const result = arg.data
        const generated = 'text' in result
        const image = ['jpg','jpeg','png','gif','bmp','webp'].includes(result.ext.toLowerCase())
        const fileId = generated ? `file:text-${result.ext}`
          : `${image ? 'image' : 'file'}:${result.index === 0 ? 'cover' : result.fileID}`
        const response = await chrome.runtime.sendMessage({
          msg: 'spool_save', id: arg.id, taskBatch: arg.taskBatch, originalURL: result.url,
          file: {
            postId: result.postId, fileId,
            fileName: generated ? `text.${result.ext}` : image ? `${result.postId}-${result.index === 0 ? 'cover' : result.fileID}.${result.ext}` : `${result.name}.${result.ext}`,
            expectedSize: result.size, url: generated ? await this.getEagleURL(result.url) : result.url,
            registration: {
              fileName: this.fileName,
              website: `https://www.fanbox.cc/@${encodeURIComponent(result.createID)}/posts/${encodeURIComponent(result.postId)}`,
              tags: result.tags ? result.tags.split(',').filter(Boolean) : [],
            },
          },
        })
        if (!response?.receipt || response.error) throw new Error(response?.error || '保存確認が返りませんでした')
        log.success(`ミニPCへ保存済み / Eagle${response.receipt.eagleState === 'done' ? '登録済み' : '登録待ち'}: ${this.fileName}`)
      } catch (error) {
        this.eagleError(arg.data.url, arg.id, arg.taskBatch, error)
      }
      return
    }

    // 检查是否是重复文件
    const url = arg.data.url
    if (this.arg.saveToEagle || !url.startsWith('blob')) {
      const duplicate = await downloadRecord.checkDeduplication(
        arg.data,
        this.arg.saveToEagle,
      )
      if (duplicate) {
        return this.skipDownload(
          {
            id: arg.id,
            reason: 'duplicate',
          },
          lang.transl('_跳过下载因为重复文件', this.fileName),
        )
      }
    }

    if (this.arg.saveToEagle && settings.deduplication) {
      try {
        if (await this.checkExistingInEagle(arg)) {
          await downloadRecord.recordEagleSuccess(
            downloadRecord.getEagleRecordKey(arg.data),
          )
          return this.skipDownload(
            { id: arg.id, reason: 'duplicate' },
            lang.transl('_跳过下载因为重复文件', this.fileName),
          )
        }
      } catch (error) {
        this.eagleError(url, arg.id, arg.taskBatch, error)
        return
      }
    }

    await downloadInterval.wait()

    // 重设当前下载栏的信息
    this.setProgressBar(0, 0)

    if (this.arg.saveToEagle) {
      try {
        const eagleURL = await this.getEagleURL(url)
        this.eagleDownload(eagleURL, this.fileName, arg.id, arg.taskBatch)
      } catch (error) {
        this.eagleError(url, arg.id, arg.taskBatch, error)
      }
    } else {
      // 向浏览器发送下载任务
      this.browserDownload(url, this.fileName, arg.id, arg.taskBatch)
    }
  }

  private checkExistingInEagle(arg: downloadArgument) {
    const sendData: SendToBackEndData = {
      msg: 'check_eagle',
      fileUrl: arg.data.url,
      fileName: this.fileName,
      id: arg.id,
      taskBatch: arg.taskBatch,
    }
    return new Promise<boolean>((resolve, reject) => {
      chrome.runtime.sendMessage(sendData, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else if (response?.error) {
          reject(new Error(response.error))
        } else if (typeof response?.exists !== 'boolean') {
          reject(new Error('Eagle check returned no result'))
        } else {
          resolve(response.exists)
        }
      })
    })
  }

  // Eagle API は blob URL を参照できないため、生成した本文だけ data URL に変換する。
  private async getEagleURL(url: string) {
    if (!url.startsWith('blob:')) {
      return url
    }

    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Unable to read generated file (${response.status})`)
    }
    const blob = await response.blob()
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () =>
        reject(reader.error || new Error('FileReader error'))
      reader.readAsDataURL(blob)
    })
  }

  // 向浏览器发送下载任务
  private browserDownload(
    url: string,
    fileName: string,
    id: string,
    taskBatch: number,
  ) {
    const sendData: SendToBackEndData = {
      msg: 'send_download',
      fileUrl: url,
      fileName: fileName,
      id,
      taskBatch,
      conflictAction: this.arg.conflictAction,
    }

    chrome.runtime.sendMessage(sendData)
  }

  private eagleDownload(
    url: string,
    fileName: string,
    id: string,
    taskBatch: number,
  ) {
    const sendData: SendToBackEndData = {
      msg: 'add_to_eagle',
      fileUrl: url,
      fileName,
      id,
      taskBatch,
      recordKey: downloadRecord.getEagleRecordKey(this.arg.data),
      website: `https://www.fanbox.cc/@${encodeURIComponent(
        this.arg.data.createID,
      )}/posts/${encodeURIComponent(this.arg.data.postId)}`,
    }

    chrome.runtime.sendMessage(sendData)
  }

  private eagleError(
    url: string,
    id: string,
    taskBatch: number,
    error: unknown,
  ) {
    const sendData: SendToBackEndData = {
      msg: 'eagle_error',
      fileUrl: url,
      fileName: this.fileName,
      id,
      taskBatch,
      error: error instanceof Error ? error.message : String(error),
    }

    chrome.runtime.sendMessage(sendData)
  }
}

export { Download }

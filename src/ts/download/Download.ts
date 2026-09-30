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
import { acquire } from '../queue/Acquire'

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

    // 检查是否是重复文件
    const url = arg.data.url
    if (!this.arg.saveToEagle && !url.startsWith('blob')) {
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

    await downloadInterval.wait()

    // 重设当前下载栏的信息
    this.setProgressBar(0, 0)

    if (this.arg.saveToEagle) {
      try {
        const website = `https://www.fanbox.cc/@${encodeURIComponent(arg.data.createID)}/posts/${encodeURIComponent(arg.data.postId)}`
        const job = await acquire(url, {
          filename: this.fileName,
          website,
          recordKey: downloadRecord.getEagleRecordKey(arg.data),
        })
        chrome.runtime.sendMessage({
          msg: 'queue_downloaded',
          data: {
            url,
            id: arg.id,
            uuid: false,
            size: job.size,
            source: 'queue',
          },
        })
      } catch (error) {
        this.eagleError(url, arg.id, arg.taskBatch, error)
      }
    } else {
      // 向浏览器发送下载任务
      this.browserDownload(url, this.fileName, arg.id, arg.taskBatch)
    }
  }

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

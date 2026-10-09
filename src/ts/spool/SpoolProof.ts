import { API } from '../API'
import { PostBody } from '../CrawlResult.d'
import { ProofFile, SavedReceipt } from './SpoolClient'

const list = document.querySelector<HTMLButtonElement>('#spoolProofList')!
const save = document.querySelector<HTMLButtonElement>('#spoolProofSave')!
const select = document.querySelector<HTMLSelectElement>('#spoolProofFile')!
const status = document.querySelector<HTMLOutputElement>('#spoolProofStatus')!
let files: ProofFile[] = []
let listedPost = ''

document.querySelector('#spoolProofOptions')!.addEventListener('click', () => {
  void chrome.runtime.sendMessage({ msg: 'spool_proof_options' })
})

list.addEventListener('click', async () => {
  list.disabled = true
  save.disabled = true
  select.replaceChildren()
  files = []
  try {
    const postId = /\/posts\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1]
    if (!postId) throw new Error('取得する投稿のページで操作してください')
    const data = await API.getPost(postId)
    // Keep the same response compatibility as InitPostPage.
    const post = data?.body?.post || (data?.body as unknown as PostBody | undefined)
    if (!post || post.id !== postId || !post.body) throw new Error('投稿本文を取得できません。ログインと閲覧権限を確認してください')
    const addImage = (image: { id: string; extension: string; originalUrl: string }) => {
      files.push({ postId, fileId: `image:${image.id}`, fileName: `${postId}-${image.id}.${image.extension}`,
        expectedSize: null, url: image.originalUrl })
    }
    const addFile = (file: { id: string; name: string; extension: string; size: number; url: string }) => {
      files.push({ postId, fileId: `file:${file.id}`, fileName: `${file.name}.${file.extension}`,
        expectedSize: file.size, url: file.url })
    }
    if (post.type === 'image' && post.body) post.body.images.forEach(addImage)
    if (post.type === 'file' && post.body) post.body.files.forEach(addFile)
    if (post.type === 'article' && post.body) {
      Object.values(post.body.imageMap).forEach(addImage)
      Object.values(post.body.fileMap).forEach(addFile)
    }
    files = files.filter((file) => file.expectedSize === null || file.expectedSize <= 64 * 1024 * 1024)
    if (!files.length) throw new Error('実証対象の添付画像・ファイルがありません（上限64 MiB）')
    for (const [index, file] of files.entries()) {
      const option = document.createElement('option')
      option.value = String(index)
      option.textContent = file.fileName
      select.append(option)
    }
    listedPost = postId
    status.textContent = '1件選んで保存してください。Eagle登録と既存の取得履歴の更新は行いません。'
    save.disabled = false
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '投稿の添付ファイルを取得できませんでした'
  } finally { list.disabled = false }
})

save.addEventListener('click', async () => {
  save.disabled = true
  list.disabled = true
  try {
    if (/\/posts\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1] !== listedPost) {
      throw new Error('投稿が変わりました。添付ファイルを読み直してください')
    }
    const file = files[Number(select.value)]
    if (!file) throw new Error('ファイルを選択してください')
    status.textContent = '認証付きで取得・保存しています…'
    const response = await chrome.runtime.sendMessage({ msg: 'spool_proof_save', file })
    if (response?.error) throw new Error(response.error)
    const receipt = response?.receipt as SavedReceipt | undefined
    if (!receipt || receipt.state !== 'saved' || receipt.eagleState !== 'not_submitted') {
      throw new Error('保存確認を受信できませんでした。同じファイルで再確認できます')
    }
    status.textContent = `ミニPCへ保存済み / Eagle未登録\n${receipt.fileName}\n${receipt.size} bytes\nSHA-256: ${receipt.sha256}\n受付ID: ${receipt.receiptId}`
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : '保存確認ができませんでした。同じファイルで再確認できます'
  } finally { save.disabled = false; list.disabled = false }
})

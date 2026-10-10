// Phase 1 only: authenticated browser download -> local durable file receipt.
// No Eagle requests, production history updates, notifications or automatic scans.
export interface ProofFile {
  postId: string
  fileId: string
  fileName: string
  expectedSize: number | null
  url: string
}

export interface SavedReceipt {
  receiptId: string
  state: 'saved'
  eagleState: 'not_submitted'
  size: number
  sha256: string
  fileName: string
}

const base = 'http://127.0.0.1:18096'
const chunkSize = 1024 * 1024
const maxSize = 64 * chunkSize
let saving = false

function validateFile(file: ProofFile) {
  if (
    !file ||
    typeof file.postId !== 'string' ||
    !/^\d{1,30}$/.test(file.postId) ||
    typeof file.fileId !== 'string' ||
    !/^(file|image):[A-Za-z0-9_-]{1,120}$/.test(file.fileId) ||
    typeof file.fileName !== 'string' ||
    !file.fileName.length || file.fileName.length > 512 ||
    /[\x00-\x1f]/.test(file.fileName) ||
    (file.expectedSize !== null &&
      (!Number.isSafeInteger(file.expectedSize) || file.expectedSize < 0 || file.expectedSize > maxSize))
  ) throw new Error('保存実証のファイル情報が不正です（上限64 MiB）')
  const url = new URL(file.url)
  if (url.protocol !== 'https:' || url.username || url.password ||
      !(url.hostname === 'fanbox.cc' || url.hostname.endsWith('.fanbox.cc'))) {
    throw new Error('保存実証はFANBOX内の添付ファイルだけが対象です')
  }
}

function savedReceipt(value: unknown, expectedSize: number | null): SavedReceipt {
  const item = value as SavedReceipt | undefined
  if (!item || item.state !== 'saved' || item.eagleState !== 'not_submitted' ||
      !/^[a-f0-9]{64}$/.test(item.receiptId) || !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !Number.isSafeInteger(item.size) || item.size < 0 || item.size > maxSize ||
      (expectedSize !== null && item.size !== expectedSize)) {
    throw new Error('補助サービスから有効な保存確認が返りませんでした')
  }
  return item
}

export async function saveProofFile(file: ProofFile): Promise<SavedReceipt> {
  validateFile(file)
  if (saving) throw new Error('ほかの保存実証が進行中です')
  saving = true
  try {
    const config = await chrome.storage.local.get('spoolProofToken')
    let token = config.spoolProofToken
    // Optional per-machine provisioning; this private file is never packaged.
    // This avoids copying service credentials through the user's clipboard/chat.
    if (token === undefined) {
      try {
        const local = await fetch(chrome.runtime.getURL('spool-proof-local.json'), {
          credentials: 'omit', cache: 'no-store',
        })
        if (local.ok) token = (await local.json()).token
      } catch {
        // Normal for an extension installed without local provisioning.
      }
      if (typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token)) {
        await chrome.storage.local.set({ spoolProofToken: token })
      }
    }
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
      throw new Error('拡張機能の保存実証設定でAPIトークンを設定してください')
    }
    const request = async (path: string, body: object | Uint8Array, offset?: number) => {
      const binary = body instanceof Uint8Array
      const response = await fetch(base + path, {
        method: binary ? 'PUT' : 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': binary ? 'application/octet-stream' : 'application/json',
          ...(offset === undefined ? {} : { 'X-Offset': String(offset) }),
        },
        body: binary ? body.slice().buffer as ArrayBuffer : JSON.stringify(body),
        signal: AbortSignal.timeout(25000),
      })
      if (!response.ok) {
        // Do not echo response bodies or authenticated source URLs into logs.
        throw new Error(`補助サービスへの保存に失敗しました（HTTP ${response.status}）`)
      }
      return response.json()
    }
    const { url: sourceURL, ...metadata } = file
    const session = await request('/v1/uploads', metadata)
    if (session.state === 'saved') return savedReceipt(session, file.expectedSize)
    if (session.state !== 'uploading' || !/^[a-f0-9]{32}$/.test(session.uploadId) ||
        session.chunkSize !== chunkSize || session.maxSize !== maxSize) {
      throw new Error('補助サービスの受付応答が不正です')
    }
    const response = await fetch(sourceURL, {
      credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(240000),
    })
    if (!response.ok || !response.body) {
      throw new Error(`FANBOXファイルを取得できませんでした（HTTP ${response.status}）`)
    }
    if (file.fileId.startsWith('image:') &&
        !response.headers.get('content-type')?.toLowerCase().startsWith('image/')) {
      await response.body.cancel()
      throw new Error('画像以外の応答が返りました。ログインと閲覧権限を確認してください')
    }
    const lengthHeader = response.headers.get('content-length')
    const contentLength = lengthHeader === null ? null : Number(lengthHeader)
    if (contentLength !== null && (!Number.isSafeInteger(contentLength) || contentLength > maxSize ||
        contentLength < 0 || (file.expectedSize !== null && contentLength !== file.expectedSize))) {
      await response.body.cancel()
      throw new Error('FANBOXファイルのサイズが実証の条件と一致しません')
    }
    const reader = response.body.getReader()
    let size = 0
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        for (let start = 0; start < next.value.length; start += chunkSize) {
          const bytes = next.value.slice(start, start + chunkSize)
          if (size + bytes.length > maxSize ||
              (file.expectedSize !== null && size + bytes.length > file.expectedSize)) {
            throw new Error('ファイルサイズが実証の上限を超えました')
          }
          const accepted = await request(`/v1/uploads/${session.uploadId}`, bytes, size)
          if (accepted.offset !== size + bytes.length) throw new Error('転送位置の確認に失敗しました')
          size += bytes.length
        }
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    if ((file.expectedSize !== null && size !== file.expectedSize) ||
        (contentLength !== null && size !== contentLength)) {
      throw new Error('FANBOXファイルの取得が完了していません')
    }
    return savedReceipt(await request(`/v1/uploads/${session.uploadId}/commit`, { size }), size)
  } finally {
    saving = false
  }
}

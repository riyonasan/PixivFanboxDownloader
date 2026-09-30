import { sha256 } from '@noble/hashes/sha256'
import { hex } from './DurableQueue'
async function send(message: object) {
  const result = await chrome.runtime.sendMessage(message)
  if (!result || result.error)
    throw new Error(result?.error || 'Queue worker unavailable')
  return result
}
export async function acquire(
  url: string,
  metadata: { filename: string; website: string; recordKey: string },
) {
  const extension = metadata.filename.split('.').pop()?.toLowerCase() || ''
  const mime =
    (
      {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        mov: 'video/quicktime',
        mp4: 'video/mp4',
        html: 'text/html',
        txt: 'text/plain',
        pdf: 'application/pdf',
      } as Record<string, string>
    )[extension] || 'application/octet-stream'
  const { job } = await send({
    msg: 'queue_begin',
    metadata: { ...metadata, mime },
  })
  if (job.state !== 'staging') return job // accepted jobs never fetch their source again
  const response = await fetch(url, { credentials: 'include' })
  if (!response.ok || !response.body)
    throw new Error(`Acquisition failed: HTTP ${response.status}`)
  if (
    response.headers.get('content-type')?.includes('text/html') &&
    extension !== 'html'
  ) {
    await response.body.cancel()
    throw new Error(
      'Expected original file; received HTML (login or access may be required)',
    )
  }
  const reader = response.body.getReader()
  let offset = 0,
    index = job.chunks
  const hash = sha256.create()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
      for (let start = 0; start < value.length; start += 256 * 1024) {
        let chunk = value.subarray(start, start + 256 * 1024)
        const end = offset + chunk.length
        // A partial unaccepted acquisition is resumed by replaying the stream.
        if (end > job.size) {
          chunk = chunk.subarray(Math.max(0, job.size - offset))
          let binary = ''
          for (let i = 0; i < chunk.length; i += 0x8000)
            binary += String.fromCharCode(...chunk.subarray(i, i + 0x8000))
          await send({
            msg: 'queue_chunk',
            jobId: job.id,
            index: index++,
            base64: btoa(binary),
          })
        }
        offset = end
      }
    }
    return (
      await send({
        msg: 'queue_accept',
        jobId: job.id,
        size: offset,
        hash: hex(hash.digest()),
      })
    ).job
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

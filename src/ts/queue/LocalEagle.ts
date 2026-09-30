import { eagle } from '../eagle/Eagle'
import { DeliveryAdapter, Job, marker } from './DurableQueue'

// V1 localhost only. No listener, remote credential, or plugin is installed.
export class LocalEagle implements DeliveryAdapter {
  async reconcile(job: Job) {
    // Never use Eagle's legacy name/folder cache for reconciliation.
    const matches: string[] = []
    for (let offset = 0; ; offset += 1000) {
      const response = await fetch(
        `http://localhost:41595/api/item/list?limit=1000&offset=${offset}`,
        { cache: 'no-store' },
      )
      const body = await response.json()
      if (
        !response.ok ||
        body.status !== 'success' ||
        !Array.isArray(body.data)
      )
        throw new Error('Eagle fresh lookup unavailable')
      for (const item of body.data) {
        if (
          !item.isDeleted &&
          item.annotation === marker(job) &&
          item.url === job.website
        ) {
          const detailResponse = await fetch(
            `http://localhost:41595/api/item/info?id=${encodeURIComponent(item.id)}`,
            { cache: 'no-store' },
          )
          const detail = await detailResponse.json()
          if (!detailResponse.ok || detail.status !== 'success')
            throw new Error('Eagle detail lookup unavailable')
          if (
            !detail.data.isDeleted &&
            detail.data.annotation === marker(job) &&
            detail.data.url === job.website
          )
            matches.push(item.id)
        }
      }
      if (body.data.length < 1000) break
    }
    if (matches.length > 1)
      throw new Error(
        'Multiple Eagle items have this job marker; manual reconciliation required',
      )
    // This only resolves whether a request created a candidate. It is never byte proof.
    return matches.length ? { itemId: matches[0] } : undefined
  }
  async submit(job: Job, bytes: AsyncIterable<Uint8Array>) {
    // V1 JSON/data-URL requires whole-body strings. Keep a separate explicit
    // transport memory budget; larger MOVs remain durably accepted and retained.
    let binary = ''
    for await (const chunk of bytes) {
      for (let i = 0; i < chunk.length; i += 0x8000)
        binary += String.fromCharCode(...chunk.subarray(i, i + 0x8000))
    }
    await eagle.addFromURL(
      `data:${job.mime};base64,${btoa(binary)}`,
      job.filename,
      job.website,
      job.id,
      marker(job),
    )
  }
  async prepare(job: Job) {
    if (job.size > 128 * 1024 ** 2)
      throw new Error(
        'V1 delivery needs whole-body base64; file exceeds 128 MiB transport budget and is retained',
      )
  }
}

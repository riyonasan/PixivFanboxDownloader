import { DurableQueue, Delivery } from './DurableQueue'
import { claim, canonical } from './Ownership'
import { LocalEagle } from './LocalEagle'

const ready = DurableQueue.open().then(async (queue) => {
  await queue.recover()
  return { queue, delivery: new Delivery(queue, new LocalEagle()) }
})
function pump() {
  void ready
    .then(({ delivery }) => delivery.run())
    .catch((e) => console.warn('Eagle delivery waiting:', String(e)))
}
// Existing scheduler alarm provides a wake-up without another scheduler.
chrome.alarms.onAlarm.addListener(pump)
chrome.runtime.onStartup.addListener(pump)
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    ![
      'pfd_claim',
      'queue_begin',
      'queue_chunk',
      'queue_accept',
      'queue_status',
    ].includes(message.msg)
  )
    return false
  void (async () => {
    if (message.msg === 'queue_status') {
      // Only extension pages may inspect metadata; no bytes or auth material exposed.
      if (!sender.url?.startsWith(chrome.runtime.getURL('')))
        throw new Error('Queue status requires an extension page')
      return { jobs: await (await ready).queue.list() }
    }
    if (!(await claim(sender)))
      throw new Error('This post is owned by another live tab')
    if (message.msg === 'pfd_claim') return { owned: true }
    const { queue } = await ready
    if (message.msg === 'queue_begin') {
      if (
        !message.metadata?.website ||
        canonical(message.metadata.website) !== canonical(sender.url!) ||
        new URL(message.metadata.website).origin !== 'https://www.fanbox.cc'
      )
        throw new Error('Queue post identity mismatch')
      return { job: await queue.begin(message.metadata) }
    }
    const job = await queue.get(message.jobId)
    if (!job || canonical(job.website) !== canonical(sender.url!))
      throw new Error('Queue job belongs to another post')
    if (message.msg === 'queue_chunk') {
      if (typeof message.base64 !== 'string' || message.base64.length > 349528)
        throw new Error('Queue message exceeds chunk memory budget')
      const raw = atob(message.base64)
      await queue.append(
        job.id,
        message.index,
        Uint8Array.from(raw, (c) => c.charCodeAt(0)),
      )
      return { committed: true }
    }
    if (!/^[a-f0-9]{64}$/.test(message.hash || ''))
      throw new Error('Original stream hash required')
    const accepted = await queue.accept(job.id, message.size, message.hash)
    pump()
    return { accepted: true, job: accepted }
  })().then(respond, (e) => respond({ error: String(e) }))
  return true
})

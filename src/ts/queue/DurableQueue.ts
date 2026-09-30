import { sha256 } from '@noble/hashes/sha256'

export type JobState =
  | 'staging'
  | 'ready'
  | 'sending'
  | 'unknown'
  | 'pending-verification'
  | 'registered'
export interface Job {
  id: string
  filename: string
  website: string
  recordKey: string
  mime: string
  state: JobState
  created: number
  sequence?: number
  size: number
  chunks: number
  hash?: string
  itemId?: string
  error?: string
}
export interface ByteProof {
  jobId: string
  itemId: string
  marker: string
  size: number
  sha256: string
  originalFile: true
}
export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export const marker = (job: Job) => `PFD:${job.id}:${job.hash}`
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
const committed = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () =>
      reject(tx.error || new Error('Queue transaction aborted'))
    tx.onerror = () => {} // onabort is the definitive failure
  })

// Extension-origin storage. No authentication material is stored here.
export class DurableQueue {
  constructor(
    private db: IDBDatabase,
    public readonly capacity = 1024 ** 3,
  ) {}
  static async open(name = 'PFD-durable-queue', capacity = 1024 ** 3) {
    const r = indexedDB.open(name, 1)
    r.onupgradeneeded = () => {
      r.result.createObjectStore('jobs', { keyPath: 'id' })
      r.result.createObjectStore('chunks', { keyPath: ['id', 'index'] })
      r.result.createObjectStore('meta')
    }
    return new DurableQueue(await request(r), capacity)
  }
  close() {
    this.db.close()
  }
  async get(id: string): Promise<Job | undefined> {
    return request(this.db.transaction('jobs').objectStore('jobs').get(id))
  }
  async list(): Promise<Job[]> {
    const jobs: Job[] = await request(
      this.db.transaction('jobs').objectStore('jobs').getAll(),
    )
    return jobs.sort(
      (a, b) =>
        (a.sequence ?? Number.MAX_SAFE_INTEGER) -
          (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
        a.created - b.created ||
        a.id.localeCompare(b.id),
    )
  }
  async begin(meta: Pick<Job, 'filename' | 'website' | 'recordKey' | 'mime'>) {
    const id = hex(sha256(new TextEncoder().encode(meta.recordKey)))
    const tx = this.db.transaction('jobs', 'readwrite', {
        durability: 'strict',
      }),
      done = committed(tx)
    const store = tx.objectStore('jobs')
    const existing: Job | undefined = await request(store.get(id))
    const job = existing || {
      ...meta,
      id,
      state: 'staging' as const,
      created: Date.now(),
      size: 0,
      chunks: 0,
    }
    if (!existing) store.add(job)
    await done
    return job
  }
  async append(id: string, index: number, bytes: Uint8Array) {
    if (bytes.length > 256 * 1024)
      throw new Error('Queue chunk exceeds 256 KiB memory budget')
    const tx = this.db.transaction(['jobs', 'chunks', 'meta'], 'readwrite', {
        durability: 'strict',
      }),
      done = committed(tx)
    const jobs = tx.objectStore('jobs'),
      chunks = tx.objectStore('chunks'),
      meta = tx.objectStore('meta')
    try {
      const job: Job = await request(jobs.get(id))
      if (!job || job.state !== 'staging' || index !== job.chunks)
        throw new Error('Invalid staging sequence')
      const used: number = (await request(meta.get('used'))) || 0
      if (used + bytes.length > this.capacity)
        throw new Error(
          'Queue full: accepted files retained; acquisition paused',
        )
      chunks.add({ id, index, blob: new Blob([new Uint8Array(bytes)]) })
      job.size += bytes.length
      job.chunks++
      jobs.put(job)
      meta.put(used + bytes.length, 'used')
    } catch (e) {
      tx.abort()
      await done.catch(() => {})
      throw e
    }
    await done // never acknowledge a request before the transaction commits
  }
  async *bytes(job: Job) {
    for (let index = 0; index < job.chunks; index++) {
      const row = await request(
        this.db
          .transaction('chunks')
          .objectStore('chunks')
          .get([job.id, index]),
      )
      if (!row)
        throw new Error(
          'Durable queue bytes missing; retain metadata for recovery',
        )
      yield new Uint8Array(await row.blob.arrayBuffer())
    }
  }
  async accept(id: string, expectedSize: number, expectedHash?: string) {
    const job = await this.get(id)
    if (!job) throw new Error('Missing staging job')
    if (job.state !== 'staging') return job
    if (job.size !== expectedSize) throw new Error('Incomplete acquisition')
    const hash = sha256.create()
    for await (const bytes of this.bytes(job)) hash.update(bytes)
    const digest = hex(hash.digest())
    if (expectedHash && digest !== expectedHash)
      throw new Error(
        'Source changed during resumed acquisition; staging bytes retained',
      )
    const tx = this.db.transaction(['jobs', 'meta'], 'readwrite', {
        durability: 'strict',
      }),
      done = committed(tx)
    const store = tx.objectStore('jobs'),
      meta = tx.objectStore('meta')
    const current: Job = await request(store.get(id))
    if (current.state !== 'staging') {
      await done
      return current
    }
    if (current.size !== job.size || current.chunks !== job.chunks) {
      tx.abort()
      await done.catch(() => {})
      throw new Error('Staging changed while hashing')
    }
    const sequence: number = ((await request(meta.get('sequence'))) || 0) + 1
    Object.assign(current, { state: 'ready', hash: digest, sequence })
    store.put(current)
    meta.put(sequence, 'sequence')
    await done
    return current
  }
  async update(id: string, patch: Partial<Job>) {
    const tx = this.db.transaction('jobs', 'readwrite', {
        durability: 'strict',
      }),
      done = committed(tx)
    const store = tx.objectStore('jobs'),
      job: Job = await request(store.get(id))
    if (!job) {
      tx.abort()
      await done.catch(() => {})
      throw new Error('Unknown job')
    }
    Object.assign(job, patch)
    store.put(job)
    await done
    return job
  }
  async recover() {
    for (const job of await this.list())
      if (job.state === 'sending')
        await this.update(job.id, {
          state: 'unknown',
          error: 'Worker stopped during request; reconciliation required',
        })
  }
  async take(id: string) {
    const tx = this.db.transaction('jobs', 'readwrite', {
        durability: 'strict',
      }),
      done = committed(tx)
    const store = tx.objectStore('jobs'),
      jobs: Job[] = await request(store.getAll())
    const unfinished = jobs
      .filter((j) => ['ready', 'unknown', 'sending'].includes(j.state))
      .sort((a, b) => a.sequence! - b.sequence!)
    const first = unfinished[0]
    if (!first || first.id !== id || first.state !== 'ready') {
      await done
      return false
    }
    first.state = 'sending'
    store.put(first)
    await done
    return true
  }
  async verify(proof: ByteProof, cleanup = false) {
    const job = await this.get(proof.jobId)
    if (
      !job ||
      !['pending-verification', 'unknown'].includes(job.state) ||
      !proof.originalFile ||
      !proof.itemId ||
      proof.marker !== marker(job) ||
      proof.size !== job.size ||
      proof.sha256 !== job.hash ||
      (job.itemId && job.itemId !== proof.itemId)
    )
      throw new Error('Exact original-file proof required')
    const tx = this.db.transaction(['jobs', 'chunks', 'meta'], 'readwrite', {
        durability: 'strict',
      }),
      done = committed(tx)
    const current: Job = await request(tx.objectStore('jobs').get(job.id))
    if (
      !['pending-verification', 'unknown'].includes(current.state) ||
      current.hash !== proof.sha256 ||
      (current.itemId && current.itemId !== proof.itemId)
    ) {
      tx.abort()
      await done.catch(() => {})
      throw new Error('Proof was superseded')
    }
    // This API is for a trusted verifier adapter, never an untrusted tab message.
    job.state = 'registered'
    job.itemId = proof.itemId
    job.error = undefined
    if (cleanup) {
      const meta = tx.objectStore('meta'),
        used: number = (await request(meta.get('used'))) || 0
      for (let index = 0; index < job.chunks; index++)
        tx.objectStore('chunks').delete([job.id, index])
      meta.put(used - job.size, 'used')
    }
    tx.objectStore('jobs').put(job)
    await done
  }
}

export interface DeliveryAdapter {
  prepare?(job: Job): Promise<void>
  // Fresh lookup by exact job marker; multiple candidates require manual resolution.
  reconcile(job: Job): Promise<{ itemId: string } | undefined>
  submit(job: Job, bytes: AsyncIterable<Uint8Array>): Promise<void>
}
export class Delivery {
  private running = false
  constructor(
    private queue: DurableQueue,
    private adapter: DeliveryAdapter,
  ) {}
  async run() {
    if (this.running) return
    this.running = true
    try {
      for (const job of await this.queue.list()) {
        if (job.state === 'unknown') {
          const found = await this.adapter.reconcile(job)
          if (!found) return // absence does not prove the prior request was rejected
          await this.queue.update(job.id, {
            state: 'pending-verification',
            itemId: found.itemId,
          })
        } else if (job.state === 'ready') {
          const found = await this.adapter.reconcile(job) // before every first submission
          if (found) {
            await this.queue.update(job.id, {
              state: 'pending-verification',
              itemId: found.itemId,
            })
            continue
          }
          await this.adapter.prepare?.(job)
          if (!(await this.queue.take(job.id))) return
          try {
            await this.adapter.submit(job, this.queue.bytes(job))
            await this.queue.update(job.id, { state: 'pending-verification' })
          } catch (e) {
            await this.queue.update(job.id, {
              state: 'unknown',
              error: String(e),
            })
            return
          }
        } else if (job.state === 'sending') return
        // Retained, acknowledged jobs do not prevent delivery of later accepted jobs.
      }
    } finally {
      this.running = false
    }
  }
}

// Read-only adapter for a future Eagle plugin integration. Not installed,
// exposed over HTTP, or accepted from browser tabs by this extension.
const { createHash } = require('node:crypto')
const { open, stat } = require('node:fs/promises')
async function verifyEagleOriginal(eagle, job, itemId) {
  const marker = `PFD:${job.id}:${job.hash}`
  const item = await eagle.item.getById(itemId)
  if (!item || item.id !== itemId || item.isDeleted || item.annotation !== marker || item.url !== job.website || !item.filePath)
    throw new Error('Eagle candidate identity mismatch')
  const file = await open(item.filePath, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== job.size) throw new Error('Original file incomplete')
    const hash = createHash('sha256'); let size = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) { hash.update(chunk); size += chunk.length }
    const after = await file.stat(), digest = hash.digest('hex')
    const fresh = await eagle.item.getById(itemId)
    const currentFile = await stat(item.filePath)
    if (size !== job.size || digest !== job.hash || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      currentFile.ino !== after.ino || currentFile.dev !== after.dev || currentFile.size !== after.size || currentFile.mtimeMs !== after.mtimeMs ||
      !fresh || fresh.id !== itemId || fresh.isDeleted || fresh.filePath !== item.filePath || fresh.annotation !== marker || fresh.url !== job.website)
      throw new Error('Original bytes not verified')
    return { jobId: job.id, itemId, marker, size, sha256: digest, originalFile: true }
  } finally { await file.close() }
}
module.exports = { verifyEagleOriginal }

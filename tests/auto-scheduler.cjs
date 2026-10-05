// Run with: node --test tests/auto-scheduler.cjs
// Chrome, FANBOX, Eagle and ntfy are simulated; no browser or network is used.
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { test } = require('node:test')
const ts = require('typescript')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000
const profile = (creatorId = 'a', extra = {}) => ({
  creatorId,
  name: creatorId,
  free: true,
  pay: true,
  minFee: null,
  maxFee: 500,
  since: NOW - DAY,
  ...extra,
})
const post = (postId = '1', creatorId = 'a', extra = {}) => ({
  creatorId,
  postId,
  fee: 500,
  ...extra,
})
const held = (postId = '1', creatorId = 'a', extra = {}) =>
  post(postId, creatorId, {
    restricted: true,
    retryAfter: NOW + DAY,
    ...extra,
  })

function compile(name) {
  return ts.transpileModule(
    readFileSync(path.join(__dirname, '../src/ts/auto', name + '.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText
}
const typesCode = compile('AutoTypes')
const schedulerCode = compile('AutoScheduler')

function harness(initial = {}) {
  let now = NOW
  let nextTabId = 1
  const store = structuredClone({
    autoCreatorProfiles: [profile()],
    autoPendingPosts: [],
    ...initial,
  })
  const tabs = new Map()
  const starts = []
  const notifications = []
  let listener
  const h = {
    store,
    tabs,
    starts,
    notifications,
    scan: async () => ({ posts: [] }),
    eagle: async () => ({ ok: true, json: async () => ({}) }),
  }
  const copy = structuredClone
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const snapshot = Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).map((key) => [
              key,
              store[key],
            ]),
          )
          await Promise.resolve()
          return copy(snapshot)
        },
        async set(values) {
          Object.assign(store, copy(values))
          await Promise.resolve()
        },
        async remove(key) {
          delete store[key]
          await Promise.resolve()
        },
      },
    },
    tabs: {
      async create(options) {
        const tab = { id: nextTabId++, status: 'complete', ...options }
        tabs.set(tab.id, tab)
        return copy(tab)
      },
      async get(id) {
        if (!tabs.has(id)) throw new Error('Missing simulated tab')
        return copy(tabs.get(id))
      },
      async remove(id) {
        tabs.delete(id)
      },
      async sendMessage(id, message) {
        if (message.msg === 'auto_scan') return h.scan(copy(message))
        assert.equal(message.msg, 'auto_start')
        starts.push(copy(message))
        return { accepted: true }
      },
    },
    runtime: {
      onMessage: {
        addListener(fn) {
          listener = fn
        },
      },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
    },
    alarms: {
      onAlarm: { addListener() {} },
      async get() {
        return {}
      },
      create() {},
    },
  }
  const typesContext = { exports: {} }
  vm.runInNewContext(typesCode, typesContext)
  const context = vm.createContext({
    exports: {},
    chrome,
    Date: class extends Date {
      static now() {
        return now
      }
    },
    setTimeout: (fn) => queueMicrotask(fn),
    console: { error() {}, warn() {} },
    fetch: (...args) => h.eagle(...args),
    require(name) {
      if (name === './AutoTypes') return typesContext.exports
      if (name === './Ntfy')
        return {
          notifyAutoPost: async (...args) => notifications.push(copy(args)),
        }
      throw new Error('Unexpected dependency: ' + name)
    },
  })
  vm.runInContext(
    schedulerCode +
      '\nglobalThis.api = { startNextPost, finishPost, runAutoCheck, scanProfiles };',
    context,
  )
  Object.assign(h, context.api, {
    setTime(value) {
      now = value
    },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve))
    },
    message(message) {
      return new Promise((resolve) =>
        assert.equal(listener(message, {}, resolve), true),
      )
    },
    async finish(extra = {}) {
      const active = copy(store.autoActivePost)
      assert.ok(active, 'A post must be running')
      await h.finishPost({
        ...active.task,
        startedAt: active.startedAt,
        success: false,
        ...extra,
      })
      await h.settle()
    },
  })
  return h
}

test('restriction persists without notification and the next free post proceeds', async () => {
  const h = harness({ autoPendingPosts: [post(), post('2', 'a', { fee: 0 })] })
  await h.startNextPost()
  await h.finish({ skipped: true })
  assert.deepEqual(h.store.autoPendingPosts[0], held())
  assert.equal(h.store.autoActivePost.task.postId, '2')
  assert.equal(h.notifications.length, 0)
  assert.equal(h.starts.length, 2)
})

test('restart retains the hold; hourly checks wait 24 hours, then retry', async () => {
  const before = harness({ autoPendingPosts: [post()] })
  await before.startNextPost()
  await before.finish({ skipped: true })
  const h = harness(before.store)
  h.setTime(NOW + DAY - 1)
  await h.runAutoCheck()
  assert.equal(h.starts.length, 0)
  h.setTime(NOW + DAY)
  await h.runAutoCheck()
  assert.equal(h.starts.length, 1)
  await h.finish({ skipped: true })
  assert.equal(h.store.autoPendingPosts[0].retryAfter, NOW + DAY * 2)
  assert.equal(h.notifications.length, 0)
})

test('manual retry only releases eligible holds for the selected creator', async () => {
  const h = harness({
    autoCreatorProfiles: [profile(), profile('b')],
    autoPendingPosts: [
      held(),
      held('2', 'b'),
      held('3', 'a', { fee: 1000 }),
      post('4', 'a', { retryAfter: NOW + HOUR }),
    ],
  })
  const response = await h.message({
    msg: 'auto_retry_restricted',
    creatorId: 'a',
  })
  await h.settle()
  assert.equal(response.count, 1)
  assert.equal(h.starts[0].postId, '1')
  assert.equal(
    h.store.autoPendingPosts.find((p) => p.postId === '2').retryAfter,
    NOW + DAY,
  )
  assert.equal(
    h.store.autoPendingPosts.find((p) => p.postId === '4').retryAfter,
    NOW + HOUR,
  )
  assert.ok(!h.store.autoPendingPosts.some((p) => p.postId === '3'))
})

test('success after rejoining clears the hold and preserves notification details', async () => {
  const h = harness({ autoPendingPosts: [held()] })
  await h.message({ msg: 'auto_retry_restricted', creatorId: 'a' })
  await h.settle()
  await h.finish({ success: true, creatorName: 'Creator', postTitle: 'Post' })
  assert.deepEqual(h.store.autoPendingPosts, [])
  assert.equal(h.notifications.length, 1)
  assert.equal(h.notifications[0][1], true)
  assert.equal(h.notifications[0][2].creatorName, 'Creator')
  assert.equal(h.notifications[0][2].postTitle, 'Post')
})

test('ordinary failure still notifies and retries after one hour', async () => {
  const h = harness({ autoPendingPosts: [held('1', 'a', { retryAfter: 0 })] })
  await h.startNextPost()
  await h.finish()
  assert.equal(h.store.autoPendingPosts[0].retryAfter, NOW + HOUR)
  assert.equal(h.store.autoPendingPosts[0].restricted, false)
  assert.equal(h.notifications[0][1], false)
  h.setTime(NOW + HOUR - 1)
  await h.startNextPost()
  assert.equal(h.starts.length, 1)
  h.setTime(NOW + HOUR)
  await h.startNextPost()
  assert.equal(h.starts.length, 2)
})

test('saving paid-off, price limits and removal prunes only excluded posts and preserves cursor', async () => {
  const h = harness({
    autoCreatorProfiles: [profile(), profile('b'), profile('c')],
    autoPendingPosts: [
      held(),
      post('2', 'a', { fee: 0 }),
      held('3', 'b'),
      held('4', 'b', { fee: 1000 }),
      held('5', 'c'),
    ],
  })
  const response = await h.message({
    msg: 'auto_save_profiles',
    profiles: [
      profile('a', { pay: false, since: 1 }),
      profile('b'),
      profile('new', { since: 1 }),
    ],
  })
  assert.equal(response.profiles[0].since, NOW - DAY)
  assert.equal(response.profiles[2].since, NOW)
  assert.deepEqual(
    h.store.autoPendingPosts.map((p) => p.postId),
    ['2', '3'],
  )
  assert.equal(
    (await h.message({ msg: 'auto_retry_restricted', creatorId: 'a' })).count,
    0,
  )
  await h.settle()
  assert.ok(h.starts.every((s) => s.postId === '2'))
})

test('Eagle unavailable keeps a manually released hold for the next check', async () => {
  const h = harness({
    autoPendingPosts: [held()],
    fanboxSetting: { saveToEagle: true },
  })
  h.eagle = async () => {
    throw new Error('Eagle is closed')
  }
  await h.message({ msg: 'auto_retry_restricted', creatorId: 'a' })
  await h.settle()
  assert.equal(h.starts.length, 0)
  assert.equal(h.store.autoPendingPosts[0].retryAfter, 0)
  assert.equal(h.notifications.length, 0)
  h.eagle = async () => ({ ok: true, json: async () => ({}) })
  await h.startNextPost()
  assert.equal(h.starts.length, 1)
})

test('repeat clicks do not start duplicate work or release the active hold', async () => {
  const h = harness({ autoPendingPosts: [held()] })
  await Promise.all([
    h.message({ msg: 'auto_retry_restricted', creatorId: 'a' }),
    h.message({ msg: 'auto_retry_restricted', creatorId: 'a' }),
  ])
  await h.settle()
  assert.equal(h.starts.length, 1)
  assert.equal(
    (await h.message({ msg: 'auto_retry_restricted', creatorId: 'a' })).count,
    0,
  )
  await h.finish({ skipped: true })
  assert.equal(h.store.autoPendingPosts[0].retryAfter, NOW + DAY)
  assert.equal(h.starts.length, 1)
})

test('disabling paid posts while Eagle responds prevents their start', async () => {
  const h = harness({
    autoPendingPosts: [
      held('1', 'a', { retryAfter: 0 }),
      post('2', 'a', { fee: 0 }),
    ],
    fanboxSetting: { saveToEagle: true },
  })
  h.eagle = async () => {
    await h.message({
      msg: 'auto_save_profiles',
      profiles: [profile('a', { pay: false })],
    })
    return { ok: true, json: async () => ({}) }
  }
  await h.startNextPost()
  await h.settle()
  assert.deepEqual(
    h.starts.map((s) => s.postId),
    ['2'],
  )
})

test('scan and restriction result cannot overwrite each other', async () => {
  const h = harness({ autoPendingPosts: [post()] })
  await h.startNextPost()
  h.scan = async () => ({ posts: [post('2')] })
  await Promise.all([h.scanProfiles(), h.finish({ skipped: true })])
  await h.settle()
  assert.equal(h.store.autoPendingPosts.length, 2)
  assert.deepEqual(
    h.store.autoPendingPosts.find((p) => p.postId === '1'),
    held(),
  )
  assert.ok(h.store.autoPendingPosts.some((p) => p.postId === '2'))
  assert.equal(h.store.autoCreatorProfiles[0].since, NOW)
})

test('settings changed during a scan do not advance the cursor using old filters', async () => {
  const h = harness({ autoCreatorProfiles: [profile('a', { pay: false })] })
  h.scan = async () => {
    await h.message({ msg: 'auto_save_profiles', profiles: [profile()] })
    return { posts: [] }
  }
  await h.scanProfiles()
  assert.equal(h.store.autoCreatorProfiles[0].since, NOW - DAY)
  assert.equal(h.store.autoCreatorProfiles[0].pay, true)
  h.scan = async () => ({ posts: [post()] })
  await h.runAutoCheck()
  assert.equal(h.store.autoCreatorProfiles[0].since, NOW)
  assert.equal(h.starts[0].postId, '1')
})

test('a late restriction result cannot restore posts excluded by settings', async () => {
  const h = harness({ autoPendingPosts: [post()] })
  await h.startNextPost()
  await Promise.all([
    h.message({
      msg: 'auto_save_profiles',
      profiles: [profile('a', { pay: false })],
    }),
    h.finish({ skipped: true }),
  ])
  await h.settle()
  assert.deepEqual(h.store.autoPendingPosts, [])
  assert.equal(h.notifications.length, 0)
})

test('stale or duplicate completion messages cannot erase another task', async () => {
  const h = harness({ autoPendingPosts: [post(), post('2')] })
  await h.startNextPost()
  const active = structuredClone(h.store.autoActivePost)
  await h.finishPost({
    ...active.task,
    startedAt: active.startedAt - 1,
    success: true,
  })
  assert.equal(h.store.autoPendingPosts.length, 2)
  await h.finish({ success: true, creatorName: 'a', postTitle: 'one' })
  await h.finishPost({
    ...active.task,
    startedAt: active.startedAt,
    success: true,
  })
  assert.deepEqual(
    h.store.autoPendingPosts.map((p) => p.postId),
    ['2'],
  )
  assert.equal(h.store.autoActivePost.task.postId, '2')
  assert.equal(h.notifications.length, 1)
})

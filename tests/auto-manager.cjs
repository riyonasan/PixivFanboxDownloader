// Minimal DOM + Chrome mocks. Never opens a browser, reads auth or uses a network.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const compile = (file) => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/ts', file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const typesCode = compile('auto/AutoTypes.ts')
const managerCode = compile('InitHomePage.ts')
const profile = (extra = {}) => ({ creatorId: 'dummy', name: 'Dummy', free: true, pay: true, minFee: null, maxFee: 500, since: 1, ...extra })
const held = (extra = {}) => ({ creatorId: 'dummy', postId: 'dummy-post', fee: 500, restricted: true, retryAfter: 999999, ...extra })

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.listeners = {}
    this.style = {}
    this.disabled = false
    this.checked = false
    this.value = ''
    this.textContent = ''
  }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child) } }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = undefined }
  querySelector(selector) { return this.all().find((child) => '.' + child.className === selector) || null }
  all() { return this.children.flatMap((child) => [child, ...child.all()]) }
  addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn) }
  emit(name) { for (const fn of this.listeners[name] || []) fn({ target: this }); if (name === 'input' && this.parent) this.parent.emit(name) }
  click() { if (!this.disabled) this.emit('click') }
}

async function harness(initial = {}) {
  const store = structuredClone({ autoCreatorProfiles: [profile()], autoPendingPosts: [held()], ...initial })
  const slot = new Element('section')
  const listeners = new Set()
  const messages = []
  const alerts = []
  const types = { exports: {} }
  vm.runInNewContext(typesCode, types)
  const h = { store, slot, listeners, messages, alerts,
    respond: async (message) => message.msg === 'auto_save_profiles' ? { profiles: message.profiles } : { count: 1 },
    async settle() { await new Promise((resolve) => setImmediate(resolve)) },
    change(changes, area = 'local') { for (const fn of listeners) fn(changes, area) },
  }
  const mocks = {
    './Lang': { lang: { transl: (text) => text } },
    './Colors': { Colors: {} },
    './Tools': { Tools: { findSlot: () => slot, clearSlot: () => { slot.children = [] } } },
    './InitPageBase': { InitPageBase: class { init() {} } },
    './API': { API: { request: async () => ({ body: { creators: [{ creatorId: 'dummy', user: { name: 'Dummy' } }] } }) } },
    './EVT': { EVT: {} }, './Log': { log: {} },
    './PageType': { pageType: { type: 'following', list: { Following: 'following', Supporting: 'supporting' } } },
    './download/SaveFanCard': { saveFanCard: {} }, './auto/AutoTypes': types.exports,
  }
  const context = { exports: {}, require: (name) => { assert.ok(name in mocks, 'unexpected dependency: ' + name); return mocks[name] },
    document: { createElement: (tag) => new Element(tag), createTextNode: (text) => { const node = new Element('text'); node.textContent = text; return node } },
    window: { alert: (message) => alerts.push(message) },
    chrome: { storage: { local: { get: async () => structuredClone(store) }, onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } },
      runtime: { sendMessage: async (message) => { messages.push(structuredClone(message)); return h.respond(structuredClone(message)) } } },
    fetch: () => { throw new Error('Network forbidden') },
  }
  vm.runInNewContext(managerCode, context)
  const page = new context.exports.InitHomePage()
  const openButton = new Element('button')
  await page.showAutoManager(openButton)
  const manager = slot.querySelector('.autoCreatorManager')
  assert.ok(manager)
  const row = manager.children.find((child) => child.tagName === 'DIV')
  const inputs = row.all().filter((child) => child.tagName === 'INPUT')
  Object.assign(h, { page, openButton, manager, inputs, retry: row.all().find((child) => child.tagName === 'BUTTON'), save: manager.children.at(-1) })
  return h
}

test('new registration defaults paid off and free on', async () => {
  const h = await harness({ autoCreatorProfiles: [], autoPendingPosts: [] })
  assert.equal(h.inputs[0].checked, false)
  assert.equal(h.inputs[1].checked, true)
  assert.equal(h.inputs[2].checked, false)
  assert.equal(h.retry.disabled, true)
})

test('retry counts only matching holds for the saved creator', async () => {
  const h = await harness({ autoPendingPosts: [held(), held({ postId: 'expensive', fee: 1000 }), held({ creatorId: 'other' }), held({ restricted: false })] })
  assert.ok(h.retry.textContent.includes('1'))
  assert.equal(h.retry.disabled, false)
})

test('editing settings disables retry until saved', async () => {
  const h = await harness()
  h.inputs[2].checked = false
  h.inputs[2].emit('input')
  assert.equal(h.retry.disabled, true)
  h.retry.click()
  assert.equal(h.messages.length, 0)
})

test('save routes through scheduler and locks inputs until acknowledged', async () => {
  const h = await harness()
  let resolve
  h.respond = (message) => message.msg === 'auto_save_profiles' ? new Promise((done) => resolve = () => done({ profiles: message.profiles })) : Promise.resolve({})
  h.save.click()
  assert.equal(h.save.disabled, true)
  assert.ok(h.inputs.every((input) => input.disabled))
  assert.equal(h.retry.disabled, true)
  assert.equal(h.messages[0].msg, 'auto_save_profiles')
  resolve()
  await h.settle()
  assert.equal(h.save.disabled, false)
  assert.ok(h.inputs.every((input) => !input.disabled))
  assert.equal(h.retry.disabled, false)
  assert.equal(h.messages[1].msg, 'auto_check_now')
})

test('failed save keeps retry disabled and restores inputs', async () => {
  const h = await harness()
  h.respond = async () => { throw new Error('dummy-save-failure') }
  h.save.click()
  await h.settle()
  assert.equal(h.retry.disabled, true)
  assert.equal(h.save.disabled, false)
  assert.ok(h.inputs.every((input) => !input.disabled))
  assert.ok(h.alerts[0].includes('dummy-save-failure'))
})

test('manual retry uses selected creator and prevents duplicate clicks', async () => {
  const h = await harness()
  let resolve
  h.respond = () => new Promise((done) => resolve = () => done({ count: 1 }))
  h.retry.click()
  h.retry.click()
  assert.deepEqual(h.messages, [{ msg: 'auto_retry_restricted', creatorId: 'dummy' }])
  assert.equal(h.retry.disabled, true)
  resolve()
  await h.settle()
  assert.equal(h.retry.disabled, false)
  assert.ok(h.alerts[0].includes('1'))
})

test('storage events update pending counts and apply current saved filters', async () => {
  const h = await harness()
  h.change({ autoPendingPosts: { newValue: [] } }, 'sync')
  assert.equal(h.retry.disabled, false)
  h.change({ autoPendingPosts: { newValue: [] } })
  assert.equal(h.retry.disabled, true)
  h.change({ autoPendingPosts: { newValue: [held()] }, autoCreatorProfiles: { newValue: [profile({ pay: false })] } })
  assert.equal(h.retry.disabled, true)
})

test('closing manager and destroying page remove storage listeners', async () => {
  const h = await harness()
  assert.equal(h.listeners.size, 1)
  await h.page.showAutoManager(h.openButton)
  assert.equal(h.listeners.size, 0)
  assert.equal(h.slot.querySelector('.autoCreatorManager'), null)
  await h.page.showAutoManager(h.openButton)
  assert.equal(h.listeners.size, 1)
  h.page.destroy()
  assert.equal(h.listeners.size, 0)
  assert.equal(h.slot.children.length, 0)
})

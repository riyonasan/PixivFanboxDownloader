// No Chrome, FANBOX, Eagle, ntfy or real network. Exercise browser transfer semantics.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/ts/spool/SpoolClient.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const file = { postId: '123', fileId: 'file:abc', fileName: 'test.bin', expectedSize: 5,
  url: 'https://downloads.fanbox.cc/files/post/123/abc.bin' }
const receipt = { receiptId: 'b'.repeat(64), state: 'saved', eagleState: 'not_submitted',
  size: 5, sha256: 'c'.repeat(64), fileName: 'test.bin' }
const uploadId = 'a'.repeat(32)

function harness(options = {}) {
  const calls = []
  let offset = 0
  const persisted = []
  const context = { exports: {}, Uint8Array, ArrayBuffer, URL, AbortSignal,
    chrome: { runtime: { getURL: (name) => 'chrome-extension://test/' + name }, storage: { local: {
      get: async () => options.unconfigured ? {} : { spoolProofToken: 't'.repeat(40) },
      set: async (value) => persisted.push(value),
    } } },
    fetch: async (url, init) => {
      calls.push({ url, init })
      if (url === 'chrome-extension://test/spool-proof-local.json') {
        return { ok: !options.noProvisioning, json: async () => ({ token: options.badToken || 't'.repeat(40) }) }
      }
      if (url === (options.sourceURL || file.url)) {
        if (options.sourceError) throw new Error('source failure')
        const data = options.bytes || new Uint8Array([1, 2, 3, 4, 5])
        let read = false
        return { ok: !options.sourceStatus || options.sourceStatus === 200, status: options.sourceStatus || 200, headers: { get: (name) => name === 'content-type'
          ? (options.mime || 'application/octet-stream') : (options.noLength ? null : String(data.length)) },
          body: { cancel: async () => {}, getReader: () => ({ read: async () => {
            if (read) return { done: true }
            read = true
            return { done: false, value: data }
          }, cancel: async () => {} }) } }
      }
      assert.ok(url.startsWith('http://127.0.0.1:18096/'))
      assert.equal(init.credentials, 'omit')
      assert.equal(init.headers.Authorization, 'Bearer ' + 't'.repeat(40))
      if (options.offline) throw new Error('offline')
      if (url.endsWith('/v1/uploads')) {
        const metadata = JSON.parse(init.body)
        assert.deepEqual(Object.keys(metadata).sort(), options.production
          ? ['expectedSize', 'fileId', 'fileName', 'postId', 'registration'] : ['expectedSize', 'fileId', 'fileName', 'postId'])
        assert.ok(!init.body.includes('downloads.fanbox.cc'))
        offset = 0
        return { ok: true, json: async () => options.duplicate ||
          { state: 'uploading', uploadId, chunkSize: 1048576, maxSize: options.production ? 2 ** 40 : 67108864 } }
      }
      if (init.method === 'PUT') {
        assert.equal(Number(init.headers['X-Offset']), offset)
        assert.ok(init.body.byteLength <= 1048576)
        offset += init.body.byteLength
        return { ok: !options.chunkFailure, status: 507, json: async () => ({ offset: options.badOffset ? 999 : offset }) }
      }
      assert.ok(url.endsWith('/commit'))
      const size = JSON.parse(init.body).size
      assert.equal(size, offset)
      return { ok: true, json: async () => options.badReceipt || { ...receipt, size, eagleState: options.production ? 'pending' : receipt.eagleState } }
    } }
  vm.runInNewContext(code, context)
  return { save: context.exports.saveProofFile, spool: context.exports.saveSpoolFile, calls, persisted }
}

const productionFile = () => ({ ...file, registration: { fileName:'FANBOX/作者/投稿-001.png', website:'https://www.fanbox.cc/@creator/posts/123', tags:[] } })
test('FIFO receipt means saved and pending; authenticated browser fetch never calls Eagle', async () => {
  const h = harness({production:true})
  const sizes = []
  assert.equal((await h.spool(productionFile(),async size=>{sizes.push(size)})).eagleState,'pending')
  assert.deepEqual(sizes,[5])
  assert.ok(h.calls.every(call => !call.url.includes('41595')))
  assert.equal(h.calls.find(call => call.url === file.url).init.credentials,'include')
})

test('production cover uses the existing pixiv CDN with matching post and manifest permission', async () => {
  const sourceURL='https://pixiv.pximg.net/fanbox/public/images/post/123/cover/abc.jpeg'
  const h=harness({production:true,sourceURL,mime:'image/jpeg'})
  await h.spool({...productionFile(),fileId:'image:cover',url:sourceURL})
  assert.equal(h.calls.find(call=>call.url===sourceURL).init.credentials,'include')
  for(const name of ['src','dist']) {
    const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,`../${name}/manifest.json`),'utf8'))
    assert.ok(manifest.host_permissions.includes('https://pixiv.pximg.net/*'))
  }
})

test('cover allowance rejects other posts, other CDN paths and ordinary attachments', async () => {
  const sourceURL='https://pixiv.pximg.net/fanbox/public/images/post/123/cover/abc.jpeg'
  for(const changes of [
    {postId:'124'}, {fileId:'image:abc'},
    {url:'https://pixiv.pximg.net/unrelated/abc.jpeg'},
    {url:'https://pixiv.pximg.net/fanbox/public/images/post/123/cover/abc.jpeg?other=1'},
  ]) {
    const h=harness({production:true,sourceURL})
    await assert.rejects(h.spool({...productionFile(),fileId:'image:cover',url:sourceURL,...changes}))
    assert.equal(h.calls.length,0)
  }
})

test('background adds newly fetched bytes to the existing daily total before save success', async () => {
  const background=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/ts/spool/SpoolBackground.ts'),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText
  let listener
  let duplicate=false
  const totals=[]
  const messages=[]
  const dependencies={
    './SpoolClient':{SpoolAuthError:class extends Error{},saveSpoolFile:async(_file,fetched)=>{
      if(!duplicate) await fetched(5)
      return {...receipt,eagleState:'done'}
    }},
    './SpoolRuntime':{localSpoolConfig:async()=>({role:'collector'}),notifySpoolAuthentication:async()=>{}},
    '../TotalDownload':{totalDownload:{addDownload:bytes=>totals.push(bytes)}},
  }
  vm.runInNewContext(background,{exports:{},URL,require:name=>dependencies[name],chrome:{
    runtime:{id:'extension',onMessage:{addListener:fn=>{listener=fn}}},
    storage:{local:{get:async()=>({spoolCollectionEnabled:true})}},
    tabs:{sendMessage:async(_id,message)=>messages.push(message)},
  }})
  const save=()=>new Promise(resolve=>assert.equal(listener({msg:'spool_save',file:productionFile(),id:'abc',taskBatch:1,originalURL:file.url},
    {id:'extension',frameId:0,tab:{id:9},url:'https://www.fanbox.cc/@creator/posts/123'},resolve),true))
  assert.ok((await save()).receipt)
  duplicate=true
  assert.ok((await save()).receipt)
  assert.deepEqual(totals,[5])
  assert.equal(messages.length,2)
})
test('simultaneous download threads are serialized without losing either save', async () => {
  const h = harness({production:true})
  const result = await Promise.all([h.spool(productionFile()),h.spool(productionFile())])
  assert.equal(result.length,2)
  assert.equal(h.calls.filter(call => call.url.endsWith('/commit')).length,2)
})
test('saved duplicate does not report authentication recovery without fetching', async () => {
  const h = harness({production:true,duplicate:{...receipt,eagleState:'done'}})
  let authenticated = 0
  assert.equal((await h.spool(productionFile(),async()=>{authenticated++})).eagleState,'done')
  assert.equal(authenticated,0)
  assert.equal(h.calls.length,1)
})
test('authentication rejection cannot become a saved receipt', async () => {
  const h = harness({production:true,sourceStatus:403})
  await assert.rejects(h.spool(productionFile()),/認証/)
  assert.ok(h.calls.every(call=>!call.url.endsWith('/commit')))
})
test('generated text has a stable typed file ID and browser-owned data URL', async () => {
  const sourceURL = 'data:text/plain;charset=utf-8;base64,aGVsbG8='
  const h = harness({production:true,sourceURL})
  await h.spool({...productionFile(),fileId:'file:text-txt',url:sourceURL})
  const sent = JSON.parse(h.calls.find(call=>call.url.endsWith('/v1/uploads')).init.body)
  assert.equal(sent.fileId,'file:text-txt')
  assert.ok(!JSON.stringify(sent).includes('aGVsbG8'))
})

test('authenticated source fetch and separate durable receipt without source URL transmission', async () => {
  const h = harness()
  assert.deepEqual(JSON.parse(JSON.stringify(await h.save(file))), receipt)
  assert.equal(h.calls.find((call) => call.url === file.url).init.credentials, 'include')
  assert.ok(h.calls.every((call) => !call.url.includes('41595')))
})

test('saved duplicate is verified without redownloading', async () => {
  const h = harness({ duplicate: receipt })
  await h.save(file)
  assert.equal(h.calls.length, 1)
})

test('private same-machine provisioning avoids manual credential transfer', async () => {
  const h = harness({ unconfigured: true })
  await h.save(file)
  assert.deepEqual(JSON.parse(JSON.stringify(h.persisted)), [{ spoolProofToken: 't'.repeat(40) }])
  assert.equal(h.calls[0].url, 'chrome-extension://test/spool-proof-local.json')
})

for (const options of [{ noProvisioning: true }, { badToken: 'invalid' }]) {
  test('missing or invalid local provisioning cannot start a transfer: ' + JSON.stringify(options), async () => {
    const h = harness({ unconfigured: true, ...options })
    await assert.rejects(h.save(file))
    assert.equal(h.calls.length, 1)
    assert.equal(h.persisted.length, 0)
  })
}

test('chunks stay bounded for larger source chunks', async () => {
  const bytes = new Uint8Array(2500000)
  const h = harness({ bytes })
  assert.equal((await h.save({ ...file, expectedSize: bytes.length })).size, bytes.length)
  assert.equal(h.calls.filter((call) => call.init.method === 'PUT').length, 3)
})

test('offline helper prevents starting authenticated download', async () => {
  const h = harness({ offline: true })
  await assert.rejects(h.save(file))
  assert.equal(h.calls.length, 1)
})

for (const options of [{ sourceError: true }, { chunkFailure: true }, { badOffset: true }]) {
  test('failed transfer never commits: ' + JSON.stringify(options), async () => {
    const h = harness(options)
    await assert.rejects(h.save(file))
    assert.ok(h.calls.every((call) => !call.url.endsWith('/commit')))
  })
}

test('missing content length still enforces API size at end of stream', async () => {
  const h = harness({ noLength: true })
  await assert.rejects(h.save({ ...file, expectedSize: 6 }))
  assert.ok(h.calls.every((call) => !call.url.endsWith('/commit')))
})

test('invalid commit receipt is never treated as success', async () => {
  const h = harness({ badReceipt: { ...receipt, eagleState: 'done' } })
  await assert.rejects(h.save(file))
})

for (const changes of [{ url: 'https://evil.invalid/file' }, { url: 'blob:example' },
  { postId: '../123' }, { fileId: 'file:../../other' }, { expectedSize: 67108865 }]) {
  test('invalid input rejected before any request: ' + JSON.stringify(changes), async () => {
    const h = harness()
    await assert.rejects(h.save({ ...file, ...changes }))
    assert.equal(h.calls.length, 0)
  })
}

test('failed run releases the single-proof lock for retry', async () => {
  const h = harness({ offline: true })
  await assert.rejects(h.save(file))
  await assert.rejects(h.save(file), /offline/)
})

test('image response must be an image before sending any file bytes', async () => {
  const h = harness({ mime: 'text/html' })
  await assert.rejects(h.save({ ...file, fileId: 'image:abc', expectedSize: null }))
  assert.ok(h.calls.every((call) => call.init.method !== 'PUT' && !call.url.endsWith('/commit')))
})

test('valid image response is accepted', async () => {
  const h = harness({ mime: 'image/jpeg' })
  assert.equal((await h.save({ ...file, fileId: 'image:abc', expectedSize: null })).state, 'saved')
})

const panelCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/ts/spool/SpoolProof.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function panelHarness(data) {
  const nodes = new Map()
  for (const id of ['spoolProofList', 'spoolProofSave', 'spoolProofFile', 'spoolProofStatus', 'spoolProofOptions']) {
    nodes.set('#' + id, { disabled: id === 'spoolProofSave', value: '0', textContent: '', children: [], listeners: {},
      addEventListener(name, listener) { this.listeners[name] = listener },
      replaceChildren() { this.children = [] }, append(child) { this.children.push(child) } })
  }
  const sent = []
  const location = { pathname: '/@creator/posts/123' }
  vm.runInNewContext(panelCode, { exports: {}, location,
    require(name) {
      if (name === './SpoolPanel') return {}
      assert.equal(name, '../API')
      return { API: { getPost: async () => data } }
    },
    document: { querySelector: (id) => nodes.get(id), createElement: () => ({}) },
    chrome: { runtime: { sendMessage: async (message) => { sent.push(message); return { receipt } } } },
  })
  return { nodes, sent, location }
}

const post = { id: '123', type: 'file', body: { files: [
  { id: 'abc', name: 'test', extension: 'bin', size: 5, url: file.url },
] } }

for (const [shape, data] of [['body.post', { body: { post } }], ['body', { body: post }]]) {
  test('proof UI lists and saves a selected attachment with API shape ' + shape, async () => {
    const h = panelHarness(data)
    await h.nodes.get('#spoolProofList').listeners.click()
    assert.equal(h.nodes.get('#spoolProofSave').disabled, false)
    assert.equal(h.nodes.get('#spoolProofFile').children.length, 1)
    await h.nodes.get('#spoolProofSave').listeners.click()
    assert.equal(h.sent.length, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(h.sent[0])), { msg: 'spool_proof_save', file })
    assert.match(h.nodes.get('#spoolProofStatus').textContent, /Eagle未登録/)
  })
}

test('restricted post cannot enable the save action', async () => {
  const h = panelHarness({ body: { ...post, body: null, isRestricted: true } })
  await h.nodes.get('#spoolProofList').listeners.click()
  assert.equal(h.nodes.get('#spoolProofSave').disabled, true)
  assert.equal(h.sent.length, 0)
})

test('SPA navigation prevents saving an attachment from the previous post', async () => {
  const h = panelHarness({ body: post })
  await h.nodes.get('#spoolProofList').listeners.click()
  h.location.pathname = '/@creator/posts/456'
  await h.nodes.get('#spoolProofSave').listeners.click()
  assert.equal(h.sent.length, 0)
  assert.match(h.nodes.get('#spoolProofStatus').textContent, /投稿が変わりました/)
})

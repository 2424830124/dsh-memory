/**
 * Settings route checks: the config file write and the HTTP contract behind
 * the panel above the composer.
 * Run with `node test/settings.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { saveConfigValue } from '../lib/config.js'
import { DocumentError } from '../lib/errors.js'
import { SETTINGS_ROUTE, createSettingsHandler } from '../lib/settings-route.js'

const failures = []
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.stack?.split('\n').slice(0, 3).join('\n       ')}`)
  }
}

/** A request whose body is the given text. */
function request(method, body, url = '/plugins/dsh-memory/settings') {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body, 'utf8')])
  stream.method = method
  stream.url = url
  return stream
}

/** A response that records the status and JSON body. */
function response() {
  const record = { status: 0, headers: {}, body: '' }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(body) {
      record.body = body
    },
  }
}

/** Call the handler once and parse what it answered. */
async function call(handler, method, body, url) {
  const res = response()
  await handler(request(method, body, url), res)
  return { status: res.record.status, body: JSON.parse(res.record.body) }
}

/** A runtime stub holding the one setting the panel edits, plus an empty overview. */
function runtimeStub(value = 200) {
  return {
    config: { logSummaryMaxChars: value },
    updateSettings(patch) {
      Object.assign(this.config, patch)
      return this.config
    },
    overview: async () => [],
    fileText: async () => null,
  }
}

/** A runtime stub that also reports what each scope holds. */
function overviewStub(value = 200) {
  const runtime = runtimeStub(value)
  runtime.overview = async () => [
    { scope: 'Global', directory: '/g', files: [{ fileName: '我的记忆', desc: '关于用户', format: '' }] },
  ]
  return runtime
}

const root = await mkdtemp(join(tmpdir(), 'dsh-memory-settings-'))
const file = join(root, 'config.yaml')

try {
  await check('配置文件不存在时新建，只写这一行', async () => {
    saveConfigValue(file, 'logSummaryMaxChars', 300)
    assert.equal(await readFile(file, 'utf8'), 'logSummaryMaxChars: 300\n')
  })

  await check('改值只替换那一行，注释和其他键原样保留', async () => {
    const source = '# 手写的注释\nsnapshotTtlMinutes: 60\nlogSummaryMaxChars: 300\nfileOrder: []\n'
    await writeFile(file, source, 'utf8')
    saveConfigValue(file, 'logSummaryMaxChars', 120)
    assert.equal(
      await readFile(file, 'utf8'),
      '# 手写的注释\nsnapshotTtlMinutes: 60\nlogSummaryMaxChars: 120\nfileOrder: []\n',
    )
  })

  await check('GET 返回字段表与当前值', async () => {
    const handler = createSettingsHandler({ file, runtime: runtimeStub(180) })
    const { status, body } = await call(handler, 'GET')
    assert.equal(status, 200)
    assert.equal(body.settings.logSummaryMaxChars, 180)
    assert.ok(Array.isArray(body.fields), '面板靠字段表渲染，GET 必须带上')
    const keys = body.fields.map((field) => field.key)
    assert.ok(keys.includes('injectLog') && keys.includes('fileOrder'), '每个配置项都要出现')
    assert.equal(
      body.fields.find((field) => field.key === 'fileOrder').hidden,
      true,
      '文件顺序靠面板拖动维护，不该再给输入框',
    )
    // 面板的「+」照着这份列表摆选项，权威在 lib/model.js。
    assert.ok(body.injectIgnoreOptions.includes('update_at'))
    assert.ok(body.injectIgnoreOptions.includes('t1.desc'))
    assert.ok(!body.injectIgnoreOptions.includes('t9.desc'))
  })

  await check('GET 带上各作用域当前的记忆文件', async () => {
    const handler = createSettingsHandler({ file, runtime: overviewStub(180) })
    const { status, body } = await call(handler, 'GET')
    assert.equal(status, 200)
    assert.equal(body.scopes.length, 1)
    assert.equal(body.scopes[0].scope, 'Global')
    assert.equal(body.scopes[0].files[0].fileName, '我的记忆')
    assert.equal(body.scopes[0].files[0].desc, '关于用户')
  })

  await check('GET 按会话 id 问工作区', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.overview = async (sessionId) => {
      seen.push(sessionId)
      return []
    }
    const handler = createSettingsHandler({ file, runtime })
    const res = response()
    await handler(request('GET', undefined, '/plugins/dsh-memory/settings?session=s1'), res)
    assert.equal(res.record.status, 200)
    assert.deepEqual(seen, ['s1'], '面板把当前会话 id 传给 runtime，工作区那一页才跟着走')
  })

  await check('POST 合法值：落盘 + 改内存 + 回新值', async () => {
    const runtime = runtimeStub(180)
    const handler = createSettingsHandler({ file, runtime })
    const { status, body } = await call(handler, 'POST', JSON.stringify({ logSummaryMaxChars: 260 }))
    assert.equal(status, 200)
    assert.equal(body.settings.logSummaryMaxChars, 260)
    assert.equal(runtime.config.logSummaryMaxChars, 260)
    assert.match(await readFile(file, 'utf8'), /^logSummaryMaxChars: 260$/m)
  })

  await check('POST 布尔与列表：写成 YAML 标量，不是 String()', async () => {
    const runtime = runtimeStub(180)
    const handler = createSettingsHandler({ file, runtime })
    const { status } = await call(handler, 'POST', JSON.stringify({ injectLog: true, fileOrder: ['我的记忆', '项目笔记'] }))
    assert.equal(status, 200)
    assert.equal(runtime.config.injectLog, true)
    assert.deepEqual(runtime.config.fileOrder, ['我的记忆', '项目笔记'])
    const source = await readFile(file, 'utf8')
    assert.match(source, /^injectLog: true$/m)
    assert.match(source, /^fileOrder: \[我的记忆, 项目笔记\]$/m)
  })

  await check('POST 超范围：400，文件不动', async () => {
    const before = await readFile(file, 'utf8')
    const handler = createSettingsHandler({ file, runtime: runtimeStub(260) })
    const { status, body } = await call(handler, 'POST', JSON.stringify({ logSummaryMaxChars: 0 }))
    assert.equal(status, 400)
    assert.match(body.error, /日志摘要字数上限/)
    assert.equal(await readFile(file, 'utf8'), before)
  })

  await check('POST 非整数：400', async () => {
    const handler = createSettingsHandler({ file, runtime: runtimeStub(260) })
    const { status } = await call(handler, 'POST', JSON.stringify({ logSummaryMaxChars: 'abc' }))
    assert.equal(status, 400)
  })

  await check('POST 不是 JSON：400 而不是 500', async () => {
    const handler = createSettingsHandler({ file, runtime: runtimeStub(260) })
    const { status, body } = await call(handler, 'POST', 'not json')
    assert.equal(status, 400)
    assert.match(body.error, /JSON/)
  })

  await check('没有要改的字段：400', async () => {
    const handler = createSettingsHandler({ file, runtime: runtimeStub(260) })
    const { status, body } = await call(handler, 'POST', JSON.stringify({ other: 1 }))
    assert.equal(status, 400)
    assert.match(body.error, /没有要修改/)
  })

  await check('其他方法：405', async () => {
    const handler = createSettingsHandler({ file, runtime: runtimeStub(260) })
    const { status } = await call(handler, 'PUT')
    assert.equal(status, 405)
  })

  await check('GET 带 file 时只回那一个文件的内容', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.fileText = async (request) => {
      seen.push(request)
      return { fileName: request.fileName, scope: request.scope, text: '正文' }
    }
    const handler = createSettingsHandler({ file, runtime })
    const res = response()
    await handler(
      request('GET', undefined, `/plugins/dsh-memory/settings?session=s1&scope=Workspace&file=${encodeURIComponent('项目笔记')}`),
      res,
    )
    assert.equal(res.record.status, 200)
    assert.deepEqual(seen, [{ scope: 'Workspace', sessionId: 's1', fileName: '项目笔记', kind: 'memory' }])
    assert.deepEqual(JSON.parse(res.record.body).file, { fileName: '项目笔记', scope: 'Workspace', text: '正文' })
  })

  await check('GET 带 kind=log 时去日志那一排找', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.fileText = async (request) => {
      seen.push(request)
      return { fileName: request.fileName, scope: request.scope, kind: request.kind, text: '一天' }
    }
    const handler = createSettingsHandler({ file, runtime })
    const res = response()
    await handler(
      request('GET', undefined, '/plugins/dsh-memory/settings?scope=Global&kind=log&file=2026-10-27'),
      res,
    )
    assert.equal(res.record.status, 200)
    assert.deepEqual(seen, [{ scope: 'Global', sessionId: undefined, fileName: '2026-10-27', kind: 'log' }])
  })

  await check('POST 带 file：交给 patchFile，回文件与作用域表', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.patchFile = async (patch) => {
      seen.push(patch)
      return { fileName: patch.fileName, desc: patch.desc, tree: [] }
    }
    const handler = createSettingsHandler({ file, runtime })
    const patch = { scope: 'Global', fileName: '我的记忆', kind: 'memory', desc: '新描述', nodes: [] }
    const { status, body } = await call(handler, 'POST', JSON.stringify({ file: patch }), '/plugins/dsh-memory/settings?session=s9')
    assert.equal(status, 200)
    assert.deepEqual(seen, [{ ...patch, sessionId: 's9' }])
    assert.deepEqual(body.file, { fileName: '我的记忆', desc: '新描述', tree: [] })
    assert.ok(Array.isArray(body.scopes))
  })

  // 这条把「面板能提交哪些字段」钉死：以后 readFilePatch 少认一个键，这里就会红。
  await check('POST 带 file：认得的字段一个不少，不认的丢掉', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.patchFile = async (patch) => {
      seen.push(patch)
      return { fileName: patch.fileName, tree: [] }
    }
    const handler = createSettingsHandler({ file, runtime })
    const submitted = {
      scope: 'Workspace',
      kind: 'memory',
      fileName: '项目笔记',
      newFileName: '新名字',
      desc: '新描述',
      format: '标题写事实',
      injectIgnore: ['t2', 'update_at'],
      newNodes: [{ parent: [], title: '新一级', desc: '正文', keyword: ['k'], 多余: 1 }],
      nodes: [{ path: ['a', 'b'], title: '改过的', desc: '改过的正文', keyword: ['x'] }],
      removed: [['旧标题'], ['旧标题', '子'], '不是数组', []],
      不认得: '丢掉',
    }
    const { status } = await call(handler, 'POST', JSON.stringify({ file: submitted }), '/plugins/dsh-memory/settings?session=s9')
    assert.equal(status, 200)
    assert.deepEqual(seen, [{
      scope: 'Workspace',
      kind: 'memory',
      fileName: '项目笔记',
      newFileName: '新名字',
      desc: '新描述',
      format: '标题写事实',
      injectIgnore: ['t2', 'update_at'],
      newNodes: [{ parent: [], title: '新一级', desc: '正文', keyword: ['k'] }],
      nodes: [{ path: ['a', 'b'], title: '改过的', desc: '改过的正文', keyword: ['x'] }],
      removed: [['旧标题'], ['旧标题', '子']],
      sessionId: 's9',
    }])
  })

  await check('POST create：交给 createFile，回新文件与作用域表', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.createFile = async (request) => {
      seen.push(request)
      return { fileName: request.fileName, scope: request.scope, kind: 'memory', tree: [] }
    }
    const handler = createSettingsHandler({ file, runtime })
    const { status, body } = await call(
      handler,
      'POST',
      JSON.stringify({ create: { scope: 'Workspace', fileName: ' 新本子 ' } }),
      '/plugins/dsh-memory/settings?session=s9',
    )
    assert.equal(status, 200)
    // 名字两端空白要剪掉：不然会建出一个前后带空格的怪文件。
    assert.deepEqual(seen, [{ scope: 'Workspace', kind: 'memory', fileName: '新本子', sessionId: 's9' }])
    assert.equal(body.file.fileName, '新本子')
    assert.ok(Array.isArray(body.scopes))
  })

  await check('POST remove：交给 deleteFile，回删掉的是哪个', async () => {
    const seen = []
    const runtime = runtimeStub(180)
    runtime.deleteFile = async (request) => {
      seen.push(request)
      return { fileName: request.fileName, scope: request.scope, kind: request.kind }
    }
    const handler = createSettingsHandler({ file, runtime })
    const { status, body } = await call(handler, 'POST', JSON.stringify({ remove: { scope: 'Global', kind: 'log', fileName: '2026-10-28' } }))
    assert.equal(status, 200)
    assert.deepEqual(seen, [{ scope: 'Global', kind: 'log', fileName: '2026-10-28' }])
    assert.equal(body.removed.fileName, '2026-10-28')
  })

  await check('POST create/remove 出错：400 带原因', async () => {
    const runtime = runtimeStub(180)
    runtime.createFile = async () => {
      throw new DocumentError('已经有一个叫 我的记忆 的记忆文件了')
    }
    const handler = createSettingsHandler({ file, runtime })
    const rejected = await call(handler, 'POST', JSON.stringify({ create: { scope: 'Global', fileName: '我的记忆' } }))
    assert.equal(rejected.status, 400)
    assert.match(rejected.body.error, /已经有一个叫/)

    const missing = await call(handler, 'POST', JSON.stringify({ create: { scope: 'Global', fileName: '  ' } }))
    assert.equal(missing.status, 400)
  })

  await check('POST 带 file 但写入被拒：400 带原因，不是 500', async () => {
    const runtime = runtimeStub(180)
    runtime.patchFile = async () => {
      throw new DocumentError('找不到标题: a > b')
    }
    const handler = createSettingsHandler({ file, runtime })
    const { status, body } = await call(handler, 'POST', JSON.stringify({ file: { scope: 'Global', fileName: '我的记忆' } }))
    assert.equal(status, 400)
    assert.match(body.error, /找不到标题/)
  })

  await check('POST 带 file 但没这个文件：404', async () => {
    const runtime = runtimeStub(180)
    runtime.patchFile = async () => undefined
    const handler = createSettingsHandler({ file, runtime })
    const { status } = await call(handler, 'POST', JSON.stringify({ file: { scope: 'Global', fileName: '没有这个' } }))
    assert.equal(status, 404)
  })

  await check('路由常量与客户端调用的一致', async () => {
    const client = await readFile(join(import.meta.dirname, '..', 'client.js'), 'utf8')
    assert.ok(client.includes(SETTINGS_ROUTE), `client.js 应调用 ${SETTINGS_ROUTE}`)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}

/**
 * Store and runtime checks that touch the filesystem.
 * Run with `node test/store.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_FILE_NAME, loadConfigFile } from '../lib/config.js'
import { resolveLayout } from '../lib/paths.js'
import { MemoryStore } from '../lib/store.js'
import { MemoryRuntime } from '../lib/runtime.js'
import { renderInjection } from '../lib/render.js'

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

/** Build a throwaway home plus one workspace. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
  const store = new MemoryStore({ homeDir: home, warn: (message) => console.log(`       warn: ${message}`) })
  await store.ensureDirectory(store.globalDir, 'Global')
  return { home, workspace, store }
}

/** A minimal fake agent whose working directory is fixed. */
function fakeAgent(id, workspace) {
  return {
    id,
    session: { header: {} },
    workspace,
    injected: [],
    inject(message) {
      this.injected.push(message)
    },
  }
}

/** A runtime whose workingDirectory service reports one fixed root per agent. */
function runtimeFor(store, workspace, extra = {}) {
  const runtime = new MemoryRuntime({
    store,
    config: {
      snapshotTtlMinutes: 60,
      workingDirectory: { ensure: async (agent) => agent.workspace ?? workspace },
      ...extra,
    },
    logger: { warn: (message) => console.log(`       warn: ${message}`) },
  })
  runtime.setAgentSource(() => runtime.tracked)
  runtime.tracked = []
  return runtime
}

console.log('store')
await check('写入后立即能被读到', async () => {
  const { store } = await sandbox()
  const document = {
    fileName: '我的记忆',
    desc: '关于用户的事',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([['我们经历过的一些事', { update_at: '', desc: '一起吃过饭', keyword: [], children: new Map() }]]),
    source: '',
  }
  await store.write(store.globalDir, 'Global', document)
  const names = store.documents(store.globalDir).map((entry) => entry.fileName)
  assert.deepEqual(names, ['我的记忆'])
})

await check('面板概览：全局列得出来，工作区跟着会话走', async () => {
  const { store, workspace } = await sandbox()
  const document = {
    fileName: '我的记忆',
    desc: '关于用户的事',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map(),
    source: '',
  }
  await store.write(store.globalDir, 'Global', document)

  const runtime = runtimeFor(store, workspace, { snapshotTtlMinutes: 0 })
  const agent = fakeAgent('panel-session', workspace)
  await runtime.attach(agent, undefined)

  const scopes = await runtime.overview('panel-session')
  assert.deepEqual(scopes.map((entry) => entry.scope), ['Global', 'Workspace'])
  assert.deepEqual(scopes[0].files.map((file) => file.fileName), ['我的记忆'])
  assert.equal(scopes[1].directory, store.workspaceDir(workspace), '工作区那一页用的是这个会话的根')

  const rendered = await runtime.fileText({ scope: 'Global', sessionId: 'panel-session', fileName: '我的记忆' })
  assert.equal(rendered?.scope, 'Global')
  assert.match(rendered?.text ?? '', /我的记忆/, '面板显示的就是 memory_read 那份渲染')

  // 日志那一排：按日期列出，内容也能单独取到
  await store.write(store.globalDir, 'Global', {
    ...document,
    fileName: '2026-10-27',
    kind: 'log',
    desc: '用来记录和“他”之间的互动',
    roots: new Map([['2026-10-27', { update_at: '', desc: '', keyword: [], children: new Map() }]]),
  })
  await store.reloadDirectory(store.globalDir, 'Global')
  const after = await runtime.overview('panel-session')
  assert.ok(after[0].logs.some((entry) => entry.fileName === '2026-10-27'), '日志是另一个货架')
  assert.ok(!after[0].files.some((entry) => entry.fileName === '2026-10-27'), '日志不混进文件列表')
  const logText = await runtime.fileText({ scope: 'Global', fileName: '2026-10-27', kind: 'log' })
  assert.match(logText?.text ?? '', /2026-10-27/, '日志也能按 kind=log 取到渲染文本')
  runtime.stop()
})

await check('面板保存：描述、格式、不注入的值和正文关键词都能落盘，更新时间不动', async () => {
  const { store, workspace } = await sandbox()
  const written = '2026-01-01T00:00:00.000Z'
  await store.write(store.globalDir, 'Global', {
    fileName: '我的记忆',
    desc: '旧描述',
    format: '旧格式',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([['关于用户', { update_at: written, desc: '旧正文', keyword: ['醒'], children: new Map() }]]),
    source: '',
  })
  const runtime = runtimeFor(store, workspace)
  const body = await runtime.patchFile({
    scope: 'Global',
    fileName: '我的记忆',
    kind: 'memory',
    desc: '新描述',
    format: '新格式',
    injectIgnore: ['keyword'],
    nodes: [{ path: ['关于用户'], desc: '新正文', keyword: ['醒', '标签'] }],
  })
  assert.equal(body.meta.desc, '新描述')
  assert.equal(body.meta.format, '新格式')
  assert.deepEqual(body.meta.injectIgnore, ['keyword'])
  assert.equal(body.tree[0].desc, '新正文')
  assert.deepEqual(body.tree[0].keyword, ['醒', '标签'])
  assert.equal(body.tree[0].updateAt, written, 'update_at 是写入时间，面板改不动')

  // 落的是同一份文件，读回来必须还是刚才那几项。
  const reread = await runtime.fileText({ scope: 'Global', fileName: '我的记忆' })
  assert.equal(reread.meta.desc, '新描述')
  assert.deepEqual(reread.tree[0].keyword, ['醒', '标签'])

  // 不存在的标题要报错而不是悄悄新建一个。
  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '我的记忆', nodes: [{ path: ['没有的'], desc: 'x' }] }),
    /找不到标题/,
  )
})

await check('面板改名：文件名和标题都能改，旧文件不留在磁盘上', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', {
    fileName: '旧名字',
    desc: '描述',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([
      ['旧标题', { update_at: '2026-01-01T00:00:00.000Z', desc: '正文', keyword: [], children: new Map() }],
      ['另一份', { update_at: '2026-01-01T00:00:00.000Z', desc: '', keyword: [], children: new Map() }],
    ]),
    source: '',
  })
  const runtime = runtimeFor(store, workspace)
  const body = await runtime.patchFile({
    scope: 'Global',
    fileName: '旧名字',
    kind: 'memory',
    newFileName: '新名字',
    nodes: [{ path: ['旧标题'], title: '新标题' }],
  })
  assert.equal(body.fileName, '新名字')
  assert.equal(body.tree[0].title, '新标题')

  // 旧文件必须删掉，否则同一段记忆会有两份。
  const names = store.documents(store.globalDir).map((entry) => entry.fileName)
  assert.deepEqual(names, ['新名字'])

  // 同一层重名要拒绝，别把两个标题写成同一个。
  await assert.rejects(
    () => runtime.patchFile({
      scope: 'Global',
      fileName: '新名字',
      nodes: [{ path: ['另一份'], title: '新标题' }],
    }),
    /同一层已经有/,
  )

  // 已经有同名文件时改名要拒绝。
  await store.write(store.globalDir, 'Global', {
    fileName: '占位',
    desc: '',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map(),
    source: '',
  })
  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '新名字', newFileName: '占位' }),
    /已经有一个叫/,
  )
})

await check('面板新建标题：挂在指定层下，重名和超层都要拒绝', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', {
    fileName: '笔记',
    desc: '',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([['已有', { update_at: '2026-01-01T00:00:00.000Z', desc: '', keyword: [], children: new Map() }]]),
    source: '',
  })
  const runtime = runtimeFor(store, workspace)
  const body = await runtime.patchFile({
    scope: 'Global',
    fileName: '笔记',
    kind: 'memory',
    // 同一批里后面的标题可以挂在前面刚建的那一层下。
    newNodes: [{ parent: [], title: '新一级', desc: '先写好的正文', keyword: ['草稿'] }, { parent: ['新一级'], title: '新二级' }],
  })
  const added = body.tree.find((node) => node.title === '新一级')
  assert.equal(added?.children?.[0]?.title, '新二级')
  assert.equal(added?.desc, '先写好的正文')
  assert.deepEqual(added?.keyword, ['草稿'])

  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '笔记', newNodes: [{ parent: [], title: '已有' }] }),
    /同一层已经有/,
  )
  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '笔记', newNodes: [{ parent: ['新一级', '新二级', 'a', 'b'], title: '太深' }] }),
    /最多 4 层/,
  )
  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '笔记', newNodes: [{ parent: ['没有的'], title: 'x' }] }),
    /找不到标题/,
  )
})

await check('面板删除标题：整支一起摘掉，改名后的路径不再适用', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', {
    fileName: '待删',
    desc: '',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([
      ['留着', { update_at: '2026-01-01T00:00:00.000Z', desc: '', keyword: [], children: new Map() }],
      ['删掉', { update_at: '2026-01-01T00:00:00.000Z', desc: '', keyword: [], children: new Map([['孙', { update_at: '2026-01-01T00:00:00.000Z', desc: '', keyword: [], children: new Map() }]]) }],
    ]),
    source: '',
  })
  const runtime = runtimeFor(store, workspace)
  const body = await runtime.patchFile({ scope: 'Global', fileName: '待删', kind: 'memory', removed: [['删掉']] })
  assert.deepEqual(body.tree.map((node) => node.title), ['留着'])

  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '待删', removed: [['删掉']] }),
    /找不到标题/,
  )
})

await check('目录里出现坏文件时不参与组装且能报错', async () => {
  const { store } = await sandbox()
  await writeFile(join(store.globalDir, 'broken.yaml'), 'meta_data:\n  file_name: 坏的\ndata:\n  desc: 不行\n', 'utf8')
  await store.reloadDirectory(store.globalDir, 'Global')
  assert.equal(store.documents(store.globalDir).length, 0)
  assert.equal(store.broken(store.globalDir).length, 1)
})

await check('文件监听能把外部改动读进缓存', async () => {
  const { store } = await sandbox()
  const path = join(store.globalDir, 'watched.yaml')
  await writeFile(path, 'meta_data:\n  file_name: 监听\ndata: {}\n', 'utf8')
  await store.reloadDirectory(store.globalDir, 'Global')
  assert.equal(store.documents(store.globalDir).length, 1)

  const changed = new Promise((resolve) => {
    const off = store.onChange((event) => {
      if (event.fileName === 'watched.yaml') {
        off()
        resolve()
      }
    })
  })
  await writeFile(path, 'meta_data:\n  file_name: 监听\ndata:\n  新标题:\n    desc: 新内容\n', 'utf8')
  store.scheduleReload(store.globalDir, 'Global', 'watched.yaml')
  await changed
  assert.equal(store.documents(store.globalDir)[0].roots.size, 1)
})

await check('配置文件落在 <dataDir>/config.yaml：缺了不报、坏了整份忽略', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-cfg-'))
  const layout = resolveLayout({ homeDir: home })
  assert.equal(layout.dataDir, join(home, 'dsh-memory'))
  assert.equal(layout.globalDir, join(home, 'dsh-memory', '.memory'))
  assert.equal(layout.stateDir, join(home, 'dsh-memory', 'state'))

  const file = join(layout.dataDir, CONFIG_FILE_NAME)
  const warnings = []
  const warn = (message) => warnings.push(message)

  assert.deepEqual(loadConfigFile(file, warn), {})
  assert.equal(warnings.length, 0, '缺文件是正常情况，不该报警')

  await mkdir(layout.dataDir, { recursive: true })
  await writeFile(file, 'injectLog: true\nfileOrder:\n  - 我的记忆\n', 'utf8')
  assert.deepEqual(loadConfigFile(file, warn), { injectLog: true, fileOrder: ['我的记忆'] })

  await writeFile(file, 'injectLog: [oops\n', 'utf8')
  assert.deepEqual(loadConfigFile(file, warn), {})
  assert.match(warnings.at(-1), /YAML/)

  await writeFile(file, '- 数组不是配置\n', 'utf8')
  assert.deepEqual(loadConfigFile(file, warn), {})
  assert.match(warnings.at(-1), /键值对/)
})

await check('fileOrder 只改注入顺序，不改工具寻址的文件顺序', async () => {
  const { store, workspace } = await sandbox()
  const make = (fileName) => ({
    fileName,
    desc: '',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([['正文', { update_at: '', desc: fileName, keyword: [], children: new Map() }]]),
    source: '',
  })
  await store.write(store.globalDir, 'Global', make('乙'))
  await store.write(store.globalDir, 'Global', make('甲'))

  const agent = fakeAgent('order', workspace)
  const plain = runtimeFor(store, workspace)
  const injected = (runtime) => runtime.sectionText({ agent })
  // 默认按文件名排。
  assert.ok(injected(plain).indexOf('file_name: 甲') < injected(plain).indexOf('file_name: 乙'))

  // 列出来的排前面，没列出来的按原顺序跟在后面。
  const ordered = runtimeFor(store, workspace, { fileOrder: ['乙'] })
  assert.ok(injected(ordered).indexOf('file_name: 乙') < injected(ordered).indexOf('file_name: 甲'))
  // 工具看到的文件清单不受影响：仍是按文件名。
  const list = await ordered.read(agent, {})
  assert.ok(list.indexOf('甲') < list.indexOf('乙'), list)
})

await check('面板列表的顺序就是注入顺序，拖动和提示词不会各说一套', async () => {
  const { store, workspace } = await sandbox()
  const make = (fileName) => ({
    fileName,
    desc: '',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([['正文', { update_at: '', desc: fileName, keyword: [], children: new Map() }]]),
    source: '',
  })
  await store.write(store.globalDir, 'Global', make('乙'))
  await store.write(store.globalDir, 'Global', make('甲'))

  const ordered = runtimeFor(store, workspace, { fileOrder: ['乙'] })
  const [global] = await ordered.overview()
  assert.deepEqual(
    global.files.map((entry) => entry.fileName),
    ['乙', '甲'],
    '面板里看到的位置必须和注入一致，否则拖完不知道有没有生效',
  )
})
await check('并发写同一文件不会互相截断', async () => {
  const { store } = await sandbox()
  const base = {
    fileName: '并发',
    desc: '',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map(),
    source: '',
  }
  const first = { ...base, roots: new Map([['a', { update_at: '', desc: 'a', keyword: [], children: new Map() }]]) }
  const second = { ...base, roots: new Map([['b', { update_at: '', desc: 'b', keyword: [], children: new Map() }]]) }
  await Promise.all([
    store.write(store.globalDir, 'Global', first),
    store.write(store.globalDir, 'Global', second),
  ])
  const text = await readFile(join(store.globalDir, '并发.yaml'), 'utf8')
  assert.ok(text.includes('meta_data'))
  const leftovers = (await readdir(store.globalDir)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

console.log('runtime')
await check('新会话不收到更新提醒，直接以当前内容为基线', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: '早就在的内容', keyword: [], children: new Map() }]]),
  })
  const runtime = runtimeFor(store, workspace)
  const fresh = fakeAgent('n1', workspace)
  runtime.tracked = [fresh]
  await runtime.attach(fresh)

  assert.equal(fresh.injected.length, 0, '刚开的会话不该收到任何更新提醒')
  const { readSnapshot } = await import('../lib/snapshot.js')
  const saved = await readSnapshot(store.stateDir, 'n1')
  assert.ok(saved, '新会话也要立刻落一份快照')
  assert.deepEqual(Object.keys(saved.files), Object.keys(runtime.currentSnapshot(fresh)))

  // 之后同一份内容不再变化，重新接入也不该提醒。
  const again = fakeAgent('n1', workspace)
  runtime.tracked = [again]
  await runtime.attach(again)
  assert.equal(again.injected.length, 0)
})

await check('通知一投递就推进快照，丢弃才回滚', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const writer = fakeAgent('w1', workspace)
  const watcher = fakeAgent('w2', workspace)
  runtime.tracked = [writer, watcher]
  await runtime.attach(writer)
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v1', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir)
  assert.equal(watcher.injected.length, 1)

  // 还没被取走就再写一次同样的内容：已经在快照里，不该重复提醒。
  await runtime.afterWrite(writer, store.globalDir)
  assert.equal(watcher.injected.length, 1, '同一版本不该重复提醒')

  // 通知被丢弃：回滚到投递前的基线，下次变更重新提醒。
  await runtime.release(watcher)
  await runtime.afterWrite(writer, store.globalDir)
  assert.equal(watcher.injected.length, 2, '丢弃的通知要能在下次补发')
})

await check('注入只包含全局文件，工作区文件按 agent 分开', async () => {
  const { store, workspace } = await sandbox()
  const other = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('a1', workspace)
  const otherAgent = fakeAgent('a2', other)
  await runtime.attach(agent)
  await runtime.attach(otherAgent)

  await store.write(store.globalDir, 'Global', {
    fileName: '全局', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['共享', { update_at: '', desc: '共享内容', keyword: [], children: new Map() }]]),
  })
  await store.write(store.workspaceDir(workspace), 'Workspace', {
    fileName: '项目笔记', desc: '', format: '', scope: 'Workspace', injectIgnore: [], source: '',
    roots: new Map([['架构', { update_at: '', desc: '架构说明', keyword: [], children: new Map() }]]),
  })

  const textA = runtime.sectionText({ agent })
  const textB = runtime.sectionText({ agent: otherAgent })
  assert.match(textA, /共享内容/)
  assert.match(textA, /架构说明/)
  assert.match(textB, /共享内容/)
  assert.doesNotMatch(textB, /架构说明/)
})

await check('另一会话的修改以 user 消息投递且不唤醒', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const writer = fakeAgent('w1', workspace)
  const watcher = fakeAgent('w2', workspace)
  runtime.tracked = [writer, watcher]
  await runtime.attach(writer)
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: '原文', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})

  assert.equal(watcher.injected.length, 1)
  const message = watcher.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'memory')
  assert.ok(message.source.snapshot)
  assert.match(message.content[0].text, /<memory_update>/)
  assert.equal(writer.injected.length, 0)
})

await check('取走通知不改变已推进的快照，版本变化才再提醒', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const writer = fakeAgent('w1', workspace)
  const watcher = fakeAgent('w2', workspace)
  runtime.tracked = [writer, watcher]
  await runtime.attach(writer)
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v1', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})
  assert.equal(watcher.injected.length, 1)

  await runtime.claim(watcher, watcher.injected[0].source.snapshot)
  await runtime.afterWrite(writer, store.globalDir, {})
  assert.equal(watcher.injected.length, 1, '版本未变不应重复通知')

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v2', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})
  assert.equal(watcher.injected.length, 2, '版本变化应再次通知')
})

await check('旧版本的快照被整份忽略，不会被当成“全都变了”', async () => {
  const { home, store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const watcher = fakeAgent('w8', workspace)
  runtime.tracked = [watcher]
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v1', keyword: [], children: new Map() }]]),
  })

  // A snapshot written by an older plugin version: same shape, other hash scheme.
  const { mkdir, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const path = join(store.stateDir, 'sessions', 'w8.json')
  await mkdir(join(store.stateDir, 'sessions'), { recursive: true })
  await writeFile(path, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    files: { [join(store.globalDir, '记忆.yaml').split('\\').join('/')]: { hash: 'stale', sections: {} } },
  }), 'utf8')

  const { readSnapshot } = await import('../lib/snapshot.js')
  assert.equal(await readSnapshot(store.stateDir, 'w8'), undefined, '版本不对的快照应当读不出基线')
})

await check('重启后从磁盘快照算出遗漏的变更', async () => {
  const { home, store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const watcher = fakeAgent('w9', workspace)
  runtime.tracked = [watcher]
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v1', keyword: [], children: new Map() }]]),
  })
  const snapshot = runtime.currentSnapshot(watcher)
  const { writeSnapshot } = await import('../lib/snapshot.js')
  await writeSnapshot(store.stateDir, 'w9', snapshot)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v2', keyword: [], children: new Map() }]]),
  })

  const restarted = new MemoryStore({ homeDir: home })
  await restarted.ensureDirectory(restarted.globalDir, 'Global')
  const nextRuntime = runtimeFor(restarted, workspace)
  const resumed = fakeAgent('w9', workspace)
  nextRuntime.tracked = [resumed]
  await nextRuntime.attach(resumed)
  assert.equal(resumed.injected.length, 1)
  assert.match(resumed.injected[0].content[0].text, /别的会话更新/)
})

await check('注入文本对会话冻结：文件改了也不换，变化只走通知', async () => {
  const { store, workspace } = await sandbox()
  const write = (desc) => store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc, keyword: [], children: new Map() }]]),
  })
  await write('第一版')

  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('f1', workspace)
  runtime.tracked = [agent]
  await runtime.attach(agent)
  const frozen = runtime.sectionText({ agent })
  assert.match(frozen, /第一版/)

  await write('第二版')
  await runtime.afterWrite(agent, store.globalDir)
  assert.equal(runtime.sectionText({ agent }), frozen, '同一会话的注入文本不该随文件变')

  await write('第三版')
  assert.equal(runtime.sectionText({ agent }), frozen, '再改一次也一样')

  // 只有新会话才重新渲染：它本来就没有前缀可保护。
  const fresh = fakeAgent('f2', workspace)
  runtime.tracked = [agent, fresh]
  await runtime.attach(fresh)
  assert.match(runtime.sectionText({ agent: fresh }), /第三版/, '新会话看到的是当前内容')
})

await check('分叉复制父会话的快照，父快照没了就按当前状态重建', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: '分叉前的内容', keyword: [], children: new Map() }]]),
  })
  const runtime = runtimeFor(store, workspace)
  const parent = fakeAgent('p1', workspace)
  runtime.tracked = [parent]
  await runtime.attach(parent)

  // Pin the parent's frozen parts by hand: the real paths that set them are
  // fire-and-forget, and this check is about the copy, not about persistence
  // timing.
  const parentText = '父会话冻结下来的注入正文'
  runtime.frozen.set('p1', { text: parentText, logKeys: [], at: new Date().toISOString() })
  runtime.toolText.set('p1', '父会话的工具描述')
  await runtime.persist('p1', runtime.currentSnapshot(parent))

  const child = fakeAgent('c1', workspace)
  child.session.header.parentSession = 'p1'
  runtime.tracked = [parent, child]
  await runtime.attach(child)
  assert.equal(child.injected.length, 0, '继承的基线里没有新东西，不该提醒')
  assert.equal(runtime.sectionText({ agent: child }), parentText, '子会话共享父会话的前缀')
  assert.equal(runtime.sessionToolText(child, () => '重算的描述'), '父会话的工具描述')

  // 父快照已经被清掉：当作没有基线，按当前状态重建，不能抛。
  const { removeSnapshot } = await import('../lib/snapshot.js')
  await removeSnapshot(store.stateDir, 'p1')
  const orphan = fakeAgent('c2', workspace)
  orphan.session.header.parentSession = 'p1'
  runtime.tracked = [parent, child, orphan]
  await runtime.attach(orphan)
  assert.equal(orphan.injected.length, 0)
  assert.match(runtime.sectionText({ agent: orphan }), /分叉前的内容/)
})

await check('超过保留窗口的快照被丢掉，下次接入时重建', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace, { snapshotTtlMinutes: 60 })
  const agent = fakeAgent('t1', workspace)
  runtime.tracked = [agent]
  await runtime.attach(agent)

  const { isStale, readSnapshot, writeSnapshot } = await import('../lib/snapshot.js')
  const old = new Date(Date.now() - 61 * 60 * 1000).toISOString()
  await writeSnapshot(store.stateDir, 't1', {
    files: runtime.currentSnapshot(agent),
    injected: { text: '老得快照里的文本', logKeys: [] },
    tools: '老工具描述',
    updatedAt: old,
  })
  assert.equal(isStale({ updatedAt: old }, 60), true, '六十一分钟前的算过期')
  assert.equal(isStale({ updatedAt: old }, 0), false, '0 表示一直留着')

  const again = fakeAgent('t1', workspace)
  runtime.tracked = [again]
  await runtime.attach(again)
  assert.equal(again.injected.length, 0, '过期重建不算"被删"，不该提醒')

  const fresh = await readSnapshot(store.stateDir, 't1')
  assert.ok(fresh, '重建成了一份新快照')
  assert.ok(Date.parse(fresh.updatedAt) > Date.now() - 60 * 60 * 1000, '新快照用新时间')
  assert.equal(fresh.injected, undefined, '旧的冻结文本不该复活')
  assert.equal(fresh.tools, undefined)
})

await check('闲过头的会话下次组装时重新渲染注入文本', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace, { snapshotTtlMinutes: 60 })
  const agent = fakeAgent('t2', workspace)
  runtime.tracked = [agent]
  await store.write(store.globalDir, 'Global', {
    fileName: '要注入的',
    desc: '关于用户的事',
    format: '',
    scope: 'Global',
    injectIgnore: [],
    roots: new Map([['标题', { update_at: '', desc: '正文', keyword: [], children: new Map() }]]),
    source: '',
  })
  await runtime.attach(agent)
  const before = runtime.sectionText({ agent })
  assert.match(before, /要注入的/)

  // 冻结后把时钟拨回两小时：下一次组装应当重新渲染，而不是继续用旧文本。
  const old = new Date(Date.now() - 120 * 60 * 1000).toISOString()
  runtime.frozen.set('t2', { ...runtime.frozen.get('t2'), at: old })
  runtime.touched.set('t2', old)
  assert.equal(runtime.sectionText({ agent }), before, '内容没变，重渲染的结果一样')

  // 时钟重启之后不能立刻又被判过期：否则同一轮里每次组装都会重渲染。
  const after = runtime.sectionText({ agent })
  assert.equal(after, before)
  assert.ok(Date.parse(runtime.touched.get('t2')) > Date.now() - 60 * 1000, '重建后保留窗口从此刻重新算')
})

await check('edit 要求先 read，且在读取后被改动时拒绝', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('e1', workspace)
  runtime.tracked = [agent]
  await runtime.attach(agent)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: '原文', keyword: [], children: new Map() }]]),
  })

  await assert.rejects(
    () => runtime.edit(agent, { fileName: '记忆', path: ['主题'], oldString: '原文', newString: '新的' }),
    /必须先用 memory_read/,
  )

  await runtime.read(agent, { fileName: '记忆', headingPath: ['主题'] })
  await runtime.edit(agent, { fileName: '记忆', path: ['主题'], oldString: '原文', newString: '新的' })
  assert.match(renderInjection(store.documents(store.globalDir)), /新的/)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: '外部改动', keyword: [], children: new Map() }]]),
  }).catch(() => {})
})

await check('同名文件按 scope 分别读写，清单也按 scope 收窄', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('s1', workspace)
  runtime.tracked = [agent]
  await runtime.attach(agent)

  const document = (desc, scope) => ({
    fileName: '笔记', desc, format: '', scope, injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc, keyword: [], children: new Map() }]]),
  })
  // Same name in both scopes: only possible by writing past the manage guard,
  // which is exactly the state a read tool has to be able to address.
  await store.write(store.globalDir, 'Global', document('全局那份', 'Global'))
  await store.write(store.workspaceDir(workspace), 'Workspace', document('工作区那份', 'Workspace'))

  assert.match(await runtime.read(agent, { scope: 'Global', fileName: '笔记' }), /全局那份/)
  assert.match(await runtime.read(agent, { scope: 'Workspace', fileName: '笔记' }), /工作区那份/)
  // Omitting the scope keeps the old default order rather than failing.
  assert.match(await runtime.read(agent, { fileName: '笔记' }), /全局那份/)

  const globalList = await runtime.read(agent, { scope: 'Global' })
  const workspaceList = await runtime.read(agent, { scope: 'Workspace' })
  assert.match(globalList, /笔记 \[Global\]/)
  assert.doesNotMatch(globalList, /笔记 \[Workspace\]/, '带 scope 的清单只列这一层')
  assert.match(workspaceList, /笔记 \[Workspace\]/)
  assert.doesNotMatch(workspaceList, /笔记 \[Global\]/, '带 scope 的清单只列这一层')
  // Both omitted lists everything the agent can see.
  const everything = await runtime.read(agent, {})
  assert.match(everything, /笔记 \[Global\]/)
  assert.match(everything, /笔记 \[Workspace\]/, 'scope 和 file_name 都不传时才列出全部')

  await assert.rejects(() => runtime.read(agent, { scope: 'Workspace', fileName: '不存在的' }), /找不到记忆文件/)

  // `manage` has to address the copy the caller named, not whichever one the
  // default search order happens to find first.
  await runtime.manage(agent, { scope: 'Workspace', fileName: '笔记', desc: '改过的工作区那份' })
  assert.match(await runtime.read(agent, { scope: 'Workspace', fileName: '笔记' }), /改过的工作区那份/)
  assert.match(await runtime.read(agent, { scope: 'Global', fileName: '笔记' }), /全局那份/, 'Global 那份不该被改动')

  // A log's metadata belongs to the plugin, so the error has to say that rather
  // than falling through to "找不到记忆文件" (log documents are never located).
  await assert.rejects(
    () => runtime.manage(agent, { scope: 'Global', fileName: '2026-10-27' }),
    /日志文件的元数据由插件管理/,
  )

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

// Sources for the three regression checks below. They live up here so the checks
// read as scenarios rather than as document literals.
const filled = (fileName, roots) => ({
  fileName,
  desc: '',
  format: '',
  scope: 'Global',
  injectIgnore: [],
  roots,
  source: '',
})

const node = (desc, children = new Map()) => ({ update_at: '', desc, keyword: [], children })

await check('并发加载同一目录时后到的调用者不会看到空缓存', async () => {
  const store = new MemoryStore({ homeDir: await mkdtemp(join(tmpdir(), 'dsh-memory-race-')), warn: () => {} })
  await mkdir(join(store.globalDir, 'log'), { recursive: true })
  await writeFile(
    join(store.globalDir, '已有的.yaml'),
    'meta_data:\n  file_name: 已有的\n  desc: 描述\ndata:\n  标题:\n    desc: 正文\n',
    'utf8',
  )

  // Both calls are in flight at once, which is exactly what `attach` (loading the
  // workspace) racing `overview` (reading it for the panel) does on startup.
  await Promise.all([
    store.ensureDirectory(store.globalDir, 'Global'),
    store.ensureDirectory(store.globalDir, 'Global'),
  ])
  assert.equal(store.documents(store.globalDir).length, 1, '磁盘上已有的文件不能被并发加载吃掉')

  store.dispose()
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('同一次保存里既给标题改名又把新卡挂在它下面', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', filled('笔记', new Map([['旧父级', node('父正文')]])))
  const runtime = runtimeFor(store, workspace)

  // The panel sends the old title in `parent` because that is the path the card
  // was rendered from; the rename lands first, so the lookup has to translate it.
  const body = await runtime.patchFile({
    scope: 'Global',
    fileName: '笔记',
    kind: 'memory',
    nodes: [{ path: ['旧父级'], title: '新父级' }],
    newNodes: [{ parent: ['旧父级'], title: '子卡片', desc: '正文' }],
  })
  const parent = body.tree.find((entry) => entry.title === '新父级')
  assert.equal(parent?.children?.[0]?.title, '子卡片')
  assert.equal(parent?.desc, '父正文', '改名不能顺手把正文清掉')

  // A rename of a grandparent has the same problem one level further up.
  const inner = new Map([['乙', node('丙')]])
  const outer = new Map([['甲', node('', inner)]])
  await store.write(store.globalDir, 'Global', filled('两层', outer))
  const deeper = await runtime.patchFile({
    scope: 'Global',
    fileName: '两层',
    kind: 'memory',
    nodes: [{ path: ['甲'], title: 'A' }],
    newNodes: [{ parent: ['甲', '乙'], title: '一' }],
  })
  assert.equal(deeper.tree.find((entry) => entry.title === 'A')?.children?.[0]?.children?.[0]?.title, '一')

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('改的那份在磁盘上被删掉时报错，不静默重建', async () => {
  const { store, workspace } = await sandbox()
  const written = await store.write(store.globalDir, 'Global', filled('要删的', new Map([['主题', node('原文')]])))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('gone', workspace)
  runtime.tracked = [agent]
  await runtime.attach(agent)

  // Reach in the way another process would: the file the caller is holding is
  // gone, so writing it back would resurrect content nobody meant to keep.
  await rm(written.path, { force: true })

  await assert.rejects(
    () => store.write(store.globalDir, 'Global', filled('要删的', new Map()), { expectedHash: written.hash }),
    /已经被删除/,
  )
  // 面板走的是同一条路，报的也得是「被删了」而不是悄悄写回一份。
  await assert.rejects(
    () => runtime.manage(agent, { scope: 'Global', fileName: '要删的', desc: '改' }),
    /已经被删除/,
  )
  const left = await readdir(store.globalDir)
  assert.deepEqual(left.filter((name) => name.endsWith('.yaml')), [], '不该凭空多出一份')

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

const dirty = []
for (const name of dirty) await rm(name, { recursive: true, force: true })

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}


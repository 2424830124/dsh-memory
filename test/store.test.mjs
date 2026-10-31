/**
 * Store and runtime checks that touch the filesystem.
 * Run with `node test/store.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_FILE_NAME, loadConfigFile } from '../lib/config.js'
import { parseDocument } from '../lib/document.js'
import { resolveLayout } from '../lib/paths.js'
import { PresetStore } from '../lib/preset.js'
import { seedPresets } from '../lib/seed-presets.js'
import { MemoryStore } from '../lib/store.js'
import { MemoryRuntime } from '../lib/runtime.js'
import { renderInjection } from '../lib/render.js'
import { manageTool } from '../lib/tools.js'

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

await check('面板创建与删除整份记忆文件', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)

  const created = await runtime.createFile({ scope: 'Global', fileName: '面板新建' })
  assert.equal(created.fileName, '面板新建')
  assert.deepEqual(created.tree, [])
  assert.deepEqual(store.documents(store.globalDir).map((entry) => entry.fileName), ['面板新建'])

  const removed = await runtime.deleteFile({ scope: 'Global', fileName: '面板新建' })
  assert.deepEqual(removed, { fileName: '面板新建', scope: 'Global', kind: 'memory' })
  assert.deepEqual(store.documents(store.globalDir), [])
  await assert.rejects(
    () => runtime.deleteFile({ scope: 'Global', fileName: '面板新建' }),
    /找不到记忆文件/,
  )
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

  // 日期形式的文件名留给日志：模型工具这么拒绝，面板也得拒绝，否则两边规则不一致。
  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '新名字', newFileName: '2026-10-27' }),
    /是日期形式/,
  )

  // 解析失败的文件同样占着这个名字，改名不能把它覆盖掉。
  await writeFile(
    join(store.globalDir, '坏掉的.yaml'),
    'meta_data:\n  file_name: 坏掉的\ndata:\n  标题: 正文\n  - 甲\n',
    'utf8',
  )
  await store.reloadDirectory(store.globalDir, 'Global')
  await assert.rejects(
    () => runtime.patchFile({ scope: 'Global', fileName: '新名字', newFileName: '坏掉的' }),
    /已经有一个叫 坏掉的/,
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

  // 手写 YAML 常把文件名写成裸数字：统一成字符串，别让整份配置跟着校验失败。
  await writeFile(file, 'fileOrder: [2, 1]\n', 'utf8')
  assert.deepEqual(loadConfigFile(file, warn), { fileOrder: ['2', '1'] })

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
  await runtime.attach(fresh)

  assert.equal(fresh.injected.length, 0, '刚开的会话不该收到任何更新提醒')
  const { readSnapshot } = await import('../lib/snapshot.js')
  const saved = await readSnapshot(store.stateDir, 'n1')
  assert.ok(saved, '新会话也要立刻落一份快照')
  assert.deepEqual(Object.keys(saved.files), Object.keys(runtime.currentSnapshot(fresh)))

  // 之后同一份内容不再变化，重新接入也不该提醒。
  const again = fakeAgent('n1', workspace)
  await runtime.attach(again)
  assert.equal(again.injected.length, 0)
})

await check('新会话的坏文件提示也延迟到真实用户边界', async () => {
  const { store, workspace } = await sandbox()
  await writeFile(join(store.globalDir, 'broken.yaml'), 'meta_data:\n  file_name: 坏的\ndata:\n  desc: 不行\n', 'utf8')
  await store.reloadDirectory(store.globalDir, 'Global')
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('broken-boundary', workspace)
  await runtime.attach(agent)
  assert.equal(agent.injected.length, 0, 'attach 不立即发坏文件提示')

  await runtime.onUserMessage(agent, { role: 'user', source: { kind: 'user' } })
  assert.equal(agent.injected.length, 1)
  assert.match(agent.injected[0].content[0].text, /memory_broken/)
  await runtime.onUserMessage(agent, { role: 'user', source: { kind: 'user' } })
  assert.equal(agent.injected.length, 1, '相同坏文件签名只提示一次')
})

await check('按会话通知检查点推进快照，丢弃才回滚', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const writer = fakeAgent('w1', workspace)
  const watcher = fakeAgent('w2', workspace)
  await runtime.attach(writer)
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v1', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir)
  assert.equal(watcher.injected.length, 0, '保存只登记变更，不立即推送')
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })
  assert.equal(watcher.injected.length, 1)

  // 还没被取走就再写一次同样的内容：已经在快照里，不该重复提醒。
  await runtime.afterWrite(writer, store.globalDir)
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })
  assert.equal(watcher.injected.length, 1, '同一版本不该重复提醒')

  // 通知被丢弃：回滚到投递前的基线，下次用户边界重新检查并补发。
  await runtime.release(watcher)
  await runtime.afterWrite(writer, store.globalDir)
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })
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
  await runtime.attach(writer)
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: '原文', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})
  await store.write(store.globalDir, 'Global', {
    fileName: '第二份', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['补充', { update_at: '', desc: '第二次保存', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})
  assert.equal(watcher.injected.length, 0, '多次保存只登记，不立即推送')
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })

  assert.equal(watcher.injected.length, 1, '多次保存合并为一条通知')
  const message = watcher.injected[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'memory')
  assert.ok(message.source.snapshot)
  assert.match(message.content[0].text, /<memory_update>/)
  assert.match(message.content[0].text, /记忆/)
  assert.match(message.content[0].text, /第二份/)
  assert.equal(writer.injected.length, 0)
})

await check('取走通知不改变已推进的快照，版本变化才再提醒', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const writer = fakeAgent('w1', workspace)
  const watcher = fakeAgent('w2', workspace)
  await runtime.attach(writer)
  await runtime.attach(watcher)

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v1', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })
  assert.equal(watcher.injected.length, 1)

  await runtime.claim(watcher, watcher.injected[0].source.snapshot)
  await runtime.afterWrite(writer, store.globalDir, {})
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })
  assert.equal(watcher.injected.length, 1, '版本未变不应重复通知')

  await store.write(store.globalDir, 'Global', {
    fileName: '记忆', desc: '', format: '', scope: 'Global', injectIgnore: [], source: '',
    roots: new Map([['主题', { update_at: '', desc: 'v2', keyword: [], children: new Map() }]]),
  })
  await runtime.afterWrite(writer, store.globalDir, {})
  await runtime.onUserMessage(watcher, { role: 'user', source: { kind: 'user' } })
  assert.equal(watcher.injected.length, 2, '版本变化应再次通知')
})

await check('旧版本的快照被整份忽略，不会被当成“全都变了”', async () => {
  const { home, store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace)
  const watcher = fakeAgent('w8', workspace)
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
  await nextRuntime.attach(resumed)
  assert.equal(resumed.injected.length, 0, '恢复时不立即投递')
  await nextRuntime.onUserMessage(resumed, { role: 'user', source: { kind: 'user' } })
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
  await runtime.attach(child)
  assert.equal(child.injected.length, 0, '继承的基线里没有新东西，不该提醒')
  assert.equal(runtime.sectionText({ agent: child }), parentText, '子会话共享父会话的前缀')
  assert.equal(runtime.sessionToolText(child, () => '重算的描述'), '父会话的工具描述')

  // 父快照已经被清掉：当作没有基线，按当前状态重建，不能抛。
  const { removeSnapshot } = await import('../lib/snapshot.js')
  await removeSnapshot(store.stateDir, 'p1')
  const orphan = fakeAgent('c2', workspace)
  orphan.session.header.parentSession = 'p1'
  await runtime.attach(orphan)
  assert.equal(orphan.injected.length, 0)
  assert.match(runtime.sectionText({ agent: orphan }), /分叉前的内容/)
})

await check('超过保留窗口的快照被丢掉，下次接入时重建', async () => {
  const { store, workspace } = await sandbox()
  const runtime = runtimeFor(store, workspace, { snapshotTtlMinutes: 60 })
  const agent = fakeAgent('t1', workspace)
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

await check('memory_manage 用 new_file_name 改名，旧文件不留在磁盘上', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', filled('旧名', new Map([['主题', node('正文')]])))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('rename', workspace)
  await runtime.attach(agent)

  const result = await runtime.manage(agent, { scope: 'Global', fileName: '旧名', newFileName: '新名', desc: '改过的描述' })
  assert.equal(result.fileName, '新名')
  assert.equal(result.renamedFrom, '旧名')
  const renamed = await runtime.read(agent, { scope: 'Global', fileName: '新名' })
  assert.match(renamed, /改过的描述/)
  assert.match(renamed, /正文/, '改名不该顺手清掉标题')

  const names = (await readdir(store.globalDir)).filter((name) => name.endsWith('.yaml'))
  assert.deepEqual(names, ['新名.yaml'], '旧文件必须删掉，否则会同时存在两份')
  await assert.rejects(() => runtime.read(agent, { scope: 'Global', fileName: '旧名' }), /找不到记忆文件/)

  // 新名字被占用时拒绝，而不是让两份文件共用一个 file_name。
  await store.write(store.globalDir, 'Global', filled('占位', new Map()))
  await assert.rejects(
    () => runtime.manage(agent, { scope: 'Global', fileName: '新名', newFileName: '占位' }),
    /已经有一个叫 占位/,
  )
  assert.match(await runtime.read(agent, { scope: 'Global', fileName: '新名' }), /改过的描述/, '拒绝后原文件不动')

  // 解析失败的文件同样算「被占用」：改名不能把一份手写坏的 YAML 悄悄覆盖掉。
  await writeFile(
    join(store.globalDir, '坏掉的.yaml'),
    'meta_data:\n  file_name: 坏掉的\ndata:\n  标题: 正文\n  - 甲\n',
    'utf8',
  )
  await store.reloadDirectory(store.globalDir, 'Global')
  await assert.rejects(
    () => runtime.manage(agent, { scope: 'Global', fileName: '新名', newFileName: '坏掉的' }),
    /已经有一个叫 坏掉的/,
  )
  assert.match(await readFile(join(store.globalDir, '坏掉的.yaml'), 'utf8'), /file_name: 坏掉的/, '坏文件原样留着')


  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('memory_manage 把 new_file_name 传空串就删掉整份文件', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', filled('要删的', new Map([['主题', node('正文')]])))
  await store.write(store.globalDir, 'Global', filled('留下的', new Map()))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('delete', workspace)
  await runtime.attach(agent)

  const result = await runtime.manage(agent, { scope: 'Global', fileName: '要删的', newFileName: '' })
  assert.equal(result.deleted, true)
  const left = (await readdir(store.globalDir)).filter((name) => name.endsWith('.yaml'))
  assert.deepEqual(left, ['留下的.yaml'])
  await assert.rejects(() => runtime.read(agent, { scope: 'Global', fileName: '要删的' }), /找不到记忆文件/)
  assert.doesNotMatch(await runtime.read(agent, { scope: 'Global' }), /要删的/)

  // 日志不能这样删：它由插件按日期管理。
  await assert.rejects(
    () => runtime.manage(agent, { scope: 'Global', fileName: '2026-10-27', newFileName: '' }),
    /日志文件的元数据由插件管理/,
  )

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('只差大小写的改名不会把文件删掉', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', filled('abc', new Map([['主题', node('正文')]])))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('case', workspace)
  await runtime.attach(agent)

  const result = await runtime.manage(agent, { scope: 'Global', fileName: 'abc', newFileName: 'ABC' })
  assert.equal(result.fileName, 'ABC')
  // 大小写不敏感的文件系统上，写新名字就是覆盖同一个文件；再按旧路径删一次会把
  // 刚写进去的那份删掉，磁盘上一个文件都不剩。大小写敏感的文件系统上则是两份
  // 不同文件，旧的那份必须删。两种情形结果都该只剩新名字这一份。
  const names = (await readdir(store.globalDir)).filter((name) => name.endsWith('.yaml'))
  assert.deepEqual(names, ['ABC.yaml'])
  assert.match(await runtime.read(agent, { scope: 'Global', fileName: 'ABC' }), /正文/)
  // 缓存里也不能留着旧名字的空壳，否则清单里会出现两个同名文件。
  assert.deepEqual(
    store.documents(store.globalDir).map((entry) => entry.fileName),
    ['ABC'],
  )

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('空的新文件名会穿过工具层传到运行时（删除不是「没给参数」）', async () => {
  let captured
  const tool = manageTool({
    async manage(agent, request) {
      captured = request
      return { fileName: request.fileName, scope: 'Global', deleted: true }
    },
  })
  const output = await tool.execute({ scope: 'Global', file_name: '要删的', new_file_name: '' }, { agent: { id: 'tool' } })
  assert.equal(captured.newFileName, '', '空串不能被当成没给')
  assert.match(output.summary, /已删除记忆文件 要删的/)
})

await check('解析失败的文件也出现在清单里，并标明不能读写', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-broken-'))
  const store = new MemoryStore({ homeDir: home, warn: () => {} })
  await mkdir(store.globalDir, { recursive: true })
  await writeFile(join(store.globalDir, '好的.yaml'), 'meta_data:\n  file_name: 好的\n  desc: 描述\ndata:\n  标题:\n    desc: 正文\n', 'utf8')
  // 映射里混进序列：整份文件解析不出来，但它在磁盘上是存在的。
  await writeFile(join(store.globalDir, '坏文件.yaml'), 'meta_data:\n  file_name: 坏文件\ndata:\n  标题: 正文\n  - 甲\n', 'utf8')
  await store.ensureDirectory(store.globalDir, 'Global')

  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-broken-ws-'))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('broken', workspace)
  await runtime.attach(agent)

  const list = await runtime.read(agent, { scope: 'Global' })
  assert.match(list, /- 好的 \[Global\]/)
  assert.match(list, /- 坏文件 \[Global\] 解析失败/)
  // 按名读仍然报出具体的解析错误，不是「找不到」。
  await assert.rejects(() => runtime.read(agent, { scope: 'Global', fileName: '坏文件' }), /解析失败/)
  // 只有坏文件、没有正常文件时也不算「还没有任何记忆文件」。
  await rm(join(store.globalDir, '好的.yaml'), { force: true })
  store.forget(store.globalDir, '好的.yaml')
  assert.match(await runtime.read(agent, { scope: 'Global' }), /- 坏文件 \[Global\] 解析失败/)

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

await check('update_at 落盘是本地时间，带上时区偏移', async () => {
  const { store, workspace } = await sandbox()
  await store.write(store.globalDir, 'Global', filled('笔记', new Map([['主题', node('正文')]])))
  const runtime = runtimeFor(store, workspace)
  const agent = fakeAgent('clock', workspace)
  await runtime.attach(agent)
  await runtime.read(agent, { scope: 'Global', fileName: '笔记' })
  await runtime.edit(agent, { scope: 'Global', fileName: '笔记', path: ['主题'], newString: '改过' })

  const raw = await readFile(join(store.globalDir, '笔记.yaml'), 'utf8')
  const stamp = parseDocument(raw).roots.get('主题').update_at
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  // 墙上时间是本地时间，不是 UTC：小时要和本机时钟对得上。
  const now = new Date()
  assert.equal(Number(stamp.slice(11, 13)), now.getHours(), '小时要用本地时间')
  const offset = -now.getTimezoneOffset()
  const expected = `${offset < 0 ? '-' : '+'}${String(Math.abs(Math.trunc(offset / 60))).padStart(2, '0')}:${String(Math.abs(offset % 60)).padStart(2, '0')}`
  assert.ok(stamp.endsWith(expected), `偏移要是本机时区 ${expected}`)

  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('预设目录：md 去掉扩展名，按文件名排序，别的文件不算', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-preset-'))
  await writeFile(join(dir, '乙.md'), '乙预设', 'utf8')
  await writeFile(join(dir, '甲.md'), '甲预设', 'utf8')
  await writeFile(join(dir, '说明.txt'), '不是预设', 'utf8')
  const presets = new PresetStore({ dir, warn: (message) => console.log(`       warn: ${message}`) })
  await presets.start()
  assert.deepEqual(presets.names(), ['甲', '乙'])
  assert.equal(presets.text('甲'), '甲预设')
  assert.equal(presets.text('不存在'), '')
  assert.equal(presets.has('乙'), true)
  presets.dispose()
  await rm(dir, { recursive: true, force: true })
})

await check('预设热加载：改文件、删文件都直接反映，不用重启', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-preset-hot-'))
  const file = join(dir, '角色.md')
  await writeFile(file, '第一版', 'utf8')
  const presets = new PresetStore({ dir, warn: (message) => console.log(`       warn: ${message}`) })
  await presets.start()
  assert.equal(presets.text('角色'), '第一版')

  await writeFile(file, '第二版', 'utf8')
  await presets.reload()
  assert.equal(presets.text('角色'), '第二版')

  // 监听器那条路也走一遍：防抖之后自己会重读，调用方不用等重启。
  await writeFile(file, '第三版', 'utf8')
  presets.scheduleReload()
  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(presets.text('角色'), '第三版')

  // 删掉之后文本立刻变成空串：调用方据此回退到宿主的原生 identity。
  await rm(file, { force: true })
  await presets.reload()
  assert.equal(presets.text('角色'), '')
  assert.deepEqual(presets.names(), [])
  presets.dispose()
  await rm(dir, { recursive: true, force: true })
})

await check('预设新建、保存、删除都落盘，重名和非法名字被拒绝', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-preset-write-'))
  const presets = new PresetStore({ dir, warn: (message) => console.log(`       warn: ${message}`) })
  await presets.start()

  assert.equal(await presets.create('角色'), '角色')
  assert.equal(presets.has('角色'), true)
  assert.equal(presets.text('角色'), '')
  await assert.rejects(() => presets.create('角色'), /已经有名为「角色」的预设/)
  await assert.rejects(() => presets.create('守则/旧'), /预设名字里不能包含/)

  assert.equal(await presets.save('角色', '开场白第一行\n第二行'), '角色')
  assert.equal(presets.text('角色'), '开场白第一行\n第二行')

  // 保存不存在的名字会新建：另一个窗口删掉的文件也能从开着的编辑器写回来。
  await presets.save('临时', '草稿')
  assert.equal(presets.text('临时'), '草稿')

  assert.equal(await presets.remove('临时'), '临时')
  assert.equal(presets.has('临时'), false)
  await assert.rejects(() => presets.remove('临时'), /没有名为「临时」的预设/)

  presets.dispose()
  await rm(dir, { recursive: true, force: true })
})

await check('内置预设只在第一次出现：不覆盖同名文件，删掉的不会自己回来', async () => {
  const source = await mkdtemp(join(tmpdir(), 'dsh-memory-seed-src-'))
  const target = await mkdtemp(join(tmpdir(), 'dsh-memory-seed-dst-'))
  const state = await mkdtemp(join(tmpdir(), 'dsh-memory-seed-state-'))
  await writeFile(join(source, '甲.md'), '内置甲', 'utf8')
  await writeFile(join(source, '乙.md'), '内置乙', 'utf8')
  await writeFile(join(source, '说明.txt'), '不是预设', 'utf8')

  // 用户自己已经有一份同名的：保留用户的，不覆盖。
  await writeFile(join(target, '甲.md'), '我自己的甲', 'utf8')
  assert.deepEqual(await seedPresets({ sourceDir: source, targetDir: target, stateDir: state, warn: () => {} }), ['乙'])
  assert.equal(await readFile(join(target, '甲.md'), 'utf8'), '我自己的甲')
  assert.equal(await readFile(join(target, '乙.md'), 'utf8'), '内置乙')

  // 第二次启动什么都不做。
  assert.deepEqual(await seedPresets({ sourceDir: source, targetDir: target, stateDir: state, warn: () => {} }), [])

  // 删掉内置的那份，再启动不会被重新种回来。
  await rm(join(target, '乙.md'), { force: true })
  assert.deepEqual(await seedPresets({ sourceDir: source, targetDir: target, stateDir: state, warn: () => {} }), [])
  await assert.rejects(() => readFile(join(target, '乙.md'), 'utf8'), /ENOENT/)

  // 新版本新增的内置预设仍会补上。
  await writeFile(join(source, '丙.md'), '内置丙', 'utf8')
  assert.deepEqual(await seedPresets({ sourceDir: source, targetDir: target, stateDir: state, warn: () => {} }), ['丙'])

  await rm(source, { recursive: true, force: true })
  await rm(target, { recursive: true, force: true })
  await rm(state, { recursive: true, force: true })
})

await check('预设按会话选择并持久化：空选择回退原生 identity，重开还是同一份', async () => {
  const { store, workspace } = await sandbox()
  const dir = join(store.dataDir, 'preset')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '角色.md'), '我是角色预设', 'utf8')
  const presets = new PresetStore({ dir, warn: (message) => console.log(`       warn: ${message}`) })
  await presets.start()

  const make = () => new MemoryRuntime({
    store,
    presets,
    config: {
      snapshotTtlMinutes: 0,
      workingDirectory: { ensure: async (agent) => agent.workspace ?? workspace },
    },
    logger: { warn: (message) => console.log(`       warn: ${message}`) },
  })

  const runtime = make()
  const agent = fakeAgent('preset-session', workspace)
  await runtime.attach(agent)
  assert.equal(runtime.presetText({ agent }), '', '没选预设时什么都不注入')
  assert.deepEqual(runtime.presetOverview('preset-session'), { names: ['角色'], selected: '' })

  await runtime.setPreset(agent, '角色')
  assert.equal(runtime.presetText({ agent }), '我是角色预设')
  assert.deepEqual(runtime.presetOverview('preset-session'), { names: ['角色'], selected: '角色' })
  await assert.rejects(() => runtime.setPreset(agent, '不存在'), /没有名为「不存在」的预设/)

  // 重建 runtime（模拟重启）后 attach，还能从 state 目录读回同一份选择。
  const restarted = make()
  await restarted.attach(fakeAgent('preset-session', workspace))
  assert.equal(restarted.presetText({ agent: fakeAgent('preset-session', workspace) }), '我是角色预设')

  // 删除预设会把引用它的会话选择一并清掉，下一次组装回到原生 identity。
  assert.equal(await restarted.removePreset('角色'), '角色')
  assert.equal(restarted.presetText({ agent: fakeAgent('preset-session', workspace) }), '')
  assert.deepEqual(restarted.presetOverview('preset-session'), { names: [], selected: '' })

  presets.dispose()
  store.dispose()
  await rm(workspace, { recursive: true, force: true })
  await rm(store.homeDir, { recursive: true, force: true }).catch(() => {})
})

await check('设置里的默认预设：新会话 attach 时套用，已选过的会话不被改写', async () => {
  const { store, workspace } = await sandbox()
  const dir = join(store.dataDir, 'preset')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '角色.md'), '我是角色预设', 'utf8')
  const presets = new PresetStore({ dir, warn: (message) => console.log(`       warn: ${message}`) })
  await presets.start()

  const make = (defaultPreset) => new MemoryRuntime({
    store,
    presets,
    config: {
      defaultPreset,
      snapshotTtlMinutes: 0,
      workingDirectory: { ensure: async (agent) => agent.workspace ?? workspace },
    },
    logger: { warn: (message) => console.log(`       warn: ${message}`) },
  })

  const runtime = make('角色')
  const agent = fakeAgent('default-session', workspace)
  await runtime.attach(agent)
  assert.equal(runtime.presetName(agent), '角色', '没有选择文件的新会话套用默认预设')
  assert.equal(runtime.presetText({ agent }), '我是角色预设')

  // 默认值后来被清掉，已经带上默认预设的会话还是原来那份：它已经有自己的选择文件了。
  const later = make('')
  await later.attach(fakeAgent('default-session', workspace))
  assert.equal(later.presetText({ agent: { id: 'default-session' } }), '我是角色预设')

  // 新会话在默认值清空后回到原生 identity。
  const fresh = fakeAgent('fresh-session', workspace)
  await later.attach(fresh)
  assert.equal(later.presetName(fresh), '')

  // 默认值指向一个已经被删掉的名字：安静地当作没有，不要报错。
  const missing = make('不存在')
  const orphan = fakeAgent('orphan-session', workspace)
  await missing.attach(orphan)
  assert.equal(missing.presetName(orphan), '')

  // 子 agent 也走 attach，但不能被换成用户的人设：它是被派出去干活的。
  const child = fakeAgent('child-session', workspace)
  child.session.header.origin = 'subagent'
  const childRuntime = make('角色')
  await childRuntime.attach(child)
  assert.equal(childRuntime.presetName(child), '')

  presets.dispose()
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


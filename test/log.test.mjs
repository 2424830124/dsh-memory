/**
 * Short-term memory checks: the `log/` folder of date files.
 * Run with `node test/log.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyEdit } from '../lib/edit.js'
import {
  LOG_DESCS,
  formatLogDate,
  inTimeRange,
  isLogDate,
  logEntries,
  logReadRules,
  logRules,
  parseLogDateQuery,
  parseLogEntryTitle,
  parseLogTimeQuery,
} from '../lib/log.js'
import { createDocument } from '../lib/model.js'
import { parseDocument, serializeDocument } from '../lib/document.js'
import { selectLogInjection } from '../lib/log-injection.js'
import { MemoryRuntime } from '../lib/runtime.js'
import { MemoryStore } from '../lib/store.js'
import { editTool } from '../lib/tools.js'

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

/**
 * An agent that has not assembled a prompt yet.
 *
 * The injected memory block is frozen per session, so anything that asserts what
 * the prompt *would* say now needs a session that has not frozen a copy already.
 */
function freshAgent(id) {
  return { id, session: { header: {} }, injected: [], inject(message) { this.injected.push(message) } }
}

/** One empty log for a fixed date. */
function logOf(date = '2026-10-27', scope = 'Global') {
  return createDocument({ fileName: date, kind: 'log', scope })
}

/** The entries of one log, whatever its day level is called. */
function entriesOf(log) {
  return [...logEntries(log).map(([title]) => title)]
}

/** A throwaway store home. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-log-'))
  const store = new MemoryStore({ homeDir: home, warn: (message) => console.log(`       warn: ${message}`) })
  await store.ensureDirectory(store.globalDir, 'Global')
  return { home, store }
}

console.log('log')

await check('注入日志策略过滤空日并复用升序输入', () => {
  const filled = (date, body) => {
    const document = logOf(date)
    document.roots.set(date, {
      update_at: '',
      desc: '',
      keyword: [],
      children: new Map([[`09:00 ${body}`, { update_at: '', desc: body, keyword: [], children: new Map() }]]),
    })
    return { directory: 'global', document }
  }
  const files = [
    filled('2026-10-01', 'oldest'),
    { directory: 'global', document: logOf('2026-10-25') },
    filled('2026-10-26', 'middle'),
    filled('2026-10-27', 'newest'),
  ]
  const selected = selectLogInjection(files, { days: 2, detailDays: 1 })
  assert.deepEqual(selected.map(({ document }) => document.fileName), ['2026-10-26', '2026-10-27'])
  assert.deepEqual(selected.map(({ detail }) => detail), [false, true])
  assert.equal(selectLogInjection(files, { days: 0, detailDays: 2 }).length, 0)
  assert.deepEqual(
    selectLogInjection(files, { days: 5, detailDays: -1 }).map(({ detail }) => detail),
    [false, false, false],
  )
})

await check('日期只认真实存在的 YYYY-MM-DD', () => {
  assert.equal(isLogDate('2026-10-27'), true)
  assert.equal(isLogDate('2024-02-29'), true)
  assert.equal(isLogDate('2026-02-30'), false)
  assert.equal(isLogDate('2026-1-5'), false)
  assert.equal(isLogDate('我的记忆'), false)
  assert.equal(isLogDate(undefined), false)
  assert.match(formatLogDate(new Date(2026, 0, 5)), /^2026-01-05$/)
})

await check('条目标题拆成时分与摘要', () => {
  assert.deepEqual(parseLogEntryTitle('19:20 去了杭州'), { time: '19:20', summary: '去了杭州' })
  assert.deepEqual(parseLogEntryTitle('09:05'), { time: '09:05', summary: '' })
  assert.deepEqual(parseLogEntryTitle('  09:05   两个空格  '), { time: '09:05', summary: '两个空格' })
  assert.equal(parseLogEntryTitle('25:00 凌晨'), undefined)
  // 时分用冒号；连字符那种写法是别的形状，不当成条目。
  assert.equal(parseLogEntryTitle('19-20 去了杭州'), undefined)
  assert.equal(parseLogEntryTitle(undefined), undefined)
})

await check('file_name 能表达单日与日期范围', () => {
  assert.deepEqual(parseLogDateQuery('2026-10-27'), { from: '2026-10-27', to: '2026-10-27' })
  assert.deepEqual(parseLogDateQuery('2026-10-26..2026-10-27'), { from: '2026-10-26', to: '2026-10-27' })
  // A reversed range is accepted and straightened rather than rejected: the
  // model means the same days either way.
  assert.deepEqual(parseLogDateQuery('2026-10-27..2026-10-26'), { from: '2026-10-26', to: '2026-10-27' })
  assert.equal(parseLogDateQuery('我的记忆'), undefined)
  assert.equal(parseLogDateQuery(undefined), undefined)
  // A value shaped like a date but naming a day that does not exist is an
  // error, not a file name: falling through would report "找不到记忆文件".
  assert.throws(() => parseLogDateQuery('2026-02-30'), /不是真实存在的日期/)
  assert.throws(() => parseLogDateQuery('2026-10-26..2026-02-30'), /不是真实存在的日期/)
  assert.throws(() => parseLogDateQuery('2026-10-25..2026-10-26..2026-10-27'), /只能查一天或一个范围/)
  // 半截的范围要说清是范围写坏了，而不是当成文件名去找。
  assert.throws(() => parseLogDateQuery('2026-10-27..'), /两边都不能空/)
  assert.throws(() => parseLogDateQuery('..2026-10-27'), /两边都不能空/)
  // 范围用 ".."，不是路径分隔符 ">"。
  assert.equal(parseLogDateQuery('2026-10-26 > 2026-10-27'), undefined)
})

await check('heading_path 能表达时间范围，摘要和日期不算范围', () => {
  assert.deepEqual(parseLogTimeQuery(['19:20 去了杭州']), { from: '19:20', to: '19:20' })
  assert.deepEqual(parseLogTimeQuery(['19:20']), { from: '19:20', to: '19:20' })
  assert.deepEqual(parseLogTimeQuery(['12:00..14:00']), { from: '12:00', to: '14:00' })
  assert.deepEqual(parseLogTimeQuery(['14:00 下午..12:00 中午']), { from: '12:00', to: '14:00' })
  // A full heading path may carry the day level; it is dropped, not rejected.
  assert.deepEqual(parseLogTimeQuery(['2026-10-27', '19:20 去了杭州']), { from: '19:20', to: '19:20' })
  // Nothing but a day level means "the whole day", which is not a time range.
  assert.equal(parseLogTimeQuery(['2026-10-27']), undefined)
  assert.equal(parseLogTimeQuery(['不是时间']), undefined)
  assert.equal(parseLogTimeQuery(undefined), undefined)
  // 同一时刻可以有两条条目（标题不同），但两个不同的时刻分处两级不是范围。
  assert.equal(parseLogTimeQuery(['19:20 去了', '21:00 回来']), undefined)
  // 只有写在同一个标题里的 ".." 才是范围，两边都得是时分。
  assert.throws(() => parseLogTimeQuery(['19:20..']), /两边都要有时刻/)
  assert.throws(() => parseLogTimeQuery(['19:20..99:99']), /两边都要是时分/)
  assert.deepEqual(parseLogTimeQuery(['19:20..21:00']), { from: '19:20', to: '21:00' })
  assert.equal(inTimeRange('12:35 午饭', { from: '12:00', to: '14:00' }), true)
  assert.equal(inTimeRange('15:00 下午茶', { from: '12:00', to: '14:00' }), false)
  // 范围本身不成立时要报错，不能悄悄变成"一条都不要"。
  assert.throws(() => inTimeRange('12:35 午饭', { from: '12:00', to: '99:99' }), /时间范围不成立/)
  assert.throws(() => inTimeRange('12:35 午饭', { from: '12:00', to: undefined }), /时间范围不成立/)
})

await check('新建记忆文件不再因为缺 normalizeBody 而崩', () => {
  const document = createDocument({ fileName: '我的记忆', desc: '关于用户', format: '一条一件事' })
  assert.equal(document.kind, 'memory')
  assert.equal(document.desc, '关于用户')
  assert.equal(document.format, '一条一件事')
})

await check('日志的 desc 由 scope 写死，多一个别的字段就报错', async () => {
  const log = logOf()
  applyEdit(log, { path: ['2026-10-27', '09:00 起床'], newString: '赖了十分钟' }, '2026-10-27T01:00:00.000Z')
  const source = serializeDocument(log)
  assert.match(source, /^meta_data:\n {2}file_name: "?2026-10-27"?\n {2}desc: 用来记录和“他”之间的互动\n/)

  const reloaded = parseDocument(source, { kind: 'log', fileName: '2026-10-27' })
  assert.equal(reloaded.kind, 'log')
  assert.equal(reloaded.desc, '用来记录和“他”之间的互动')
  assert.deepEqual(entriesOf(reloaded), ['09:00 起床'])
  assert.equal(logEntries(reloaded)[0][1].desc, '赖了十分钟')

  // 两种 scope 各有一句写死的说明，模型写不进来别的。
  assert.equal(logOf('2026-10-27', 'Workspace').desc, '用来记录项目相关操作')
  // 旧文件没有 desc 时按 scope 补上，不用迁移。
  const old = parseDocument('meta_data:\n  file_name: 2026-10-27\ndata: {}\n', { kind: 'log', fileName: '2026-10-27', scope: 'Workspace' })
  assert.equal(old.desc, '用来记录项目相关操作')

  assert.throws(
    () => parseDocument('meta_data:\n  file_name: 2026-10-27\n  format: 不行\ndata: {}\n', { kind: 'log', fileName: '2026-10-27' }),
    /日志文件的 meta_data 只能写 file_name 和 desc/,
  )
})

await check('二级标题是「时分 摘要」，正文是细节', () => {
  const log = logOf()
  const outcome = applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], newString: '还是那家店，排队十分钟' }, 'T')
  assert.equal(outcome.created, true)
  assert.deepEqual(outcome.path, ['2026-10-27', '12:35 吃了面'])

  const day = log.roots.get('2026-10-27')
  assert.deepEqual([...day.children.keys()], ['12:35 吃了面'])
  assert.equal(day.children.get('12:35 吃了面').desc, '还是那家店，排队十分钟')
  // 二级标题没有子标题：细节就在 desc 里。
  assert.equal(day.children.get('12:35 吃了面').children.size, 0)
})

await check('写着日期那一级的路径也照样认', () => {
  const log = logOf()
  applyEdit(log, { path: ['2026-10-27', '19:20 去了杭州'], newString: '出差三天' }, 'T')
  assert.deepEqual(entriesOf(log), ['19:20 去了杭州'])
  assert.throws(
    () => applyEdit(log, { path: ['2026-10-26', '19:20 去了杭州'], newString: 'x' }, 'T'),
    /一级标题就是当天日期/,
  )
})

await check('没有 old_string 时是追加，摘要上限只管标题', () => {
  const log = logOf()
  applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], newString: '第一段' }, 'T')
  applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], newString: '第二段' }, 'T')
  assert.equal(logEntries(log)[0][1].desc, '第一段\n\n第二段')

  // 正文长度不限，摘要有上限。
  applyEdit(log, { path: ['2026-10-27', '12:36 长正文'], newString: '长'.repeat(400) }, 'T', { summaryMaxChars: 200 })
  assert.throws(
    () => applyEdit(log, { path: ['2026-10-27', `12:37 ${'长'.repeat(400)}`], newString: '正文' }, 'T', { summaryMaxChars: 200 }),
    /日志摘要最多 200 字/,
  )
})

await check('上限调低后，超长的旧摘要仍然改得动', () => {
  const log = logOf()
  // 先按旧上限（200）写一条 68 字的条目，再把上限当成 60 来改它：摘要没被改，
  // 就不该拦。以前这里校验的是路径里的原标题，改关键词、改正文全被挡回去。
  const summary = '长'.repeat(68)
  const title = `12:35 ${summary}`
  applyEdit(log, { path: ['2026-10-27', title], newString: '第一段' }, 'T')
  assert.equal(parseLogEntryTitle(title).summary, summary)

  applyEdit(log, { path: ['2026-10-27', title], newString: '第二段' }, 'T', { summaryMaxChars: 60 })
  assert.equal(logEntries(log)[0][1].desc, '第一段\n\n第二段')

  applyEdit(log, { path: ['2026-10-27', title], addKeywords: ['面'], removeKeywords: [] }, 'T', { summaryMaxChars: 60 })
  assert.deepEqual(logEntries(log)[0][1].keyword, ['面'])

  // 新建时才校验：同样长度换一条新条目，照样被拒。
  assert.throws(
    () => applyEdit(log, { path: ['2026-10-27', `12:40 ${summary}`], newString: '正文' }, 'T', { summaryMaxChars: 60 }),
    /日志摘要最多 60 字/,
  )
})

await check('条目按时间排序，不按写入顺序', () => {
  const log = logOf()
  applyEdit(log, { path: ['2026-10-27', '14:05 下午'], newString: 'x' }, 'T')
  applyEdit(log, { path: ['2026-10-27', '09:10 早上'], newString: 'x' }, 'T')
  applyEdit(log, { path: ['2026-10-27', '12:35 中午'], newString: 'x' }, 'T')
  assert.deepEqual(entriesOf(log), ['09:10 早上', '12:35 中午', '14:05 下午'])
})

await check('日志条目不能改名也不能删，正文开头不能是 #', () => {
  const log = logOf()
  applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], newString: '还是那家店' }, 'T')
  assert.throws(() => applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], removeOnly: true }, 'T'), /日志条目不能删除/)
  assert.throws(
    () => applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], newString: '## 新标题' }, 'T'),
    /开头都不能是 "#"/,
  )
  assert.throws(
    () => applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], oldString: '#吃了面', newString: '吃了面' }, 'T'),
    /开头都不能是 "#"/,
  )
  // 中间带 # 是普通正文，允许。
  applyEdit(log, { path: ['2026-10-27', '12:35 吃了面'], oldString: '还是那家店', newString: '还是那家 # 面馆' }, 'T')
  assert.equal(logEntries(log)[0][1].desc, '还是那家 # 面馆')
})

await check('关键词加在二级标题上，一级标题不沾', () => {
  const log = logOf()
  applyEdit(
    log,
    {
      path: ['2026-10-27', '12:35 吃了面'],
      newString: '还是那家店',
      addKeywords: ['午饭', '午饭'],
    },
    'T',
  )
  const day = [...log.roots.values()][0]
  assert.deepEqual(day.keyword, [])
  const entry = day.children.get('12:35 吃了面')
  assert.deepEqual(entry.keyword, ['午饭'])
  // 先建成再挂，同一次调用里写正文和关键词也成立。
  applyEdit(log, { path: ['2026-10-27', '13:00 接着聊'], newString: 'x', addKeywords: ['午饭'] }, 'T')
  assert.deepEqual(day.children.get('13:00 接着聊').keyword, ['午饭'])
})

await check('标题形状不对就直接拒绝', () => {
  const log = logOf()
  // 路径必须正好两级：一级是当天日期，二级是「时分 摘要」。
  assert.throws(() => applyEdit(log, { path: ['2026-10-27'], newString: 'x' }, 'T'), /要写成两级/)
  assert.throws(() => applyEdit(log, { path: ['19:20 去了杭州'], newString: 'x' }, 'T'), /要写成两级/)
  assert.throws(
    () => applyEdit(log, { path: ['2026-10-27', '19:20 去了杭州', '子标题'], newString: 'x' }, 'T'),
    /日志最多 2 级标题/,
  )
  // 一级标题只能是当天日期。
  assert.throws(() => applyEdit(log, { path: ['2026-10-26', '19:20 去了杭州'], newString: 'x' }, 'T'), /一级标题就是当天日期/)
  // 二级标题必须以「时分」开头（冒号分隔），且时分后面要有摘要。
  assert.throws(() => applyEdit(log, { path: ['2026-10-27', '25:00 凌晨'], newString: 'x' }, 'T'), /要以时分开头/)
  assert.throws(() => applyEdit(log, { path: ['2026-10-27', '19-20 去了杭州'], newString: 'x' }, 'T'), /要以时分开头/)
  assert.throws(() => applyEdit(log, { path: ['2026-10-27', '19:20'], newString: 'x' }, 'T'), /要在时分后面写一句摘要/)
})

await check('旧形状（一级直接是时间）的文件会被拒绝', () => {
  const source = 'meta_data:\n  file_name: 2026-10-27\ndata:\n  12:35:\n    desc: 吃了面\n'
  assert.throws(() => parseDocument(source, { kind: 'log', fileName: '2026-10-27' }), /一级标题就是当天日期/)
})

await check('日志放在 log/ 里，不混进文件清单', async () => {
  const { home, store } = await sandbox()
  const log = logOf('2026-10-27')
  applyEdit(log, { path: ['2026-10-27', '09:10 早上'], newString: '吃了面' }, 'T')
  await store.write(store.globalDir, 'Global', log)

  const onDisk = await readFile(join(store.globalDir, 'log', '2026-10-27.yaml'), 'utf8')
  assert.match(onDisk, /file_name/)
  assert.equal(store.logFile(store.globalDir, '2026-10-27').document.kind, 'log')
  assert.equal(store.logFile(store.globalDir, '2026-10-26'), undefined)
  assert.deepEqual(store.documents(store.globalDir), [])
  assert.deepEqual(store.logDocuments(store.globalDir).map((entry) => entry.fileName), ['2026-10-27'])
  store.dispose()
  await rm(home, { recursive: true, force: true })
})

await check('工具描述告诉模型怎么写日志', () => {
  const edit = logRules(200)
  assert.match(edit, /yyyy-mm-dd > ## hh:mm/)
  assert.match(edit, /200/)
  assert.match(edit, /一级是当天日期/)
  assert.doesNotMatch(edit, /例如/, '描述里不放具体例子，容易误导')
  assert.match(logReadRules(), /yyyy-mm-dd/)
})

// ---------------------------------------------------------------- 与 runtime 一起

/** A runtime over a throwaway home, with no workspace directory. */
async function runtimeSandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-rt-'))
  const store = new MemoryStore({ homeDir: home, warn: (message) => console.log(`       warn: ${message}`) })
  const runtime = new MemoryRuntime({
    store,
    config: {
      snapshotTtlMinutes: 60,
      logSummaryMaxChars: 12,
      workingDirectory: { ensure: async () => undefined },
    },
    logger: { warn: (message) => console.log(`       warn: ${message}`) },
  })
  const agent = { id: 'a1', session: { header: {} }, injected: [], inject(message) { this.injected.push(message) } }
  await runtime.start()
  await runtime.attach(agent)
  return { home, store, runtime, agent }
}

await check('启动时建好当天的日志，并允许按日期写', async () => {
  const { home, store, runtime, agent } = await runtimeSandbox()
  const today = formatLogDate()
  assert.equal(store.logFile(store.globalDir, today).document.kind, 'log')

  // 没读过就写，先被读取守卫拦住，而不是被当成普通文件。
  await assert.rejects(
    () => runtime.edit(agent, { fileName: today, path: [today, '09:10 起床'], newString: '赖床' }),
    /必须先用 memory_read/,
  )

  await runtime.read(agent, { fileName: today })
  const result = await runtime.edit(agent, { fileName: today, path: [today, '09:10 起床'], newString: '赖床' })
  assert.equal(result.outcome.created, true)
  assert.match(await runtime.read(agent, { fileName: today }), /起床/)
})

await check('写不存在的日期会报错，而不是新建一个没人看的文件', async () => {
  const { home, store, runtime, agent } = await runtimeSandbox()
  await assert.rejects(
    () => runtime.edit(agent, { fileName: '2020-01-01', path: ['2020-01-01', '09:10 很久以前'], newString: 'x' }),
    /没有 2020-01-01 的日志文件/,
  )
  // Reading a missing day spells the date once, not as "X 到 X".
  await assert.rejects(() => runtime.read(agent, { fileName: '2020-01-01' }), /没有 2020-01-01 的日志文件/)
})

await check('按日期和日期范围读日志，可再按时间收窄', async () => {
  const { home, store, runtime, agent } = await runtimeSandbox()
  const today = formatLogDate()
  await runtime.read(agent, { fileName: today })
  await runtime.edit(agent, { fileName: today, path: [today, '09:10 早上'], newString: '吃了面' })
  await runtime.edit(agent, { fileName: today, path: [today, '12:35 中午'], newString: '开会' })
  await runtime.edit(agent, { fileName: today, path: [today, '18:00 晚上'], newString: '散步' })

  const whole = await runtime.read(agent, { fileName: today })
  assert.match(whole, /09:10 早上/)
  assert.match(whole, /18:00 晚上/)

  const noon = await runtime.read(agent, { fileName: today, headingPath: ['12:00..14:00'] })
  assert.match(noon, /12:35 中午/)
  assert.doesNotMatch(noon, /09:10 早上/)

  // 一个标题路径也能精确读一条。
  const one = await runtime.read(agent, { fileName: today, headingPath: ['12:35 中午'] })
  assert.match(one, /12:35 中午/)
  assert.doesNotMatch(one, /18:00 晚上/)

  // 同一个会话里读第二天会失败，因为那天的文件还不存在。
  const tomorrow = formatLogDate(new Date(Date.now() + 86400000))
  await assert.rejects(() => runtime.read(agent, { fileName: tomorrow }), /没有/)
})

await check('两天一起读：一份头部，日期之间用 --- 隔开', async () => {
  const { home, store, runtime, agent } = await runtimeSandbox()
  const today = formatLogDate()
  const yesterday = formatLogDate(new Date(Date.now() - 86400000))

  // 昨天的文件只能直接落盘：工具按设计只写当天。
  const earlier = logOf(yesterday)
  applyEdit(earlier, { path: [yesterday, '21:30 昨天的摘要'], newString: '昨天写的东西' }, 'T')
  await store.write(store.globalDir, 'Global', earlier)

  await runtime.read(agent, { fileName: `${yesterday}..${today}` })
  await runtime.edit(agent, { fileName: today, path: [today, '19:20 今天的摘要'], newString: '今天写的东西' })
  const text = await runtime.read(agent, { fileName: `${yesterday}..${today}` })

  assert.equal(text, [
    '---',
    'desc: 用来记录和“他”之间的互动',
    'scope: Global',
    '---',
    '',
    `# ${yesterday}`,
    '',
    '## 21:30 昨天的摘要',
    `- Update at: ${earlier.roots.get(yesterday).children.get('21:30 昨天的摘要').update_at}`,
    '昨天写的东西',
    '',
    '---',
    '',
    `# ${today}`,
    '',
    '## 19:20 今天的摘要',
    `- Update at: ${store.logFile(store.globalDir, today).document.roots.get(today).children.get('19:20 今天的摘要').update_at}`,
    '今天写的东西',
  ].join('\n'))
  // 日期那一级只是分组，不带任何元数据。
  assert.doesNotMatch(text, new RegExp(`# ${today}\\n- `))

  // 快照是 fire-and-forget 写的，拆除目录前要等它落完，否则它会重建 sessions/。
  await runtime.flush()
  store.dispose()
  await rm(home, { recursive: true, force: true })
})

await check('日志默认不进提示词，打开 injectLog 后新会话才带上', async () => {
  const { home, store, runtime, agent } = await runtimeSandbox()
  const today = formatLogDate()
  // 有正文的记忆文件才进注入：只剩文件头的文件整份跳过，所以这里得挂一个标题。
  await store.write(
    store.globalDir,
    'Global',
    parseDocument('meta_data:\n  file_name: 我的记忆\n  desc: 关于用户\n  scope: Global\ndata:\n  关于用户:\n    desc: 喜欢喝乌龙\n'),
  )
  await runtime.read(agent, { fileName: today })
  await runtime.edit(agent, { fileName: today, path: [today, '09:10 早上'], newString: '吃了面' })

  const list = await runtime.read(agent, {})
  assert.match(list, /我的记忆/)
  assert.doesNotMatch(list, new RegExp(today))

  const injected = runtime.sectionText({ agent })
  assert.match(injected, /我的记忆/)
  assert.doesNotMatch(injected, /09:10 早上/)

  // 打开注入：已经在跑的会话仍拿原来那份（注入文本冻结，否则每次改配置都会
  // 把前缀缓存冲掉），新开的会话才按新配置渲染。
  runtime.config.injectLog = true
  assert.equal(runtime.sectionText({ agent }), injected, '老会话的注入文本不随配置变')

  const fresh = freshAgent('a2')
  const withLog = runtime.sectionText({ agent: fresh })
  assert.match(withLog, new RegExp(today))
  assert.match(withLog, /## 09:10 早上/)
  assert.match(withLog, /我的记忆/)

  // 摘要注入时原样照搬：长度在上游（logSummaryMaxChars）就卡住了，这里不再截一次。
  await runtime.edit(agent, { fileName: today, path: [today, '09:11 写了一很长的摘要'], newString: 'x' })
  const newest = freshAgent('a3')
  assert.match(runtime.sectionText({ agent: newest }), /## 09:11 写了一很长的摘要/)
})

await check('工具的返回文案：日期只出现一次，挂关键词不算空改', async () => {
  const { home, store, runtime, agent } = await runtimeSandbox()
  const today = formatLogDate()
  const edit = editTool(runtime)
  const call = async (args) => {
    await runtime.read(agent, { fileName: args.file_name })
    return edit.execute(args, { agent })
  }

  const created = await call({ scope: 'Global', file_name: today, heading_path: `# ${today} > ## 19:20 定了返回格式`, new_string: '正文' })
  // 日志的一级标题就是 file_name，不能再在文案里重复一遍。
  assert.equal(created.summary, `[Global] 已新建 ${today} > 19:20 定了返回格式\n正文`)

  // 只挂关键词不改正文：既不报「没有给出要改动的内容」，也不回显正文。
  const keyed = await call({ scope: 'Global', file_name: today, heading_path: `# ${today} > ## 19:20 定了返回格式`, add_keyword: ['返回格式'] })
  assert.equal(keyed.summary, `[Global] 已更新 ${today} > 19:20 定了返回格式`)

  // 快照是 fire-and-forget 写的，拆除目录前要等它落完，否则它会重建 sessions/。
  await runtime.flush()
  store.dispose()
  await rm(home, { recursive: true, force: true })
})

await check('注入只取各作用域最新的几天，最新的带正文、更早的只剩概括', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-rt-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
  const store = new MemoryStore({ homeDir: home, warn: (message) => console.log(`       warn: ${message}`) })
  await store.ensureDirectory(store.globalDir, 'Global')
  const runtime = new MemoryRuntime({
    store,
    config: {
      snapshotTtlMinutes: 60,
      logSummaryMaxChars: 12,
      injectLog: true,
      workingDirectory: { ensure: async () => workspace },
    },
    logger: { warn: (message) => console.log(`       warn: ${message}`) },
  })
  const agent = { id: 'a1', session: { header: {} }, injected: [], inject(message) { this.injected.push(message) } }
  await runtime.start()
  await runtime.attach(agent)

  // One day's file, built directly: the tool only ever writes today's log, but
  // injection has to cope with a history that accumulated over weeks.
  const dayOf = (date, scope, body) => ({
    fileName: date,
    desc: LOG_DESCS[scope],
    format: '',
    scope,
    kind: 'log',
    injectIgnore: [],
    roots: new Map([
      [
        date,
        {
          update_at: '',
          desc: '',
          keyword: [],
          children: new Map([
            [`09:00 信号 ${body}`, { update_at: '', desc: `正文 ${body}`, keyword: ['日志'], children: new Map() }],
          ]),
        },
      ],
    ]),
    source: '',
  })

  // Four global days and three workspace days. The count is what matters: with
  // three injected global days the oldest (`2026-09-09`) has to fall out.
  const workspaceDir = store.workspaceDir(workspace)
  for (const [date, body] of [['2026-09-09', 'G1'], ['2026-10-01', 'G2'], ['2026-10-26', 'G3'], ['2026-10-27', 'G4']]) {
    await store.write(store.globalDir, 'Global', dayOf(date, 'Global', body))
  }
  for (const [date, body] of [['2026-02-01', 'W1'], ['2026-10-26', 'W2'], ['2026-10-27', 'W3']]) {
    await store.write(workspaceDir, 'Workspace', dayOf(date, 'Workspace', body))
  }

  const injected = runtime.sectionText({ agent })
  assert.match(injected, /2026-10-27/)
  assert.match(injected, /2026-10-26/)
  assert.match(injected, /2026-10-01/, '第三天（按日期倒推）应该进来')
  assert.doesNotMatch(injected, /2026-09-09/, '更早的全局日志不该进来')
  assert.doesNotMatch(injected, /2026-02-01/, '更早的工作区日志不该进来')

  // 每个作用域的日志各带一个文件头（desc + scope）：同一天两边都写过时，
  // 只看日期分不出是哪一份。
  assert.equal((injected.match(/^scope: Global$/gm) ?? []).length, 1, '全局日志有自己的文件头')
  assert.equal((injected.match(/^scope: Workspace$/gm) ?? []).length, 1, '工作区日志有自己的文件头')
  assert.match(injected, new RegExp(`desc: ${LOG_DESCS.Global}`))
  assert.match(injected, new RegExp(`desc: ${LOG_DESCS.Workspace}`))
  // 日期写成一级标题：它既是日志的 file_name，也是写条目时 heading_path 的第一段。
  assert.match(injected, /^# 2026-10-27$/m, '注入里的日期要写成一级标题')
  // 组头写 `kind: log` 而不是具体日期：一个头管好几天，写具体日期就等于说这组都是那一天；
  // 用英文技术名则是因为记忆文件的名字是随便起的，任何中文标签都可能被真文件占用。
  assert.equal((injected.match(/^kind: log$/gm) ?? []).length, 2, '每个作用域的日志组头各有一行 kind')
  assert.doesNotMatch(injected, /^file_name: 2026-/m, '日志组头不能写具体日期')
  assert.doesNotMatch(injected, /^file_name: <yyyy-mm-dd>$/m, '日志组头不该再出 file_name 行')

  // The newest day of each scope keeps its body; the older ones are summary lines.
  assert.match(injected, /正文 G4/)
  assert.doesNotMatch(injected, /正文 G3|正文 G2/, '只有最新的那一天带正文')
  assert.match(injected, /## 09:00 信号 G3/)

  // Numbers are configurable, and a scope can be switched off entirely. A new
  // session picks up the new plan; the one already running keeps the text it
  // froze, because re-rendering it would discard the provider's cached prefix.
  assert.equal(runtime.sectionText({ agent }), injected, '老会话的注入文本不随配置变')
  runtime.config.logInjectGlobalDays = 2
  runtime.config.logInjectGlobalDetailDays = 2
  runtime.config.logInjectWorkspaceDays = 0
  const narrowed = runtime.sectionText({ agent: freshAgent('a4') })
  assert.doesNotMatch(narrowed, /2026-10-01/, '全局只留两天')
  assert.match(narrowed, /正文 G3/, '两天都带正文')
  assert.doesNotMatch(narrowed, /W3/, '工作区那两天被关掉了')

  // A day with no entry must not consume the configured window. The chosen
  // days must still follow their date order after the empty one is filtered out.
  const emptyDay = { ...dayOf('2026-10-25', 'Global', 'EMPTY'), roots: new Map() }
  await store.write(store.globalDir, 'Global', emptyDay)
  runtime.config.logInjectGlobalDays = 3
  const afterEmpty = runtime.sectionText({ agent: freshAgent('a-empty') })
  assert.doesNotMatch(afterEmpty, /2026-10-25/)
  assert.match(afterEmpty, /2026-10-01/)
  assert.match(afterEmpty, /2026-10-26/)
  assert.match(afterEmpty, /2026-10-27/)

  // detailDays larger than days is clamped rather than reaching past the list.
  runtime.config.logInjectGlobalDays = 1
  runtime.config.logInjectGlobalDetailDays = 5
  assert.match(runtime.sectionText({ agent: freshAgent('a5') }), /正文 G4/)

  // 快照是 fire-and-forget 写的，拆除目录前要等它落完，否则它会重建 sessions/。
  await runtime.flush()
  store.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`)
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}

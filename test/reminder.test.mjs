/**
 * Reminder checks: the turn policy, the message it produces, and the counter the
 * runtime keeps on disk. Run with `node test/reminder.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONFIG_FIELD_BY_KEY, formatScalar, readField } from '../lib/config-schema.js'
import { loadConfigFile, saveConfigValue } from '../lib/config.js'
import {
  countUserMessages,
  reminderDue,
  reminderMessage,
  reminderStatePath,
  renderReminder,
  withReminder,
} from '../lib/reminder.js'
import { MemoryRuntime } from '../lib/runtime.js'
import { MemoryStore } from '../lib/store.js'

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

/** One real user message, as the host hands it to a step. */
function userMessage(id, text = '你好') {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc-1' } }
}

/** A message another plugin authored into the same step. */
function pluginMessage(id) {
  return { id, role: 'user', content: [{ type: 'text', text: '别的插件' }], source: { kind: 'plugin:other', form: 'notice', summary: 'x' } }
}

/** A notice this plugin queued into the inbox. */
function noticeMessage(id) {
  return { id, role: 'user', content: [{ type: 'text', text: '<memory_update>' }], source: { kind: 'memory' } }
}

/** One pre-step decision carrying the given messages. */
function step(...messages) {
  return { kind: 'enter', messages }
}

/** Build a throwaway home plus one workspace. */
async function sandbox() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-home-'))
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-memory-ws-'))
  const store = new MemoryStore({ homeDir: home, warn: (message) => console.log(`       warn: ${message}`) })
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
  return new MemoryRuntime({
    store,
    config: {
      snapshotTtlMinutes: 0,
      workingDirectory: { ensure: async (agent) => agent.workspace ?? workspace },
      ...extra,
    },
    logger: { warn: (message) => console.log(`       warn: ${message}`) },
  })
}

console.log('reminder')

await check('轮数只数真实用户消息', async () => {
  assert.equal(countUserMessages(undefined), 0)
  assert.equal(countUserMessages([pluginMessage('a'), noticeMessage('b')]), 0)
  const scheduled = { id: 'c', role: 'user', content: [{ type: 'text', text: '定时任务' }], source: { kind: 'schedule' } }
  assert.equal(countUserMessages([scheduled]), 0, '定时消息不是用户发的')
  assert.equal(countUserMessages([pluginMessage('a'), userMessage('b'), userMessage('c')]), 2)
})

await check('到期判定看的是这一步跨过了哪一轮', async () => {
  assert.equal(reminderDue(0, 1, 3), false)
  assert.equal(reminderDue(1, 3, 3), true)
  assert.equal(reminderDue(2, 4, 3), true, '一步里跨过第 3 轮也要触发一次')
  assert.equal(reminderDue(3, 4, 3), false, '同一轮里不该重复触发')
  assert.equal(reminderDue(5, 6, 3), true, '第 6 轮')
  assert.equal(reminderDue(2, 2, 3), false)
  assert.equal(reminderDue(0, 1, 0), false, '0 是关')
  assert.equal(reminderDue(0, 1, Number.NaN), false)
})

await check('提示是一条独立消息，插在最后一条用户消息后面', async () => {
  const reminder = reminderMessage({ text: '记得写日志', turns: 2, id: 'reminder' })
  const messages = [userMessage('u1'), pluginMessage('p1'), noticeMessage('n1')]
  const placed = withReminder(messages, reminder)

  assert.deepEqual(placed.map((message) => message.id), ['u1', 'reminder', 'p1', 'n1'])
  assert.deepEqual(messages.map((message) => message.id), ['u1', 'p1', 'n1'], '原数组不动')
  assert.equal(placed[1].source.kind, 'plugin:dsh-memory')
  assert.equal(placed[1].role, 'user')
  assert.equal(Object.hasOwn(placed[1].source, 'plugin'), false, '来源是 kind，不是 plugin 字段')

  // 没有用户消息时挂到末尾：真发生了也不该插到别的消息前面去。
  assert.deepEqual(withReminder([pluginMessage('p1')], reminder).map((message) => message.id), ['p1', 'reminder'])
})

await check('提示正文带标签，并说明它不是新的请求', async () => {
  const text = renderReminder('记得写日志', 6)
  assert.match(text, /^<memory_reminder>\n/)
  assert.match(text, /第 6 轮/)
  assert.match(text, /不是新的请求/)
  assert.match(text, /记得写日志/)
  assert.match(text, /<\/memory_reminder>$/)

  const message = reminderMessage({ text: '记得写日志', turns: 6, id: 'fixed' })
  assert.equal(message.id, 'fixed')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.summary, '第 6 轮提示')
  assert.equal(message.content[0].text.includes('记得写日志'), true)
})

await check('runtime：到点才注入，计数按会话存在 state 里', async () => {
  const { home, workspace, store } = await sandbox()
  const runtime = runtimeFor(store, workspace, { reminderEvery: 2, reminderText: '记得写日志' })
  const agent = fakeAgent('remind-session', workspace)

  const first = await runtime.reminderStep(agent, step(userMessage('u1')))
  assert.equal(first.messages.length, 1, '第 1 轮还没到')

  const second = await runtime.reminderStep(agent, step(userMessage('u2')))
  assert.deepEqual(second.messages.map((message) => message.source.kind), ['user', 'plugin:dsh-memory'])
  assert.match(second.messages[1].content[0].text, /记得写日志/)
  assert.match(second.messages[1].content[0].text, /第 2 轮/)

  const third = await runtime.reminderStep(agent, step(userMessage('u3')))
  assert.equal(third.messages.length, 1)
  const fourth = await runtime.reminderStep(agent, step(userMessage('u4')))
  assert.equal(fourth.messages.length, 2)

  const saved = JSON.parse(await readFile(reminderStatePath(store.stateDir, 'remind-session'), 'utf8'))
  assert.equal(saved.turns, 4)

  // 换一个 runtime 就是重启一次：接着数，不是从头开始。
  const restarted = runtimeFor(store, workspace, { reminderEvery: 2, reminderText: '记得写日志' })
  const fifth = await restarted.reminderStep(agent, step(userMessage('u5')))
  assert.equal(fifth.messages.length, 1, '第 5 轮')
  const sixth = await restarted.reminderStep(agent, step(userMessage('u6')))
  assert.equal(sixth.messages.length, 2, '第 6 轮')

  store.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

await check('runtime：一步里两条用户消息，也只按跨过的倍数注入一次', async () => {
  const { home, workspace, store } = await sandbox()
  const runtime = runtimeFor(store, workspace, { reminderEvery: 3, reminderText: '提示' })
  const agent = fakeAgent('burst-session', workspace)

  const first = await runtime.reminderStep(agent, step(userMessage('u1')))
  assert.equal(first.messages.length, 1)
  const burst = await runtime.reminderStep(agent, step(userMessage('u2'), userMessage('u3')))
  assert.equal(burst.messages.length, 3, '两条用户消息 + 一条提示')
  assert.equal(burst.messages[2].source.kind, 'plugin:dsh-memory')
  assert.match(burst.messages[2].content[0].text, /第 3 轮/)

  store.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

await check('runtime：关着、没有文本、没有用户消息时都不动 decision', async () => {
  const { home, workspace, store } = await sandbox()
  const agent = fakeAgent('off-session', workspace)
  const decision = step(userMessage('u1'))

  const off = runtimeFor(store, workspace, { reminderEvery: 0, reminderText: '记得写日志' })
  assert.equal(await off.reminderStep(agent, decision), decision, '0 轮就是关')
  const skip = { kind: 'skip' }
  assert.equal(await off.reminderStep(agent, skip), skip, '不是一次要提交消息的步骤就原样返回')

  const blank = runtimeFor(store, workspace, { reminderEvery: 1, reminderText: '   ' })
  assert.equal(await blank.reminderStep(agent, decision), decision, '没写文本等于没开')

  const bare = runtimeFor(store, workspace)
  assert.equal(await bare.reminderStep(agent, decision), decision, '配置里没有这一项也要按关处理')

  const on = runtimeFor(store, workspace, { reminderEvery: 1, reminderText: '提示' })
  const pluginOnly = step(pluginMessage('p1'))
  assert.equal(await on.reminderStep(agent, pluginOnly), pluginOnly, '没有用户消息就没有轮')
  const wait = { kind: 'wait' }
  assert.equal(await on.reminderStep(agent, wait), wait)

  store.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

await check('runtime：子 agent 不计数也不注入', async () => {
  const { home, workspace, store } = await sandbox()
  const runtime = runtimeFor(store, workspace, { reminderEvery: 1, reminderText: '提示' })
  const child = fakeAgent('child-session', workspace)
  child.session.header.origin = 'subagent'

  const decision = step(userMessage('u1'))
  assert.equal(await runtime.reminderStep(child, decision), decision)

  const path = reminderStatePath(store.stateDir, 'child-session')
  assert.equal(await stat(path).then(() => true, () => false), false, '子 agent 连计数文件都不该有')

  store.dispose()
  await rm(home, { recursive: true, force: true })
  await rm(workspace, { recursive: true, force: true })
})

await check('配置：轮数必须是整数，提示文本可以带换行地存回 config.yaml', async () => {
  const every = CONFIG_FIELD_BY_KEY.get('reminderEvery')
  assert.equal(readField(every, 3).ok, true)
  assert.equal(readField(every, 0).ok, true)
  assert.equal(readField(every, -1).ok, false)
  assert.equal(readField(every, 1.5).ok, false)
  assert.equal(readField(every, '3').ok, false)

  const text = CONFIG_FIELD_BY_KEY.get('reminderText')
  assert.equal(text.multiline, true)
  assert.equal(readField(text, '记得写日志\n别忘记更新记忆').ok, true)
  assert.equal(readField(text, 7).ok, false)

  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-cfg-'))
  const file = join(dir, 'config.yaml')
  await writeFile(file, '# 这行注释要留着\nreminderEvery: 0\n', 'utf8')
  saveConfigValue(file, 'reminderEvery', formatScalar(3))
  saveConfigValue(file, 'reminderText', formatScalar('记得写日志\n别忘记更新记忆'))

  const loaded = loadConfigFile(file, (message) => console.log(`       warn: ${message}`))
  assert.equal(loaded.reminderEvery, 3)
  assert.equal(loaded.reminderText, '记得写日志\n别忘记更新记忆', '换行要原样读回来')
  const raw = await readFile(file, 'utf8')
  assert.match(raw, /# 这行注释要留着/, '写得回去，也留得住注释')
  assert.match(raw, /^reminderEvery: 3$/m)
  assert.equal(raw.split('\n').length, 4, '多行文本写成一行转义，不铺开')

  await rm(dir, { recursive: true, force: true })
})

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}

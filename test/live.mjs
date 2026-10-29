/**
 * Live end-to-end test: a real model drives the three memory tools.
 *
 * Every scenario boots the real `MemoryStore` + `MemoryRuntime` against a fresh
 * temporary directory, injects the rendered memory block as the system prompt,
 * and lets the model call `memory_read` / `memory_edit` / `memory_manage` in a
 * normal tool loop. The tool results are then asserted against the YAML on disk,
 * so a scenario only passes when the model reached the intended file state.
 *
 * Usage:
 *   node test/live.mjs                # every scenario
 *   node test/live.mjs append multi   # only the named ones
 *
 * Environment:
 *   QNAIGC_API_KEY  read from ~/.dsh/.credentials.yaml when unset
 *   LIVE_MODEL      model id, default deepseek/deepseek-v4.1-flash-1017
 *   KEEP=1          keep the temporary directories for inspection
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseDocument } from '../lib/document.js'
import { findNode } from '../lib/tree.js'
import { MemoryRuntime } from '../lib/runtime.js'
import { MemoryStore } from '../lib/store.js'
import { editTool, manageTool, readTool } from '../lib/tools.js'

const ENDPOINT = 'https://api.qnaigc.com/v1/chat/completions'
const MODEL = process.env.LIVE_MODEL ?? 'deepseek/deepseek-v4.1-flash-1017'
const MAX_TURNS = Number(process.env.LIVE_TURNS ?? 8)

/** The fixture every scenario starts from. */
const FIXTURE = `meta_data:
  file_name: 我的记忆
  desc: 记录我和用户之间的一些回忆，以及我想要记住的事
  scope: Global
  format: |-
    用来记录关于用户本人的事实、偏好，以及我们一起做过的事。
    新增内容优先放到已有的合适标题下；只有确实不属于任何现有标题时才新建。
    正文写成第三人称的短句，一条一件事，不要写成流水账。
data:
  关于用户:
    update_at: 2026-10-27T03:58:20.035Z
    desc: 一些稳定的偏好和习惯。
    称呼:
      update_at: 2026-10-27T03:58:20.035Z
      desc: 习惯用中文交流，喜欢直接给结论，不喜欢客套。
    正在做的事:
      update_at: 2026-10-27T03:58:20.035Z
      desc: 在做 dsh-memory 插件。
  工具:
    update_at: 2026-10-27T03:58:20.035Z
    desc: 关于工具选择的一些记录。
    常用:
      update_at: 2026-10-27T03:58:20.035Z
      desc: 优先用 pwsh 而不是 bash。
`

/** A second file, used by the multi scenario. */
const FIXTURE_LOG = `meta_data:
  file_name: 日志
  desc: 平时做过的事情的流水账
  scope: Global
  format: |-
    按日期记录，每天一个一级标题，时间段一个二级标题。
data:
  2026-10-27:
    update_at: 2026-10-27T03:58:20.035Z
    desc: 今天的记录。
    21:30:
      update_at: 2026-10-27T03:58:20.035Z
      desc: 把记忆插件的 description 精简到 342 字符。
`

/**
 * Read the API key from the environment or the DSH credentials file.
 * @returns {Promise<string>} the key.
 */
async function apiKey() {
  if (process.env.QNAIGC_API_KEY) return process.env.QNAIGC_API_KEY
  const path = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', '.credentials.yaml')
  const text = await readFile(path, 'utf8')
  const match = text.match(/QNAIGC_API_KEY:\s*"?([^"\s]+)"?/)
  if (match === null) throw new Error('找不到 QNAIGC_API_KEY')
  return match[1]
}

/** One booted scenario environment. */
class Env {
  constructor(root) {
    this.root = root
    this.home = join(root, 'home')
    this.workspace = join(root, 'ws')
    this.globalDir = join(this.home, '.dsh', 'dsh-memory', '.memory')
    this.workspaceMemoryDir = join(this.workspace, '.memory')
    this.warnings = []
  }

  async boot() {
    await mkdir(this.globalDir, { recursive: true })
    await mkdir(this.workspace, { recursive: true })
    await writeFile(join(this.globalDir, '我的记忆.yaml'), FIXTURE, 'utf8')
    await writeFile(join(this.globalDir, '日志.yaml'), FIXTURE_LOG, 'utf8')

    this.store = new MemoryStore({
      homeDir: this.home,
      globalDir: this.globalDir,
      warn: (message) => this.warnings.push(message),
    })
    this.runtime = new MemoryRuntime({
      store: this.store,
      config: {
        snapshotTtlMinutes: 60,
        workingDirectory: { ensure: async () => this.workspace },
      },
      logger: { warn: (message) => this.warnings.push(message) },
    })
    await this.runtime.start()
    this.agent = { id: 'live', session: { header: {} } }
    await this.runtime.attach(this.agent)
    this.tools = {
      memory_read: readTool(this.runtime),
      memory_edit: editTool(this.runtime),
      memory_manage: manageTool(this.runtime),
    }
    this.injection = this.runtime.sectionText({ agent: this.agent })
    return this
  }

  /** Raw YAML of one file, from either scope. */
  async yaml(fileName) {
    for (const dir of [this.globalDir, this.workspaceMemoryDir]) {
      try {
        return await readFile(join(dir, `${fileName}.yaml`), 'utf8')
      } catch {
        // try the next scope
      }
    }
    throw new Error(`找不到记忆文件 ${fileName}`)
  }

  /** One parsed document. */
  async doc(fileName) {
    return parseDocument(await this.yaml(fileName), { fileName })
  }

  /** The `desc` of one heading, `undefined` when the heading is missing. */
  async desc(fileName, path) {
    const node = findNode(await this.doc(fileName), path)
    return node?.desc
  }

  /** The node itself, for keyword assertions. */
  async node(fileName, path) {
    return findNode(await this.doc(fileName), path)
  }

  /** The prompt text the model would see after the edits so far. */
  injectionNow() {
    return this.runtime.sectionText({ agent: this.agent })
  }

  async dispose() {
    try {
      this.store.dispose()
    } catch {
      // best effort
    }
    if (process.env.KEEP !== '1') await rm(this.root, { recursive: true, force: true })
  }
}

/**
 * One model call, with retries for transport errors and transient statuses.
 * @param {object[]} messages - the conversation so far.
 * @param {object[]} tools - OpenAI-shaped tool definitions.
 * @param {string} key - the API key.
 * @returns {Promise<object>} the assistant message.
 */
async function callModel(messages, tools, key) {
  for (let attempt = 1; ; attempt += 1) {
    let response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', temperature: 0.2 }),
      })
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
      continue
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt >= 4) throw new Error(`模型接口返回 ${response.status}: ${(await response.text()).slice(0, 300)}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
      continue
    }
    if (!response.ok) throw new Error(`模型接口返回 ${response.status}: ${(await response.text()).slice(0, 600)}`)
    const data = await response.json()
    return data.choices?.[0]?.message ?? { content: '' }
  }
}

/** System prompt: the memory block plus the rules a real session gets. */
function systemPrompt(env) {
  return [
    '你是一个长期记忆助手的执行部分。下面是你当前记住的全部内容：',
    '',
    env.injection,
    '',
    '规则：',
    '1. 需要改记忆时一定要调用工具，不要只在回复里描述你打算怎么改。',
    '2. 改之前先用 memory_read 读目标位置，返回的内容逐字符一致才拿来做 old_string。',
    '3. 完成后再用一句话说明你做了什么。',
  ].join('\n')
}

/**
 * Run one scenario: boot, chat, assert.
 * @param {object} scenario - the scenario description.
 * @param {string} key - the API key.
 * @returns {Promise<object>} the result summary.
 */
async function runScenario(scenario, key) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-live-'))
  const env = await new Env(root).boot()
  const calls = []
  const messages = [
    { role: 'system', content: systemPrompt(env) },
    { role: 'user', content: scenario.task },
  ]
  const toolDefs = Object.values(env.tools).map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))

  let reply = ''
  let turns = 0
  try {
    for (; turns < MAX_TURNS; turns += 1) {
      const message = await callModel(messages, toolDefs, key)
      reply = message.content ?? ''
      const outgoing = { role: 'assistant', content: reply }
      if (message.reasoning_content) outgoing.reasoning_content = message.reasoning_content
      if (message.tool_calls?.length > 0) outgoing.tool_calls = message.tool_calls
      messages.push(outgoing)
      if (!message.tool_calls?.length) break

      for (const call of message.tool_calls) {
        let args = {}
        try {
          args = JSON.parse(call.function.arguments ?? '{}')
        } catch {
          args = { __raw: call.function.arguments }
        }
        const record = { name: call.function.name, args, ok: true, text: '' }
        try {
          const tool = env.tools[call.function.name]
          if (tool === undefined) throw new Error(`没有 ${call.function.name} 这个工具`)
          const value = await tool.execute(args, { agent: env.agent })
          record.text = tool.output.render(args, value).map((part) => part.text).join('')
        } catch (error) {
          record.ok = false
          record.text = `错误：${error?.message ?? error}`
        }
        calls.push(record)
        messages.push({ role: 'tool', tool_call_id: call.id, content: record.text })
      }
    }

    if (scenario.check) await scenario.check({ env, calls, messages, reply })
    return { name: scenario.name, ok: true, turns: turns + 1, calls, reply, warnings: env.warnings }
  } catch (error) {
    return {
      name: scenario.name,
      ok: false,
      turns: turns + 1,
      calls,
      reply,
      error: error?.message ?? String(error),
      warnings: env.warnings,
    }
  } finally {
    await env.dispose()
  }
}

/** Assertion helper that carries a readable Chinese message. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Whether any call matched a predicate. */
function some(calls, name, predicate = () => true) {
  return calls.some((call) => call.name === name && predicate(call))
}

/** Every scenario. */
const SCENARIOS = [
  {
    name: 'append',
    task: '把“喜欢喝美式咖啡”记到 我的记忆 的 关于用户 > 称呼 里，一句话，跟已有的内容放在一起。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const desc = await env.desc('我的记忆', ['关于用户', '称呼'])
      check(typeof desc === 'string' && desc.includes('美式'), `称呼 里没有出现“美式”，实际是：${JSON.stringify(desc)}`)
      check(!desc.includes('不喜欢客套') || desc.includes('习惯用中文交流'), '原有内容被整段冲掉了')
    },
  },
  {
    name: 'create',
    task: '在 我的记忆 的 关于用户 下面新建一个二级标题 偏好，正文写“喜欢在晚上写代码。”',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const desc = await env.desc('我的记忆', ['关于用户', '偏好'])
      check(typeof desc === 'string' && desc.includes('晚上写代码'), `偏好 的正文不对：${JSON.stringify(desc)}`)
      const parent = await env.desc('我的记忆', ['关于用户'])
      check(parent.includes('稳定的偏好'), '父标题原有的正文被覆盖了')
    },
  },
  {
    name: 'rename',
    task: '把 我的记忆 里 工具 > 常用 这个标题改名成 首选，正文不动。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const renamed = await env.desc('我的记忆', ['工具', '首选'])
      check(typeof renamed === 'string' && renamed.includes('pwsh'), `首选 不存在或正文丢了：${JSON.stringify(renamed)}`)
      const old = await env.node('我的记忆', ['工具', '常用'])
      check(old === undefined, '旧标题 常用 还在')
    },
  },
  {
    name: 'delete',
    task: '删掉 日志 里 2026-10-27 > 21:30 这个二级标题，它下面的内容一起删。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const node = await env.node('日志', ['2026-10-27', '21:30'])
      check(node === undefined, '21:30 没有被删掉')
      const parent = await env.desc('日志', ['2026-10-27'])
      check(parent.includes('今天的记录'), '删子标题时把父标题的正文也带走了')
    },
  },
  {
    name: 'keyword',
    task: '给 我的记忆 的 关于用户 > 正在做的事 加上关键词 “dsh-memory” 和 “记忆插件”。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const node = await env.node('我的记忆', ['关于用户', '正在做的事'])
      check(Array.isArray(node?.keyword), 'keyword 字段不存在')
      check(node.keyword.includes('dsh-memory') && node.keyword.includes('记忆插件'), `keyword 不对：${JSON.stringify(node.keyword)}`)
    },
  },
  {
    name: 'ambiguous',
    task: '把 我的记忆 的 关于用户 > 称呼 里的第一个“喜欢”改成“偏爱”，别的一律不动。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const desc = await env.desc('我的记忆', ['关于用户', '称呼'])
      check(typeof desc === 'string' && desc.includes('偏爱直接给结论'), `没有精确改到那一处：${JSON.stringify(desc)}`)
      check(desc.includes('不喜欢客套'), `把另一处“喜欢”也改掉了：${JSON.stringify(desc)}`)
      check(desc.split('喜欢').length - 1 === 1, `“喜欢”剩下 ${desc.split('喜欢').length - 1} 处，应该只留“不喜欢客套”那一处：${JSON.stringify(desc)}`)
      check(desc.includes('习惯用中文交流'), '开头那句被动了')
    },
  },
  {
    name: 'missing-heading',
    task: '先看看 我的记忆 里有没有 关于用户 > 宠物 这个标题，有的话把内容念给我；然后不管有没有，都在 关于用户 下面新建 宠物，正文写“养了一只叫豆豆的猫。”',
    async check({ env, calls }) {
      check(some(calls, 'memory_read'), '模型没有先读')
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const desc = await env.desc('我的记忆', ['关于用户', '宠物'])
      check(typeof desc === 'string' && desc.includes('豆豆'), `宠物 的正文不对：${JSON.stringify(desc)}`)
    },
  },
  {
    name: 'mismatch',
    task: '把 我的记忆 的 工具 > 常用 里的“优先用 pwsh 而不是 bash。”改成“命令行一律用 pwsh。”。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const desc = await env.desc('我的记忆', ['工具', '常用'])
      check(desc === '命令行一律用 pwsh。', `结果不对：${JSON.stringify(desc)}`)
    },
  },
  {
    name: 'manage-create',
    task: '新建一个 Workspace 记忆文件，file_name 叫 项目笔记，desc 写“当前工作区的项目笔记”，format 写“按主题分组，每个主题一个一级标题。”。建完在它下面写一条：# 进度 里写“Windows 上已经跑通插件的三个工具。”',
    async check({ env, calls }) {
      check(some(calls, 'memory_manage'), '模型没有调用 memory_manage')
      const yaml = await env.yaml('项目笔记')
      check(yaml.includes('scope: Workspace'), '新建的文件不是 Workspace')
      check(yaml.includes('按主题分组'), 'format 没写进去')
      const desc = await env.desc('项目笔记', ['进度'])
      check(typeof desc === 'string' && desc.includes('三个工具'), `进度 的正文不对：${JSON.stringify(desc)}`)
    },
  },
  {
    name: 'manage-meta',
    task: '第一步：给 我的记忆 的 工具 > 常用 加上关键词 “pwsh优先”。第二步：把 我的记忆 的 inject_ignore 设成 ["keyword"]，别的元数据不动。做完告诉我，注入给模型的记忆里还能不能看到 “pwsh优先” 这个词？',
    async check({ env, calls, reply }) {
      check(some(calls, 'memory_manage'), '模型没有调用 memory_manage')
      const doc = await env.doc('我的记忆')
      check(JSON.stringify(doc.injectIgnore ?? []).includes('keyword'), 'inject_ignore 没写进去')
      const node = await env.node('我的记忆', ['工具', '常用'])
      check(Array.isArray(node?.keyword) && node.keyword.includes('pwsh优先'), `keyword 没加上：${JSON.stringify(node?.keyword)}`)
      const injection = env.injectionNow()
      check(!injection.includes('pwsh优先'), '设了 inject_ignore: keyword 之后关键词仍然出现在注入里')
      check(injection.includes('优先用 pwsh 而不是 bash'), '正文被 keyword 的 ignore 规则一起吞了')
      check(/不能|看不到|不再/.test(reply), `模型没有正确回答注入里还有没有这个词：${reply}`)
    },
  },
  {
    name: 'no-tool',
    task: '我让你记住：我养了一只叫豆豆的猫。你现在就把这件事写进 我的记忆。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit') || some(calls, 'memory_manage'), '模型只是嘴上答应，没有真的写')
      const text = await env.yaml('我的记忆')
      check(text.includes('豆豆'), '记忆文件里没有出现“豆豆”')
    },
  },
  {
    name: 'multi',
    task: '一次做完两件事，都落在 我的记忆 的 关于用户 > 正在做的事 上：1) 正文末尾追加一句“现在在做真实模型测试。”；2) 加关键词 “live-test”。',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const node = await env.node('我的记忆', ['关于用户', '正在做的事'])
      check(typeof node?.desc === 'string' && node.desc.includes('真实模型测试'), `正文没追加：${JSON.stringify(node?.desc)}`)
      check(node.desc.includes('在做 dsh-memory 插件'), '追加时把原有正文覆盖了')
      check(Array.isArray(node.keyword) && node.keyword.includes('live-test'), `关键词没加上：${JSON.stringify(node?.keyword)}`)
    },
  },
  {
    name: 'depth3',
    task: '在 我的记忆 里新建三级标题：# 项目 > ## dsh-memory > ### 测试，正文写“用七牛云的 deepseek 模型跑端到端测试。”',
    async check({ env, calls }) {
      check(some(calls, 'memory_edit'), '模型没有调用 memory_edit')
      const desc = await env.desc('我的记忆', ['项目', 'dsh-memory', '测试'])
      check(typeof desc === 'string' && desc.includes('七牛云'), `三级标题没建出来：${JSON.stringify(desc)}`)
      check(env.injectionNow().includes('### 测试'), '三级标题没有进入注入内容')
    },
  },
]

/**
 * Deterministic error paths, no model involved: run the calls a confused model
 * would make and print exactly the message it would read back.
 * @returns {Promise<void>} completion.
 */
async function runErrorCases() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-memory-errors-'))
  const env = await new Env(root).boot()
  const run = async (tool, args) => {
    try {
      const value = await env.tools[tool].execute(args, { agent: env.agent })
      return `（成功）${env.tools[tool].output.render(args, value).map((part) => part.text).join('')}`
    } catch (error) {
      return error?.message ?? String(error)
    }
  }
  try {
    await run('memory_read', { scope: 'Global', file_name: '我的记忆' })
    await run('memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 一个特别长的标题名字用来触发中间截断', new_string: '正文' })
    await run('memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 一个特别长的标题名字用来触发中间截断 > ## 另一个同样很长的标题名字用来触发截断', new_string: '正文' })
    await run('memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 一个特别长的标题名字用来触发中间截断 > ## 另一个同样很长的标题名字用来触发截断 > ### 第三层也很长的标题名字', new_string: '正文' })
    const cases = [
      ['读一个不存在的文件', 'memory_read', { scope: 'Global', file_name: '不存在的文件' }],
      ['读一个不存在的标题', 'memory_read', { scope: 'Global', file_name: '我的记忆', heading_path: '# 关于用户 > ## 宠物' }],
      ['没读过就改', 'memory_edit', { scope: 'Global', file_name: '日志', heading_path: '# 2026-10-27 > ## 21:30', new_string: '改一下' }],
      ['old_string 对不上', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 工具 > ## 常用', old_string: '优先用 bash', new_string: 'x' }],
      ['old_string 出现多次', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 关于用户 > ## 称呼', old_string: '喜欢', new_string: '偏爱' }],
      ['改标题时 # 个数不对', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 工具 > ## 常用', old_string: '## 常用', new_string: '### 首选' }],
      ['改标题时 old_string 不是标题行', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 工具 > ## 常用', old_string: '常用', new_string: '## 首选' }],
      ['未知参数', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 工具 > ## 常用', keyword: ['x'] }],
      ['缺必填参数', 'memory_edit', { heading_path: '# 工具' }],
      ['什么都没给', 'memory_edit', { scope: 'Global', file_name: '日志', heading_path: '# 2026-10-27 > ## 21:30', new_string: '' }],
      ['heading_path 有的段带 # 有的不带', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 工具 > 常用', new_string: 'x' }],
      ['heading_path 全都不带 #（允许）', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '工具 > 常用', old_string: '优先用 pwsh 而不是 bash。', new_string: '优先用 pwsh，不用 bash。' }],
      ['heading_path 用数组形式（也收）', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: ['# 工具', '## 常用'], old_string: '优先用 pwsh，不用 bash。', new_string: '优先用 pwsh。' }],
      ['标题用保留字', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 关于用户 > ## desc', new_string: 'x' }],
      ['标题超过 3 级', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# a > ## b > ### c > #### d', new_string: 'x' }],
      ['新建时上级不存在', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 项目 > ## dsh-memory > ### 测试', new_string: 'x' }],
      ['新建标题却在正文里写了标题行', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 关于用户 > ## 宠物', new_string: '## 宠物\n养了一只猫。' }],
      ['正文里混进 #', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 工具 > ## 常用', new_string: '补充一句\n# 这是伪标题' }],
      ['长标题改名（结果中间省略）', 'memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 一个特别长的标题名字用来触发中间截断 > ## 另一个同样很长的标题名字用来触发截断 > ### 第三层也很长的标题名字', old_string: '### 第三层也很长的标题名字', new_string: '### 第三层换成一个新的同样很长的名字' }],
      ['scope 写错', 'memory_manage', { scope: 'global', new_file_name: '新文件' }],
      ['新建一个重名文件', 'memory_manage', { scope: 'Global', new_file_name: '我的记忆' }],
      ['新建时没给文件名', 'memory_manage', { scope: 'Global' }],
    ]
    for (const [label, tool, args] of cases) {
      console.log(`— ${label} —`)
      console.log(`  ${tool} ${JSON.stringify(args)}`)
      console.log(`  → ${await run(tool, args)}\n`)
    }

    // Another process changes the file after this session read it: the write
    // must be refused instead of silently overwriting the other edit.
    const target = join(env.globalDir, '我的记忆.yaml')
    await run('memory_read', { scope: 'Global', file_name: '我的记忆' })
    const outside = (await readFile(target, 'utf8')).replace('在做 dsh-memory 插件。', '在做 dsh-memory 插件，顺便修了个 bug。')
    await writeFile(target, outside, 'utf8')
    console.log('— 读到之后别的进程改了文件 —')
    console.log(`  ${await run('memory_edit', { scope: 'Global', file_name: '我的记忆', heading_path: '# 关于用户 > ## 正在做的事', new_string: '在这句后面追加' })}\n`)
  } finally {
    await env.dispose()
  }
}

const wanted = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
if (wanted.includes('errors')) {
  await runErrorCases()
  process.exit(0)
}

const selected = wanted.length === 0 ? SCENARIOS : SCENARIOS.filter((item) => wanted.includes(item.name))
if (selected.length === 0) {
  console.error(`没有匹配的场景，可选：${SCENARIOS.map((item) => item.name).join(', ')}`)
  process.exit(2)
}

const key = await apiKey()
console.log(`模型 ${MODEL}，共 ${selected.length} 个场景\n`)

const LIMIT = Number(process.env.LIVE_CONCURRENCY ?? 3)
const results = []
let cursor = 0
/** Worker: pull the next scenario until the queue is empty. */
async function worker() {
  while (cursor < selected.length) {
    const index = cursor
    cursor += 1
    const started = Date.now()
    const result = await runScenario(selected[index], key)
    result.durationMs = Date.now() - started
    results[index] = result
    const mark = result.ok ? '通过' : '失败'
    console.log(`${mark}  ${result.name}  ${(result.durationMs / 1000).toFixed(1)}s  ${result.calls.length} 次工具调用`)
    if (!result.ok) console.log(`      ${result.error}`)
  }
}
await Promise.all(Array.from({ length: Math.min(LIMIT, selected.length) }, worker))

console.log('')
for (const result of results) {
  console.log(`— ${result.name} —`)
  if (result.calls.length === 0) console.log('  （没有工具调用）')
  for (const call of result.calls) {
    const args = JSON.stringify(call.args)
    const text = String(call.text).replace(/\n/g, ' ⏎ ')
    console.log(`  ${call.ok ? '·' : 'x'} ${call.name} ${args.length > 160 ? `${args.slice(0, 160)}…` : args}`)
    console.log(`    → ${text.length > 220 ? `${text.slice(0, 220)}…` : text}`)
  }
  if (result.reply) console.log(`  回复：${result.reply.replace(/\n/g, ' ').slice(0, 200)}`)
}

const passed = results.filter((result) => result.ok).length
console.log(`\n${passed}/${results.length} 通过`)
process.exit(passed === results.length ? 0 : 1)

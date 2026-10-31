/**
 * dsh-memory: cross-session long-term memory for DeepSeek Harness.
 *
 * Memory lives in YAML files on disk: one file per memory "notebook", a heading
 * tree inside each. The model reads and edits headings through three tools, sees
 * the tree in its system prompt, and is told — without being woken up — when
 * another session changed something it had already seen.
 *
 * Every hook below is contained: a memory failure returns an empty result or a
 * warning, never an exception thrown into prompt assembly, agent creation, or
 * the tool pipeline. Breaking those would break every unrelated request.
 *
 * @module dsh-memory
 */

import z from '@deepseek-ai/schemastery'

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_FIELDS, defaultSettings } from './lib/config-schema.js'
import { CONFIG_FILE_NAME, loadConfigFile } from './lib/config.js'
import { resolveLayout } from './lib/paths.js'
import { PRESET_DIR_NAME, PresetStore } from './lib/preset.js'
import { seedPresets } from './lib/seed-presets.js'
import { overrideHarnessIdentity, overridePersona } from './lib/prompt-override.js'
import { MemoryRuntime } from './lib/runtime.js'
import { SETTINGS_ROUTE, createSettingsHandler } from './lib/settings-route.js'
import { MemoryStore } from './lib/store.js'
import { isSubagentAgent } from './lib/subagent.js'
import { TOOL_NAMES, editTool, manageTool, readTool, renderEditDescription } from './lib/tools.js'

export const name = 'memory'

export const inject = ['tools', 'systemPrompt']

/**
 * Turn one field description into its Schemastery validator.
 * @param {import('./lib/config-schema.js').ConfigField} field - the field to describe.
 * @returns {object} the schema for that field.
 */
function fieldSchema(field) {
  switch (field.type) {
    case 'boolean':
      return z.boolean().default(Boolean(field.default))
    case 'number': {
      let schema = z.number().step(1)
      if (field.min !== undefined) schema = schema.min(field.min)
      return schema.default(field.default)
    }
    case 'list':
      return z.array(z.string()).default([...field.default])
    default:
      return z.string().default(String(field.default))
  }
}

/** Every setting, validated by the same list the panel is built from. */
export const Config = z.object(Object.fromEntries(CONFIG_FIELDS.map((field) => [field.key, fieldSchema(field)])))

/**
 * Resolve the effective settings.
 *
 * The profile config is the baseline; `<dataDir>/config.yaml` overrides it,
 * because that file sits next to the memory it configures and is the one a user
 * opens. Both go through the same schema, so a key cannot mean different things
 * depending on its source.
 *
 * @param {object|undefined} config - the profile configuration.
 * @param {(message: string) => void} warn - diagnostic sink.
 * @returns {object} settings with every field resolved, plus `configFile`.
 */
function resolveSettings(config, warn) {
  const base = config ?? {}
  // 路径不对外开放配置：目录只由 `resolveLayout()` 的默认值决定（`DSH_HOME` 或
  // `~/.dsh`），这样记忆永远和 Harness 自己的数据放在一起，不会因为一个手写
  // 路径而突然读到别处去。
  const layout = resolveLayout()
  const configFile = join(layout.dataDir, CONFIG_FILE_NAME)
  const fromFile = loadConfigFile(configFile, warn)

  // 只喂字段表认识的键：手写的 config.yaml 里留着的旧键不能把整份配置带崩。
  const known = (source) => {
    const picked = {}
    for (const field of CONFIG_FIELDS) {
      if (source[field.key] !== undefined) picked[field.key] = source[field.key]
    }
    return picked
  }

  let settings
  try {
    settings = Config(known({ ...base, ...fromFile }))
  } catch (error) {
    warn(`memory: 配置项有误，已忽略（${error?.message ?? error}）`)
    try {
      settings = Config(known(base))
    } catch {
      settings = undefined
    }
  }

  // Schema first, then whatever the profile passed, then the declared default.
  // The fallbacks only matter for an `apply()` reached without validation.
  const resolved = defaultSettings()
  for (const field of CONFIG_FIELDS) {
    const validated = settings?.[field.key]
    if (validated !== undefined) {
      resolved[field.key] = validated
      continue
    }
    if (base[field.key] !== undefined) resolved[field.key] = base[field.key]
  }
  resolved.configFile = configFile
  return resolved
}

/**
 * Activate the memory plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {object} config - the resolved plugin configuration.
 */
export function apply(ctx, config) {
  const warn = (message) => {
    try {
      ctx.logger.warn(message)
    } catch {
      // Logging must never be the reason a request fails.
    }
  }

  // Schemastery applies the field defaults before `apply` runs; resolveSettings
  // re-checks them so an unvalidated apply() (unit tests build one by hand)
  // still gets a complete configuration.
  const settings = resolveSettings(config, warn)

  // 路径不进配置：`MemoryStore` 自己用 `resolveLayout()` 的默认值（`DSH_HOME` 或
  // `~/.dsh`），这里不传任何目录，免得看起来像还能配。
  const store = new MemoryStore({ warn })

  // 预设：`<dataDir>/preset/*.md`，文件名（去掉 `.md`）就是预设名。一个会话
  // 选中哪份，就把哪份写进宿主的 harness identity；目录被监听，改文件、加文件
  // 都会直接反映到下一次组装，不需要重启。换成哪份由面板的「预设」页签决定，
  // 这里只提供 `runtime.setPreset()`。
  const presets = new PresetStore({ dir: join(store.dataDir, PRESET_DIR_NAME), warn })

  const runtime = new MemoryRuntime({
    store,
    presets,
    // The resolved settings are handed over whole: the runtime reads the keys it
    // needs, so a field added to `Config` reaches it without a second list here.
    // 取服务推迟到调用时：本插件可能比 workingDirectory 先挂上，启动那一刻它是空的。
    config: { ...settings, workingDirectory: () => ctx.get('workingDirectory') },
    logger: { warn },
  })

  ctx.effect(() => {
    store.onChange(({ directory }) => {
      try {
        runtime.broadcast(directory)
      } catch (error) {
        warn(`memory: 处理记忆变更失败 ${error?.message ?? error}`)
      }
    })
    return () => {
      runtime.stop()
      store.dispose()
      presets.dispose()
    }
  }, 'memory.watch()')

  // 内置预设：包里的 `presets/*.md` 在第一次启动时拷进用户的预设目录。只拷
  // 没见过的名字（`state/presets-seeded.json` 记着给过哪些），所以改过的不会被
  // 覆盖，删掉的也不会再冒出来；后来版本新增的预设仍会补上。
  const bundledPresets = fileURLToPath(new URL('./presets/', import.meta.url))
  seedPresets({
    sourceDir: bundledPresets,
    targetDir: join(store.dataDir, PRESET_DIR_NAME),
    stateDir: store.stateDir,
    warn,
  })
    .catch((error) => warn(`memory: 复制内置预设失败 ${error?.message ?? error}`))
    .then(() => presets.start())
    .catch((error) => warn(`memory: 初始化预设目录失败 ${error?.message ?? error}`))
  runtime.start().catch((error) => warn(`memory: 初始化失败 ${error?.message ?? error}`))

  // The settings panel needs somewhere to save to. A profile without a Web
  // server (a headless run) simply has no panel, which is not a failure.
  ctx.inject(['webServer'], (web) => {
    web.effect(() => web.webServer.register({
      kind: 'exact',
      path: SETTINGS_ROUTE,
      handler: createSettingsHandler({ file: settings.configFile, runtime }),
    }), 'memory.settingsRoute()')
  })

  // 注入不注册自己的分节，而是改写组装好的结果：记忆写进宿主 persona 前缀段
  //（`deployment:persona-prefix`，order 0），选中的预设写进 harness identity
  //（`harness:identity`，order -1000）。两段换完之后，提示词最开头就是预设和
  // 记忆，原来的 persona 与 identity 都不在了。
  //
  // 不能自己注册同名分节：分节按作用域分层，preset 已经在这个会话的 agent
  // 作用域里注册了 persona 段，再注册会撞 "already registered"；harness
  // identity 又只在宿主开着 includeHarnessIdentity 时才存在。组装瀑布是唯一
  // 既不撞层、又能在缺段时补一段的位置。
  //
  // 先 `await next()` 再改写：动的是最终结果，别的监听器（模型选择、会话引用
  // 之类的变量提供者）照常工作。记忆按会话冻结（`runtime.sectionText()`），
  // 预设不冻结（`runtime.presetText()`）——切换预设就是要下一次组装立刻生效，
  // 前缀缓存被移动是明确接受的代价。
  //
  // 文本为空时原样返回：没有记忆就不挖掉 persona，没有预设就保留宿主原生的
  // identity。失败只降级成「不覆盖」：组装失败会毁掉整个模型请求，而记忆和
  // 预设不该有这个权力。
  ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const settled = await next()
    try {
      const memory = overridePersona(settled, runtime.sectionText(context))
      return overrideHarnessIdentity(memory, runtime.presetText(context))
    } catch (error) {
      warn(`memory: 改写提示词前缀失败 ${error?.message ?? error}`)
      return settled
    }
  }), 'memory.prompt()')

  ctx.effect(() => ctx.on('agent/created', async ({ agent, signal }) => {
    try {
      const subagent = isSubagentAgent(agent)
      if (subagent && agent.ctx !== undefined) {
        try {
          agent.ctx.tools.restrict({ deny: [TOOL_NAMES.edit, TOOL_NAMES.manage] })
        } catch (error) {
          warn(`memory: 无法为子 agent 限制记忆工具 ${error?.message ?? error}`)
        }
      }
      await runtime.attach(agent, signal)
      // A subagent just had `memory_edit` denied; registering a scoped copy would
      // shadow the denial and hand the tool straight back.
      if (!subagent) freezeEditTool(agent)
    } catch (error) {
      warn(`memory: 会话 ${String(agent?.id)} 接入记忆失败 ${error?.message ?? error}`)
    }
  }), 'memory.agentCreated()')

  /**
   * Give one session its own `memory_edit`, with a frozen description.
   *
   * The description lists every file's format, so the global registration
   * re-renders it on each assembly and a new file moves the request header —
   * which discards the provider's cached prefix for that session. A scoped
   * registration shadows the global one (`tools.register` writes into the
   * calling agent's layer, and a layer's own copy wins), so this session keeps
   * the text it opened with while every other session keeps its own.
   *
   * The description is a getter rather than a captured string so that an expired
   * snapshot can still refresh: `sessionToolText` returns the frozen copy for as
   * long as it lives, then renders a fresh one after the retention window, when
   * there is no cache left to protect.
   *
   * A failure is only a warning: the global definition still works, it just
   * re-renders.
   *
   * @param {object} agent - the live agent.
   * @returns {void}
   */
  function freezeEditTool(agent) {
    const scope = agent?.ctx?.tools
    if (scope === undefined) return
    try {
      const frozen = { ...editTool(runtime) }
      Object.defineProperty(frozen, 'description', {
        enumerable: true,
        configurable: true,
        get: () => runtime.sessionToolText(agent, () => renderEditDescription(runtime)),
      })
      scope.register(frozen)
    } catch (error) {
      warn(`memory: 无法为会话 ${String(agent?.id)} 冻结编辑工具描述 ${error?.message ?? error}`)
    }
  }

  ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
    if (agent === undefined || (status !== 'idle' && status !== 'running')) return
    try {
      runtime.setAgentRunning(agent, status === 'running')
    } catch (error) {
      warn(`memory: 更新会话 ${String(agent?.id)} 通知调度状态失败 ${error?.message ?? error}`)
    }
  }), 'memory.agentStatus()')

  ctx.effect(() => ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (agent === undefined) return
    runtime.onUserMessage(agent, message).catch((error) => {
      warn(`memory: 用户消息触发会话 ${String(agent?.id)} 记忆检查失败 ${error?.message ?? error}`)
    })
  }), 'memory.inboxInserted()')

  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    try {
      runtime.forget(agent)
    } catch (error) {
      warn(`memory: 清理会话快照失败 ${error?.message ?? error}`)
    }
  }), 'memory.agentDisposed()')

  ctx.effect(() => ctx.on('agent/inbox/claimed', async ({ agent, message }) => {
    if (message?.source?.kind !== 'memory') return
    try {
      await runtime.claim(agent, message.source.snapshot)
    } catch (error) {
      warn(`memory: 记录记忆通知已送达失败 ${error?.message ?? error}`)
    }
  }), 'memory.claimed()')

  ctx.effect(() => ctx.on('agent/inbox/discarded', async ({ agent, message }) => {
    if (message?.source?.kind !== 'memory') return
    try {
      await runtime.release(agent)
    } catch (error) {
      warn(`memory: 回滚记忆通知失败 ${error?.message ?? error}`)
    }
  }), 'memory.discarded()')

  // Snapshot retention is measured from the end of the model's last message: the
  // provider's prefix cache starts expiring from then, so that is the clock that
  // decides when a frozen prompt text can no longer save anything.
  ctx.effect(() => ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent === undefined) return
    try {
      await runtime.touch(agent)
    } catch (error) {
      warn(`memory: 记录会话 ${String(agent?.id)} 活跃时间失败 ${error?.message ?? error}`)
    }
  }), 'memory.turnStopping()')

  ctx.effect(() => ctx.tools.register(readTool(runtime)), 'memory.tool.read()')
  ctx.effect(() => ctx.tools.register(editTool(runtime)), 'memory.tool.edit()')
  ctx.effect(() => ctx.tools.register(manageTool(runtime)), 'memory.tool.manage()')
}

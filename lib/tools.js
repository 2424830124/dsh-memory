/**
 * The three memory tools: read, edit, manage.
 *
 * Definitions are written as **compiled JSON Schema**, not the `defineTool`
 * author DSL: `ctx.tools.register()` stores `parameters` verbatim and the prompt
 * assembly sends it to the provider unchanged, so an author-form parameter map
 * would reach the API as an invalid function schema.
 *
 * The supported schema subset is `type / oneOf / properties / required /
 * additionalProperties / items / enum / const` plus the `description` / `title`
 * / `default` / `examples` annotations. Anything else makes the whole request
 * fail, so nothing outside that list appears below.
 *
 * `memory_read` is available to every agent; `memory_edit` and `memory_manage`
 * are denied to delegated children by a scoped `tools.restrict()` call in the
 * plugin entry point.
 *
 * @module dsh-memory/tools
 */

import { DocumentError } from './errors.js'
import { DEFAULT_SUMMARY_MAX_CHARS, isDateShaped, logReadRules, logRules } from './log.js'
import { normalizeHeadingPath } from './path.js'
import { renderFormats } from './render.js'

/**
 * The three tool names, defined once.
 *
 * The entry point denies two of them to delegated children, and a name written
 * twice is a name that can drift apart.
 */
export const TOOL_NAMES = Object.freeze({
  read: 'memory_read',
  edit: 'memory_edit',
  manage: 'memory_manage',
})

/**
 * Heading path parameter, shared by the read and edit tools.
 *
 * Examples carry placeholders (`t1`, `t2`, `yyyy-mm-dd`) instead of real
 * content: a live model once copied a concrete example verbatim into a log edit,
 * which is the one place that shape is wrong.
 */
const HEADING_PATH = {
  type: 'string',
  description: '标题路径，从一级标题开始，用 " > " 连接，要带上标题前的 #，例如 "# t1 > ## t2"。',
}

/**
 * Build the `heading_path` schema with one tool-specific sentence appended.
 * @param {string} extra - what this tool does with the path.
 * @returns {object} the parameter schema.
 */
function headingPath(extra) {
  return { ...HEADING_PATH, description: `${HEADING_PATH.description}${extra}` }
}

/** Output shape for a tool that returns text. */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : '(没有内容)' }]
  },
}

/** Output shape for a tool that reports what it saved. */
const RESULT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      fileName: { type: 'string' },
      summary: { type: 'string' },
    },
    required: ['fileName', 'summary'],
    additionalProperties: false,
  },
  render(_args, value) {
    return [{ type: 'text', text: typeof value?.summary === 'string' ? value.summary : '已保存' }]
  },
}

/** The `scope` parameter shared by the tools that address one file. */
const SCOPE_PROPERTY = {
  type: 'string',
  enum: ['Global', 'Workspace'],
  description: '文件所在作用域。Global 对所有工作区可见，Workspace 只对当前工作区可见。',
}
/** `memory_read` parameters. */
const READ_PROPERTIES = {
  scope: {
    ...SCOPE_PROPERTY,
    description: `${SCOPE_PROPERTY.description}传 file_name 时必须给；只看文件清单时可以不给，给了就只列那一层。`,
  },
  file_name: {
    type: 'string',
    description: '记忆文件的 file_name。省略时只返回文件清单：给了 scope 就列那一层，没给就列全部。',
  },
  heading_path: headingPath('省略时返回整个文件。'),
}

/** `memory_edit` parameters. */
const EDIT_PROPERTIES = {
  scope: SCOPE_PROPERTY,
  file_name: {
    type: 'string',
    description: '要修改的记忆文件（元数据里的 file_name）。写日志时这里填日期 "yyyy-mm-dd"。',
  },
  heading_path: headingPath('指到还不存在的标题就是新建它，正文写入该标题的 desc。'),
  old_string: {
    type: 'string',
    description: '要被替换的原文，与 memory_read 返回的内容逐字符一致，且在目标标题里只出现一次；可以是片段。省略时把 new_string 追加到末尾。改标题时填原标题行，例如 "## t2"。',
  },
  new_string: {
    type: 'string',
    description: '替换后的文本。新建标题时这里是该标题的正文，不要再写一遍标题行。正文里不能出现 "#"。改标题时以 "#" 开头，"#" 的个数等于该标题的层级。空字符串表示删除该标题及其整棵子树。',
  },
  add_keyword: {
    type: 'array',
    items: { type: 'string' },
    description: '要添加的关键词，可多个。重复的会被忽略。',
  },
  del_keyword: {
    type: 'array',
    items: { type: 'string' },
    description: '要删除的关键词，可多个，要与已存在的关键词完全一致。不存在的会被忽略。',
  },
}

/** `memory_manage` parameters. */
const MANAGE_PROPERTIES = {
  file_name: {
    type: 'string',
    description: '要修改的记忆文件（元数据里的 file_name）。新建时省略。',
  },
  new_file_name: {
    type: 'string',
    description:
      '文件名（meta_data.file_name）。省略 file_name 时是新建用的名字；给了 file_name 就是改名后的新名字，传空字符串表示把这份记忆文件整个删掉。不能是 YYYY-MM-DD 这样的日期，那个名字留给日志。',
  },
  scope: {
    type: 'string',
    description: '要操作的文件所在作用域。Global 对所有工作区可见，Workspace 只对当前工作区可见。',
  },
  desc: {
    type: 'string',
    description: '关于这个文件的描述，记录什么东西等。会注入提示词。',
  },
  format: {
    type: 'string',
    description: '这个文件的格式说明：可以更新哪些东西、怎么更新、哪些会注入到提示词。只在 memory_read 返回该文件时给出，不进提示词。',
  },
  inject_ignore: {
    type: 'array',
    items: { type: 'string' },
    description: '注入提示词时要忽略的章节内容，整体替换。新建文件默认是 update_at、keyword；写 [] 就是全都注入，少注入一项就把它加进来。可选值 t1、t2、t3、t4、desc、keyword、update_at，以及 t2.desc 这类组合。一份文件如果什么都没剩下（列了 t1，或者里面没有标题），整个文件都不进提示词，连文件头一起；其余几项只作用于章节正文与关键词，不动元数据。',
  },
}

/**
 * Shorten one long label by replacing its middle with `...`.
 *
 * Tool results go back into the model's context, and a deep heading path can be
 * longer than the useful part of the answer. Both ends stay visible so the model
 * can still recognise which file and which branch it touched.
 *
 * @param {string} text - the text to fit.
 * @param {number} [limit] - maximum code points to keep.
 * @returns {string} the fitted text.
 */
function middleEllipsis(text, limit = 60) {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  const keep = Math.max(4, limit - MIDDLE_MARKER_WIDTH)
  const head = Math.ceil(keep / 2)
  return `${chars.slice(0, head).join('')}${MIDDLE_MARKER}${chars.slice(chars.length - (keep - head)).join('')}`
}

/**
 * What a cut text shows in the middle.
 *
 * `...` on its own was read as content: an echoed detail that ended
 * `…2026-1...记忆」…` looked like a mangled date rather than an omission, so the
 * marker says what it is.
 */
const MIDDLE_MARKER = '……（略）……'

/** Width of MIDDLE_MARKER in code points; it is wider than its 4 `...`-style peers. */
const MIDDLE_MARKER_WIDTH = Array.from(MIDDLE_MARKER).length

/** How much of the stored body an edit result echoes back. */
const BODY_ECHO_LIMIT = 140

/**
 * Build one object-rooted parameter schema.
 * @param {Record<string, object>} properties - per-parameter schemas.
 * @param {string[]} required - the parameters the model must supply.
 * @returns {{type: string, properties: object, required?: string[]}} the schema.
 */
function parameters(properties, required) {
  return required.length === 0
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/**
 * Reject arguments the tool does not declare.
 *
 * The provider forwards the model's arguments verbatim, so a misspelled key
 * would otherwise be dropped silently: the call would report success while
 * changing nothing, and the model would never learn its mistake.
 *
 * @param {string} toolName - the calling tool's name, for the message.
 * @param {Record<string, unknown>} args - the arguments the model supplied.
 * @param {Record<string, object>} properties - every declared parameter.
 * @param {string[]} required - the parameters that must be present.
 * @returns {void}
 * @throws {Error} on an unknown or missing parameter.
 */
function assertArgs(toolName, args, properties, required) {
  const allowed = Object.keys(properties)
  const unknown = Object.keys(args).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `${toolName} 没有 ${unknown.map((key) => `"${key}"`).join('、')} 这个参数，没有做任何修改。可用参数：${allowed.join('、')}。`,
    )
  }
  const missing = required.filter((key) => args[key] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `${toolName} 缺少必填参数 ${missing.map((key) => `"${key}"`).join('、')}，没有做任何修改。可用参数：${allowed.join('、')}。`,
    )
  }
}

/**
 * Wrap one runtime failure as a model-readable message.
 * @param {unknown} error - the thrown value.
 * @returns {Error} an error whose message the model can act on.
 */
function asToolError(error) {
  if (error instanceof DocumentError) {
    return new Error(error.path === undefined ? error.message : `${error.message}（位置：${error.path}）`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Normalize a heading path without throwing.
 *
 * `presentCall` runs before `execute`, so a malformed `heading_path` must not
 * break the call presentation; `execute` is what reports the real error.
 *
 * @param {unknown} value - the raw parameter.
 * @returns {string[]} the parsed path, or `[]` when it is malformed.
 */
function safeHeadingPath(value) {
  try {
    return normalizeHeadingPath(value)
  } catch {
    return []
  }
}

/**
 * Read one string argument.
 * @param {Record<string, unknown>} args - the model's arguments.
 * @param {string} name - the parameter name.
 * @returns {string|undefined} the trimmed value, or undefined when absent.
 */
function stringArg(args, name) {
  const value = args[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read one string-list argument.
 * @param {Record<string, unknown>} args - the model's arguments.
 * @param {string} name - the parameter name.
 * @returns {string[]} the entries, empty when absent.
 */
function listArg(args, name) {
  const value = args[name]
  return Array.isArray(value) ? value.map((entry) => String(entry)) : []
}

/**
 * Assemble one tool definition with the argument checks and error wrapping every
 * memory tool shares.
 *
 * @param {object} spec - the tool's identity and behaviour.
 * @param {string} spec.name - the tool name.
 * @param {string|(() => string)} spec.description - a static description, or one recomputed per call.
 * @param {Record<string, object>} spec.properties - the declared parameters.
 * @param {string[]} [spec.required] - the parameters that must be present.
 * @param {object} spec.output - the output shape.
 * @param {(args: Record<string, unknown>, agent: object) => Promise<object>} spec.run - the body, given the calling agent.
 * @param {(args: Record<string, unknown>) => object} spec.present - the call presentation.
 * @returns {object} the tool definition, ready for `ctx.tools.register`.
 */
function defineTool(spec) {
  const required = spec.required ?? []
  const tool = {
    name: spec.name,
    parameters: parameters(spec.properties, required),
    output: spec.output,
    async execute(args, exec) {
      assertArgs(spec.name, args, spec.properties, required)
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${spec.name} 需要在 agent 会话中调用`)
      try {
        return await spec.run(args, agent)
      } catch (error) {
        throw asToolError(error)
      }
    },
    presentCall: spec.present,
  }
  if (typeof spec.description !== 'function') {
    tool.description = spec.description
    return tool
  }
  // A getter, so a file created or edited in this session appears in the
  // description without re-registering the tool (which would commit a new tool
  // surface to every live session).
  Object.defineProperty(tool, 'description', {
    enumerable: true,
    configurable: true,
    get() {
      try {
        return spec.description()
      } catch (error) {
        return `（读取 format 失败：${error?.message ?? error}）`
      }
    },
  })
  return tool
}

/**
 * Build the `memory_read` tool definition.
 * @param {import('./runtime.js').MemoryRuntime} runtime - the runtime.
 * @returns {object} the tool definition.
 */
export function readTool(runtime) {
  return defineTool({
    name: TOOL_NAMES.read,
    description: [
      '读取记忆文件。传 file_name 时必须同时给 scope；省略 file_name 返回文件清单（给了 scope 只列那一层，没给就列出全部），此时 scope 可选。省略 heading_path 返回整个文件。写之前先读：memory_edit 会校验读到的版本。',
      logReadRules(),
    ].join('\n'),
    properties: READ_PROPERTIES,
    output: TEXT_OUTPUT,
    async run(args, agent) {
      const scope = stringArg(args, 'scope')
      const fileName = stringArg(args, 'file_name')
      if (fileName !== undefined && scope === undefined) {
        throw new Error('读单个文件时必须同时给出 scope（Global 或 Workspace）。只想看有哪些文件就省略 file_name，那时 scope 也可以不传。')
      }
      const text = await runtime.read(agent, {
        scope,
        fileName,
        headingPath: args.heading_path === undefined ? undefined : normalizeHeadingPath(args.heading_path),
      })
      return { text }
    },
    present(args) {
      const path = safeHeadingPath(args.heading_path)
      const file = stringArg(args, 'file_name')
      const target = file === undefined ? '记忆清单' : path.length > 0 ? `${file} > ${path.join(' > ')}` : file
      return { card: 'generic', title: `Read memory ${target}`, kind: 'read' }
    },
  })
}

/**
 * The `memory_edit` description, as rendered from what is on disk right now.
 *
 * Exported because the runtime freezes this text per session. It names every
 * file's format, so it changes whenever a file appears — and the tool
 * description sits at the front of the request, where any change discards the
 * provider's cached prefix. Freezing it is what keeps a live session's prefix
 * intact; a file that appears later is reached by reading it.
 *
 * @param {import('./runtime.js').MemoryRuntime} runtime - the runtime.
 * @returns {string} the description.
 */
export function renderEditDescription(runtime) {
  return [
    '修改记忆文件的正文和关键词。scope 指定改 Global 还是当前工作区；改之前先用 memory_read 读取目标位置。',
    logRules(runtime.config?.logSummaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS),
    `以下是每个记忆文件对应的format：\n${renderFormats(runtime.allDocuments())}`,
  ].join('\n\n')
}

/**
 * Build the `memory_edit` tool definition.
 *
 * This is the global registration, used by sessions the plugin has not frozen
 * a description for. The entry point registers a per-session copy that carries
 * the frozen text and shadows this one, so a live session never sees the text
 * move under it.
 *
 * @param {import('./runtime.js').MemoryRuntime} runtime - the runtime.
 * @returns {object} the tool definition.
 */
export function editTool(runtime) {
  return defineTool({
    name: TOOL_NAMES.edit,
    description: () => renderEditDescription(runtime),
    properties: EDIT_PROPERTIES,
    required: ['scope', 'file_name', 'heading_path'],
    output: RESULT_OUTPUT,
    async run(args, agent) {
      const path = normalizeHeadingPath(args.heading_path)
      const addKeywords = listArg(args, 'add_keyword')
      const removeKeywords = listArg(args, 'del_keyword')
      const fileName = String(args.file_name).trim()
      const removeOnly = args.new_string === ''
      const hasBody = args.old_string !== undefined || args.new_string !== undefined

      if (!hasBody && addKeywords.length === 0 && removeKeywords.length === 0) {
        throw new Error('没有给出任何要改动的内容。改正文用 new_string（或 old_string + new_string），删除标题用 new_string 传空字符串，关键词用 add_keyword / del_keyword。')
      }

      const { outcome, scope } = await runtime.edit(agent, {
        scope: stringArg(args, 'scope'),
        fileName,
        path,
        oldString: typeof args.old_string === 'string' ? args.old_string : undefined,
        newString: typeof args.new_string === 'string' ? args.new_string : undefined,
        removeOnly,
        addKeywords,
        removeKeywords,
      })

      const before = paragraphLabel(fileName, path)
      const after = outcome.renamed ? paragraphLabel(fileName, outcome.path) : before
      const verb = outcome.created ? '已新建' : outcome.renamed ? '已改名' : outcome.deleted ? '已删除' : '已更新'
      let summary = outcome.renamed ? `${verb} ${middleEllipsis(before)} 为 ${middleEllipsis(after)}` : `${verb} ${middleEllipsis(before)}`
      summary = `[${scope}] ${summary}`
      if (typeof outcome.body === 'string' && outcome.body !== '') {
        summary += `\n${middleEllipsis(outcome.body, BODY_ECHO_LIMIT)}`
      }
      return { fileName, summary }
    },
    present(args) {
      const path = safeHeadingPath(args.heading_path)
      const file = stringArg(args, 'file_name')
      return { card: 'generic', title: `Edit memory ${path.length > 0 ? path.join(' > ') : file ?? ''}`, kind: 'edit' }
    },
  })
}

/**
 * Spell `file > heading path` for a tool result line.
 *
 * A log's path starts with the day, which is already the file name: showing both
 * would read `2026-10-27 > 2026-10-27 > 19:20 …`. The day is dropped when the
 * file name is a date — a log is the only file that can be named that way.
 *
 * @param {string} fileName - the memory file name.
 * @param {string[]} path - the heading path.
 * @returns {string} the label.
 */
function paragraphLabel(fileName, path) {
  const rest = isDateShaped(fileName) ? path.slice(1) : path
  return rest.length === 0 ? fileName : `${fileName} > ${rest.join(' > ')}`
}

/**
 * Build the `memory_manage` tool definition.
 * @param {import('./runtime.js').MemoryRuntime} runtime - the runtime.
 * @returns {object} the tool definition.
 */
export function manageTool(runtime) {
  return defineTool({
    name: TOOL_NAMES.manage,
    description: '新建记忆文件、修改已有文件的元数据（desc、format、inject_ignore）、改名，或删除整份文件。新建出来的文件没有正文，内容用 memory_edit 填写。删除只在给了 file_name 时有效，把 new_file_name 传空字符串即可。',
    properties: MANAGE_PROPERTIES,
    required: ['scope'],
    output: RESULT_OUTPUT,
    async run(args, agent) {
      const { fileName, scope, renamedFrom, deleted } = await runtime.manage(agent, {
        fileName: stringArg(args, 'file_name'),
        // Read raw: an empty string is meaningful here (it deletes the file),
        // so `stringArg` - which treats blank as absent - would swallow it.
        newFileName: typeof args.new_file_name === 'string' ? args.new_file_name : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
        desc: typeof args.desc === 'string' ? args.desc : undefined,
        format: typeof args.format === 'string' ? args.format : undefined,
        injectIgnore: Array.isArray(args.inject_ignore) ? args.inject_ignore.map((entry) => String(entry)) : undefined,
      })
      if (deleted === true) return { fileName, summary: `[${scope}] 已删除记忆文件 ${fileName}` }
      if (renamedFrom !== undefined) return { fileName, summary: `[${scope}] 已将记忆文件 ${renamedFrom} 改名为 ${fileName}` }
      return { fileName, summary: `[${scope}] 已保存记忆文件 ${fileName}` }
    },
    present(args) {
      const target = stringArg(args, 'file_name') ?? stringArg(args, 'new_file_name') ?? '记忆文件'
      return { card: 'generic', title: `Manage memory ${target}`, kind: 'edit' }
    },
  })
}

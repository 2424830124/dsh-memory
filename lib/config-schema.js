/**
 * Every setting the plugin has, described once.
 *
 * The same list feeds three places that used to carry their own copy: the
 * Schemastery schema that validates the profile config, the settings route that
 * validates what the panel sends, and the inputs the panel renders. Adding a
 * knob now means adding one entry here — the other three follow.
 *
 * Each entry is deliberately data, not code: the route serialises the list to
 * the browser as-is, so keep it JSON-safe.
 *
 * @module dsh-memory/config-schema
 */

/**
 * @typedef {object} ConfigField
 * @property {string} key - the config key, as written in `config.yaml`.
 * @property {'number'|'boolean'|'string'|'list'} type - how to edit and validate it.
 * @property {unknown} default - the value used when nothing sets it.
 * @property {string} group - which block of the panel it belongs to.
 * @property {string} title - Chinese label; also used in validation messages.
 * @property {number} [min] - smallest accepted value, for `number`.
 * @property {boolean} [restart] - whether a change only takes effect after a restart.
 * @property {boolean} [hidden] - not rendered as a form input; the panel writes it another way.
 */

/** @type {readonly ConfigField[]} */
export const CONFIG_FIELDS = Object.freeze([
  {
    key: 'fileOrder',
    type: 'list',
    default: [],
    group: 'inject',
    title: '文件顺序',
    // 由面板里拖动文件维护，不给输入框：手写文件名列表既难对应到具体文件，
    // 也容易写出拼错的名字而毫无提示。
    hidden: true,
  },
  {
    key: 'snapshotTtlMinutes',
    type: 'number',
    min: 0,
    default: 60,
    group: 'session',
    title: '快照保留分钟',
  },
  {
    key: 'logSummaryMaxChars',
    type: 'number',
    min: 1,
    default: 200,
    group: 'log',
    title: '日志摘要字数上限',
  },
  {
    key: 'injectLog',
    type: 'boolean',
    default: false,
    group: 'log',
    title: '注入日志',
  },
  {
    key: 'logInjectEntries',
    type: 'number',
    min: 0,
    default: 20,
    group: 'log',
    title: '每天最多几条',
  },
  {
    key: 'logInjectGlobalDays',
    type: 'number',
    min: 0,
    default: 3,
    group: 'log',
    title: '全局日志天数',
  },
  {
    key: 'logInjectGlobalDetailDays',
    type: 'number',
    min: 0,
    default: 1,
    group: 'log',
    title: '全局带正文天数',
  },
  {
    key: 'logInjectWorkspaceDays',
    type: 'number',
    min: 0,
    default: 2,
    group: 'log',
    title: '工作区日志天数',
  },
  {
    key: 'logInjectWorkspaceDetailDays',
    type: 'number',
    min: 0,
    default: 1,
    group: 'log',
    title: '工作区带正文天数',
  },
])

/** @type {ReadonlyMap<string, ConfigField>} */
export const CONFIG_FIELD_BY_KEY = new Map(CONFIG_FIELDS.map((field) => [field.key, field]))

/**
 * Build the settings object with every field at its default.
 * @returns {Record<string, unknown>} one key per field, arrays copied.
 */
export function defaultSettings() {
  const settings = {}
  for (const field of CONFIG_FIELDS) {
    settings[field.key] = Array.isArray(field.default) ? [...field.default] : field.default
  }
  return settings
}

/**
 * Check one value against its field.
 *
 * The panel and the config file are both hand-edited, so this is the single
 * gate: nothing reaches the runtime or the file without passing through here.
 *
 * @param {ConfigField} field - the field the value belongs to.
 * @param {unknown} value - the value to check.
 * @returns {{ok: true, value: unknown}|{ok: false, error: string}} the result.
 */
export function readField(field, value) {
  switch (field.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, error: `${field.title}必须是整数` }
      }
      if (field.min !== undefined && value < field.min) {
        return { ok: false, error: `${field.title}不能小于 ${field.min}` }
      }
      return { ok: true, value }
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { ok: false, error: `${field.title}必须是 true 或 false` }
      return { ok: true, value }
    }
    case 'list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        return { ok: false, error: `${field.title}必须是字符串列表` }
      }
      return { ok: true, value: value.map((item) => item.trim()).filter((item) => item !== '') }
    }
    default: {
      if (typeof value !== 'string') return { ok: false, error: `${field.title}必须是字符串` }
      return { ok: true, value }
    }
  }
}

/**
 * Render one value as a YAML scalar, so `config.yaml` stays readable.
 * @param {unknown} value - a value that passed {@link readField}.
 * @returns {string} the YAML source for that value.
 */
export function formatScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[${value.map((item) => formatScalar(item)).join(', ')}]`
  return quoteScalar(String(value))
}

/**
 * Quote a string only when YAML would otherwise misread it.
 * @param {string} text - the scalar to render.
 * @returns {string} the scalar, plain or double-quoted.
 */
function quoteScalar(text) {
  const plain = text !== ''
    && !/^[\s,[\]{}#&*!|>'"%@`-]/.test(text)
    && !/:\s|\s#|[\n\t]/.test(text)
    && !/\s$/.test(text)
  return plain ? text : JSON.stringify(text)
}

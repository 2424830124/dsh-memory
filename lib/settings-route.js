/**
 * The HTTP endpoint behind the settings panel.
 *
 * The Web UI lives in the browser and the configuration lives in a YAML file
 * next to the memory it configures, so the two meet on one small route: a GET
 * reports the fields and their current values, a POST validates what the panel
 * sent, writes it through the same reader the plugin uses at startup, and
 * applies it to the live runtime.
 *
 * The route answers its own failures as JSON instead of throwing, because a
 * malformed request must not surface as a broken page.
 *
 * @module dsh-memory/settings-route
 */

import { CONFIG_FIELDS, CONFIG_FIELD_BY_KEY, formatScalar, readField } from './config-schema.js'
import { saveConfigValue } from './config.js'
import { DocumentError } from './errors.js'
import { INJECT_IGNORE_LEVELS, INJECT_IGNORE_OPTIONS, normalizeKind, normalizeScope } from './model.js'

/** Prefix the browser calls. Serves both the read and the write. */
export const SETTINGS_ROUTE = '/plugins/dsh-memory/settings'

/** Largest accepted request body; a settings patch is small, a file patch is not. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON payload.
 * @returns {void}
 */
function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(body))
}

/**
 * Collect a request body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {Promise<string>} the decoded body.
 * @throws when the body exceeds {@link MAX_BODY_BYTES}.
 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Validate one settings patch from the browser.
 *
 * Every field is optional; unknown fields are ignored rather than rejected, so
 * an older panel talking to a newer plugin still saves what it knows.
 *
 * @param {unknown} payload - the parsed request body.
 * @returns {{ok: true, patch: object}|{ok: false, error: string}} the result.
 */
function readPatch(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '请求体必须是对象' }
  }

  const patch = {}
  for (const [key, value] of Object.entries(payload)) {
    const field = CONFIG_FIELD_BY_KEY.get(key)
    if (field === undefined) continue
    const checked = readField(field, value)
    if (!checked.ok) return { ok: false, error: checked.error }
    patch[key] = checked.value
  }
  return { ok: true, patch }
}

/**
 * Validate one whole-file action (create or delete) from the browser.
 *
 * @param {unknown} value - the `create` / `remove` field of the request body.
 * @returns {{ok: true, action: object}|{ok: false, error: string}} the result.
 */
function readFileAction(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'create / remove 必须是对象' }
  }
  if (typeof value.fileName !== 'string' || value.fileName.trim() === '') {
    return { ok: false, error: 'fileName 不能为空' }
  }
  return {
    ok: true,
    action: {
      scope: normalizeScope(value.scope),
      kind: normalizeKind(value.kind),
      fileName: value.fileName.trim(),
    },
  }
}

/**
 * Validate one file patch from the browser.
 *
 * The panel edits a document through the same route it reads, so the payload
 * says which file and which fields. Anything missing is left alone: the panel
 * sends only what changed, and a field it never touched must not be rewritten.
 *
 * @param {unknown} value - `payload.file`.
 * @returns {{ok: true, patch: object}|{ok: false, error: string}} the result.
 */
function readFilePatch(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'file 必须是对象' }
  }
  if (typeof value.fileName !== 'string' || value.fileName === '') {
    return { ok: false, error: 'fileName 不能为空' }
  }
  const patch = {
    scope: normalizeScope(value.scope),
    kind: normalizeKind(value.kind),
    fileName: value.fileName,
  }
  if (typeof value.newFileName === 'string') patch.newFileName = value.newFileName
  if (typeof value.desc === 'string') patch.desc = value.desc
  if (typeof value.format === 'string') patch.format = value.format
  if (Array.isArray(value.injectIgnore)) patch.injectIgnore = value.injectIgnore.map(String)
  if (Array.isArray(value.newNodes)) {
    patch.newNodes = value.newNodes
      .filter((node) => node !== null && typeof node === 'object' && typeof node.title === 'string')
      .map((node) => ({
        parent: Array.isArray(node.parent) ? node.parent.map(String) : [],
        title: node.title,
        ...(typeof node.desc === 'string' ? { desc: node.desc } : {}),
        ...(Array.isArray(node.keyword) ? { keyword: node.keyword.map(String) } : {}),
      }))
  }
  if (Array.isArray(value.removed)) {
    patch.removed = value.removed
      .filter((path) => Array.isArray(path) && path.length > 0)
      .map((path) => path.map(String))
  }
  if (Array.isArray(value.nodes)) {
    patch.nodes = value.nodes
      .filter((node) => node !== null && typeof node === 'object')
      .map((node) => ({
        path: Array.isArray(node.path) ? node.path.map(String) : [],
        ...(typeof node.title === 'string' ? { title: node.title } : {}),
        ...(typeof node.desc === 'string' ? { desc: node.desc } : {}),
        ...(Array.isArray(node.keyword) ? { keyword: node.keyword.map(String) } : {}),
      }))
  }
  return { ok: true, patch }
}

/**
 * Validate one preset action from the browser.
 *
 * Presets are whole Markdown files, not YAML documents: the panel only needs to
 * list them, pick one for the session, and create/save/delete a file. The name
 * is validated again by the store; anything user-visible comes back as a 400.
 *
 * @param {unknown} value - `payload.preset`.
 * @returns {{ok: true, action: {op: string, name: string, text: string}}|{ok: false, error: string}} the result.
 */
function readPresetAction(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'preset 必须是对象' }
  }
  if (!['select', 'create', 'save', 'remove'].includes(value.op)) {
    return { ok: false, error: 'preset.op 必须是 select / create / save / remove' }
  }
  if (typeof value.name !== 'string') {
    return { ok: false, error: 'preset.name 必须是字符串' }
  }
  return {
    ok: true,
    action: {
      op: value.op,
      name: value.name,
      text: typeof value.text === 'string' ? value.text : '',
    },
  }
}

/**
 * Build the route handler.
 * @param {object} options - handler options.
 * @param {string} options.file - absolute path of the config file to write.
 * @param {{config: object, updateSettings: (patch: object) => object}} options.runtime - live runtime.
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>} the handler.
 */
export function createSettingsHandler({ file, runtime }) {
  /** @returns {Record<string, unknown>} the values the panel shows. */
  const current = () => {
    const values = {}
    for (const field of CONFIG_FIELDS) {
      const value = runtime.config[field.key]
      values[field.key] = value === undefined ? field.default : value
    }
    return values
  }

  /**
   * The query string, parsed.
   * @param {import('node:http').IncomingMessage} request - the request.
   * @returns {URLSearchParams} its parameters.
   */
  const queryOf = (request) => {
    const url = request.url ?? ''
    const index = url.indexOf('?')
    return new URLSearchParams(index < 0 ? '' : url.slice(index + 1))
  }

  /**
   * The session the panel is showing, when it named one.
   * @param {URLSearchParams} query - the parsed query.
   * @returns {string|undefined} the session id.
   */
  const sessionOf = (query) => {
    const value = query.get('session')
    return value === null || value === '' ? undefined : value
  }

  /**
   * 参数没通过校验时回 400——三处 POST 分支都这么开头。
   * @param {object} checked - `{ok, error}` 形态的校验结果。
   * @returns {boolean} true 表示已经回过响应，调用方直接 return。
   */
  const reject = (response, checked) => {
    if (checked.ok) return false
    sendJson(response, 400, { error: checked.error })
    return true
  }

  /**
   * 跑一个会碰磁盘的动作，把「这次改动没落地」翻译成 400。
   *
   * 文件不见了、标题被删了、磁盘上已经被人改过——都是面板该原样显示的原因，
   * 不是插件故障，所以走 400 而不是 500。
   * @param {import('node:http').ServerResponse} response - the response.
   * @param {() => Promise<unknown>} action - what to run.
   * @returns {Promise<{ok: boolean, value?: unknown}>} `ok: false` 表示已经回过响应。
   */
  const attempt = async (response, action) => {
    try {
      return { ok: true, value: await action() }
    } catch (error) {
      if (!(error instanceof DocumentError)) throw error
      sendJson(response, 400, { error: error.message })
      return { ok: false }
    }
  }

  /**
   * The body every answer carries, plus the one file the panel asked for.
   * @param {import('node:http').IncomingMessage} request - the request.
   * @returns {Promise<object>} the answer.
   */
  const snapshot = async (request) => {
    const query = queryOf(request)
    const sessionId = sessionOf(query)
    const body = {
      fields: CONFIG_FIELDS,
      settings: current(),
      scopes: await runtime.overview(sessionId),
      // 面板的「+」只摆这些值：可选值的权威在 lib/model.js，客户端不抄一份。
      injectIgnoreOptions: INJECT_IGNORE_OPTIONS,
      injectIgnoreLevels: INJECT_IGNORE_LEVELS,
      // 预设页签要的是名字清单和本会话选了哪份；文本按需用 ?preset= 单独取。
      presets: runtime.presetOverview?.(sessionId) ?? { names: [], selected: '' },
    }
    const fileName = query.get('file')
    if (fileName !== null && fileName !== '') {
      const scope = normalizeScope(query.get('scope'))
      const kind = normalizeKind(query.get('kind'))
      body.file = (await runtime.fileText({ scope, sessionId, fileName, kind })) ?? null
    }
    const presetName = query.get('preset')
    if (presetName !== null && presetName !== '') {
      body.preset = { name: presetName, text: runtime.presetContent?.(presetName) ?? '' }
    }
    return body
  }

  return async function handleSettings(request, response) {
    try {
      if (request.method === 'GET') {
        sendJson(response, 200, await snapshot(request))
        return
      }
      if (request.method !== 'POST') {
        sendJson(response, 405, { error: '只支持 GET 和 POST' })
        return
      }

      let payload
      try {
        payload = JSON.parse((await readBody(request)) || '{}')
      } catch (error) {
        sendJson(response, 400, { error: `请求体不是合法 JSON（${error?.message ?? error}）` })
        return
      }

      // `create` / `remove` 是整份文件的操作：新建或删除，和改内容分开走。
      if (payload.create !== undefined || payload.remove !== undefined) {
        const action = payload.create ?? payload.remove
        const isCreate = payload.create !== undefined
        const checked = readFileAction(action)
        if (reject(response, checked)) return
        const sessionId = sessionOf(queryOf(request))
        const withSession = sessionId === undefined
          ? checked.action
          : { ...checked.action, sessionId }
        if (isCreate) {
          const created = await attempt(response, () => runtime.createFile(withSession))
          if (!created.ok) return
          sendJson(response, 200, { file: created.value ?? null, scopes: (await snapshot(request)).scopes })
          return
        }
        const removed = await attempt(response, () => runtime.deleteFile(withSession))
        if (!removed.ok) return
        if (removed.value === undefined) {
          sendJson(response, 404, { error: `找不到记忆文件: ${checked.action.fileName}` })
          return
        }
        sendJson(response, 200, { removed: removed.value, scopes: (await snapshot(request)).scopes })
        return
      }

      // `file` 在就说明这次不是改设置，而是改某个文件里的一处内容：
      // 描述、更新格式、不注入的值，或者某个标题的正文和关键词。
      if (payload.file !== undefined) {
        const checkedFile = readFilePatch(payload.file)
        if (reject(response, checkedFile)) return
        // 文件不见了、标题被删了、或者磁盘上已经被人改过：都是「这次改动没落地」，
        // 不是插件故障，所以回 400 带上原因，让面板把话原样显示出来。
        const patched = await attempt(response, () => runtime.patchFile({
          ...checkedFile.patch,
          sessionId: sessionOf(queryOf(request)),
        }))
        if (!patched.ok) return
        if (patched.value === undefined) {
          sendJson(response, 404, { error: `找不到记忆文件: ${checkedFile.patch.fileName}` })
          return
        }
        sendJson(response, 200, { file: patched.value, scopes: (await snapshot(request)).scopes })
        return
      }

      // `preset` 是「预设」页签的写入口：选中、新建、保存、删除都在这里。
      // 选中必须带 session——预设是按会话生效的，没有会话就没有对象可选。
      if (payload.preset !== undefined) {
        const checkedPreset = readPresetAction(payload.preset)
        if (reject(response, checkedPreset)) return
        const sessionId = sessionOf(queryOf(request))
        if (checkedPreset.action.op === 'select' && sessionId === undefined) {
          sendJson(response, 400, { error: '选择预设需要 session' })
          return
        }
        const done = await attempt(response, async () => {
          const action = checkedPreset.action
          if (action.op === 'select') return runtime.setPreset({ id: sessionId }, action.name)
          if (action.op === 'create') return runtime.createPreset(action.name)
          if (action.op === 'save') return runtime.savePreset(action.name, action.text)
          return runtime.removePreset(action.name)
        })
        if (!done.ok) return
        // 删掉的正好是设置里的默认预设：默认值跟着回到「不使用」。否则以后
        // 每个新会话都会拿到一个已经不存在的名字——`applyDefaultPreset()`
        // 会安静地跳过，但设置页里还显示着这份预设，看起来像没删干净。
        if (checkedPreset.action.op === 'remove' && runtime.config?.defaultPreset === checkedPreset.action.name) {
          try {
            saveConfigValue(file, 'defaultPreset', formatScalar(''))
          } catch (error) {
            sendJson(response, 500, {
              error: `默认预设已被删除，但写回设置失败：${error?.message ?? error}`,
            })
            return
          }
          runtime.updateSettings({ defaultPreset: '' })
        }
        sendJson(response, 200, await snapshot(request))
        return
      }

      const checked = readPatch(payload)
      if (reject(response, checked)) return
      if (Object.keys(checked.patch).length === 0) {
        sendJson(response, 400, { error: '没有要修改的设置' })
        return
      }

      // 先落盘再改内存：写文件失败时运行时保持原样，界面显示的就不会是一个
      // 其实没存下来的值。
      for (const [key, value] of Object.entries(checked.patch)) {
        saveConfigValue(file, key, formatScalar(value))
      }
      runtime.updateSettings(checked.patch)
      sendJson(response, 200, await snapshot(request))
    } catch (error) {
      sendJson(response, 500, { error: `保存失败：${error?.message ?? error}` })
    }
  }
}

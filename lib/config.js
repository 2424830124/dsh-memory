/**
 * The optional config file next to the memory directory.
 *
 * Plugin configuration normally arrives through the Harness profile, but the
 * values that belong to one installation — the snapshot window, how many days
 * of logs to inject — read better as a file you can open. Both work: the file
 * wins, because it sits right beside the plugin's data.
 *
 * @module dsh-memory/config
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { parse as parseYaml } from 'yaml'

/** Name of the config file inside the plugin data directory. */
export const CONFIG_FILE_NAME = 'config.yaml'

/**
 * Read one config file.
 *
 * Never throws: a missing file is normal, and a broken one must not stop the
 * plugin from loading. Both cases produce a warning and an empty result.
 *
 * @param {string} file - absolute path of the config file.
 * @param {(message: string) => void} warn - diagnostic sink.
 * @returns {Record<string, unknown>} the parsed top-level keys, or `{}`.
 */
export function loadConfigFile(file, warn) {
  let source
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    // A missing file is the common case, not a problem worth a warning.
    if (error?.code !== 'ENOENT') warn(`memory: 读不到配置文件 ${file}（${error?.message ?? error}），用默认配置`)
    return {}
  }

  let parsed
  try {
    parsed = parseYaml(source)
  } catch (error) {
    warn(`memory: 配置文件不是合法 YAML，已整份忽略 ${file}（${error?.message ?? error}）`)
    return {}
  }

  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`memory: 配置文件顶层必须是键值对，已整份忽略 ${file}`)
    return {}
  }
  // 手写配置常把列表写成 `[2, 1]` 这种裸数字；统一成字符串，别因为少了引号
  // 就让整份配置在 schema 那里校验失败、连带别的键一起被丢掉。
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item))) {
      parsed[key] = value.map((item) => String(item))
    }
  }
  return parsed
}

/**
 * Rewrite one key in a config file, leaving every other line untouched.
 *
 * Parsing and re-serialising would drop the comments a hand-written config
 * carries, so the existing `key: value` line is replaced in place and a missing
 * key is appended. A file that does not exist yet is created with that one line.
 *
 * @param {string} file - absolute path of the config file.
 * @param {string} key - top-level key to write.
 * @param {unknown} value - value rendered as a YAML scalar.
 * @returns {void}
 * @throws when the file exists but cannot be read or written; the caller reports it.
 */
export function saveConfigValue(file, key, value) {
  let source = ''
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  // Anchored at column 0: a same-named key nested under another one must not be
  // mistaken for the top-level setting this call is about.
  const pattern = new RegExp(`^(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*:[ \\t]*)(.*)$`, 'm')
  const rendered = String(value)
  const next = pattern.test(source)
    ? source.replace(pattern, (_, head) => head + rendered)
    : `${source === '' || source.endsWith('\n') ? source : `${source}\n`}${key}: ${rendered}\n`

  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, next, 'utf8')
}

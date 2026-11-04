/**
 * First-run defaults: the memory files and the bootstrap checklist that ship
 * inside the package.
 *
 * ```
 * defaults/memory/*.yaml        Global memory files copied out on first run
 * defaults/BOOTSTRAP.md         the first-session checklist
 * ```
 *
 * Both land in the plugin's own data directory on the first start: the memory
 * files in `<dataDir>/.memory`, the checklist next to it as
 * `<dataDir>/BOOTSTRAP.md` so it sits beside the memory it fills in.
 *
 * Seeding happens once per file, and "once" is recorded rather than inferred
 * from the file being absent: `<stateDir>/defaults-seeded.json` lists what this
 * installation has already been given. Without it, deleting a default file on
 * purpose would bring it back on the next start, and the user would have to
 * fight the package for their own memory directory.
 *
 * An existing file is never overwritten — it is recorded as seeded and left
 * exactly as it is. That is what makes an upgrade harmless for an installation
 * that has been in use for months.
 *
 * @module dsh-memory/defaults
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { writeAtomic } from './atomic.js'
import { BOOTSTRAP_FILE_NAME } from './bootstrap.js'

/** Directory inside the package holding the shipped files. */
export const DEFAULTS_DIR_NAME = 'defaults'

/** Subdirectory of the shipped files holding Global memory notebooks. */
export const DEFAULTS_MEMORY_DIR = 'memory'

/** Bookkeeping file, under the state directory. */
export const SEED_MARKER_NAME = 'defaults-seeded.json'

/** Marker format version; a bump means "ignore what was recorded". */
const MARKER_VERSION = 1

/**
 * Read the seed marker.
 *
 * A missing, corrupt, or older marker reads as "nothing seeded yet". That can
 * only ever cause a file that is already on disk to be recorded again, because
 * an existing target is never overwritten.
 *
 * @param {string} stateDir - the plugin state directory.
 * @returns {Promise<{memory: string[], bootstrap: boolean}>} what was already given.
 */
async function readMarker(stateDir) {
  const empty = { memory: [], bootstrap: false }
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, SEED_MARKER_NAME), 'utf8'))
    if (parsed?.version !== MARKER_VERSION) return empty
    return {
      memory: Array.isArray(parsed.memory) ? parsed.memory.filter((entry) => typeof entry === 'string') : [],
      bootstrap: parsed.bootstrap === true,
    }
  } catch {
    return empty
  }
}

/**
 * Write the seed marker.
 * @param {string} stateDir - the plugin state directory.
 * @param {{memory: string[], bootstrap: boolean}} marker - what has been given.
 * @returns {Promise<void>} completion.
 */
async function writeMarker(stateDir, marker) {
  await mkdir(stateDir, { recursive: true })
  const record = { version: MARKER_VERSION, memory: [...marker.memory].sort(), bootstrap: marker.bootstrap }
  await writeAtomic(join(stateDir, SEED_MARKER_NAME), JSON.stringify(record, null, 2))
}

/**
 * Copy the shipped memory notebooks that this installation has not been given.
 *
 * @param {object} options - what to copy where.
 * @param {(message: string) => void} options.warn - diagnostic sink.
 * @returns {Promise<void>} completion.
 */
async function seedMemory(options) {
  const { defaultsDir, globalDir, stateDir, warn } = options
  let names
  try {
    names = (await readdir(join(defaultsDir, DEFAULTS_MEMORY_DIR)))
      .filter((name) => name.toLowerCase().endsWith('.yaml'))
      .sort((left, right) => left.localeCompare(right, 'zh'))
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`memory: 读取默认记忆目录失败 ${defaultsDir}: ${error?.message ?? error}`)
    return
  }
  if (names.length === 0) return

  const marker = await readMarker(stateDir)
  const seeded = new Set(marker.memory)
  let changed = false
  for (const name of names) {
    if (seeded.has(name)) continue
    const target = join(globalDir, name)
    try {
      await mkdir(globalDir, { recursive: true })
      // 已有的文件不动：升级一份用了很久的安装时，默认内容只补空缺，绝不覆盖。
      if (!existsSync(target)) await copyFile(join(defaultsDir, DEFAULTS_MEMORY_DIR, name), target)
      seeded.add(name)
      changed = true
    } catch (error) {
      warn(`memory: 写入默认记忆文件失败 ${target}: ${error?.message ?? error}`)
    }
  }
  if (changed) await writeMarker(stateDir, { memory: [...seeded], bootstrap: marker.bootstrap })
}

/**
 * Place the shipped checklist in the data directory, once.
 *
 * @param {object} options - what to copy where.
 * @param {(message: string) => void} options.warn - diagnostic sink.
 * @returns {Promise<void>} completion.
 */
async function seedBootstrap(options) {
  const { defaultsDir, dataDir, stateDir, warn } = options
  const marker = await readMarker(stateDir)
  if (marker.bootstrap) return
  const target = join(dataDir, BOOTSTRAP_FILE_NAME)
  try {
    await mkdir(dataDir, { recursive: true })
    if (!existsSync(target)) await copyFile(join(defaultsDir, BOOTSTRAP_FILE_NAME), target)
  } catch (error) {
    // 清单没拷成不是一个致命问题：下次启动会再试一次，因为标记这时还没写。
    if (error?.code !== 'ENOENT') warn(`memory: 写入 BOOTSTRAP 失败 ${target}: ${error?.message ?? error}`)
    return
  }
  await writeMarker(stateDir, { memory: marker.memory, bootstrap: true })
}

/**
 * Install the shipped defaults for a first run.
 *
 * Never throws: a failed seed is a warning, because the plugin still works with
 * whatever the user already has.
 *
 * @param {object} options - layout and sink.
 * @param {string} options.defaultsDir - the package's `defaults/` directory.
 * @param {string} options.dataDir - the plugin data directory.
 * @param {string} options.globalDir - the Global memory directory.
 * @param {string} options.stateDir - the plugin state directory.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @returns {Promise<void>} completion.
 */
export async function seedDefaults(options) {
  const warn = options.warn ?? (() => {})
  try {
    await seedMemory({ ...options, warn })
    await seedBootstrap({ ...options, warn })
  } catch (error) {
    warn(`memory: 写入默认内容失败: ${error?.message ?? error}`)
  }
}

/**
 * Copy the presets that ship with the plugin into the user's preset folder.
 *
 * A preset is just a `.md` file, so shipping starters means putting them next to
 * the user's own ones. That has to happen exactly once per file: overwriting on
 * every start would undo edits, and re-creating a file the user deleted would
 * make deleting impossible. A marker in the state directory records which
 * bundled names were already offered, so a later version that adds a new preset
 * still gets it, while a deleted one stays deleted.
 *
 * Never throws: a plugin that cannot seed a starter preset is still a working
 * memory plugin, and a failure here must not stop activation.
 *
 * @module dsh-memory/seed-presets
 */

import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Marker of bundled presets that have been offered to this installation. */
export const SEED_MARKER_NAME = 'presets-seeded.json'

/**
 * Read the marker; a missing or broken one means "nothing seeded yet".
 * @param {string} file - absolute path of the marker file.
 * @param {(message: string) => void} warn - diagnostic sink.
 * @returns {Promise<Set<string>>} names already offered to the user.
 */
async function readMarker(file, warn) {
  let source
  try {
    source = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`memory: 读不到内置预设标记 ${file}（${error?.message ?? error}）`)
    return new Set()
  }
  try {
    const parsed = JSON.parse(source)
    const seeded = Array.isArray(parsed?.seeded) ? parsed.seeded : []
    return new Set(seeded.filter((name) => typeof name === 'string'))
  } catch (error) {
    warn(`memory: 内置预设标记不是合法 JSON，按「都没复制过」处理 ${file}（${error?.message ?? error}）`)
    return new Set()
  }
}

/**
 * Seed the bundled presets once.
 *
 * @param {object} options - where things live.
 * @param {string} options.sourceDir - the plugin's own `presets/` directory.
 * @param {string} options.targetDir - the user's preset directory.
 * @param {string} options.stateDir - the plugin state directory, for the marker.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @returns {Promise<string[]>} names actually copied this time.
 */
export async function seedPresets({ sourceDir, targetDir, stateDir, warn = () => {} }) {
  let entries
  try {
    entries = await readdir(sourceDir)
  } catch (error) {
    // A package without bundled presets is normal.
    if (error?.code !== 'ENOENT') warn(`memory: 读不到内置预设目录 ${sourceDir}（${error?.message ?? error}）`)
    return []
  }

  const names = entries.filter((name) => name.toLowerCase().endsWith('.md')).sort((left, right) => left.localeCompare(right, 'zh'))
  if (names.length === 0) return []

  const markerFile = join(stateDir, SEED_MARKER_NAME)
  const seeded = await readMarker(markerFile, warn)
  const copied = []
  let changed = false

  for (const name of names) {
    if (seeded.has(name)) continue
    try {
      await mkdir(targetDir, { recursive: true })
      // `COPYFILE_EXCL` is the whole safety story: an existing file — whether the
      // user wrote it or edited a seeded copy — is never replaced.
      await copyFile(join(sourceDir, name), join(targetDir, name), constants.COPYFILE_EXCL)
      copied.push(name.slice(0, -'.md'.length))
    } catch (error) {
      if (error?.code === 'EEXIST') {
        // Already there under the same name: treat as offered and leave it alone.
        seeded.add(name)
        changed = true
        continue
      }
      warn(`memory: 复制内置预设「${name}」失败 ${error?.message ?? error}`)
      continue
    }
    seeded.add(name)
    changed = true
  }

  if (changed) {
    try {
      await mkdir(stateDir, { recursive: true })
      await writeFile(markerFile, `${JSON.stringify({ version: 1, seeded: [...seeded].sort((left, right) => left.localeCompare(right, 'zh')) }, null, 2)}\n`, 'utf8')
    } catch (error) {
      warn(`memory: 写内置预设标记失败 ${error?.message ?? error}`)
    }
  }

  return copied
}

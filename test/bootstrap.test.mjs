/**
 * First-run checks: the shipped defaults, the bootstrap checklist, and the
 * prompt text the checklist contributes.
 * Run with `node test/bootstrap.test.mjs`.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BOOTSTRAP_COMPLETE,
  BOOTSTRAP_FILE_NAME,
  BootstrapStore,
  bootstrapBody,
  parseBootstrapStatus,
} from '../lib/bootstrap.js'
import { DEFAULTS_DIR_NAME, DEFAULTS_MEMORY_DIR, SEED_MARKER_NAME, seedDefaults } from '../lib/defaults.js'
import { MemoryRuntime } from '../lib/runtime.js'
import { MemoryStore } from '../lib/store.js'
import { PERSONA_SECTION, overridePersona } from '../lib/prompt-override.js'

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

/** A temporary directory, removed when the check ends. */
async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-memory-bootstrap-'))
}

/** A package `defaults/` directory with the given files. */
async function fakeDefaults(root, memory = { 'SOUL.yaml': 'meta_data:\n  file_name: SOUL\n' }, bootstrap = '# 清单\n') {
  const dir = join(root, DEFAULTS_DIR_NAME)
  await mkdir(join(dir, DEFAULTS_MEMORY_DIR), { recursive: true })
  for (const [name, text] of Object.entries(memory)) await writeFile(join(dir, DEFAULTS_MEMORY_DIR, name), text, 'utf8')
  if (bootstrap !== undefined) await writeFile(join(dir, BOOTSTRAP_FILE_NAME), bootstrap, 'utf8')
  return dir
}

/** The text of a checklist file that is finished. */
function completed(text = '# 清单\n') {
  return `---\nstatus: ${BOOTSTRAP_COMPLETE}\n---\n\n${text}`
}

check('frontmatter 的 status 才是完成信号，缺什么都是 pending', () => {
  assert.equal(parseBootstrapStatus('---\nstatus: pending\n---\n\n# 清单'), 'pending')
  assert.equal(parseBootstrapStatus(completed()), 'complete')
  assert.equal(parseBootstrapStatus('---\nstatus: "complete"\n---\n'), 'complete')
  assert.equal(parseBootstrapStatus('---\ntitle: 清单\n---\n'), 'pending')
  assert.equal(parseBootstrapStatus('# 没有 frontmatter'), 'pending')
  assert.equal(parseBootstrapStatus(''), 'pending')
  assert.equal(parseBootstrapStatus(undefined), 'pending')
})

check('注入的是正文，frontmatter 不进提示词', () => {
  assert.equal(bootstrapBody('---\nstatus: pending\n---\n\n# 清单\n正文\n'), '# 清单\n正文')
  assert.equal(bootstrapBody('# 清单\n'), '# 清单')
  assert.equal(bootstrapBody(undefined), '')
})

await check('清单文件在就注入，并带上文件路径；删掉就不注入', async () => {
  const root = await tempDir()
  try {
    await writeFile(join(root, BOOTSTRAP_FILE_NAME), '---\nstatus: pending\n---\n\n# 清单\n- [ ] 名字\n', 'utf8')
    const bootstrap = new BootstrapStore({ dir: root })
    await bootstrap.start()
    try {
      const store = new MemoryStore({ homeDir: root, env: {} })
      const runtime = new MemoryRuntime({ store, bootstrap, config: {}, logger: { warn() {} } })
      const text = runtime.bootstrapText()
      assert.match(text, /first-session checklist/)
      assert.ok(text.includes(join(root, BOOTSTRAP_FILE_NAME)), '注入文本里要有文件路径')
      assert.match(text, /status: complete/)
      assert.match(text, /# 清单\n- \[ \] 名字/)
      assert.doesNotMatch(text, /---\nstatus: pending/)

      // 没有清单的运行时什么都不加。
      const empty = new MemoryRuntime({ store, config: {}, logger: { warn() {} } })
      assert.equal(empty.bootstrapText(), '')
    } finally {
      bootstrap.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('清单改成 complete 后插件自己把文件删掉', async () => {
  const root = await tempDir()
  try {
    const path = join(root, BOOTSTRAP_FILE_NAME)
    await writeFile(path, '---\nstatus: pending\n---\n\n# 清单\n', 'utf8')
    const bootstrap = new BootstrapStore({ dir: root })
    await bootstrap.start()
    try {
      assert.match(bootstrap.text, /# 清单/)
      await writeFile(path, completed(), 'utf8')
      await bootstrap.reload()
      assert.equal(bootstrap.text, '')
      assert.equal(existsSync(path), false)
    } finally {
      bootstrap.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('清单是 complete 时启动就直接删，不用等下一轮', async () => {
  const root = await tempDir()
  try {
    const path = join(root, BOOTSTRAP_FILE_NAME)
    await writeFile(path, completed(), 'utf8')
    const bootstrap = new BootstrapStore({ dir: root })
    await bootstrap.start()
    try {
      assert.equal(bootstrap.text, '')
      // removeFinished 是异步的，等它落地。
      for (let attempt = 0; attempt < 100 && existsSync(path); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(existsSync(path), false)
    } finally {
      bootstrap.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('默认记忆文件补空缺，不覆盖已有的那份', async () => {
  const root = await tempDir()
  try {
    const defaultsDir = await fakeDefaults(root, {
      'SOUL.yaml': 'meta_data:\n  file_name: SOUL\n  desc: 默认\n',
      'MEMORY.yaml': 'meta_data:\n  file_name: MEMORY\n',
    })
    const dataDir = join(root, 'data')
    const globalDir = join(dataDir, '.memory')
    const stateDir = join(dataDir, 'state')
    await mkdir(globalDir, { recursive: true })
    await writeFile(join(globalDir, 'SOUL.yaml'), 'meta_data:\n  file_name: SOUL\n  desc: 我改过的\n', 'utf8')

    await seedDefaults({ defaultsDir, dataDir, globalDir, stateDir })

    assert.match(await readFile(join(globalDir, 'SOUL.yaml'), 'utf8'), /我改过的/)
    assert.match(await readFile(join(globalDir, 'MEMORY.yaml'), 'utf8'), /MEMORY/)
    assert.equal(existsSync(join(dataDir, BOOTSTRAP_FILE_NAME)), true)
    const marker = JSON.parse(await readFile(join(stateDir, SEED_MARKER_NAME), 'utf8'))
    assert.deepEqual(marker.memory.sort(), ['MEMORY.yaml', 'SOUL.yaml'])
    assert.equal(marker.bootstrap, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

await check('删掉默认文件之后不会被重新播种', async () => {
  const root = await tempDir()
  try {
    const defaultsDir = await fakeDefaults(root)
    const dataDir = join(root, 'data')
    const globalDir = join(dataDir, '.memory')
    const stateDir = join(dataDir, 'state')
    await seedDefaults({ defaultsDir, dataDir, globalDir, stateDir })
    assert.equal(existsSync(join(globalDir, 'SOUL.yaml')), true)

    await rm(join(globalDir, 'SOUL.yaml'))
    await rm(join(dataDir, BOOTSTRAP_FILE_NAME))
    await seedDefaults({ defaultsDir, dataDir, globalDir, stateDir })

    assert.equal(existsSync(join(globalDir, 'SOUL.yaml')), false)
    assert.equal(existsSync(join(dataDir, BOOTSTRAP_FILE_NAME)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

check('清单和记忆一起写进 persona 段，清单在前', () => {
  const assembly = { sections: [{ name: PERSONA_SECTION, text: '原来是人格' }] }
  const prefix = ['清单正文', '记忆正文'].join('\n\n')
  const rewritten = overridePersona(assembly, prefix, { insertMissing: true })
  assert.equal(rewritten.sections[0].text, '清单正文\n\n记忆正文')
  assert.equal(rewritten.sections[0].interpolate, false)
})

check('有清单时 persona 段缺了也要补出来，只有记忆时不补', () => {
  const missing = { sections: [{ name: 'other', text: 'x' }] }
  const withChecklist = overridePersona(missing, '清单正文', { insertMissing: true })
  assert.equal(withChecklist.sections[0].name, PERSONA_SECTION)
  assert.equal(withChecklist.sections[0].text, '清单正文')
  assert.equal(overridePersona(missing, '记忆正文'), missing)
})

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}

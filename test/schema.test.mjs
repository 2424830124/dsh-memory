/**
 * Validate the exact objects handed to `ctx.tools.register()`.
 *
 * `register()` stores `parameters` verbatim and the prompt assembly forwards it
 * to the provider unchanged, so this checks the *registered* shape rather than
 * running it through `defineTool` (which compiles an author DSL and would hide
 * an author-form parameter map that reaches the API as an invalid schema).
 *
 * The accepted subset is the one the Harness enforces for tool schemas:
 * `type / oneOf / properties / required / additionalProperties / items / enum /
 * const`, plus the `description / title / default / examples` annotations.
 *
 * Run with `node test/schema.test.mjs`.
 */

import assert from 'node:assert/strict'

const { MemoryStore } = await import('../lib/store.js')
const { MemoryRuntime } = await import('../lib/runtime.js')
const { readTool, editTool, manageTool } = await import('../lib/tools.js')

/** What a shortened result shows where the text was cut. */
const MIDDLE_MARKER = '……（略）……'

const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Collect every violation of the supported subset in one schema tree.
 * @param {unknown} node - candidate schema node.
 * @param {string} path - diagnostic path.
 * @param {string[]} violations - accumulator.
 */
function walkSchema(node, path, violations) {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue
    if (ANNOTATION_KEYWORDS.has(key)) continue
    violations.push(`${path}.${key} is not in the supported subset`)
  }
  if (Object.hasOwn(node, 'type')) {
    if (!SCHEMA_TYPES.has(node.type)) violations.push(`${path}.type ${JSON.stringify(node.type)} is not a schema type`)
    if (node.type === 'array') {
      if (!Object.hasOwn(node, 'items')) violations.push(`${path}.items is required for an array`)
      else {
        // A nested array (`items.items`) is rejected by the OpenAI-compatible
        // providers this deployment uses: they validate `items` through an
        // `anyOf` meta-schema and fail the whole request with INVALID_REQUEST.
        if (node.items?.type === 'array') {
          violations.push(`${path}.items must not itself be an array — use an array of objects instead`)
        }
        walkSchema(node.items, `${path}.items`, violations)
      }
    }
    if (node.type === 'object') {
      if (Object.hasOwn(node, 'properties')) {
        if (typeof node.properties !== 'object' || node.properties === null || Array.isArray(node.properties)) {
          violations.push(`${path}.properties must be a mapping`)
        } else {
          for (const [name, child] of Object.entries(node.properties)) walkSchema(child, `${path}.properties.${name}`, violations)
        }
      }
      if (Object.hasOwn(node, 'required')) {
        if (!Array.isArray(node.required) || node.required.some((entry) => typeof entry !== 'string')) {
          violations.push(`${path}.required must be an array of strings`)
        } else if (Object.hasOwn(node, 'properties')) {
          for (const name of node.required) {
            if (!Object.hasOwn(node.properties, name)) violations.push(`${path}.required names unknown property ${name}`)
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
    }
  }
  if (Object.hasOwn(node, 'enum') && !Array.isArray(node.enum)) violations.push(`${path}.enum must be an array`)
}

/**
 * Assert one registered tool is well formed for the provider.
 * @param {object} tool - the definition handed to `ctx.tools.register()`.
 */
function assertRegistrable(tool) {
  assert.equal(typeof tool.name, 'string')
  assert.ok(tool.name.length > 0, 'tool name must not be empty')
  assert.equal(typeof tool.description, 'string', `${tool.name}: description must be a string`)
  assert.ok(tool.description.length > 0, `${tool.name}: description must not be empty`)

  assert.ok(tool.parameters !== null && typeof tool.parameters === 'object', `${tool.name}: parameters must be an object`)
  assert.equal(
    tool.parameters.type,
    'object',
    `${tool.name}: parameters must be an object-rooted JSON Schema, not an author-form parameter map`,
  )
  assert.ok(
    Object.hasOwn(tool.parameters, 'properties'),
    `${tool.name}: parameters requires a properties map`,
  )

  const violations = []
  walkSchema(tool.parameters, 'parameters', violations)
  walkSchema(tool.output.schema, 'output.schema', violations)
  assert.deepEqual(violations, [], `${tool.name}: ${violations.join('; ')}`)

  // The registry snapshots these through a JSON round trip; anything lossy throws.
  assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), tool.parameters, `${tool.name}: parameters must be lossless JSON`)

  assert.equal(typeof tool.execute, 'function', `${tool.name}: execute must be a function`)
  assert.equal(typeof tool.output.render, 'function', `${tool.name}: output.render must be a function`)
}

const store = new MemoryStore({ homeDir: process.cwd() })
const runtime = new MemoryRuntime({
  store,
  config: { snapshotTtlMinutes: 60, workingDirectory: undefined },
  logger: { warn: () => {} },
})

const tools = [
  readTool(runtime),
  editTool(runtime),
  manageTool(runtime),
]

const failures = []
for (const tool of tools) {
  try {
    assertRegistrable(tool)
    console.log(`  ok   ${tool.name}`)
  } catch (error) {
    failures.push({ name: tool.name, error })
    console.log(`  FAIL ${tool.name}: ${error.message}`)
  }
}

// A getter that throws would break prompt assembly for every request.
for (const tool of tools) {
  try {
    const text = tool.description
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 0)
  } catch (error) {
    failures.push({ name: `${tool.name}.description`, error })
    console.log(`  FAIL ${tool.name}.description 抛出异常: ${error.message}`)
  }
}

// An undeclared parameter must fail loudly instead of being dropped silently.
for (const tool of tools) {
  try {
    await assert.rejects(() => tool.execute({ bogus: true }, { agent: {} }), /没有 "bogus" 这个参数/)
    console.log(`  ok   ${tool.name} 拒绝未知参数`)
  } catch (error) {
    failures.push({ name: `${tool.name}.unknownArg`, error })
    console.log(`  FAIL ${tool.name} 未拒绝未知参数: ${error.message}`)
  }
}

// A missing required parameter must name itself rather than reach the runtime.
try {
  await assert.rejects(
    () => editTool(runtime).execute({}, { agent: {} }),
    /缺少必填参数 "scope"、"file_name"、"heading_path"/,
  )
  console.log('  ok   memory_edit 把 scope、file_name、heading_path 声明为必填')
} catch (error) {
  failures.push({ name: 'memory_edit.missingArg', error })
  console.log(`  FAIL memory_edit 未拒绝缺失的必填参数: ${error.message}`)
}

// `memory_read` only requires `scope` when it is given a `file_name` to address.
try {
  await assert.rejects(
    () => readTool(runtime).execute({ file_name: '记忆' }, { agent: {} }),
    /必须同时给出 scope/,
  )
  assert.equal(readTool(runtime).parameters.required, undefined, 'memory_read 不该无条件声明必填参数')
  console.log('  ok   memory_read 只在传 file_name 时要求 scope')
} catch (error) {
  failures.push({ name: 'memory_read.conditionalScope', error })
  console.log(`  FAIL memory_read 的 scope 条件校验不对: ${error.message}`)
}

// `scope` is required on memory_manage: it decides which directory is addressed.
try {
  await assert.rejects(() => manageTool(runtime).execute({}, { agent: {} }), /缺少必填参数 "scope"/)
  assert.deepEqual(manageTool(runtime).parameters.required, ['scope'])
  console.log('  ok   memory_manage 把 scope 声明为必填')
} catch (error) {
  failures.push({ name: 'memory_manage.requiredScope', error })
  console.log(`  FAIL memory_manage 未把 scope 声明为必填: ${error.message}`)
}

// Each file's `format` belongs at the end of the memory_edit description.
try {
  const withFormats = editTool({
    allDocuments: () => [
      { fileName: '我的记忆', scope: 'Global', format: '写成第三人称的短句。\n一条一件事。' },
      { fileName: '工作日志', scope: 'Workspace', format: '' },
    ],
  })
  const text = withFormats.description
  assert.ok(text.includes('[Global] 我的记忆:'), 'format 块缺少 Global 文件')
  assert.ok(text.includes('  写成第三人称的短句。\n  一条一件事。'), 'format 正文未缩进保留换行')
  assert.ok(text.includes('[Workspace] 工作日志:'), 'format 块缺少 Workspace 文件')
  assert.ok(text.includes('（这个文件没有声明 format）'), '空 format 未标注')
  assert.ok(text.indexOf('[Global] 我的记忆:') > text.indexOf('修改记忆文件的正文'), 'format 块应排在用途说明之后')
  // The batch form is only reachable if the description says it exists: the
  // model reads this text before it ever looks at the parameter list, and a
  // sentence lost in an edit would quietly turn `edits` into a hidden feature.
  assert.ok(text.includes('用 edits'), '用途说明没提 edits 批量')
  assert.ok(text.includes('一批只改 scope 和 file_name 指的那一份文件'), '用途说明没说一批只能改一份文件')
  assert.ok(text.includes('缺的上级会一起建出来'), '用途说明没提自动补齐上级')
  console.log('  ok   memory_edit 描述末尾拼上了每个文件的 format')
} catch (error) {
  failures.push({ name: 'memory_edit.formatDoc', error })
  console.log(`  FAIL memory_edit 描述未拼上 format: ${error.message}`)
}

// The result names the heading path and nothing else: no stored body is echoed
// back, so the answer costs one line no matter how much text was written.
try {
  const longTitle = '一个特别长的标题名字'.repeat(4)
  const stub = {
    async edit() {
      return { outcome: { renamed: true, path: [longTitle, longTitle, longTitle] }, scope: 'Global' }
    },
  }
  const summary = (await editTool(stub).execute({
    scope: 'Global',
    file_name: '我的记忆',
    heading_path: `# ${longTitle} > ## ${longTitle}`,
    old_string: `## ${longTitle}`,
    new_string: `## ${longTitle}新的`,
  }, { agent: {} })).summary
  assert.ok(summary.includes(MIDDLE_MARKER), `长路径没有被截断：${summary}`)
  assert.ok(summary.startsWith('[Global] 已改名 我的记忆 > # '), `截断后应保留开头：${summary}`)
  assert.ok(!summary.includes(longTitle.repeat(2)), '截断后仍然保留了整段长标题')

  const short = (await editTool({ async edit() { return { outcome: { path: ['工具'] }, scope: 'Global' } } })
    .execute({ scope: 'Global', file_name: '我的记忆', heading_path: '# 工具', new_string: '习惯用中文交流。' }, { agent: {} })).summary
  assert.equal(short, '[Global] 已更新 我的记忆 > # 工具', `短结果不该被截断，也不该回显正文：${JSON.stringify(short)}`)

  // 改名时两头都报路径，都带 #，也都不带正文。
  const renamed = (await editTool({ async edit() { return { outcome: { renamed: true, path: ['新名字'] }, scope: 'Workspace' } } })
    .execute({ scope: 'Global', file_name: '我的记忆', heading_path: '# 旧名字', old_string: '# 旧名字', new_string: '# 新名字' }, { agent: {} })).summary
  assert.equal(renamed, '[Workspace] 已改名 我的记忆 > # 旧名字 为 我的记忆 > # 新名字', `改名的两头都该带 #：${JSON.stringify(renamed)}`)
  console.log('  ok   memory_edit 的结果只报标题路径，不回显正文')
} catch (error) {
  failures.push({ name: 'memory_edit.ellipsis', error })
  console.log(`  FAIL memory_edit 长结果未按预期截断: ${error.message}`)
}

// The batch form answers one line per request, in the order they were applied,
// and refuses to mix itself with the single form: the two spellings differ only
// in nesting, so a call that gives both would silently drop one of them.
try {
  const stub = {
    async edit(agent, request) {
      assert.deepEqual(request.edits.map((edit) => edit.path), [['工具', '常用'], ['新的一节']])
      return { outcomes: [{ created: true, path: ['工具', '常用'] }, { path: ['新的一节'] }], scope: 'Workspace' }
    },
  }
  const summary = (await editTool(stub).execute({
    scope: 'Global',
    file_name: '我的记忆',
    edits: [
      { heading_path: '# 工具 > ## 常用', new_string: '优先用 pwsh。' },
      { heading_path: '# 新的一节', new_string: '还没想好' },
    ],
  }, { agent: {} })).summary
  assert.equal(summary, '[Workspace] 已新建 我的记忆 > # 工具 > ## 常用\n[Workspace] 已更新 我的记忆 > # 新的一节', `批量的摘要每条一行：${JSON.stringify(summary)}`)

  assert.ok(
    (await editTool(runtime).parameters).properties.edits.required === undefined,
    'edits 自己不该是必填',
  )
  await assert.rejects(
    () => editTool(stub).execute({ scope: 'Global', file_name: '我的记忆', heading_path: '# 工具', edits: [{ heading_path: '# 工具' }] }, { agent: {} }),
    /edits 与单条参数不能同时给/,
    'edits 和单条字段同时给应该被拒绝',
  )
  console.log('  ok   memory_edit 的 edits 每条一行摘要，且与单条参数互斥')
} catch (error) {
  failures.push({ name: 'memory_edit.edits', error })
  console.log(`  FAIL memory_edit 的 edits 结果形状不对: ${error.message}`)
}

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}

/**
 * Unit checks for the memory core. Run with `node test/core.test.mjs`.
 */

import assert from 'node:assert/strict'

import { parseDocument, serializeDocument } from '../lib/document.js'
import { applyEdit, parseHeadingLine } from '../lib/edit.js'
import { DocumentError } from '../lib/errors.js'
import { createDocument } from '../lib/model.js'
import { normalizeHeadingPath } from '../lib/path.js'
import { renderNotice } from '../lib/notice.js'
import {
  HARNESS_IDENTITY_SECTION,
  PERSONA_SECTION,
  overrideHarnessIdentity,
  overridePersona,
} from '../lib/prompt-override.js'
import { renderFormats, renderInjection, renderRead } from '../lib/render.js'
import { diffEntries, diffSections, headingHashes } from '../lib/snapshot.js'
import { normalizeBody } from '../lib/text.js'
import { findNode } from '../lib/tree.js'

/** The body text of one heading, the way an edit matches against it. */
const bodyAt = (document, path) => findNode(document, path)?.desc

const SAMPLE = `meta_data:
  file_name: 我的记忆
  desc: 记录我和用户之间的一些回忆
  format: |
    记录日常
  scope: Global
  inject_ignore:
    - keyword
data:
  我们经历过的一些事:
    update_at: 2026-10-01T00:00:00+08:00
    desc: 一级正文
    keyword:
      - 回忆
    我们之间的互动:
      update_at: 2026-10-02T00:00:00+08:00
      desc: 记录了我们之间的互动
      yyyy-mm-dd:
        update_at: 2026-10-03T00:00:00+08:00
        desc: 我们今天一起出去完，用户请我吃饭
`

const failures = []
function check(name, fn) {
  try {
    fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

console.log('document')
check('normalizeBody 折叠空行与行尾空白', () => {
  assert.equal(normalizeBody('\n\n  a  \n\n\n\nb\n\n'), '  a\n\nb')
})
check('parseDocument 读取元数据与三级标题', () => {
  const doc = parseDocument(SAMPLE)
  assert.equal(doc.fileName, '我的记忆')
  assert.equal(doc.scope, 'Global')
  assert.deepEqual(doc.injectIgnore, ['keyword'])
  assert.equal(doc.format, '记录日常')
  const node = findNode(doc, ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd'])
  assert.equal(node.desc, '我们今天一起出去完，用户请我吃饭')
})
check('parseDocument 拒绝保留字标题', () => {
  assert.throws(() => parseDocument('meta_data:\n  file_name: x\ndata:\n  desc: nope\n'), DocumentError)
})
check('parseDocument 拒绝非法 inject_ignore', () => {
  assert.throws(
    () => parseDocument('meta_data:\n  file_name: x\n  inject_ignore:\n    - t9\ndata: {}\n'),
    /inject_ignore/,
  )
})
check('parseDocument 拒绝五层标题', () => {
  const text = 'meta_data:\n  file_name: x\ndata:\n  a:\n    b:\n      c:\n        d:\n          e: {}\n'
  assert.throws(() => parseDocument(text), /最多 4 级/)
})
check('serializeDocument 往返保真', () => {
  const doc = parseDocument(SAMPLE)
  const again = parseDocument(serializeDocument(doc))
  assert.equal(again.fileName, doc.fileName)
  assert.deepEqual(
    [...doc.roots.keys()],
    [...again.roots.keys()],
  )
  const a = findNode(doc, ['我们经历过的一些事', '我们之间的互动'])
  const b = findNode(again, ['我们经历过的一些事', '我们之间的互动'])
  assert.deepEqual(b.keyword, a.keyword)
  assert.equal(b.desc, a.desc)
})

console.log('edit')
check('parseHeadingLine 识别标题行', () => {
  assert.deepEqual(parseHeadingLine('## 我们之间的互动'), { level: 2, title: '我们之间的互动' })
  assert.equal(parseHeadingLine('普通文本'), undefined)
})
check('old_string 唯一匹配替换正文', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, {
    path: ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd'],
    oldString: '用户请我吃饭',
    newString: '用户请我吃了火锅',
  }, '2026-10-27T00:00:00+08:00')
  assert.equal(
    bodyAt(doc, ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd']),
    '我们今天一起出去完，用户请我吃了火锅',
  )
})
check('old_string 不存在时拒绝且不修改', () => {
  const doc = parseDocument(SAMPLE)
  const before = bodyAt(doc, ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd'])
  assert.throws(
    () => applyEdit(doc, {
      path: ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd'],
      oldString: '不存在的内容',
      newString: 'x',
    }, '2026-10-27T00:00:00+08:00'),
    /不一致/,
  )
  assert.equal(bodyAt(doc, ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd']), before)
})
check('old_string 出现多次时拒绝', () => {
  const doc = parseDocument('meta_data:\n  file_name: x\ndata:\n  a:\n    desc: |-\n      same\n      x\n      same\n')
  assert.throws(() => applyEdit(doc, { path: ['a'], oldString: 'same', newString: 'y' }, 'now'), /出现了 2 次/)
})
check('old_string 可以是跨行片段，只换这一截', () => {
  const doc = parseDocument('meta_data:\n  file_name: x\ndata:\n  a:\n    desc: |-\n      今天天气很好\n      适合出去踢球\n')
  applyEdit(doc, { path: ['a'], oldString: '很好\n', newString: '不好\n不' }, 'now')
  assert.equal(bodyAt(doc, ['a']), '今天天气不好\n不适合出去踢球')
})
check('正文开头不能是 #，中间可以有', () => {
  const doc = parseDocument('meta_data:\n  file_name: x\ndata:\n  a:\n    desc: 原来的内容\n')
  // 开头是 # 的一律拒绝：整段换掉和前面带空格都算开头。
  assert.throws(
    () => applyEdit(doc, { path: ['a'], oldString: '原来的内容', newString: '#伪标题\n补充一句' }, 'now'),
    /开头不能是 "#"/,
  )
  assert.throws(
    () => applyEdit(doc, { path: ['a'], oldString: '原来的内容', newString: '   ##前导空白也算开头' }, 'now'),
    /开头不能是 "#"/,
  )
  assert.equal(bodyAt(doc, ['a']), '原来的内容')

  // 中间和后一行可以带 #。
  applyEdit(doc, { path: ['a'], newString: '这句里有个 # 号' }, 'now')
  assert.equal(bodyAt(doc, ['a']), '原来的内容\n\n这句里有个 # 号')
  applyEdit(doc, { path: ['a'], newString: '第一行\n#后面这行不是标题' }, 'now')
  assert.equal(bodyAt(doc, ['a']), '原来的内容\n\n这句里有个 # 号\n\n第一行\n#后面这行不是标题')

  // 新建标题时正文也能带 #，只要不是开头。
  applyEdit(doc, { path: ['a', 'b'], newString: '正文 # 里有井号\n#后面这行也不是标题' }, 'now')
  assert.equal(findNode(doc, ['a', 'b'])?.desc, '正文 # 里有井号\n#后面这行也不是标题')

  // 开头写成标题行（# 后面带空格）仍旧按「重命名」解释，正文必须换一种写法。
  assert.throws(() => applyEdit(doc, { path: ['a'], newString: '# 出现在开头' }, 'now'), /改标题时必须用 old_string/)
  // 新建标题时 new_string 若以 # 打头，正文校验先拦下来。
  assert.throws(
    () => applyEdit(doc, { path: ['a', 'c'], newString: '## c\n正文' }, 'now'),
    /开头不能是 "#"/,
  )
  assert.equal(findNode(doc, ['a', 'c']), undefined)
})
check('替换后再整体整理空行：new_string 补一个换行即可断开', () => {
  const doc = parseDocument('meta_data:\n  file_name: x\ndata:\n  a:\n    desc: |-\n      今天天气很好，适合出去踢球\n')
  applyEdit(doc, { path: ['a'], oldString: '很好，', newString: '很好\n' }, 'now')
  assert.equal(bodyAt(doc, ['a']), '今天天气很好\n适合出去踢球')
})
check('替换后中间多出来的空行被压成一个', () => {
  const doc = parseDocument('meta_data:\n  file_name: x\ndata:\n  a:\n    desc: |-\n      a\n      b\n')
  applyEdit(doc, { path: ['a'], oldString: 'b', newString: 'x\n\n\n\ny' }, 'now')
  assert.equal(bodyAt(doc, ['a']), 'a\nx\n\ny')
})
check('heading_path 允许带 # 前缀', () => {
  assert.deepEqual(normalizeHeadingPath(['# 我们经历过的一些事', '## 我们之间的互动']), ['我们经历过的一些事', '我们之间的互动'])
  assert.deepEqual(normalizeHeadingPath('# 我们经历过的一些事 > ## 我们之间的互动'), ['我们经历过的一些事', '我们之间的互动'])
  assert.throws(() => normalizeHeadingPath('## 我们之间的互动'), /"#" 的个数应该是 1/)
  assert.throws(() => normalizeHeadingPath('# a > ## b > #### d'), /"#" 的个数应该是 3/)
  assert.throws(() => normalizeHeadingPath('# a > b'), /没带 #/)
  assert.throws(() => normalizeHeadingPath('a > ## b'), /没带 #/)
  assert.deepEqual(normalizeHeadingPath('   '), [])
  assert.deepEqual(normalizeHeadingPath(['我们经历过的一些事']), ['我们经历过的一些事'])
  assert.deepEqual(normalizeHeadingPath(undefined), [])
  const doc = parseDocument(SAMPLE)
  assert.notEqual(findNode(doc, normalizeHeadingPath(['# 我们经历过的一些事', '## 我们之间的互动'])), undefined)
})
check('省略 old_string 时追加到末尾', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, { path: ['我们经历过的一些事'], newString: '追加的一行' }, 'now')
  assert.equal(bodyAt(doc, ['我们经历过的一些事']), '一级正文\n\n追加的一行')
})
check('新建标题：heading_path 指到位置，new_string 填正文', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, { path: ['我想要记住的'], newString: '用户的生日是 3 月 2 日。' }, '2026-10-27T00:00:00+08:00')
  assert.equal(bodyAt(doc, ['我想要记住的']), '用户的生日是 3 月 2 日。')
})
check('新建标题时 new_string 不能再写一遍标题行', () => {
  const doc = parseDocument(SAMPLE)
  assert.throws(
    () => applyEdit(doc, { path: ['我想要记住的'], newString: '# 我想要记住的' }, 'now'),
    /new_string 填这个标题的正文/,
  )
})
check('新建二级标题由 heading_path 决定层级', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, { path: ['我想要记住的'], newString: '还没想好' }, 'now')
  applyEdit(doc, { path: ['我想要记住的', 'claude'], newString: '用的是 v4.1' }, 'now')
  assert.equal(bodyAt(doc, ['我想要记住的', 'claude']), '用的是 v4.1')
  assert.equal(findNode(doc, ['我想要记住的', 'claude']).children.size, 0)
})
check('重命名标题并保留子树', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, {
    path: ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd'],
    oldString: '### yyyy-mm-dd',
    newString: '### 2026-10-27',
  }, 'now')
  const node = findNode(doc, ['我们经历过的一些事', '我们之间的互动', '2026-10-27'])
  assert.ok(node)
  assert.equal(node.desc, '我们今天一起出去完，用户请我吃饭')
})
check('删除标题会连子树一起删掉', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, {
    path: ['我们经历过的一些事', '我们之间的互动'],
    removeOnly: true,
  }, 'now')
  assert.equal(findNode(doc, ['我们经历过的一些事', '我们之间的互动']), undefined)
})
check('关键字增删：先删后加', () => {
  const doc = parseDocument(SAMPLE)
  applyEdit(doc, {
    path: ['我们经历过的一些事'],
    addKeywords: ['日常'],
    removeKeywords: ['回忆'],
  }, 'now')
  assert.deepEqual(findNode(doc, ['我们经历过的一些事']).keyword, ['日常'])
})
check('每次编辑都会更新自身与祖先的 update_at', () => {
  const doc = parseDocument(SAMPLE)
  const before = findNode(doc, ['我们经历过的一些事']).update_at
  applyEdit(doc, {
    path: ['我们经历过的一些事', '我们之间的互动', 'yyyy-mm-dd'],
    oldString: '吃',
    newString: '喝',
  }, '2026-10-27T09:00:00+08:00')
  assert.equal(findNode(doc, ['我们经历过的一些事']).update_at, '2026-10-27T09:00:00+08:00')
  assert.notEqual(findNode(doc, ['我们经历过的一些事']).update_at, before)
})

console.log('render')
check('inject_ignore 只用来减：没列出的都注入', () => {
  const doc = parseDocument(SAMPLE)
  const text = renderInjection([doc])
  assert.match(text, /^The following is your own long-term memory\.\n\n<memory>/)
  assert.match(text, /# 我们经历过的一些事/)
  // SAMPLE 的 inject_ignore 关掉了 keyword，注入里就没有。
  assert.doesNotMatch(text, /- Keyword:/)
  // 没关的都进来。
  assert.match(text, /- Update at: 2026-10-01T00:00:00\+08:00/)
  assert.doesNotMatch(text, /format/)
  // 头部带 scope：同名文件在全局和工作区各有一份时才分得清。
  assert.match(text, /^scope: Global$/m)

  // 只关掉一级的 update_at，下面两级照旧。
  const partial = renderInjection([
    parseDocument(SAMPLE.replace('    - keyword', '    - keyword\n    - t1.update_at')),
  ])
  assert.doesNotMatch(partial, /- Update at: 2026-10-01T00:00:00\+08:00/)
  assert.match(partial, /- Update at: 2026-10-02T00:00:00\+08:00/)
})
check('不写 inject_ignore 就是全都注入', () => {
  const doc = parseDocument(SAMPLE.replace('  inject_ignore:\n    - keyword\n', ''))
  const text = renderInjection([doc])
  assert.match(text, /- Update at:/)
  assert.match(text, /- Keyword: 回忆/)
})
check('新建的记忆文件默认忽略 update_at / keyword', () => {
  const doc = createDocument({ fileName: '新建的', desc: '说明' })
  assert.deepEqual(doc.injectIgnore, ['update_at', 'keyword'])
  // 默认值要落盘，不然下次读回来又变成"全都注入"。
  assert.match(serializeDocument(doc), /inject_ignore:\n(?: {4}- \w+\n){2}/)
  // 明确写 [] 就是全都注入，默认值不能把它吃掉。
  assert.deepEqual(createDocument({ fileName: '空的', injectIgnore: [] }).injectIgnore, [])
  // 日志固定什么都不忽略，与作用域无关。
  assert.deepEqual(createDocument({ fileName: '2026-10-28', kind: 'log', scope: 'Workspace' }).injectIgnore, [])
})
check('t3 忽略整棵三级子树', () => {
  const doc = parseDocument(SAMPLE.replace('    - keyword', '    - t3'))
  const text = renderInjection([doc])
  assert.doesNotMatch(text, /yyyy-mm-dd/)
  assert.match(text, /我们之间的互动/)
})
check('什么都不注入的文件连文件头都不出现', () => {
  // 一级标题全关 = 整份文件不进提示词。
  const off = parseDocument(SAMPLE.replace('    - keyword', '    - keyword\n    - t1'))
  assert.equal(renderInjection([off]), '')

  // 一个标题都没有的文件同理：以前会剩下一个只有 file_name / desc 的空壳头。
  const blank = createDocument({ fileName: '还没写的', desc: '说明', injectIgnore: [] })
  assert.equal(renderInjection([blank]), '')

  // 旁边还有别的文件时，只有它自己消失。
  const keep = parseDocument('meta_data:\n  file_name: 留着的\n  desc: 说明\n  scope: Global\ndata:\n  一个标题:\n    desc: 正文\n')
  const text = renderInjection([off, keep])
  assert.doesNotMatch(text, new RegExp(off.fileName))
  assert.match(text, /file_name: 留着的/)

  // 但 format 是「怎么改这份文件」的说明，跳过注入不影响它。
  assert.match(renderFormats([off]), new RegExp(off.fileName))
  // 读取也不受影响：全文照旧。
  assert.match(renderRead(off), new RegExp(off.fileName))
})
check('注入改写 persona 段：只换文本，别的段与顺序不动', () => {
  const assembly = {
    sections: [
      { name: 'harness', text: 'identity' },
      { name: PERSONA_SECTION, text: '原来的 persona' },
      { name: 'tools', text: 'tools' },
    ],
    variables: { model: 'm' },
  }
  const rewritten = overridePersona(assembly, '<memory>…</memory>')
  assert.notEqual(rewritten, assembly)
  // 输入本身不能被动过：瀑布里别人拿到的还是自己交出去的那份。
  assert.equal(assembly.sections[1].text, '原来的 persona')
  assert.deepEqual(rewritten.sections.map((section) => section.name), ['harness', PERSONA_SECTION, 'tools'])
  assert.equal(rewritten.sections[0].text, 'identity')
  assert.equal(rewritten.sections[1].text, '<memory>…</memory>')
  // 记忆是用户文本：正文里的 `{{…}}` 不能被当成提示词变量去插值。
  assert.equal(rewritten.sections[1].interpolate, false)
  assert.equal(rewritten.variables.model, 'm')
})
check('记忆为空或没有 persona 段时原样返回，persona 不会被挖掉', () => {
  const assembly = { sections: [{ name: PERSONA_SECTION, text: 'persona' }] }
  assert.equal(overridePersona(assembly, ''), assembly)
  const other = { sections: [{ name: '别的段', text: '原样' }] }
  assert.equal(overridePersona(other, '记忆'), other)
  assert.equal(overridePersona({}, '记忆').sections, undefined)
  assert.equal(overridePersona(undefined, '记忆'), undefined)
})
check('预设改写 harness identity：有段换文本，没段插到最前', () => {
  const assembly = {
    sections: [
      { name: HARNESS_IDENTITY_SECTION, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: PERSONA_SECTION, text: 'persona' },
    ],
  }
  const rewritten = overrideHarnessIdentity(assembly, '新的预设')
  assert.notEqual(rewritten, assembly)
  assert.equal(assembly.sections[0].text, 'You are an AI agent powered by DeepSeek Harness.')
  assert.deepEqual(rewritten.sections.map((section) => section.name), [HARNESS_IDENTITY_SECTION, PERSONA_SECTION])
  assert.equal(rewritten.sections[0].text, '新的预设')
  assert.equal(rewritten.sections[0].interpolate, false)
  assert.equal(rewritten.sections[1].text, 'persona')

  // 宿主关掉 includeHarnessIdentity 时这一段根本不存在，预设要自己补一格，
  // 而且排在所有别的段前面（identity 的 order 是 -1000）。
  const inserted = overrideHarnessIdentity({ sections: [{ name: PERSONA_SECTION, text: 'persona' }] }, '预设')
  assert.deepEqual(inserted.sections.map((section) => section.name), [HARNESS_IDENTITY_SECTION, PERSONA_SECTION])
  assert.equal(inserted.sections[0].interpolate, false)
})
check('没有预设时原样返回，原生 identity 不被挖掉', () => {
  const assembly = { sections: [{ name: HARNESS_IDENTITY_SECTION, text: '原生 identity' }] }
  assert.equal(overrideHarnessIdentity(assembly, ''), assembly)
  assert.equal(overrideHarnessIdentity({}, '预设').sections, undefined)
  assert.equal(overrideHarnessIdentity(undefined, '预设'), undefined)
})
check('读取忽略 inject_ignore 并带上 update_at', () => {
  const doc = parseDocument(SAMPLE)
  const text = renderRead(doc, ['我们经历过的一些事'])
  assert.match(text, /- Update at: 2026-10-01T00:00:00\+08:00/)
  assert.match(text, /- Keyword: 回忆/)
})
check('整份读取是 docs/通用返回格式.md 的形状', () => {
  const text = renderRead(parseDocument(SAMPLE))
  assert.equal(text, [
    '---',
    'file_name: 我的记忆',
    'desc: 记录我和用户之间的一些回忆',
    'scope: Global',
    '---',
    '',
    '# 我们经历过的一些事',
    '- Keyword: 回忆',
    '- Update at: 2026-10-01T00:00:00+08:00',
    '一级正文',
    '',
    '## 我们之间的互动',
    '- Update at: 2026-10-02T00:00:00+08:00',
    '记录了我们之间的互动',
    '',
    '### yyyy-mm-dd',
    '- Update at: 2026-10-03T00:00:00+08:00',
    '我们今天一起出去完，用户请我吃饭',
  ].join('\n'))
  // format 是写给人看的使用说明，工具描述里已经有一份，读取结果里不再重复。
  assert.doesNotMatch(text, /format/)
})

console.log('sync')
check('diffSections 报告新增、更新与删除', () => {
  const doc = parseDocument(SAMPLE)
  const after = headingHashes(doc)
  const before = { ...after }
  before[['我们经历过的一些事', '我们之间的互动'].join('\u0000')] = 'stale'
  const changes = diffSections(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'updated')
  assert.deepEqual(changes[0].path, ['我们经历过的一些事', '我们之间的互动'])
})
check('renderNotice 每行一个变更，并写明是别的会话改的', () => {
  const text = renderNotice([
    { fileName: '我的记忆', scope: 'Global', changes: [{ path: ['a', 'b'], kind: 'updated' }, { path: ['c'], kind: 'added' }] },
  ])
  assert.match(text, /^<memory_update>/)
  assert.match(text, /别的会话修改了记忆/)
  assert.match(text, /- Global\/我的记忆: # a > ## b（别的会话更新）/)
  assert.match(text, /- Global\/我的记忆: # c（别的会话新增）/)
  assert.doesNotMatch(text, /内容更新/)
})
check('改名只报一条改名，不报整棵子树的新增与删除', () => {
  const doc = parseDocument(SAMPLE)
  const before = headingHashes(doc)
  const after = {}
  for (const [key, hash] of Object.entries(before)) {
    const path = key.split('\u0000')
    // 只改根标题，子标题的内容一个字都没动。
    after[[path[0] === '我们经历过的一些事' ? '我们之间的事' : path[0], ...path.slice(1)].join('\u0000')] = hash
  }
  const changes = diffSections(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'renamed')
  assert.deepEqual(changes[0].from, ['我们经历过的一些事'])
  assert.deepEqual(changes[0].path, ['我们之间的事'])
  const text = renderNotice([{ fileName: '我的记忆', scope: 'Global', changes }])
  assert.match(text, /# 我们之间的事（别的会话改名，原来叫 # 我们经历过的一些事）/)
})
check('只改元数据、更新时间或兄弟顺序时也报一条文件级变更', () => {
  const doc = parseDocument(SAMPLE)
  const entry = { hash: 'aaa', sections: headingHashes(doc) }
  const same = { hash: 'bbb', sections: headingHashes(doc) }
  const changes = diffEntries(entry, same)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].kind, 'file')
  assert.deepEqual(changes[0].path, [])
  // 内容真没变时保持沉默。
  assert.equal(diffEntries(entry, { ...entry }).length, 0)
})
check('空的变更列表不渲染成只有头尾的空块', () => {
  assert.equal(renderNotice([]), undefined)
  assert.equal(renderNotice([{ fileName: '我的记忆', scope: 'Global', changes: [] }]), undefined)
})

if (failures.length > 0) {
  console.log(`\n${failures.length} 项失败`)
  process.exitCode = 1
} else {
  console.log('\n全部通过')
}

# AGENTS.md

给在这个仓库里写代码的人（和 AI）看的。用户文档在 [README.md](./README.md)，这里讲结构、不变量和踩过的坑。

## 1. 这是什么

DeepSeek Harness 的跨会话长期记忆插件。记忆是磁盘上的 YAML 文件（标题树），插件把它注入提示词、给模型三个工具读写、并在别的会话改动后发一条不唤醒的通知。另有一份按天分文件的**日志**（短期记忆）。

- 做：提示词注入、读写工具、跨会话通知、按日日志、设置面板。
- 不做：自动召回、删除记忆目录、跨层级移动章节、删除日志。
- 依赖只有 `yaml`。ESM，无构建步骤，`"type": "module"`。

用户画像：聊天、扮演、轻量编程；记忆存量预期不大，塞得进提示词。

- **不做自动召回是故意的**，不是没做完。整份注入是主路径——检索排错了比不排更糟（一段"看起来相关其实是别的场景"的记忆会把模型带偏），而存量不大的时候先筛一遍只是白丢上下文。以后可能加**基于关键词的轻量召回**，定位是存量变大后的兜底，不替换整份注入。改注入流程时别把它改成 RAG。
- **头号设计目标是"结构可自定义"**，不是"功能多"。插件不预设文件清单、章节模板或字段语义，一切结构都在文件自身的 `file_name` / `desc` / `format` / 标题树 / `inject_ignore` 里。所以：不要为了某个用例往代码里塞硬编码的结构约定；加能力优先想"这件事能不能由用户自己用现有字段表达"。
- 由此推出一条实现偏好：**注入顺序和 `inject_ignore` 都按文件生效**，用户靠"分文件"控制粒度（一个文件一份用途）。这也是 `fileOrder` 只影响注入、面板拖动即排序的原因。

## 2. 跑起来

```bash
# 五份离线测试，不需要宿主（这是主要的验证手段）
node --test test/core.test.mjs test/store.test.mjs test/schema.test.mjs test/log.test.mjs test/settings.test.mjs

# 需要在真实宿主里跑：逐条验证三个工具的成功与错误路径
node test/live.mjs

# 把样例记忆渲染出来人工看一眼
node test/dump.mjs
```

本机默认 `node` 可能被沙箱拒绝，可用的 bundled node：
`E:\用户\.dsh\dsh-runtimes\dsh-plugin-desktop-primary-runtime\dependencies\node\bin\node.exe`。
**没有 `react-dom` / `react-test-renderer`**，浏览器侧代码只能在 Node 里用 hooks shim 冒烟，没法真挂载 DOM。

## 3. 分层与模块

依赖单向：`tools → runtime → store/snapshot/notice/render/edit → document/model/tree → text/path`。`errors` 谁都能 import，它谁也不 import。底层不 import 上层。

| 模块 | 职责 | 对外 |
| --- | --- | --- |
| `index.js` | 入口：读配置、挂 hook、注册工具 | `name` `inject` `Config` `apply` |
| `lib/runtime.js` | 协调：可见范围、注入文本、投递、通知、数据访问、快照生命周期 | `MemoryRuntime` |
| `lib/tools.js` | 三个工具的定义与参数校验 | `TOOL_NAMES` `readTool` `editTool` `manageTool` `renderEditDescription` |
| `lib/store.js` | 磁盘门面，把 cache/watch/writer 拼起来 | `MemoryStore` |
| `lib/cache.js` | 目录加载、缓存索引、按文件名定位 | `MemoryCache` `FILE_EXTENSION` `logRelative` `isLogRelative` |
| `lib/watch.js` | 文件监听与 200ms 防抖重载 | `MemoryWatcher` |
| `lib/writer.js` | 写入队列、hash 乐观锁、重名判定 | `MemoryWriter` |
| `lib/atomic.js` | 原子落盘（temp + rename + Windows EPERM 重试） | `writeAtomic` |
| `lib/snapshot.js` | 会话快照（三份）与标题级比对 | `headingHashes` `snapshotEntry` `diffSections` `diffEntries` `readSnapshot` `writeSnapshot` `copySnapshot` `removeSnapshot` `isStale` `pruneSnapshots` |
| `lib/notice.js` | 比对结果 → 通知文案（空列表返回 `undefined`） | `NOTICE_SOURCE_KIND` `renderNotice` `renderBrokenNotice` |
| `lib/render.js` | 文档 → 文本（注入、读取、日志、文件清单、format 段） | `renderInjection` `renderRead` `renderLog` `renderLogRange` `renderFileList` `renderFormats` |
| `lib/edit.js` | 一次编辑请求的全部语义 | `applyEdit` `parseHeadingLine` |
| `lib/log.js` | 日志形状、日期与时间查询、固定规则文案 | `LOG_DIR_NAME` `LOG_MAX_DEPTH` `DEFAULT_SUMMARY_MAX_CHARS` `LOG_DESCS` `logRules` `logReadRules` 等 |
| `lib/document.js` | YAML ↔ 文档对象 | `parseDocument` `serializeDocument` |
| `lib/model.js` | 常量、字段校验、节点与文档构造 | `MAX_DEPTH` `RESERVED_KEYS` `INJECT_IGNORE_OPTIONS` `INJECT_IGNORE_LEVELS` `SCOPES` `createNode` `createDocument` `cloneDocument` 等 |
| `lib/tree.js` | 标题树查找与改写 | `walk` `findNode` `findSiblings` `touchPath` `renameHeading` |
| `lib/text.js` | 文本规范化 | `normalizeBody` `normalizeFragment` `normalizeMetaLine` `normalizeMetaBlock` |
| `lib/path.js` | 标题路径 | `PATH_SEPARATOR` `normalizeHeadingPath` `headingLabel` |
| `lib/hash.js` | 哈希 | `hashText` `shortHash` |
| `lib/paths.js` | 目录布局（唯一的路径来源） | `resolveLayout` |
| `lib/errors.js` | 全库唯一的错误类型 | `DocumentError` |
| `lib/config-schema.js` | 配置项的单一事实来源 | `CONFIG_FIELDS` `CONFIG_FIELD_BY_KEY` `defaultSettings` `readField` `formatScalar` |
| `lib/config.js` | 配置文件读写（就地改行、保留注释） | `CONFIG_FILE_NAME` `loadConfigFile` `saveConfigValue` |
| `lib/settings-route.js` | 设置面板的 HTTP 端点 | `SETTINGS_ROUTE` `createSettingsHandler` |
| `client.js` | 浏览器侧「记忆」标签页：装配、i18n、样式、状态与 effect | 模块工厂，注册进 `conversation.view` |
| `client.settings.js` | 设置表单渲染（chunk） | `renderSettings` |
| `client.browse.js` | 左栏列表渲染（chunk） | `renderBrowser` |
| `client.file.js` | 右栏详情与标题卡渲染（chunk） | `renderFile` |

`lib/store.js` 只是门面，三块互不认识：`cache.js` 不认识文件系统事件，`watch.js` 不认识 YAML，`writer.js` 不认识监听。它们之间用 `cache.onLoaded` 回调挂钩，所以 cache 不用 import watcher，也就没有循环依赖。

## 4. 不变量（改代码时别破坏）

1. **注入顺序必须稳定**。同一批文件、同一批配置，每次组装出的文本逐字节相同。不按 `update_at` 排、不按修改时间排——注入是 system prompt 的前缀，顺序一漂，整段缓存全废。
2. **一个会话的前缀在整个生命周期内不变**。注入文本和 `memory_edit` 描述按会话冻结（§6），只有快照过期重建时才重算。
3. **标题最多 4 级**，由 `lib/model.js` 的 `LEVELS` 派生（`MAX_DEPTH`、`RESERVED_KEYS`、`inject_ignore` 合法值都跟着走）。加一层只改 `LEVELS`。
4. **`desc` / `keyword` / `update_at` 是标题的保留字**，任何层级都不能当标题名。
5. **同级不能重名**；`file_name` 在"一个会话能看到的目录"里唯一（不同工作区各自同名是允许的）。
6. **序列化往返稳定**：`serializeDocument` → `parseDocument` 必须得到同一份文档；空字段不写进文件。
7. **正文开头不能是 `#`**（会被读成标题行）；中间和后面几行可以。日志的 `old_string` / `new_string` 同理，只在开头这一条上拒绝。
8. **错误绝不外抛**：注入组装、agent 创建、工具管线里的异常都可能毁掉无关请求。每个 hook 都包住，最坏降级成空注入 / `return []` / 一条 warning。
9. **通知只在"这个会话还没被告知过"时发**，唯一实现点是 `MemoryRuntime.notifyAgent()`。
10. **面板不另做一套渲染**：「原文」和「注入效果」都走 `runtime.fileText()`，跟 `memory_read` / `renderInjection` 同源。

## 5. 提示词注入

`ctx.systemPrompt.section({ name:'memory', order, text })`，`order` 取宿主 `getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') - 1`——排在 harness identity 之后、persona 之前。**不开放配置**：记忆要先于任务描述被读到；做成选项只会被人调到工具说明中间去。

格式：一句 `The following is your own long-term memory.`（在标签外）+ `<memory>` 包住若干 `---` 分隔的文件块。文件头带 `file_name` / `desc` / `scope`；每个标题下是 `- Keyword:`、`- Update at:` 行，然后正文。

- 那句英文是为了解决人称错位：记忆用「我」的口吻写，提示词其余部分是英文第二人称。
- `format` 不注入（只进 `memory_edit` 的描述）。
- `inject_ignore` 生效：`t3` 忽略整棵三级子树，`desc` 忽略所有正文，`t2.desc` 只忽略二级的正文。唯一判断点是 `render.js` 的 `isSuppressed()`。
- 顺序：全部全局文件 → 全部工作区文件，段内按 `localeCompare(…, 'zh')`；`fileOrder` 把列出的按给定先后排在前面。`overview()` 与 `injectedDocuments()` 共用 `orderByConfig()`，所以面板列表的顺序**就是**注入顺序。
- 一个文件都没有时返回空串，不注入空块。

## 6. 会话快照（三份，一个文件）

`~/.dsh/dsh-memory/state/sessions/<sessionId>.json`，`version: 4`：

```json
{
  "version": 4,
  "updatedAt": "…",              // 模型最后一条消息的结束时间（agent/turn-stopping 时写）
  "injected": { "text": "…", "logKeys": ["<dir>\u0000<fileName>"] },
  "tools": "…",                  // 冻结的 memory_edit 描述全文
  "files": { "<dir>\u0000<fileName>": { "hash": "…", "sections": { "<path>": "…" } } }
}
```

| 字段 | 作用 | 何时变 |
| --- | --- | --- |
| `injected` | 提示词里那段记忆就注入这份文本 | 冻结，只有过期重建时重算 |
| `tools` | `memory_edit` 的工具描述 | 冻结，同上 |
| `files` | 检测"哪几个标题变了" | 每次文件更新都推进 |

- **为什么冻结前两份**：它们都在请求最前面，改一个字符就切断供应商的前缀缓存。文件一改就重渲染，等于每次编辑都把该会话的缓存作废——而它本来已经看过那批文件了。变化改走通知。
- **`tools` 怎么按会话冻结**：全局注册的 `memory_edit` 描述是 getter，每次装配重算（列着每个文件的 format）。`index.js` 的 `freezeEditTool()` 在 `agent/created` 里用 `agent.ctx.tools.register()` 注册**同名副本**，描述换成冻结文本——宿主工具层按"自己的层覆盖全局层"解析同名工具。子 agent 不做这件事（它的 `memory_edit` 刚被 `tools.restrict` 拒掉，再注册会绕回去）。
- **`files` 里为什么收日志**：注入冻结后，别的会话往当天日志追加的内容不会再从实时注入看到，通知是唯一出路。冻结那刻纳入的日志 key 存在 `injected.logKeys`，所以**改注入天数不影响旧会话**，只有重建的新会话遵守新配置。
- **`updatedAt` 是模型最后一条消息的结束时间**，不是写入时间：一直在说话的会话必须保持同一前缀，只有真闲下来才算数。`snapshotTtlMinutes`（默认 60，`0` 关闭）控制窗口；启动清一次，之后按窗口一半周期清（夹在 1–30 分钟）。`sectionText()` 里也判一次，闲过头的会话丢掉冻结部分重渲染。
- **分叉复制父快照**：`agent.session.header.parentSession` 指向父会话，`copySnapshot()` 拷整份文件。父快照可能已被清掉，或者它自己就过期了——那就当没有基线，按当前状态重建。
- **版本不符 / 文件损坏 / 缺失**一律当"没有基线"：会话直接采纳当前状态，不回放历史。新会话同理——否则它一开口就会收到一条"所有文件都是新增"的通知。
- **`sections` 的键是完整标题路径**，所以改父标题会让整棵子树的键都变。`diffSections()` 先做一次改名识别：一对"消失"和"出现"的路径如果等长、只差一处、且内容指纹相同（或子树集合完全一致），合并成一条 `renamed`。这一识别只此一处。
- `sections` 看不见"只改 `meta_data`"或"同级重排"，那时 `diffEntries()` 退回文件级 `{ path: [], kind: 'file' }`——只要整份文件 `hash` 变了就一定有话说。整份文件被删时 `describeChanges()` 反向遍历基线里多出来的键，报 `deleted`。
- **`writeSnapshot` 兼容"只传 files"**（旧调用与测试用），内部包成 `{ files }`；`injected` / `tools` 只在有值时写入，避免推进基线时把冻结部分冲掉。

## 7. 投递与通知

- `agent.inject(message)` 塞进收件箱，**不唤醒** agent。消息 `source` 带 `{ kind: 'memory', snapshot }`。
- 入队即记为"已推进"（`delivered` + `inFlight`），闲置很久的会话不会重复收同一批变化。
- 被丢弃（`agent/inbox/discarded`）→ `release()` 把基线退回去，下次还会通知。
- 被消费（`agent/inbox/claimed`）→ `claim()` 落实快照并用新状态重算。
- 文案：`<memory_update>` + 一行说明 + 每条变化一行；五种说法 `added` / `updated` / `removed` / `renamed`（带原路径）/ `file`（元数据、更新时间或同级顺序变了）/ `deleted`（整份文件没了）。列表为空时**什么都不发**（`renderNotice()` 返回 `undefined`）。
- 文件解析失败另发 `<memory_broken>`，同一签名只发一次；坏文件不参与"被删了"的比对。

## 8. 日志

一天一个文件，`log/<yyyy-mm-dd>.yaml`，最多 2 级（`LOG_MAX_DEPTH`）。一级标题固定是当天日期（= `file_name`），二级是 `HH:MM 摘要`，条目的 `desc` 就是不限长度的细节。摘要写在标题里，是为了"一次 `memory_edit` 记完一件事"，不用先写摘要再寻址到 `detail`。

- `meta_data` 只有 `file_name` 和按 `scope` 写死的 `desc`（`LOG_DESCS`）；多一个键就解析失败。
- 写：`heading_path` 必须写全 `# 2026-10-27 > ## 12:35 摘要`，少一层多一层都报错；条目按时间插入；只能写当天；不能改名、不能删除。
- 读：`file_name` 是日期（`2026-10-26..2026-10-27` 是范围），`heading_path` 用 `12:00..14:00` 收窄；范围分隔符是 `..`，路径分隔符是 ` > `，混用会明确报错，不猜。非法范围**显式抛错**，不会静默把当天条目全丢掉。
- 同一时刻可以有多条条目（`19:20 去了` / `19:20 回来`），路径的键是完整标题不是时分；摘要不参与匹配。
- 当天文件在 `start()` 和每次 `attach()` 补建；零点 +5 秒切天，定时器 `unref()`。
- 注入（`injectLog`，默认关）：每作用域一份文件头（`kind: log`、`desc`、`scope`），最新的那天带正文，更早的只剩标题；预算四个数见 `CONFIG_FIELDS`；某天没条目就不占预算。`renderLog()` 只渲染一天，`renderInjection()` 负责分组加头。

## 9. 存储层

- 直接 `node:fs`，不走 `ctx.fs`：记忆是插件私有数据，走组合文件系统会触发沙箱策略、审批提示和 fs 观察事件。
- 缓存按「目录 → 磁盘相对路径」分层（文件可能被外部改名，模型的寻址键是 `meta_data.file_name`）。
- 一个目录下挂 `*.yaml` 和 `log/*.yaml` 两层，只扫一层；目录之间、目录内文件之间都并发加载。
- `ensureDirectory()` 首次加载 + 起 watcher。**在飞的加载记在 `loading` 表**，同目录并发调用共享同一次加载——先塞空缓存再慢慢填，会让第二个调用者看到"已加载"却拿到空列表，文件就像突然不见了。
- 写入串行化（每路径一条队列，写完自清），temp + rename 落盘；`writeAtomic` 在 Windows 上对 `EPERM`/`EBUSY`/`EACCES` 退避重试，temp 名带进程 id + 时间 + 递增计数（同一毫秒并发写同一路径会撞名）。
- 乐观锁读的是**原路径**（`baseRelative`）：面板改名时新路径上还没文件，只按新路径算哈希会得到 `undefined`，锁就被跳过了。文件在中间被别人删掉是**报错**而不是静默重建；改名后旧文件删不掉也报错（"请手动删掉，否则会同时存在两份"）。
- 外部改动 → `reloadFile` → `onChange` → `runtime.handleExternalChange` → 给能看见该目录的会话算通知。

## 10. 工具

参数用 **compiled JSON Schema** 手写，不用作者 DSL（`ctx.tools.register()` 原样透传 `parameters`）。可用子集：`type / oneOf / properties / required / additionalProperties / items / enum / const` + `description / title / default / examples`。

`defineTool()` 统一提供：未知参数报错、缺必填报错、`exec.agent` 为空报错、`DocumentError` 转成人能读的文案。`memory_edit` / `memory_manage` 在子 agent 里被 `tools.restrict({ deny })` 关掉。

`memory_edit` 的语义（`applyEdit`）：

- `heading_path` 指向不存在的标题 → 新建（父级必须已存在）。
- 只有 `new_string` → 追加到正文末尾；`old_string` + `new_string` → 正文里唯一匹配替换。
- `new_string` 为空串 → 删除该标题及整棵子树。
- `old_string` 是标题行（`## 旧标题`）→ 改名，`#` 个数必须等于层级，子标题保留。
- `keyword` 先删后加，同一行只留一份；每次编辑更新目标标题与所有祖先的 `update_at`。
- 编辑在 `cloneDocument` 副本上做，写盘失败不会让缓存显示一份没落盘的文本。
- 写前必须读过：`rememberRead()` 记下哈希，编辑时比对；`store.write()` 再比一次磁盘哈希。

## 11. 面板与 chunk 契约

`client.js` 主包 ~2100 行（状态、effect、i18n、样式、跨区 helper），三个 `client.*.js` 是 chunk，由主包用 `require.async()` 按需加载。**文件名必须匹配宿主的 `client.*.js` 正则**，且与 `client.js` 同目录。

- chunk 里**只有**"拿 props 返回 vnode"的纯函数：没有 hooks、没有 state、不 import 彼此的辅助函数。样式常量、`t`、全部 state 与 setter、以及跨区共用的工厂（`placeholder` / `chips` / `spawnAdd` / `saveFile` …）都由主包当 props 传下去。状态只有一份，chunk 只负责画。
- 用 `useState` + `useEffect` 加载 chunk，不用 `React.lazy`：不依赖宿主有没有包 Suspense 边界。没加载完之前右栏是 skeleton、左栏和设置表单显示"加载中"。
- 面板自己定高：`ResizeObserver`（面板 + 滚动宿主）+ 宿主 DOM 的 `MutationObserver` + `window.resize` 触发，`requestAnimationFrame` 合帧。**别改回轮询**。
- 控件一律用宿主 `@deepseek-ai/dsh-client-ui-primitives` 的（`Button` `Input` `InputNumber` `SegmentedControl` `Switch` `Tag` `InlineAlert` `MarkdownText` `Icon*`）；颜色一律用主题别名（`--dsw-alias-*`），不写死十六进制。图标不透传 `style`，颜色交给外层元素。
- 不用 `window.prompt` / `window.confirm`（Electron 里前者不支持、后者同步阻塞会让窗口收不到指针事件），新建/删除都在栏内展开。
- 保存只替换**刚保存的那一半**草稿，另一半（还没保存的正文或描述）留在原处——把整份草稿重建成磁盘状态等于抹掉用户正在写的东西。
- 保存按钮用 `inFlight` ref 挡重复点击：回车和按钮能在同一次渲染里各触发一次，`busy` 那时还是 `false`。
- 切作用域 / 切货架时清空选中项**连同草稿**（待删标题、待建卡片、待加关键词），否则在 A 上标了要删的标题、切到 B 一保存就会把 A 的路径发出去。

## 12. 设置路由

```
GET  /plugins/dsh-memory/settings?session=<id>
     → { fields, settings, scopes, injectIgnoreOptions, injectIgnoreLevels }
GET  …&scope=Global&file=<名>&kind=log
     → 上面那份 + { file: { fileName, scope, kind, source, text, injected, meta, tree } }
POST …                    ← { logSummaryMaxChars: 400 }           改配置
POST …?session=<id>       ← { file: { scope, fileName, kind, newFileName?, desc?, format?, injectIgnore?, nodes, newNodes?, removed? } }
POST …?session=<id>       ← { create: { scope, kind, fileName } }
POST …?session=<id>       ← { remove: { scope, kind, fileName } }
```

- POST 带 `file` 走 `runtime.patchFile()`（落盘前用读到的哈希做乐观锁）；带 `create` / `remove` 走 `createFile()` / `deleteFile()`。
- `source` 是磁盘原文，`text` 是 `memory_read` 的返回，`injected` 是提示词里的形状，`meta` + `tree` 是画卡片的结构（浏览器不解析 YAML）。
- 设置写回走 `saveConfigValue()`：按 `key:` 逐行改，注释和其他键原样保留（不 parse 再序列化）。
- 请求体坏了、字段不对、方法不对，路由自己回 JSON 错误（400/405/500），不往上抛。
- 没有 Web server 的 profile（headless）就没有这条路由，不算失败。

## 13. 配置

`lib/config-schema.js` 的 `CONFIG_FIELDS` 是**唯一事实来源**，同时喂给三处：`index.js` 的 Schemastery `Config`、设置路由的校验、`client.js` 的控件。加一个配置项只有两步——`CONFIG_FIELDS` 加一条，`client.js` 的 `DICTIONARIES` 补 `field.<key>` / `hint.<key>` 两句文案。

优先级：`config.yaml` > profile 插件配置 > 内置默认值。合并前只挑字段表认识的键（手写的旧键不会把整份配置带崩），合并后再用同一份 schema 校验一次，不合法就 warning + 默认值。

**目录不可配置**：`resolveLayout()` 只读环境（`DSH_HOME`，没有就是 `~/.dsh`），Global 在 `<home>/dsh-memory/.memory`，工作区在 `<workspace>/.memory`。早期这几个是可配置的，删掉是因为一个写错的路径会让插件安静地读到一份空记忆。要换位置就改 `DSH_HOME`。

## 14. 扩展点

- **加标题层级**：改 `lib/model.js` 的 `LEVELS`（`MAX_DEPTH`、`RESERVED_KEYS`、`inject_ignore` 合法值全跟着走；`renderNode` 用 `depth` 递归，不用改）。
- **加标题字段**（比如 `tag`）：`ASPECTS` 加一项 → `model.js` 读取校验 → `document.js` 读写 → `render.js` 一段渲染。`inject_ignore` 合法值自动扩展。
- **换存储**：只动 `store.js`（含 `cache.js` / `watch.js` / `writer.js`）和 `paths.js`。
- **换通知策略**：`runtime.js` 的通知都汇到 `notifyAgent()`，比对在 `describeChanges()`，文案在 `notice.js`。
- **加工具**：`defineTool()` 已含参数校验、agent 检查、错误包装、`presentCall`，新工具只写 `name/description/properties/run/present`。
- **改日志形状**：`log.js` 的 `LOG_MAX_DEPTH` / `parseLogEntryTitle` / `assertLogTitle` 是全部形状规则；`isLogDate()` 是唯一日期判定点，`parseLogDateQuery()` 是唯一日期查询解析点。

规划中但没做的三件事（用户已在 [README](./README.md#近期目标) 里定了优先级，别擅自提前实现）：

1. **关键词召回** —— 它和不变量 2（前缀按会话冻结）**天然冲突**：召回结果随话题变，注入文本一改缓存全废。要做得在会话开始 / 快照重建那一刻召一次、结果跟快照一起冻结，不是每轮召回。落地前先把"省下的 token vs 打掉缓存的钱"算清楚。
2. **人设预设** —— 会话级前缀，走同一套冻结。难点是接入口：新建会话是宿主动作，插件目前只有 `conversation.view` 一个落点。
3. **定时/定频注入** —— 倾向追加到对话（像通知那样不唤醒），不要改系统提示词，否则又是在动前缀。

## 15. 约定与坑

- **改文本文件只能用 read / edit / write 工具。** 别用 PowerShell 的 `Get-Content -Raw | Set-Content -Encoding UTF8`：它会把 UTF-8 当 GBK 解码，整份文件变乱码（本项目真被这个毁过一次）。用 Node 脚本做行区间手术是安全的（`readFileSync(...,'utf8')` → `writeFileSync(...,'utf8')`），但仍要跑 `node --check` 并复读。
- **别给"测试正在等"的定时器加 `unref()`。** `unref()` 让事件循环不再等它，顶层 `await` 就永远不 settle，Node 判定进程无事可做直接退出（`test/store.test.mjs` 的文件监听用例真被这个打挂过）。`watch.js` 的防抖定时器**不能** unref；`runtime.js` 的午夜切天与快照清扫不参与测试等待，可以 unref。
- 仓库没有 `.git`，所以没有别的副本；`.backup/` 里是几个历史快照。
- 中文文案统一用中文全角标点；报错要告诉模型"哪一份、哪个标题、为什么"，不要只说"失败"。
- 新增行为优先补测试（五份 suite 是唯一自动验证）；`test/live.mjs` 只在真实宿主里跑。
- `locale/zh.json` / `locale/en.json` 是插件的元信息（面板外），面板内的文案在 `client.js` 的 `DICTIONARIES`。

## 16. 文档

- [README.md](./README.md) —— 用户文档（安装、配置、面板、文件格式）。
- `docs/` —— 落盘与返回形状的参照，不参与运行；形状变了要顺手改，测试不替它们兜底：
  [记忆文件格式](docs/记忆文件格式.md)、[日志文件格式](docs/日志文件格式.md)、
  [通用返回格式](docs/通用返回格式.md)、[日志返回格式](docs/日志返回格式.md)。

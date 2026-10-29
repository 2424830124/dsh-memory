/**
 * client.file.js：面板的渲染函数，由 `client.js` 用 `require.async` 按需取走。
 *
 * 这里只有「拿 props 返回 vnode」的纯函数：状态、effect、i18n 的 `t` 与全部样式都在主包，
 * 通过 props 传进来。拆出去是为了让主包只剩编排，不至于一个组件六千行。
 * 没有 hooks：hooks 必须在组件里按固定顺序调用，搬进 lodash 式的纯函数就不成立了。
 */
window.__ModuleLoader__.load({
  id: '@huai_xin/dsh-memory',
  chunk: 'client.file.js',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const render = (props) => {
      const {
        MAX_DEPTH,
        UI,
        addButton,
        addInputStyle,
        addText,
        adding,
        adds,
        caretStyle,
        chevronStyle,
        chipRowStyle,
        chips,
        collapsed,
        contentNote,
        contentOpen,
        deleteButtonStyle,
        dropLevel,
        keepSubmenu,
        editFile,
        editorStyle,
        emptyHintStyle,
        file,
        fileDirty,
        fileError,
        fileTextStyle,
        h,
        ignoreLabel,
        ignoreLevels,
        ignoreOptions,
        injectView,
        injectedBodyStyle,
        injectedPreview,
        isRemoved,
        keepLevel,
        metaLabelStyle,
        metaNote,
        metaOpen,
        metaRowStyle,
        nodeCardStyle,
        nodeChildrenStyle,
        nodeMetaRowStyle,
        openPicker,
        paneCaption,
        paneHeadStyle,
        paneStyle,
        paneSwitchActiveStyle,
        paneSwitchGroupStyle,
        paneSwitchStyle,
        paneTitleStyle,
        panesStyle,
        patchMeta,
        patchNode,
        picker,
        pickerAnchorStyle,
        pickerGroupStyle,
        pickerItemStyle,
        pickerRect,
        pickerStyle,
        placeholder,
        samePath,
        saveButtonStyle,
        saveFile,
        savingPart,
        setAddText,
        setAdding,
        setAdds,
        setCollapsed,
        setContentOpen,
        setEditFile,
        setInjectView,
        setMetaOpen,
        setPicker,
        setRemoved,
        setSubmenu,
        skeleton,
        sourceColumnStyle,
        spawnAdd,
        submenu,
        t,
        underPath,
        when,
      } = props

      /** 「标签 + 控件」横排一行：标题行、关键词行、不注入行都长这样。 */
      const inlineRowStyle = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }

      /** 浮层锚点：不参与伸缩，只管撑住它自己。 */
      const anchorSlotStyle = { flex: '0 0 auto', display: 'flex' }

      /**
       * 一张标题卡的第一行：折叠三角、标题输入框、加子级、删除。
       *
       * 「还没落盘」的卡和磁盘上已有的标题长得一样——展开收起 + 就地改标题 +
       * 往下加一层 + 砍掉这一支，所以这一行只写一遍，两处都调它。
       *
       * @param {object} parts - `{open, onToggle, title, onTitle, placeholder, onAddChild, onRemove}`.
       *   `onAddChild` 省略时不画那个「+」（例如已经在最深一层）。
       * @returns {object} the row.
       */
      const cardTitleRow = (parts) => h('div', {
        style: inlineRowStyle,
      },
        h('button', {
          type: 'button',
          className: 'dsm-hover',
          'aria-label': t('node.title'),
          'aria-expanded': parts.open,
          onClick: parts.onToggle,
          style: {
            display: 'flex',
            alignItems: 'center',
            flex: '0 0 auto',
            padding: '2px',
            border: 'none',
            background: 'transparent',
            color: 'inherit',
          },
        }, h('span', { 'aria-hidden': true, style: caretStyle(parts.open) })),
        h('input', {
          type: 'text',
          value: parts.title,
          'aria-label': t('node.title'),
          ...(parts.placeholder === undefined ? {} : { placeholder: parts.placeholder }),
          className: 'dsm-hover',
          style: {
            flex: '1 1 auto',
            minWidth: 0,
            fontSize: 13,
            fontWeight: 600,
            lineHeight: '20px',
            color: 'var(--dsw-alias-label-primary)',
            padding: '0 4px',
            borderRadius: 4,
            border: '1px solid transparent',
            background: 'transparent',
          },
          onChange: (event) => parts.onTitle(event.target.value),
        }),
        parts.onAddChild === undefined || parts.onAddChild === null
          ? null
          : h('span', { style: anchorSlotStyle },
            addButton(false, parts.onAddChild, t('node.addChild'))),
        h('button', {
          type: 'button',
          className: 'dsm-hover',
          'aria-label': t('remove'),
          onClick: parts.onRemove,
          style: deleteButtonStyle,
        }, '×'))

      /**
       * 关键词那一行：已有的词做成可删的标签，右边留给「+」和它的输入框。
       *
       * @param {object} parts - `{keywords, onRemove, anchor}`; `anchor` 就是那个「+」/ 输入框。
       * @returns {object} the row.
       */
      const keywordRow = (parts) => h('div', {
        style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0, width: '100%' },
      },
        h('span', {
          style: { flex: '0 0 auto', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-tertiary)' },
        }, `${t('node.keyword')}:`),
        h('div', { style: { ...chipRowStyle, flex: '1 1 auto' } }, chips(parts.keywords, parts.onRemove)),
        parts.anchor)

      const pendingRow = (entry) => {
        const rowKey = `add:${entry.id}`
        const open = collapsed[rowKey] === undefined ? true : collapsed[rowKey] !== true
        const kwKey = `pkw:${entry.id}`
        const keywordList = entry.keyword ?? []
        const childPath = [...entry.parent, entry.title]
        const saveWord = () => {
          const word = addText.trim()
          if (word !== '' && !keywordList.includes(word)) patchAdd(entry, { keyword: [...keywordList, word] })
          setAdding(null)
          setAddText('')
        }
        const heading = cardTitleRow({
          open,
          onToggle: () => setCollapsed((previous) => ({ ...previous, [rowKey]: open })),
          title: entry.title,
          placeholder: t('node.title'),
          onTitle: (value) => patchAdd(entry, { title: value }),
          onAddChild: childPath.length < MAX_DEPTH ? () => spawnAdd(childPath) : null,
          onRemove: () => setAdds((previous) => previous.filter((item) => item !== entry
            && !underPath(item.parent, childPath))),
        })
        const bodyBox = h('textarea', {
          rows: 2,
          value: entry.desc ?? '',
          'aria-label': t('node.title'),
          className: 'dsm-hover',
          style: { ...editorStyle, borderStyle: 'dashed', color: 'var(--dsw-alias-label-secondary)' },
          onChange: (event) => patchAdd(entry, { desc: event.target.value }),
        })
        // 还没落盘：更新时间先空着，关键词可以先写好。
        const anchor = h('span', { style: anchorSlotStyle },
          adding === kwKey
            ? h('input', {
              type: 'text',
              autoFocus: true,
              value: addText,
              placeholder: t('keyword.add'),
              'aria-label': t('keyword.add'),
              className: 'dsm-hover',
              style: { flex: '0 0 140px', ...addInputStyle, position: 'static' },
              onChange: (event) => setAddText(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setAdding(null)
                  return
                }
                if (event.key !== 'Enter') return
                event.preventDefault()
                saveWord()
              },
              onBlur: () => {
                setAdding(null)
                setAddText('')
              },
            })
            : addButton(false, () => {
              setAdding(kwKey)
              setAddText('')
            }, t('keyword.add')))
        const meta = h('div', {
          style: { ...nodeMetaRowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
        },
          h('span', {
            style: { color: 'var(--dsw-alias-label-tertiary)' },
          }, `${t('node.updatedAt')}: —`),
          keywordRow({
            keywords: keywordList,
            onRemove: (item) => patchAdd(entry, { keyword: keywordList.filter((word) => word !== item) }),
            anchor,
          }))
        const children = adds.filter((item) => !isRemoved(item.parent) && samePath(item.parent, childPath))
        return h('div', {
          key: `add:${entry.id}`,
          style: { ...nodeCardStyle, borderStyle: 'dashed' },
        },
        heading,
        open && bodyBox,
        open && meta,
        open && children.length > 0 && h('div', { style: nodeChildrenStyle },
          children.map((item) => pendingRow(item))))
      }

      /**
       * 改一条「待新建」的标题草稿。
       *
       * @param {object} entry - the pending heading.
       * @param {object} change - the fields to overwrite.
       * @returns {void}
       */
      const patchAdd = (entry, change) => {
        setAdds((previous) => previous.map((item) => {
          if (item === entry) return { ...item, ...change }
          if (change.title === undefined) return item
          if (!samePath(item.parent, [...entry.parent, entry.title])) return item
          return { ...item, parent: [...entry.parent, change.title] }
        }))
      }

      /**
       * Where a panel hangs off `rect`: below it, or above when there is no room.
       *
       * `height` 只用来算翻不翻面，不写进样式——面板多高交给内容，
       * 写死会在下面撑出一块空白。
       * @returns {object} left / top / width.
       */
      const anchorBox = (rect, width, height) => {
        if (rect === null) return { display: 'none' }
        const gap = 4
        const room = typeof window === 'undefined' ? 0 : window.innerHeight
        let top = rect.bottom + gap
        // 贴着窗口底就翻到按钮上面去，免得下面半截露不出来。
        if (room > 0 && top + height > room - 8) top = Math.max(8, rect.top - gap - height)
        return { left: Math.max(8, rect.right - width), top, width }
      }

      /**
       * 合法的不注入项：外层「整层/单项」，标题行右边的「›」再浮出该层的三项。
       *
       * 行本身就是选项：点「一级标题」加的是 `t1`（整层不注入）；「›」只是展开
       * 细分项。已经选过的不再列出。两层都用 `position: fixed`——面板在可滚动的
       * 列里，`absolute` 会被裁掉。
       * @param {string[]} chosen - values already in `inject_ignore`.
       * @param {(value: string) => void} onPick - add one.
       * @returns {object} the panel.
       */
      const ignorePicker = (chosen, onPick) => {
        const usable = ignoreOptions.filter((value) => !chosen.includes(value))
        // 整层的值单独成行，别再混进「单项」里，否则同一条会出两次。
        const plain = usable.filter((value) => !value.includes('.') && !ignoreLevels.includes(value))
        // 整层没被选过就一定可选：校验表现在也认整层值，只是宿主那份选项表要重启才刷新。
        const levels = ignoreLevels.filter((level) => !chosen.includes(level))
        // 菜单行：整行可点，右边留给「›」。子菜单从整行右侧浮出来。
        const menuItemStyle = {
          ...pickerItemStyle,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }
        const item = (value, text) => h('button', {
          key: value,
          type: 'button',
          className: 'dsm-hover',
          onClick: () => onPick(value),
          style: menuItemStyle,
        }, h('span', null, text))
        const rows = plain.length + levels.length
        const box = anchorBox(pickerRect, 172, 12 + Math.max(rows, 1) * 26)
        return h('div', {
          style: { ...pickerStyle, ...box, minWidth: 0, maxHeight: 320, overflowY: 'auto', gap: 2 },
          'data-dsm-picker': '1',
          onMouseLeave: dropLevel,
        },
        usable.length === 0 && h('span', { style: pickerGroupStyle }, t('nothing')),
        plain.map((value) => h('div', { key: `plain:${value}`, onMouseEnter: () => setSubmenu(null) },
          item(value, ignoreLabel(value)))),
        levels.map((level) => {
          const parts = usable.filter((value) => value.startsWith(`${level}.`))
          const open = submenu?.level === level
          return h('div', {
            key: level,
            style: { display: 'flex', alignItems: 'center', gap: 2 },
            onMouseEnter: (event) => keepLevel(level, event.currentTarget.getBoundingClientRect()),
            onMouseLeave: dropLevel,
          },
          h('button', {
            type: 'button',
            className: 'dsm-hover',
            // 行本身就是选项：点它加整层。能用与否只看「选过没有」，不看服务端选项表——
            // 宿主那份代码要重启才更新，而校验表（`INJECT_IGNORE_VALUES`）一直认得整层值。
            onClick: () => {
              onPick(level)
              setSubmenu(null)
            },
            style: { ...menuItemStyle, flex: '1 1 auto', background: 'transparent', border: 'none' },
          }, h('span', null, ignoreLabel(level))),
          parts.length > 0 && h('button', {
            type: 'button',
            className: 'dsm-hover',
            'aria-expanded': open,
            'aria-label': `${ignoreLabel(level)}：更新时间 / 关键词 / 正文`,
            onClick: (event) => keepLevel(level, event.currentTarget.getBoundingClientRect()),
            style: chevronStyle,
          }, '›'),
          open && (() => {
            const rect = submenu?.rect ?? null
            const width = 140
            const height = 12 + parts.length * 26
            const room = typeof window === 'undefined' ? width + 40 : window.innerWidth
            const left = rect === null
              ? 0
              : (rect.right + 6 + width > room ? rect.left - width - 6 : rect.right + 6)
            return h('div', {
              style: {
                ...pickerStyle,
                left: Math.max(8, left),
                top: rect === null ? 0 : rect.top - 6,
                width,
                maxHeight: 320,
                minWidth: 0,
                gap: 2,
              },
              'data-dsm-picker': '1',
              onMouseEnter: keepSubmenu,
              onMouseLeave: dropLevel,
            }, parts.map((value) => item(value, ignoreLabel(value.slice(level.length + 1)))))
          })())
        }))
      }

      /** @returns {object} one editable metadata value, caption above. */
      const metaEditor = (key, caption, value, onChange, rows) => h('div', { key, style: metaRowStyle },
        h('span', { style: metaLabelStyle }, caption),
        h('textarea', {
          rows,
          value,
          'aria-label': caption,
          className: 'dsm-hover',
          style: editorStyle,
          onChange: (event) => onChange(event.target.value),
        }))

      /**
       * A card header: collapse arrow and title on the left, status and save on the right.
       *
       * @param {string} label - the card's title.
       * @param {boolean} open - whether the card is expanded.
       * @param {Function} toggle - flips `open`.
       * @param {'meta'|'content'} part - which save this button belongs to.
       * @param {object|null} note - the last save outcome, if any.
       * @returns {object} the header element.
       */
      const cardHead = (label, open, toggle, part, note) => {
        const busy = savingPart === part
        const dirty = fileDirty(part)
        // 出错要说清楚；没出错就只报「改没改过」，免得旧的“已保存”骗人。
        const status = note?.tone === 'error' ? note : { tone: 'muted', text: dirty ? t('unsaved') : t('saved') }
        return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('button', {
            type: 'button',
            className: 'dsm-hover',
            'aria-expanded': open,
            onClick: toggle,
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              minWidth: 0,
              padding: 0,
              border: 'none',
              background: 'transparent',
              color: 'inherit',
            },
          },
          h('span', { 'aria-hidden': true, style: caretStyle(open) }),
          h('h4', { style: { ...paneTitleStyle, margin: 0 } }, label)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('span', {
              role: status.tone === 'error' ? 'alert' : 'status',
              style: {
                fontSize: 11,
                lineHeight: '16px',
                color: status.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
              },
            }, status.text),
            h('button', {
              type: 'button',
              className: 'dsm-hover',
              disabled: busy || !dirty,
              onClick: () => saveFile(part),
              style: {
                ...saveButtonStyle,
                opacity: busy || !dirty ? 0.5 : 1,
                cursor: busy || !dirty ? 'default' : 'pointer',
              },
            }, busy ? t('saving') : t('save'))))
      }

      /**
       * @returns {object} the `meta_data` card: identity, description, switches.
       *
       * 只给记忆文件画。日志的 `desc` 由插件按作用域写死、也没有 `format` 和
       * `inject_ignore`，唯一能看的是文件名，而文件名就是日期、和一级标题重复。
       */
      const metadataCard = () => {
        const draftNow = editFile ?? { fileName: '', desc: '', format: '', injectIgnore: [] }
        const chosen = draftNow.injectIgnore
        const rows = [
          h('div', { key: 'fileName', style: metaRowStyle },
            h('span', { style: metaLabelStyle }, t('meta.fileName')),
            h('input', {
              type: 'text',
              value: draftNow.fileName,
              'aria-label': t('meta.fileName'),
              className: 'dsm-hover',
              style: editorStyle,
              onChange: (event) => patchMeta({ fileName: event.target.value }),
            })),
          metaEditor('desc', t('meta.desc'), draftNow.desc, (next) => patchMeta({ desc: next }), 2),
          metaEditor('format', t('meta.format'), draftNow.format, (next) => patchMeta({ format: next }), 4),
          // 可选值是固定的一小撮（层 × 部分），所以用「+ 挑一个」，而不是让人手打内部名字。
          // 只有 chip 区滚动：标签和「+」留在两侧，不被内容推走。
          h('div', { key: 'ignore', style: inlineRowStyle },
            h('span', { style: metaLabelStyle }, t('meta.injectIgnore')),
            h('div', { style: { ...chipRowStyle, flex: '1 1 auto' } },
              chips(chosen, (item) => patchMeta({ injectIgnore: chosen.filter((entry) => entry !== item) }), ignoreLabel)),
            h('span', { style: { ...pickerAnchorStyle, flex: '0 0 auto' }, 'data-dsm-picker': '1' },
              addButton(picker === 'meta', (event) => openPicker(event, 'meta'), t('meta.addValue')),
              picker === 'meta' && ignorePicker(chosen, (value) => {
                patchMeta({ injectIgnore: [...chosen, value] })
                setPicker(null)
              }))),
        ]
        return h('section', { key: 'meta', style: { ...nodeCardStyle, gap: 8 } },
          cardHead(t('meta.title'), metaOpen, () => setMetaOpen((previous) => !previous), 'meta', metaNote),
          metaOpen && rows)
      }

      /** @returns {object} the content card: every heading, saved on their own. */
      const contentCard = (tree) => h('section', { key: 'content', style: { ...nodeCardStyle, gap: 8 } },
        cardHead(t('content.title'), contentOpen, () => setContentOpen((previous) => !previous), 'content', contentNote),
        contentOpen && (tree.length === 0 && adds.length === 0
          ? h('p', { style: emptyHintStyle }, t('source.empty'))
          : tree.filter((node) => !isRemoved([String(node.title ?? '')]))
            .map((node) => headingCard(node, [String(node.title ?? '')]))),
        contentOpen && file?.kind === 'memory' && h('div', {
          style: { display: 'flex', flexDirection: 'column', gap: 6 },
        },
          adds.filter((entry) => !isRemoved(entry.parent) && entry.parent.length === 0).map((entry) => pendingRow(entry)),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { display: 'flex' }, 'data-dsm-picker': '1' },
              addButton(false, () => spawnAdd([]), t('content.addRoot'))))))

      /**
       * One heading, drawn as a card: title row, its metadata, its body, its children.
       *
       * 卡片可以折叠——四层标题全展开时一张文件会很长，收起来才看得清骨架。
       * 正文和关键词在这里就能改，改的是草稿；点元数据卡上的「保存」才落盘。
       *
       * @param {object} node - the serialized heading.
       * @param {string[]} path - the heading path, which is also its identity.
       * @returns {object} the card element.
       */
      const headingCard = (node, path) => {
        const key = JSON.stringify(path)
        // 一级标题默认展开，二级以下默认收起：先看目录，再决定展开哪一支。
        const open = collapsed[key] === undefined ? path.length <= 1 : collapsed[key] !== true
        const draftNow = editFile?.nodes?.[key] ?? {
          title: String(node.title ?? ''),
          desc: typeof node.desc === 'string' ? node.desc : '',
          keyword: Array.isArray(node.keyword) ? node.keyword.map(String) : [],
        }
        const children = Array.isArray(node.children) ? node.children : []
        // 日志的一级标题是日期，只用来分组：它没有正文，别给一个空框让人以为能写。
        const dateHeading = file?.kind === 'log' && path.length === 1
        const toggle = () => setCollapsed((previous) => ({ ...previous, [key]: open }))
        // 标题本身也是内容，就地改；改的是草稿，点内容卡的「保存」才落盘。
        // 还能再往下一层时，行末给一个「+」：点了就在这一支下面长一张卡。
        const heading = cardTitleRow({
          open,
          onToggle: toggle,
          title: draftNow.title ?? '',
          onTitle: (value) => patchNode(key, { title: value }),
          onAddChild: file?.kind === 'memory' && path.length < MAX_DEPTH ? () => spawnAdd(path) : null,
          // 删掉这一支连同下面的子标题，同样是草稿，点「保存」才落盘。
          onRemove: () => setRemoved((previous) => [...previous, path]),
        })
        const keywords = keywordRow({
          keywords: draftNow.keyword,
          onRemove: (item) => patchNode(key, {
            keyword: draftNow.keyword.filter((entry) => entry !== item),
          }),
          anchor: h('span', { style: { ...pickerAnchorStyle, flex: '0 0 auto' }, 'data-dsm-picker': '1' },
            // 输入框开着的时候「+」让位：它只负责把输入框叫出来。
            picker !== `kw:${key}` && addButton(false, (event) => openPicker(event, `kw:${key}`), t('keyword.add')),
            // 关键词是自由词，所以「+」露出一个输入框，回车加一个。
            picker === `kw:${key}` && h('input', {
              type: 'text',
              autoFocus: true,
              value: editFile?.pending?.[key] ?? '',
              placeholder: t('keyword.add'),
              'aria-label': t('keyword.add'),
              className: 'dsm-hover',
              'data-dsm-picker': '1',
              style: { ...anchorBox(pickerRect, 150, 32), ...addInputStyle },
              onChange: (event) => setEditFile((previous) => (previous === null
                ? previous
                : { ...previous, pending: { ...(previous.pending ?? {}), [key]: event.target.value } })),
              onKeyDown: (event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setPicker(null)
                  return
                }
                if (event.key !== 'Enter') return
                event.preventDefault()
                const text = String(editFile?.pending?.[key] ?? '').trim()
                if (text !== '' && !draftNow.keyword.includes(text)) {
                  patchNode(key, { keyword: [...draftNow.keyword, text] })
                }
                setEditFile((previous) => (previous === null
                  ? previous
                  : { ...previous, pending: { ...(previous.pending ?? {}), [key]: '' } }))
                setPicker(null)
              },
              onBlur: () => setPicker(null),
            })),
        })
        return h('div', { key, style: nodeCardStyle },
          heading,
          // 正文在更新时间上面：先说这条记的是什么，再说是谁在什么时候写的。
          open && !dateHeading && h('textarea', {
            rows: Math.min(10, Math.max(2, Math.ceil(String(draftNow.desc).length / 56) + 1)),
            value: draftNow.desc,
            'aria-label': draftNow.title ?? node.title,
            className: 'dsm-hover',
            style: { ...editorStyle, borderStyle: 'dashed', color: 'var(--dsw-alias-label-secondary)' },
            onChange: (event) => patchNode(key, { desc: event.target.value }),
          }),
          // 更新时间一行，关键词另起一行：挤在同一行时关键词会被时间戳压扁。
          // 日志的日期标题没有这两样：时间由标题里的时分承担，关键词挂在二级标题上。
          open && !dateHeading && h('div', { style: { ...nodeMetaRowStyle, flexDirection: 'column', alignItems: 'flex-start', gap: 6 } },
            node.updateAt !== '' && h('span', null, `${t('node.updatedAt')}: ${when(node.updateAt)}`),
            keywords),
          open && children.length > 0 && h('div', { style: nodeChildrenStyle },
            children.filter((child) => !isRemoved([...path, String(child.title ?? '')]))
              .map((child) => headingCard(child, [...path, String(child.title ?? '')]))),
          open && adds.filter((entry) => entry.parent.length === path.length && samePath(entry.parent, path))
            .map((entry) => pendingRow(entry)))
      }

      /** @returns {object} the right-hand side: the picked file, or why there is none. */
      const detail = () => {
        if (fileError !== null) return placeholder(t('failed'), fileError)
        if (file === null) return h('div', { style: panesStyle }, skeleton(), skeleton())
        const preview = injectView === 'preview'
        const tree = Array.isArray(file.tree) ? file.tree : []
        return h('div', { style: panesStyle },
          h('div', { style: sourceColumnStyle },
            h('div', { style: paneHeadStyle },
              paneCaption(UI.IconCodeOutlineRegular, t('pane.source'))),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 } },
              file.kind === 'memory' && metadataCard(),
              contentCard(tree))),
          h('div', { style: paneStyle },
            h('div', { style: paneHeadStyle },
              paneCaption(UI.IconContextInjectionOutlineRegular, t('pane.injected')),
              h('div', { style: paneSwitchGroupStyle },
                h('button', {
                  type: 'button',
                  className: 'dsm-hover',
                  onClick: () => setInjectView('raw'),
                  style: !preview ? paneSwitchActiveStyle : paneSwitchStyle,
                }, t('pane.raw')),
                h('button', {
                  type: 'button',
                  className: 'dsm-hover',
                  onClick: () => setInjectView('preview'),
                  style: preview ? paneSwitchActiveStyle : paneSwitchStyle,
                }, t('pane.preview')))),
            // 注入效果自己滚：面板定高，长文档不把整页顶长。
            h('div', { style: injectedBodyStyle },
              preview
                ? injectedPreview(file.injected)
                : h('pre', { style: fileTextStyle }, file.injected))))
      }

      return detail()
    }

    exports.renderFile = render
    return module.exports
  },
})

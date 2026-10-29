/**
 * client.browse.js：面板的渲染函数，由 `client.js` 用 `require.async` 按需取走。
 *
 * 这里只有「拿 props 返回 vnode」的纯函数：状态、effect、i18n 的 `t` 与全部样式都在主包，
 * 通过 props 传进来。拆出去是为了让主包只剩编排，不至于一个组件六千行。
 * 没有 hooks：hooks 必须在组件里按固定顺序调用，搬进 lodash 式的纯函数就不成立了。
 */
window.__ModuleLoader__.load({
  id: '@huai_xin/dsh-memory',
  chunk: 'client.browse.js',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const render = (props) => {
      const {
        UI,
        browserStyle,
        confirming,
        createText,
        creating,
        detail,
        dragFrom,
        emptyHintStyle,
        fileAction,
        h,
        moveFile,
        picked,
        placeholder,
        railBodyStyle,
        railConfirmNoStyle,
        railConfirmStyle,
        railConfirmTextStyle,
        railConfirmYesStyle,
        railDeleteStyle,
        railDescStyle,
        railItemActiveStyle,
        railItemStyle,
        railListStyle,
        railNameStyle,
        railNote,
        railRowStyle,
        railStyle,
        scope,
        scopeEntries,
        setConfirming,
        setCreateText,
        setCreating,
        setPicked,
        setShelf,
        shelf,
        shelves,
        t,
      } = props

      /** @returns {object|null} one outcome line for the rail, or null when there is none. */
      const railStatus = () => (railNote === null
        ? null
        : h('p', {
          role: railNote.tone === 'error' ? 'alert' : 'status',
          style: {
            ...emptyHintStyle,
            padding: '0 8px',
            color: railNote.tone === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-state-success-primary)',
          },
        }, railNote.text))

      /** @returns {object} the browser body for one scope: a rail plus the picked file. */
      const browserBody = (scope) => {
        const entries = scopeEntries(scope, shelf)
        const emptyText = t(shelf === 'log' ? 'log.empty' : 'scope.empty')
        const rail = h('div', { style: railStyle },
          h(UI.SegmentedControl, {
            id: 'dsm-shelf',
            value: shelf,
            label: t('title'),
            options: shelves.map((item) => ({ value: item.id, label: item.text })),
            onChange: (next) => setShelf(next),
          }),
          shelf === 'memory' && creating && h('input', {
            key: 'create-input',
            type: 'text',
            autoFocus: true,
            value: createText,
            placeholder: t('file.createName'),
            'aria-label': t('file.createName'),
            onChange: (event) => setCreateText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                setCreating(false)
                setCreateText('')
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              const name = createText.trim()
              if (name === '') return
              // 成了才收输入框：失败了名字还得留在框里，否则用户得重打一遍，
              // 而失败的原因（重名、文件名不合法）也只有这时才看得见。
              void fileAction({ op: 'create', fileName: name, kind: 'memory' }).then((ok) => {
                if (!ok) return
                setCreating(false)
                setCreateText('')
              })
            },
            style: {
              font: 'inherit',
              width: '100%',
              boxSizing: 'border-box',
              padding: '4px 8px',
              fontSize: 12,
              lineHeight: '18px',
              color: 'var(--dsw-alias-label-primary)',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-brand-primary)',
              borderRadius: 6,
              outline: 'none',
            },
          }),
          shelf === 'memory' && !creating && h('button', {
            type: 'button',
            className: 'dsm-hover',
            onClick: () => setCreating(true),
            style: {
              font: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              width: '100%',
              padding: '4px 8px',
              fontSize: 12,
              lineHeight: '18px',
              background: 'transparent',
              border: '1px dashed var(--dsw-alias-border-l1)',
              borderRadius: 6,
              color: 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            },
          }, `+ ${t('file.create')}`),
          entries.length === 0
            ? h('p', { style: { ...emptyHintStyle, padding: '12px 8px' } }, emptyText)
            : h('div', { style: railListStyle, role: 'listbox', 'aria-label': t('title') },
              entries.map((entry, index) => h('div', {
                key: entry.fileName,
                className: 'dsm-rail-row',
                style: railRowStyle,
                // 只有记忆文件能拖：日志按日期排，顺序没有意义。
                draggable: shelf === 'memory',
                onDragStart: () => {
                  dragFrom.current = index
                },
                onDragOver: (event) => {
                  if (shelf === 'memory') event.preventDefault()
                },
                onDrop: (event) => {
                  event.preventDefault()
                  moveFile(dragFrom.current, index)
                  dragFrom.current = null
                },
              },
                h('button', {
                  type: 'button',
                  role: 'option',
                  'aria-selected': picked === entry.fileName,
                  'data-active': picked === entry.fileName,
                  className: 'dsm-rail-item',
                  onClick: () => setPicked(entry.fileName),
                  title: entry.desc === '' || entry.desc === undefined ? entry.fileName : entry.desc,
                  // 名字按钮在行里只占剩余宽度：留出右边那个删除方块的位置。
                  // basis 必须写 0 而不是 auto——换行是按 basis 算的，auto 会用
                  // 那行不换行的 desc 撑出来的宽度，把删除方块挤到下一行去。
                  style: { ...(picked === entry.fileName ? railItemActiveStyle : railItemStyle), flex: '1 1 0', width: 'auto' },
                },
                // 抓手只在记忆文件上出现；日志条目没有可拖的东西。
                shelf === 'memory' && h('span', { key: 'grip', className: 'dsm-grip', 'aria-hidden': true }),
                h('span', { key: 'body', style: railBodyStyle },
                  h('span', { style: railNameStyle }, entry.fileName),
                  typeof entry.desc === 'string' && entry.desc !== '' &&
                    h('span', { style: railDescStyle }, entry.desc))),
                h('button', {
                  type: 'button',
                  className: 'dsm-hover dsm-rail-delete',
                  'aria-label': t('file.delete'),
                  title: t('file.delete'),
                  onClick: () => setConfirming((previous) => (previous === entry.fileName ? null : entry.fileName)),
                  style: railDeleteStyle,
                }, '×'),
                // 确认条占满整行，只有点了「删除」才真删。
                confirming === entry.fileName && h('div', {
                  key: 'confirm',
                  style: railConfirmStyle,
                },
                  h('span', { style: railConfirmTextStyle }, t('file.deleteConfirm').replace('%s', entry.fileName)),
                  h('button', {
                    type: 'button',
                    className: 'dsm-hover',
                    onClick: () => {
                      setConfirming(null)
                      void fileAction({ op: 'remove', fileName: entry.fileName, kind: shelf })
                    },
                    style: railConfirmYesStyle,
                  }, t('file.deleteYes')),
                  h('button', {
                    type: 'button',
                    className: 'dsm-hover',
                    onClick: () => setConfirming(null),
                    style: railConfirmNoStyle,
                  }, t('file.deleteNo')))))),
          // 新建 / 删除的结果就写在左栏：这两种操作之后右栏往往已经没有东西可显示。
          railStatus(),
          // 拖动手感提示只在记忆文件货架上出现。
          shelf === 'memory' && entries.length > 1 &&
            h('p', { style: { ...emptyHintStyle, padding: '0 8px' } }, t('drag.hint')))

        const right = entries.length === 0
          ? placeholder(emptyText, t('pick.hint'))
          : picked === null
            ? placeholder(t('pick.hint'), '')
            : detail()

        return h('div', { style: browserStyle }, rail, right)
      }

      return browserBody(scope)
    }

    exports.renderBrowser = render
    return module.exports
  },
})

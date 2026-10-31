/**
 * client.presets.js：预设页签的渲染函数，由 `client.js` 用 `require.async` 按需取走。
 *
 * 左栏：最上面是「DSH 默认身份」卡片，下面是新建按钮/输入框和预设清单；
 * 每行尾部只有删除（×），选中谁只是「在查看」，不代表「在用」。
 * 右栏：「修改 / 预览」两块——「使用 / 使用中」在修改那块的表头，默认身份的
 * 「使用」在它自己卡片的右侧。换掉正在用的那份会打断前缀缓存，所以表头先亮
 * 一条警告，确认后才切换。
 *
 * 这里只有「拿 props 返回 vnode」的纯函数：没有 hooks、没有 state，
 * 全部样式与回调都在主包 `ui/client.js` 里。
 */
window.__ModuleLoader__.load({
  id: '@huai_xin/dsh-memory',
  chunk: 'client.presets.js',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /**
     * @param {object} props - 主包传下来的状态、样式与回调。
     * @returns {object} the preset tab body.
     */
    const render = (props) => {
      const {
        UI,
        h,
        t,
        browserStyle,
        createButtonStyle,
        createInputStyle,
        railStyle,
        railListStyle,
        railRowStyle,
        railItemStyle,
        railItemActiveStyle,
        railDeleteStyle,
        railConfirmYesStyle,
        railConfirmNoStyle,
        railNameStyle,
        emptyHintStyle,
        textStyle,
        editorStyle,
        saveButtonStyle,
        panesStyle,
        paneStyle,
        paneHeadStyle,
        paneCaption,
        injectedBodyStyle,
        injectedPreview,
        placeholder,
        names,
        selected,
        picked,
        loading,
        error,
        note,
        draft,
        dirty,
        busy,
        creating,
        createText,
        switching,
        confirming,
        onPick,
        onUse,
        onUseConfirm,
        onUseCancel,
        onCreateToggle,
        onCreateText,
        onCreateSubmit,
        onCreateCancel,
        onDeleteToggle,
        onDelete,
        onDraft,
        onSave,
      } = props

      // 「+ 新建预设」与记忆页签的「+ 新建文件」共用主包传下来的同两个样式。

      // 「使用」与「使用中」必须同尺寸：换状态时表头不能跳高，否则下面的
      // 文本框会跟着上下挪一格。
      const useButtonStyle = {
        font: 'inherit',
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        fontSize: 11,
        lineHeight: '16px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      }

      const useTagStyle = {
        ...useButtonStyle,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'default',
      }

      // 警告一律用错误色：这是「会打断缓存」的提示，不是普通提醒。
      const warnColor = 'var(--dsw-alias-state-error-primary)'
      const warnBarStyle = {
        display: 'flex',
        flex: '1 1 auto',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 6,
        flexWrap: 'wrap',
        minWidth: 0,
      }
      const warnTextStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        fontSize: 11,
        lineHeight: '16px',
        color: warnColor,
        background: `color-mix(in srgb, ${warnColor} 10%, transparent)`,
        border: `1px solid color-mix(in srgb, ${warnColor} 55%, transparent)`,
        borderRadius: 6,
      }
      const useConfirmStyle = {
        ...useButtonStyle,
        background: warnColor,
        border: `1px solid ${warnColor}`,
        color: 'var(--dsw-alias-label-inverse)',
        fontWeight: 600,
      }
      const useCancelStyle = {
        ...useButtonStyle,
        background: 'transparent',
        border: `1px solid color-mix(in srgb, ${warnColor} 55%, transparent)`,
        color: warnColor,
      }

      // 默认身份是独立一块：浅底 + 细边，和下面的预设清单区分开。
      const defaultPanelStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 6,
      }
      const defaultNameStyle = {
        ...railNameStyle,
        flex: '1 1 0',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontSize: 12,
        fontWeight: 500,
        color: picked === '' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
      }

      /** @returns {object[]|object|null} 换预设时的那条警告行。 */
      const warnBar = switching
        ? h('div', { style: warnBarStyle },
          h('span', { style: warnTextStyle }, t('presets.switchWarning')),
          h('button', {
            type: 'button',
            className: 'dsm-hover',
            style: useConfirmStyle,
            disabled: busy,
            onClick: onUseConfirm,
          }, t('presets.switchConfirm')),
          h('button', {
            type: 'button',
            className: 'dsm-hover',
            style: useCancelStyle,
            disabled: busy,
            onClick: onUseCancel,
          }, t('presets.switchCancel')))
        : null

      /** @returns {object|null} 「删除 / 取消」的内联确认，展开时不再画 ×。 */
      const deleteControl = (name) => (confirming === name
        ? h('div', {
          key: 'confirm',
          style: { display: 'flex', alignItems: 'center', gap: 4, flex: '0 0 auto' },
        },
        h('button', {
          type: 'button',
          className: 'dsm-hover',
          style: railConfirmYesStyle,
          onClick: () => onDelete(name),
        }, t('presets.deleteYes')),
        h('button', {
          type: 'button',
          className: 'dsm-hover',
          style: railConfirmNoStyle,
          onClick: () => onDeleteToggle(null),
        }, t('presets.deleteNo')))
        : h('button', {
          key: 'delete',
          type: 'button',
          className: 'dsm-hover dsm-rail-delete',
          'aria-label': t('presets.delete'),
          title: t('presets.delete'),
          onClick: () => onDeleteToggle(name),
          style: railDeleteStyle,
        }, '×'))

      /** @returns {object} 清单里的一行：名字（点开看）、使用中标签、删除。 */
      const presetRow = (name) => h('div', {
        key: name,
        className: 'dsm-rail-row',
        style: railRowStyle,
      },
      h('button', {
        type: 'button',
        role: 'option',
        'aria-selected': picked === name,
        'data-active': picked === name,
        className: 'dsm-rail-item',
        onClick: () => onPick(name),
        // 名字按钮只占剩余宽度，给右边的标签和删除方块留位置。
        style: { ...(picked === name ? railItemActiveStyle : railItemStyle), flex: '1 1 0', width: 'auto' },
      },
      h('span', { style: railNameStyle }, name)),
      selected === name ? h('span', { key: 'used', style: useTagStyle }, t('presets.inUse')) : null,
      deleteControl(name))

      /** @returns {object} 「DSH 默认身份」那一块：点名字查看，右侧使用/使用中。 */
      const defaultRow = h('div', { key: '__default', style: defaultPanelStyle },
        h('button', {
          type: 'button',
          'aria-pressed': picked === '',
          onClick: () => onPick(''),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flex: '1 1 0',
            minWidth: 0,
            padding: 0,
            background: 'transparent',
            border: 'none',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          },
        },
        h('span', { style: defaultNameStyle }, t('presets.defaultIdentity'))),
        selected === ''
          ? h('span', { key: 'used', style: useTagStyle }, t('presets.inUse'))
          : h('button', {
            key: 'use',
            type: 'button',
            className: 'dsm-hover',
            style: useButtonStyle,
            disabled: busy,
            onClick: () => onUse(''),
          }, t('presets.use')))

      const rail = h('div', { style: railStyle },
        defaultRow,
        creating
          ? h('input', {
            key: 'create-input',
            type: 'text',
            autoFocus: true,
            value: createText,
            placeholder: t('presets.createName'),
            'aria-label': t('presets.createName'),
            style: createInputStyle,
            onChange: (event) => onCreateText(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                onCreateCancel()
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              onCreateSubmit()
            },
          })
          : h('button', {
            key: 'create',
            type: 'button',
            className: 'dsm-hover',
            style: createButtonStyle,
            onClick: onCreateToggle,
          }, `+ ${t('presets.create')}`),
        h('div', { style: railListStyle, role: 'listbox' },
          names.map(presetRow),
          names.length === 0
            ? h('p', {
              style: {
                ...emptyHintStyle,
                flex: '1 1 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '12px 8px',
              },
            }, t('presets.empty'))
            : null),
        note === null
          ? null
          : h('p', {
            role: note.tone === 'error' ? 'alert' : 'status',
            style: {
              ...textStyle,
              padding: '0 8px',
              color: note.tone === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-tertiary)',
            },
          }, note.text))

      /** @returns {object} 默认身份被选中时的右栏：没有正文可改。 */
      const defaultView = h('div', { style: panesStyle },
        h('div', { style: { ...paneStyle, gridColumn: '1 / -1' } },
          h('div', { style: paneHeadStyle },
            paneCaption(UI.IconContextInjectionOutlineRegular, t('presets.defaultIdentity')),
            warnBar),
          h('p', { style: textStyle }, t('presets.defaultHint'))))

      /** @returns {object} 选了一份预设时的右栏：修改与预览。 */
      const presetView = h('div', { style: panesStyle },
        h('div', { style: paneStyle },
          h('div', { style: paneHeadStyle },
            paneCaption(UI.IconCodeOutlineRegular, t('presets.edit')),
            warnBar ?? (selected === picked
              ? h('span', { key: 'used', style: useTagStyle }, t('presets.inUse'))
              : h('button', {
                key: 'use',
                type: 'button',
                className: 'dsm-hover',
                style: useButtonStyle,
                disabled: busy,
                onClick: () => onUse(picked),
              }, t('presets.use')))),
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 } },
            h('span', { style: { ...textStyle, fontWeight: 600 } }, picked),
            dirty ? h('span', { style: textStyle }, t('presets.unsaved')) : null),
          h('textarea', {
            style: {
              ...editorStyle,
              // 右侧是固定高度的栏：让编辑框吃掉标头与按钮之外的全部空间，
              // 否则浏览器按默认两行高画，一份预设只露出开头两行。
              flex: '1 1 auto',
              minHeight: 120,
              resize: 'none',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            },
            value: draft,
            disabled: busy,
            spellCheck: false,
            onChange: (event) => onDraft(event.target.value),
          }),
          error === null
            ? null
            : h('p', { style: { ...textStyle, color: 'var(--dsw-alias-state-error-primary)' } }, error),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'dsm-hover',
              style: { ...saveButtonStyle, opacity: busy || !dirty ? 0.55 : 1 },
              disabled: busy || !dirty,
              onClick: onSave,
            }, busy ? t('presets.saving') : t('presets.save')),
            h('span', { style: textStyle }, t('presets.hint')))),
        h('div', { style: paneStyle },
          h('div', { style: paneHeadStyle },
            paneCaption(UI.IconContextInjectionOutlineRegular, t('presets.preview'))),
          h('div', { style: injectedBodyStyle }, injectedPreview(draft))))

      const body = picked === null
        ? placeholder(t('presets.pick'), t('presets.pickHint'))
        : picked === ''
          ? defaultView
          : loading
            ? placeholder(t('presets.loading'), '')
            : presetView

      return h('div', { style: browserStyle }, rail, body)
    }

    exports.renderPresets = render
    return module.exports
  },
})

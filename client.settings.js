/**
 * client.settings.js：面板的渲染函数，由 `client.js` 用 `require.async` 按需取走。
 *
 * 这里只有「拿 props 返回 vnode」的纯函数：状态、effect、i18n 的 `t` 与全部样式都在主包，
 * 通过 props 传进来。拆出去是为了让主包只剩编排，不至于一个组件六千行。
 * 没有 hooks：hooks 必须在组件里按固定顺序调用，搬进 lodash 式的纯函数就不成立了。
 */
window.__ModuleLoader__.load({
  id: '@huai_xin/dsh-memory',
  chunk: 'client.settings.js',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const render = (props) => {
      const {
        UI,
        busy,
        draft,
        fields,
        groupCardStyle,
        groupTitleStyle,
        h,
        hintStyle,
        labelStyle,
        loaded,
        onKeyDown,
        restartStyle,
        rowStyle,
        rowTextStyle,
        t,
        update,
      } = props

      /** @returns {object} the control for one field. */
      const control = (field) => {
        const busyNow = busy || !loaded
        if (field.type === 'boolean') {
          const on = draft[field.key] === true
          return h(UI.Switch, {
            checked: on,
            disabled: busyNow,
            label: t(`field.${field.key}`),
            onChange: (next) => update(field, next),
          })
        }
        return h(UI.Input, {
          type: field.type === 'number' ? 'number' : 'text',
          min: field.min,
          step: field.type === 'number' ? 1 : undefined,
          value: draft[field.key] ?? '',
          disabled: busyNow,
          'aria-label': t(`field.${field.key}`),
          onChange: (event) => update(field, event.target.value),
          onKeyDown,
          style: { width: field.type === 'number' ? 88 : 180, maxWidth: '100%' },
        })
      }

      // 字段表可以比字典先长出新键：查不到时退回字段自己带的 title，
      // 这样加一个配置项不至于在界面上显示成 `field.foo`。
      const label = (field) => {
        const text = t(`field.${field.key}`)
        return text === `field.${field.key}` ? field.title : text
      }
      const hint = (field) => {
        const key = `hint.${field.key}`
        const text = t(key)
        return text === key ? '' : text
      }

      const groups = []
      let group = null
      // `hidden` 的字段由别处维护（比如文件顺序靠拖动），不给输入框。
      for (const field of fields.filter((item) => item.hidden !== true)) {
        if (group === null || field.group !== group.id) {
          const key = `group.${field.group}`
          const text = t(key)
          group = { id: field.group, title: text === key ? field.group : text, rows: [] }
          groups.push(group)
        }
        const explanation = hint(field)
        group.rows.push(h('div', {
          key: field.key,
          // 行之间一条发丝线，第一行不画：卡片的顶边已经在了。
          style: { ...rowStyle, borderTop: group.rows.length === 0 ? 'none' : '1px solid var(--dsw-alias-border-l1)' },
        },
        h('div', { style: rowTextStyle },
          h('span', { style: labelStyle },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, label(field)),
            field.restart === true && h('span', { style: restartStyle }, t('restart'))),
          explanation === '' ? null : h('p', { style: hintStyle }, explanation)),
        control(field)))
      }

      /** @returns {object[]} the cards of the settings form. */
      const rows = groups.map((item) => h('section', { key: item.id, style: groupCardStyle },
        h('h4', { style: groupTitleStyle }, item.title),
        ...item.rows))

      return rows
    }

    exports.renderSettings = render
    return module.exports
  },
})

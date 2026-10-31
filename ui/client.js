window.__ModuleLoader__.load({
  id: '@huai_xin/dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 宿主的界面组件：按钮、输入框、开关、分段控件、菜单和图标。
    // 用它们而不是自己画，字号、圆角、悬停和焦点才和宿主其余界面一致。
    // 注入效果的预览不经过宿主：`injectedPreview()` 自己按行画（见本文件）。
    const UI = require('@deepseek-ai/dsh-client-ui-primitives')

    /** Locale namespace for this panel's text. */
    const NS = 'dsh-memory.settings'

    /** The route `lib/settings-route.js` answers on. */
    const ROUTE = '/plugins/dsh-memory/settings'

    const DICTIONARIES = {
      zh: {
        tab: '记忆',
        title: '记忆',
        'view.presets': '预设',
        'view.global': '全局',
        'view.workspace': '工作区',
        'view.settings': '设置',
        'scope.empty': '还没有记忆文件',
        'browse.sub': '左边选一个文件，右边看它落盘和注入的样子',
        'rail.memory': '记忆文件',
        'rail.log': '日志',
        'log.empty': '还没有日志',
        'pane.source': '原文',
        'pane.injected': '注入效果',
        'pane.raw': '原始文本',
        'pane.preview': '预览',
        'meta.title': '元数据',
        'meta.fileName': '文件名',
        'meta.desc': '描述',
        'meta.format': '更新格式',
        'meta.injectIgnore': '不注入的值',
        'content.title': '内容',
        'content.addRoot': '加一级标题',
        'node.addChild': '加子标题',
        'node.title': '标题',
        'node.updatedAt': '更新于',
        'node.keyword': '关键词',
        remove: '删除',
        'keyword.add': '加关键词',
        'meta.addValue': '加一项',
        // 「不注入的值」的内部名（`t1.desc` 这样的值）在界面上的说法。
        'ignore.update_at': '更新时间',
        'ignore.keyword': '关键词',
        'ignore.desc': '正文',
        'ignore.t1': '一级标题',
        'ignore.t2': '二级标题',
        'ignore.t3': '三级标题',
        'ignore.t4': '四级标题',
        'action.failed': '操作失败',
        'source.empty': '这个文件还没有标题',
        'drag.hint': '拖动排序即注入顺序',
        'file.create': '新建文件',
        'file.createName': '新记忆文件的名字',
        'file.delete': '删除文件',
        'file.deleteConfirm': '删除「%s」？删掉就找不回来了。',
        'file.created': '已新建',
        'file.deleteYes': '删除',
        'file.deleteNo': '取消',
        'file.deleted': '已删除',
        'pick.hint': '选一个文件看它长什么样',
        'presets.title': '预设',
        'presets.sub': '整体替换提示词最开头的身份',
        'presets.inUse': '使用中',
        'presets.use': '使用',
        'presets.defaultIdentity': 'DSH 默认身份',
        'presets.defaultHint': '不使用预设时，提示词开头保留宿主原生的 harness identity。',
        'presets.switchWarning': '可能破坏前缀缓存',
        'presets.switchConfirm': '确认切换',
        'presets.switchCancel': '取消',
        'presets.edit': '修改',
        'presets.preview': '预览',
        'presets.create': '新建预设',
        'presets.createName': '预设名字',
        'presets.created': '已新建',
        'presets.seat': '预设',
        'presets.none': '不使用预设',
        'presets.delete': '删除',
        'presets.deleteYes': '删除',
        'presets.deleteNo': '取消',
        'presets.empty': '还没有预设',
        'presets.pick': '选一份预设。',
        'presets.pickHint': '点「使用」并确认后，这份预设才会整体替换提示词最开头的 harness identity；切换会作废一次前缀缓存，所以要先确认。',
        'presets.save': '保存',
        'presets.saving': '保存中…',
        'presets.unsaved': '有未保存的修改',
        'presets.loading': '读取中…',
        'presets.hint': '保存后下一次请求生效；直接改目录里的 .md 约 200ms 自动重载。',
        'presets.selected': '已切换，下一次模型请求生效',
        'presets.defaultOn': '已切回 DSH 默认身份，下一次模型请求生效',
        'presets.deleted': '已删除',
        'presets.failed': '预设保存失败',
        'settings.sub': '改动即时生效',
        changed: '有 %s 项改动',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        unsaved: '未保存',
        failed: '保存失败',
        loading: '读取中…',
        nothing: '没有改动',
        'group.inject': '注入',
        'group.session': '会话',
        'group.log': '日志',
        'group.preset': '预设',
        'field.defaultPreset': '新会话默认预设',
        'hint.defaultPreset': '新建的会话自动从这份预设开始；选「不使用预设」就用原生身份。只影响之后新开的会话，已经选过预设的会话不会被改动',
        'field.snapshotTtlMinutes': '快照保留分钟',
        'hint.snapshotTtlMinutes': '会话多久没动静就丢掉快照、下次发消息重新生成。前缀缓存一般 5–60 分钟，按供应商的规则调；0 表示一直留着',
        'field.logSummaryMaxChars': '日志摘要字数上限',
        'hint.logSummaryMaxChars': '一条日志摘要（写在标题里）最多多少字',
        'field.injectLog': '注入日志',
        'hint.injectLog': '把最近几天的日志也放进提示词',
        'field.logInjectEntries': '每天最多几条',
        'hint.logInjectEntries': '一天最多带几条日志，0 表示不限',
        'field.logInjectGlobalDays': '全局日志天数',
        'hint.logInjectGlobalDays': '全局日志带最近几天',
        'field.logInjectGlobalDetailDays': '全局带正文天数',
        'hint.logInjectGlobalDetailDays': '这几天里最新的几天带正文，其余只留标题',
        'field.logInjectWorkspaceDays': '工作区日志天数',
        'hint.logInjectWorkspaceDays': '工作区日志带最近几天',
        'field.logInjectWorkspaceDetailDays': '工作区带正文天数',
        'hint.logInjectWorkspaceDetailDays': '这几天里最新的几天带正文，其余只留标题',
      },
      en: {
        tab: 'Memory',
        title: 'Memory',
        'view.global': 'Global',
        'view.workspace': 'Workspace',
        'view.settings': 'Settings',
        'view.presets': 'Presets',
        'scope.empty': 'No memory files yet',
        'browse.sub': 'Pick a file on the left; see it on disk and injected on the right',
        'rail.memory': 'Files',
        'rail.log': 'Logs',
        'log.empty': 'No logs yet',
        'pane.source': 'Source',
        'pane.injected': 'Injected',
        'pane.raw': 'Text',
        'pane.preview': 'Preview',
        'meta.title': 'Metadata',
        'meta.fileName': 'File name',
        'meta.desc': 'Description',
        'meta.format': 'Update rules',
        'meta.injectIgnore': 'Not injected',
        'content.title': 'Content',
        'content.addRoot': 'Add a top-level heading',
        'node.addChild': 'Add a sub-heading',
        'node.title': 'Heading',
        'node.updatedAt': 'Updated',
        'node.keyword': 'Keywords',
        remove: 'Remove',
        'keyword.add': 'Add keyword',
        'meta.addValue': 'Add value',
        'ignore.update_at': 'Updated at',
        'ignore.keyword': 'Keywords',
        'ignore.desc': 'Body',
        'ignore.t1': 'Level 1 headings',
        'ignore.t2': 'Level 2 headings',
        'ignore.t3': 'Level 3 headings',
        'ignore.t4': 'Level 4 headings',
        'action.failed': 'Action failed',
        'source.empty': 'This file has no headings yet',
        'drag.hint': 'Drag to reorder injection',
        'file.create': 'New file',
        'file.createName': 'Name for the new memory file',
        'file.delete': 'Delete file',
        'file.deleteConfirm': 'Delete “%s”? This cannot be undone.',
        'file.created': 'Created',
        'file.deleteYes': 'Delete',
        'file.deleteNo': 'Cancel',
        'file.deleted': 'Deleted',
        'pick.hint': 'Pick a file to see what it looks like',
        'presets.title': 'Presets',
        'presets.sub': 'Replaces the identity at the very start of the prompt',
        'presets.inUse': 'In use',
        'presets.use': 'Use',
        'presets.defaultIdentity': 'DSH default identity',
        'presets.defaultHint': 'With no preset, the prompt keeps the native harness identity from the host.',
        'presets.switchWarning': 'May break the prefix cache',
        'presets.switchConfirm': 'Switch',
        'presets.switchCancel': 'Cancel',
        'presets.edit': 'Edit',
        'presets.preview': 'Preview',
        'presets.create': 'New preset',
        'presets.createName': 'Preset name',
        'presets.created': 'Created',
        'presets.seat': 'Preset',
        'presets.none': 'No preset',
        'presets.delete': 'Delete',
        'presets.deleteYes': 'Delete',
        'presets.deleteNo': 'Cancel',
        'presets.empty': 'No presets yet',
        'presets.pick': 'Pick a preset.',
        'presets.pickHint': 'Press “Use” and confirm to replace the harness identity at the very start of the prompt; switching drops the prefix cache once, hence the confirmation.',
        'presets.save': 'Save',
        'presets.saving': 'Saving…',
        'presets.unsaved': 'Unsaved changes',
        'presets.loading': 'Loading…',
        'presets.hint': 'Takes effect on the next request; edits to the .md files reload after ~200ms.',
        'presets.selected': 'Switched — effective on the next model request',
        'presets.defaultOn': 'Back to the DSH default identity — effective on the next model request',
        'presets.deleted': 'Deleted',
        'presets.failed': 'Could not save the preset',
        'settings.sub': 'Changes apply immediately',
        changed: '%s pending',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        unsaved: 'Unsaved',
        failed: 'Save failed',
        loading: 'Loading…',
        nothing: 'Nothing changed',
        'group.inject': 'Injection',
        'group.session': 'Session',
        'group.log': 'Log',
        'group.preset': 'Presets',
        'field.defaultPreset': 'Default preset for new sessions',
        'hint.defaultPreset': 'New sessions start from this preset; pick “No preset” to keep the native identity. Only affects sessions started afterwards — sessions that already picked one are left alone',
        'field.snapshotTtlMinutes': 'Snapshot retention (minutes)',
        'hint.snapshotTtlMinutes':
            'Drop a session snapshot after this much idle time and rebuild it on the next message. Provider prefix caches usually last 5–60 minutes; 0 keeps snapshots forever',
        'field.logSummaryMaxChars': 'Log summary length',
        'hint.logSummaryMaxChars': 'Maximum characters of one log summary (written in the heading)',
        'field.injectLog': 'Inject logs',
        'hint.injectLog': 'Put the last few days of logs into the prompt too',
        'field.logInjectEntries': 'Entries per day',
        'hint.logInjectEntries': 'Most entries carried per day; 0 means no limit',
        'field.logInjectGlobalDays': 'Global log days',
        'hint.logInjectGlobalDays': 'Days of global log to carry',
        'field.logInjectGlobalDetailDays': 'Global detail days',
        'hint.logInjectGlobalDetailDays': 'Newest days that keep their body; the rest keep only the heading',
        'field.logInjectWorkspaceDays': 'Workspace log days',
        'hint.logInjectWorkspaceDays': 'Days of workspace log to carry',
        'field.logInjectWorkspaceDetailDays': 'Workspace detail days',
        'hint.logInjectWorkspaceDetailDays': 'Newest days that keep their body; the rest keep only the heading',
      },
    }

    // The translator is module state because the component has no access to the
    // plugin context. Locale changes refresh it and notify the mounted panel.
    let translate = (key) => key
    const listeners = new Set()
    const subscribe = (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
    const readTranslate = () => translate
    const setTranslate = (next) => {
      translate = next
      for (const listener of [...listeners]) listener()
    }

    /**
     * The rules inline styles cannot express: hover, focus ring, drag feedback,
     * scrollbars and the loading pulse.
     *
     * 颜色一律走主题令牌；`color-mix` 只用来叠一层同色半透明，深浅两套主题
     * 因此都不用另写一份。选择器全部挂在 `.dsm-root` 下，不会漏到宿主界面里。
     */
    const STYLE_ID = 'dsh-memory-panel-styles'
    const PANEL_STYLES = `
      .dsm-root button:not(:disabled) { cursor: pointer; }
      .dsm-root button:focus-visible { outline: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary) 40%, transparent); outline-offset: 2px; }
      .dsm-root button:disabled { cursor: not-allowed; opacity: 0.55; }
      .dsm-hover:hover:not(:disabled) { background-color: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
      .dsm-rail-item:hover:not(:disabled) { background-color: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); }
      .dsm-rail-item[data-dragging='true'] { opacity: 0.5; }
      .dsm-rail-item[data-over='true'] { box-shadow: inset 0 2px 0 0 var(--dsw-alias-brand-primary); }
      .dsm-grip {
        flex: 0 0 auto;
        width: 5px;
        height: 14px;
        border-radius: 2px;
        opacity: 0;
        color: currentColor;
        background-image: radial-gradient(currentColor 1px, transparent 1.2px);
        background-size: 5px 5px;
        background-repeat: repeat-y;
        transition: opacity 120ms ease;
      }
      .dsm-rail-delete { opacity: 0.45; transition: opacity 120ms ease, color 120ms ease; }
      .dsm-rail-row:hover .dsm-rail-delete,
      .dsm-rail-delete:focus-visible { opacity: 1; color: var(--dsw-alias-label-primary); }
      .dsm-rail-item:hover .dsm-grip,
      .dsm-rail-item[data-active='true'] .dsm-grip { opacity: 0.5; }
      .dsm-root ::-webkit-scrollbar { width: 8px; height: 8px; }
      .dsm-root ::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 4px; }
      .dsm-root ::-webkit-scrollbar-track { background: transparent; }
      .dsm-root ::selection { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); }
      @keyframes dsm-pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.8; } }
      .dsm-skeleton {
        height: 10px;
        border-radius: 4px;
        background: var(--dsw-alias-bg-layer-2);
        animation: dsm-pulse 1.4s ease-in-out infinite;
      }
      @media (prefers-reduced-motion: reduce) {
        .dsm-skeleton { animation: none; }
        .dsm-root *, .dsm-root *::before, .dsm-root *::after { transition: none !important; }
      }
    `

    /**
     * Put the stylesheet in the document once.
     *
     * 面板可能被反复挂载，样式表跟着重复插入就会层层叠加；按 id 判重。
     * @returns {void}
     */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = PANEL_STYLES
      document.head.appendChild(tag)
    }

    ensureStyles()

    /** The page shell: a padded column, like the other conversation tabs. */
    const pageStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      padding: '16px 20px 12px',
      // 面板铺满对话区：两栏各占一半，靠的是这里的全宽，不是给 maxWidth 定一个数。
      width: '100%',
      minWidth: 0,
      // 高度锁在会话窗口内，滚动交给各面板自己。
      height: '100%',
      maxHeight: '100%',
      minHeight: 0,
      boxSizing: 'border-box',
    }

    /** The header: title and caption on the left, the tab strip on the right. */
    const headerStyle = {
      display: 'flex',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      flexWrap: 'wrap',
      // 面板锁高之后，可压缩的只有下面的内容：标题和保存条都得站住。
      flex: '0 0 auto',
      gap: 12,
      minWidth: 0,
    }

    /** The page title. */
    const headingStyle = {
      margin: 0,
      fontSize: 17,
      fontWeight: 600,
      lineHeight: '24px',
      letterSpacing: '-0.01em',
      color: 'var(--dsw-alias-label-primary)',
    }

    /** The line under the title. */
    const subheadingStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /**
     * The scroll box around the settings form.
     *
     * 面板自身锁高、不滚动，滚的是这一层：保存条要留在下面不动，
     * 所以它不能跟着表单一起被滚走。`minHeight: 0` 是必须的——flex 子项的
     * 默认最小高度是内容高度，不归零的话 `overflowY` 永远不触发。
     */
    const settingsBodyStyle = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      overflowX: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      // 铺满对话区：控件在右列、宽度固定，拉宽只多出中间留白，不会把输入框拉长。
      width: '100%',
      minWidth: 0,
      paddingRight: 4,
    }

    /** 卡片底色：面板里的每一格（设置分组、左栏、两栏视图）都铺这一层。 */
    const cardSurfaceStyle = {
      borderRadius: 10,
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
    }

    /** One block of related settings, drawn as a card. */
    const groupCardStyle = {
      ...cardSurfaceStyle,
      // 不许压缩：滚的是外面的盒子，卡片自己要保持原高。
      flex: '0 0 auto',
      display: 'flex',
      flexDirection: 'column',
      padding: '0 14px 4px',
    }

    /** 小字号的「栏目名」：大写、加粗、拉字距。分组标题和栏位标题共用。 */
    const captionStyle = {
      fontSize: 11,
      fontWeight: 600,
      lineHeight: '16px',
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /** The group heading. */
    const groupTitleStyle = {
      ...captionStyle,
      margin: 0,
      padding: '12px 0 4px',
    }

    /**
     * One settings row: what it is on the left, the control on the right.
     *
     * 左列放标签和说明，右列只放控件——说明写在控件下面会把行撑得很高，
     * 而且和下一行的标签挤在一起。
     */
    const rowStyle = {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) auto',
      alignItems: 'center',
      gap: '2px 16px',
      padding: '10px 0',
      minWidth: 0,
    }

    /** The label and its explanation, stacked. */
    const rowTextStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 0,
    }

    /** The field label inside a row. */
    const labelStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary)',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }

    /** The explanation under a label. */
    const hintStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /** Muted text: hints and the loading line. */
    const textStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }

    /** The two columns: file names on the left, the picked file on the right. */
    const browserStyle = {
      display: 'grid',
      gridTemplateColumns: 'minmax(150px, 186px) minmax(0, 1fr)',
      // 一行铺满剩余高度：三块面板同高，内容各自在内部滚。
      gridTemplateRows: 'minmax(0, 1fr)',
      gap: 12,
      alignItems: 'stretch',
      width: '100%',
      minWidth: 0,
      minHeight: 320,
      height: '100%',
      overflow: 'hidden',
    }

    /** The left rail. */
    const railStyle = {
      ...cardSurfaceStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
      // 与右侧两栏同高：外壳定高，列表自己滚。
      minHeight: 0,
      padding: '8px 6px 6px',
    }

    /** The list under the shelf tabs. */
    const railListStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 1,
      minWidth: 0,
      overflowY: 'auto',
      flex: '1 1 auto',
      minHeight: 0,
    }

    // 「新建文件」和「新建预设」是同一个控件，样式只在这里写一份。
    /** The dashed "new file / new preset" button at the top of a rail. */
    const createButtonStyle = {
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
    }

    /** The inline name input that replaces the button while creating. */
    const createInputStyle = {
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
    }

    /**
     * One entry in the left rail.
     *
     * 选中态只换底色和左边那道 2px 的强调条——不改变行高和缩进，点来点去
     * 列表不会跳。
     */
    const railItemStyle = {
      font: 'inherit',
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      width: '100%',
      minWidth: 0,
      padding: '5px 8px 5px 6px',
      textAlign: 'left',
      background: 'transparent',
      border: 'none',
      borderLeft: '2px solid transparent',
      outline: 'none',
      borderRadius: 6,
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      transition: 'background-color 120ms ease, color 120ms ease',
    }

    /** The picked entry. */
    const railItemActiveStyle = {
      ...railItemStyle,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-2)',
      borderLeft: '2px solid var(--dsw-alias-brand-primary)',
    }

    /** A rail row: the name button plus its delete square. */
    const railRowStyle = {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 2,
      minWidth: 0,
    }

    /** The small square that drops a whole file. */
    const railDeleteStyle = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 18,
      height: 18,
      padding: 0,
      font: 'inherit',
      fontSize: 12,
      lineHeight: '16px',
      background: 'transparent',
      border: 'none',
      borderRadius: 4,
      color: 'var(--dsw-alias-label-tertiary)',
      cursor: 'pointer',
    }

    /** The inline delete confirmation: one full-width row under the entry. */
    const railConfirmStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      flexWrap: 'wrap',
      flex: '1 1 100%',
      marginTop: 2,
      padding: '4px 8px 6px',
      borderRadius: 6,
      background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
    }

    /** The question inside that row. */
    const railConfirmTextStyle = {
      flex: '1 1 100%',
      minWidth: 0,
      fontSize: 11,
      lineHeight: '15px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    /** The two buttons of that row. */
    const railConfirmYesStyle = {
      font: 'inherit',
      padding: '2px 8px',
      fontSize: 11,
      lineHeight: '16px',
      borderRadius: 4,
      border: '1px solid var(--dsw-alias-state-error-primary)',
      background: 'var(--dsw-alias-state-error-primary)',
      color: '#fff',
      cursor: 'pointer',
    }
    const railConfirmNoStyle = {
      font: 'inherit',
      padding: '2px 8px',
      fontSize: 11,
      lineHeight: '16px',
      borderRadius: 4,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
    }

    /** 单行截断：名字和描述都会超出栏宽，一律省略号收尾。 */
    const ellipsisStyle = {
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }

    /** The file name inside an entry. */
    const railNameStyle = {
      ...ellipsisStyle,
      flex: 1,
      fontSize: 13,
      lineHeight: '20px',
    }

    /** The muted line under a name: the file's own description. */
    const railDescStyle = {
      ...ellipsisStyle,
      whiteSpace: 'nowrap',
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /** A rail entry's text column: the name over its description. */
    const railBodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
      flex: 1,
      minWidth: 0,
    }

    /** The save bar under the form: fixed, so it does not scroll away. */
    const actionsStyle = {
      flex: '0 0 auto',
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 10,
      width: '100%',
      minWidth: 0,
      paddingTop: 10,
      borderTop: '1px solid var(--dsw-alias-border-l1)',
    }

    /** A centred placeholder: nothing to show yet, or nothing to show at all. */
    const emptyStyle = {
      display: 'flex',
      flex: 1,
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '32px 16px',
      textAlign: 'center',
    }

    /** The line that says what is missing. */
    const emptyTitleStyle = {
      margin: 0,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    /** The second line of a placeholder: what to do about it. */
    const emptyHintStyle = {
      margin: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /** The file body, pre-formatted. */
    const fileTextStyle = {
      margin: 0,
      flex: 1,
      minWidth: 0,
      minHeight: 0,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: '20px',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      color: 'var(--dsw-alias-label-secondary)',
    }

    /** The scroll box around the injected form. */
    const injectedBodyStyle = {
      flex: '1 1 auto',
      minHeight: 0,
      overflowY: 'auto',
      minWidth: 0,
    }

    /** The pair of side-by-side views: the bytes on disk, and the injected form. */
    const panesStyle = {
      minWidth: 0,
      minHeight: 0,
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
      gridTemplateRows: 'minmax(0, 1fr)',
      alignItems: 'stretch',
      height: '100%',
      overflow: 'hidden',
      gap: 12,
    }

    /** One titled view, drawn as a card so the two sides read as equal. */
    const paneStyle = {
      ...cardSurfaceStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden',
      padding: '10px 12px 12px',
    }

    /** A pane's caption. */
    const paneTitleStyle = { ...captionStyle }

    /** The caption row: title on the left, view switch on the right. */
    const paneHeadStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      minHeight: 18,
    }

    /** The view switch, drawn as a small segmented control. */
    const paneSwitchGroupStyle = {
      display: 'inline-flex',
      gap: 2,
      padding: 1,
      borderRadius: 6,
      background: 'var(--dsw-alias-bg-layer-2)',
    }

    /** One switch button in a caption row. */
    const paneSwitchStyle = {
      font: 'inherit',
      fontSize: 11,
      lineHeight: '16px',
      padding: '1px 7px',
      background: 'transparent',
      border: '1px solid transparent',
      outline: 'none',
      borderRadius: 5,
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      transition: 'color 120ms ease, background-color 120ms ease',
    }

    /** The switch item currently in effect. */
    const paneSwitchActiveStyle = {
      ...paneSwitchStyle,
      fontWeight: 600,
      color: 'var(--dsw-alias-label-primary)',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l2)',
    }

    // ── 原文面板：元数据卡片 + 标题树卡片 ─────────────────────────────────
    // 面板把「这个文件长什么样」按结构画出来，而不是丢一整段 YAML 给人看。
    // 卡片是可编辑草稿：元数据与各级标题各自「保存」，写入仍由 `saveFile()` 走设置路由。

    /**
     * The scroll column that holds the pane head, the metadata card and the heading cards.
     *
     * 外面套一圈边框，把「原文」这一栏整体收成一个面板；里面的卡片各自还有自己的框。
     */
    const sourceColumnStyle = {
      ...cardSurfaceStyle,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minWidth: 0,
      minHeight: 0,
      padding: '10px 12px 12px',
      overflowY: 'auto',
    }

    /** One labelled field: the caption above, the value box below. */
    const metaRowStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      minWidth: 0,
    }

    /** A metadata caption. */
    const metaLabelStyle = {
      flex: '0 0 auto',
      whiteSpace: 'nowrap',
      fontSize: 11,
      lineHeight: '16px',
      letterSpacing: '0.04em',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /**
     * A row of small labels: keywords and `inject_ignore` chips.
     *
     * 一行说完：换行会让标签和它的值分家（标签一行、chip 一行），看着像两段；
     * 真放不下就横向滚动，而不是往下堆。
     */
    const chipRowStyle = {
      display: 'flex',
      flexWrap: 'nowrap',
      alignItems: 'center',
      gap: 4,
      minWidth: 0,
      overflowX: 'auto',
    }

    /** One chip. */
    const chipStyle = {
      display: 'inline-flex',
      flex: '0 0 auto',
      alignItems: 'center',
      whiteSpace: 'nowrap',
      padding: '0 6px',
      borderRadius: 4,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      fontSize: 11,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
    }

    /** One chip that can be taken off: the label plus its cross. */
    const chipRemoveStyle = {
      font: 'inherit',
      marginLeft: 3,
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      fontSize: 11,
      lineHeight: '18px',
      cursor: 'pointer',
    }

    /** 方形的图标按钮（删除、加）：定宽定高、居中放一个字符。 */
    const squareButtonStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      cursor: 'pointer',
    }

    /** The square that deletes a heading card: same height as a chip. */
    const deleteButtonStyle = {
      ...squareButtonStyle,
      flex: '0 0 auto',
      width: 24,
      height: 24,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      fontSize: 14,
      lineHeight: 1,
    }

    const addButtonStyle = {
      ...squareButtonStyle,
      width: 20,
      height: 20,
      borderRadius: 4,
      border: '1px dashed var(--dsw-alias-border-l2)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '18px',
    }

    /**
     * The panel a `+` opens: legal values, grouped by where they apply.
     *
     * 固定定位、浮在锚点下面：面板挂在可滚动的列里，`absolute` 会被祖先裁掉；
     * 位置由 `anchorBox()` 按 `+` 的实际矩形算。
     */
    const pickerStyle = {
      position: 'fixed',
      zIndex: 30,
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      padding: '8px 10px',
      borderRadius: 8,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
      minWidth: 236,
    }

    /** The anchor the picker hangs from. */
    const pickerAnchorStyle = {
      position: 'relative',
      display: 'inline-flex',
    }

    /** The one-line notice inside the picker when nothing is selectable. */
    const pickerGroupStyle = {
      flex: '0 0 auto',
      minWidth: 58,
      fontSize: 11,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /**
     * 所有「看起来像一个可填的框」的东西共用这一层：值、输入框、正文编辑器都穿它。
     * 只放形状，不放尺寸——尺寸因场合而异。
     */
    const fieldFrameStyle = {
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
    }

    /** One pickable value. */
    const pickerItemStyle = {
      ...fieldFrameStyle,
      padding: '0 7px',
      borderRadius: 4,
      fontSize: 11,
      lineHeight: '18px',
      cursor: 'pointer',
    }

    /** The square that unfolds one level's parts; it sits apart from the label. */
    const chevronStyle = {
      ...pickerItemStyle,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 22,
      flex: '0 0 auto',
      padding: 0,
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /** The input a `+` reveals when the value is free text (keywords). */
    const addInputStyle = {
      ...fieldFrameStyle,
      width: 96,
      padding: '1px 6px',
      borderRadius: 4,
      fontSize: 11,
      lineHeight: '18px',
    }

    /**
     * An editable box, sharing the value box's frame.
     *
     * The host has no multiline input, and the body of a heading is a couple of
     * sentences, so this is a plain `<textarea>` wearing the same colors.
     */
    const editorStyle = {
      ...fieldFrameStyle,
      boxSizing: 'border-box',
      width: '100%',
      minWidth: 0,
      margin: 0,
      padding: '5px 8px',
      borderRadius: 6,
      fontSize: 12,
      lineHeight: '18px',
      resize: 'vertical',
    }

    /** The save button beside the metadata caption. */
    const saveButtonStyle = {
      font: 'inherit',
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 10px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-1)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      lineHeight: '18px',
      cursor: 'pointer',
    }

    /** One heading card. */
    const nodeCardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      minWidth: 0,
      padding: '8px 10px 10px',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
    }

    /** The line under a title: when it changed, what it is tagged with. */
    const nodeMetaRowStyle = {
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
    }

    /**
     * How deep headings may nest. Must track `lib/model.js` 的 `LEVELS`:
     * 加一级时这里要一起改，否则浏览器侧会停在旧深度，界面上再也加不出新的一级。
     */
    const MAX_DEPTH = 4

    const previewTextStyle = {
      margin: 0,
      fontSize: 13,
      lineHeight: '20px',
      color: 'var(--dsw-alias-label-secondary)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }

    /** 注入预览里各级标题的字号，和正文拉开差距。 */
    const PREVIEW_HEADING_SIZES = { 1: 22, 2: 18, 3: 16, 4: 14 }

    const previewHeadingStyle = (depth) => ({
      margin: '14px 0 6px',
      fontSize: PREVIEW_HEADING_SIZES[depth] ?? 14,
      fontWeight: 600,
      lineHeight: 1.35,
      color: 'var(--dsw-alias-label-primary)',
    })

    const injectedPreview = (text) => String(text ?? '').split(/\r?\n/)
      .map((line, index) => {
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading !== null) {
          return h('div', { key: `h${index}`, style: previewHeadingStyle(heading[1].length) }, heading[2])
        }
        if (line.trim() === '') return h('div', { key: `g${index}`, style: { height: 6 } })
        if (/^<\/?memory>$/.test(line.trim())) {
          return h('div', { key: `t${index}`, style: { ...previewTextStyle, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, line)
        }
        if (line.startsWith('- ')) {
          return h('div', { key: `l${index}`, style: { ...previewTextStyle, paddingLeft: 12, textIndent: '-8px' } }, `• ${line.slice(2)}`)
        }
        if (/^---+$/.test(line.trim())) {
          return h('div', { key: `s${index}`, style: { height: 1, background: 'var(--dsw-alias-border-l1)', margin: '8px 0' } })
        }
        return h('div', { key: `p${index}`, style: previewTextStyle }, line)
      })

    const caretStyle = (open) => ({
      flex: '0 0 auto',
      width: 0,
      height: 0,
      borderLeft: '6px solid currentColor',
      borderTop: '4px solid transparent',
      borderBottom: '4px solid transparent',
      color: 'var(--dsw-alias-label-tertiary)',
      transform: open ? 'rotate(90deg)' : 'none',
      transition: 'transform 120ms ease',
    })

    /** Nested headings: indented, joined by a hairline. */
    const nodeChildrenStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      minWidth: 0,
      marginLeft: 7,
      paddingLeft: 9,
      borderLeft: '1px solid var(--dsw-alias-border-l1)',
    }


    /**
     * GET one JSON answer.
     * @param {string} target - the URL to read.
     * @returns {Promise<object>} the parsed body; rejects on a non-2xx status.
     */
    async function getJson(target) {
      const response = await fetch(target, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /**
     * POST one JSON body and read the JSON answer.
     *
     * 所有 POST（改设置、文件增删、保存文件、预设增删改选）都走这里：解析失败就当空
     * 对象，非 2xx 时优先用服务端给的 `error`，没有才退回状态码。免得各写一份。
     *
     * @param {string} target - the URL to post to.
     * @param {object} payload - the body to serialize.
     * @returns {Promise<object>} the parsed body; rejects on a non-2xx status.
     */
    async function postJson(target, payload) {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body
    }

    /**
     * Turn a stored value into what the input shows.
     * @param {object} field - the field description.
     * @param {unknown} value - the stored value.
     * @returns {unknown} the draft value.
     */
    function toDraft(field, value) {
      if (field.type === 'list') return Array.isArray(value) ? value.join(', ') : ''
      if (field.type === 'boolean') return value === true
      if (field.type === 'number') return value === undefined || value === null ? '' : String(value)
      return value === undefined || value === null ? '' : String(value)
    }

    /**
     * Turn what the input shows back into a value the Host accepts.
     * @param {object} field - the field description.
     * @param {unknown} draft - the draft value.
     * @returns {unknown} the value sent on save.
     */
    function fromDraft(field, draft) {
      switch (field.type) {
        case 'list':
          return String(draft ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '')
        case 'boolean':
          return draft === true
        case 'number':
          return String(draft ?? '').trim() === '' ? null : Number(draft)
        default:
          return String(draft ?? '')
      }
    }

    /**
     * The children of the conversation's 「记忆」tab.
     *
     * The form is built from the field list the Host sends back, so a setting
     * added to `lib/config-schema.js` shows up here without touching this file.
     * Every save is a full round trip: the Host answers with the values it
     * actually stored, so the form never shows something that was not accepted.
     *
     * @returns {object} the page element.
     */
    function MemorySettings(props) {
      const t = React.useSyncExternalStore(subscribe, readTranslate, readTranslate)
      // 翻译函数只在「现在这一刻」有用：放进 effect 的依赖里会让切语言重跑一遍
      // 取数，把还没保存的草稿冲掉。需要读当前语言的异步回调从这里拿。
      const tRef = React.useRef(t)
      tRef.current = t
      // 槽位把当前会话的 id 交给每个 View，用它问「这个会话的工作区是哪个」。
      const session = props?.sessionId === undefined ? undefined : String(props.sessionId)
      const url = session === undefined ? ROUTE : `${ROUTE}?session=${encodeURIComponent(session)}`
      const [fields, setFields] = React.useState([])
      const [values, setValues] = React.useState({})
      const [draft, setDraft] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [scopes, setScopes] = React.useState([])
      const [view, setView] = React.useState('Global')
      const [picked, setPicked] = React.useState(null)
      // 新建文件用栏内输入框：宿主是 Electron，window.prompt 不可用。
      const [creating, setCreating] = React.useState(false)
      const [createText, setCreateText] = React.useState('')
      // 删除的二次确认也走栏内：window.confirm 会卡住渲染进程，回来就点不动了。
      const [confirming, setConfirming] = React.useState(null)
      const [shelf, setShelf] = React.useState('memory')
      const [injectView, setInjectView] = React.useState('preview')
      const [collapsed, setCollapsed] = React.useState({})
      const [file, setFile] = React.useState(null)
      const [fileError, setFileError] = React.useState(null)
      const [editFile, setEditFile] = React.useState(null)
      // 元数据与内容分开保存：各自一个保存中标记、一条状态文案。
      const [savingPart, setSavingPart] = React.useState(null)
      const [metaNote, setMetaNote] = React.useState(null)
      const [contentNote, setContentNote] = React.useState(null)
      // 左栏的新建 / 删除结果：它必须显示在左栏，因为这类操作之后右栏常常是空的。
      const [railNote, setRailNote] = React.useState(null)
      const [removed, setRemoved] = React.useState([])
      // 两张卡各自能收起。
      const [metaOpen, setMetaOpen] = React.useState(false)
      const [adds, setAdds] = React.useState([])
      const [adding, setAdding] = React.useState(null)
      const [addText, setAddText] = React.useState('')
      const [contentOpen, setContentOpen] = React.useState(true)
      // 合法的不注入项由服务端给（`lib/model.js` 才是权威），面板只负责摆出来。
      const [ignoreOptions, setIgnoreOptions] = React.useState([])
      const [ignoreLevels, setIgnoreLevels] = React.useState([])
      // 哪个「+」的菜单开着：`meta` 是不注入项，`kw:<key>` 是某级标题的关键词。
      const [picker, setPicker] = React.useState(null)
      // 「+」的矩形：菜单位置按它算（固定定位，避开祖先的裁剪）。
      const [pickerRect, setPickerRect] = React.useState(null)
      // 不注入项菜单里展开的那一层：{ level, rect }。悬停某层右侧浮出「更新时间/关键词/正文」。
      const [submenu, setSubmenu] = React.useState(null)
      // 预设页签：清单与当前会话的选择随 `/settings` 回来，正文按需单独取——
      // 预设是一整段开头文本，没必要每次刷新都全量传。
      const [presets, setPresets] = React.useState({ names: [], selected: '' })
      const [presetPicked, setPresetPicked] = React.useState(null)
      const [presetText, setPresetText] = React.useState('')
      const [presetDraft, setPresetDraft] = React.useState('')
      const [presetLoading, setPresetLoading] = React.useState(false)
      const [presetError, setPresetError] = React.useState(null)
      const [presetBusy, setPresetBusy] = React.useState(false)
      const [presetNote, setPresetNote] = React.useState(null)
      const [presetCreating, setPresetCreating] = React.useState(false)
      const [presetCreateText, setPresetCreateText] = React.useState('')
      // 正在等确认的切换目标：null = 没在切换，'' = 切回 DSH 默认身份。
      const [presetSwitchTarget, setPresetSwitchTarget] = React.useState(null)
      // 设置页签里「新会话默认预设」的下拉：和预设页签的清单共用一个来源。
      const [defaultPresetOpen, setDefaultPresetOpen] = React.useState(false)
      const [presetConfirming, setPresetConfirming] = React.useState(null)
      // 选择、保存、新建、删除都可能被回车与按钮同时触发，和设置表单同一个坑。
      const presetInFlight = React.useRef(false)

      // 四块渲染代码放在同目录的 client.*.js 里，按需取。主包只留编排、状态和 i18n，
      // 免得一个组件两千多行。用 state + effect 而不是 React.lazy，是为了不依赖
      // 宿主有没有包 Suspense 边界；chunk 没到之前先显示加载态。
      const [chunks, setChunks] = React.useState({})

      React.useEffect(() => {
        let live = true
        Promise.all([
          require.async('./client.settings.js'),
          require.async('./client.file.js'),
          require.async('./client.browse.js'),
          require.async('./client.presets.js'),
        ]).then(([settings, file, browse, presetsChunk]) => {
          if (live) setChunks({ settings, file, browse, presets: presetsChunk })
        }).catch((error) => {
          if (live) setStatus({ tone: 'error', text: `${t('failed')}: ${error?.message ?? error}` })
        })
        return () => {
          live = false
        }
      }, [])

      // 面板要跟会话窗口一样高：宿主没给这一层确定高度，`height: 100%` 会解析成 auto，
      // 所以自己量一次。底边取最近的滚动祖先，而不是视口底——输入框在滚动容器外面，
      // 量到视口的话面板会被输入框盖住一截。
      const rootRef = React.useRef(null)
      const [panelHeight, setPanelHeight] = React.useState(0)
      React.useEffect(() => {
        const scrollHost = (node) => {
          let el = node?.parentElement ?? null
          while (el !== null) {
            const overflowY = window.getComputedStyle(el).overflowY
            if ((overflowY === 'auto' || overflowY === 'scroll') && el.clientHeight > 0) return el
            el = el.parentElement
          }
          return null
        }
        // 输入框是浮在对话流上的独立子树，不在滚动容器里，所以还要单独量它的上沿。
        // 只认面板之外的编辑框：面板自己也有一堆 textarea。
        const composerTop = () => {
          let top = null
          for (const node of document.querySelectorAll('textarea, [contenteditable="true"]')) {
            if (rootRef.current?.contains(node) === true) continue
            const rect = node.getBoundingClientRect()
            if (rect.height === 0 || rect.top < window.innerHeight * 0.4) continue
            top = top === null ? rect.top : Math.min(top, rect.top)
          }
          return top
        }
        const measure = () => {
          const box = rootRef.current?.getBoundingClientRect()
          if (box === undefined || box === null) return
          const host = scrollHost(rootRef.current)
          const hostBottom = host === null ? window.innerHeight - 20 : host.getBoundingClientRect().bottom - 8
          const input = composerTop()
          // 谁更靠上就听谁的：面板底边不许钻到输入框底下。
          const bottom = input === null ? hostBottom : Math.min(hostBottom, input - 12)
          setPanelHeight(Math.max(320, Math.round(bottom - box.top)))
        }
        measure()
        // 输入框的高度会随着打字数、附件、换行变化，所以底边不是量一次就定了。
        // 但它一变，DOM 本身也变了：盯 DOM 与容器尺寸比每隔几毫秒扫一遍全文档便宜，
        // 也只在真变的时候才跑。两条通知都合并到一帧里，量一次就够。
        let frame = 0
        const schedule = () => {
          if (frame !== 0) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            measure()
          })
        }
        const observers = []
        const host = scrollHost(rootRef.current)
        if (typeof ResizeObserver === 'function') {
          for (const node of [rootRef.current, host]) {
            if (node === null || node === undefined) continue
            const observer = new ResizeObserver(schedule)
            observer.observe(node)
            observers.push(observer)
          }
        }
        const mutations = typeof MutationObserver === 'function'
          ? new MutationObserver((records) => {
            // 面板自己打字也会改 DOM，而面板在输入框上面，量不出新东西。
            if (records.every((record) => rootRef.current?.contains(record.target) === true)) return
            schedule()
          })
          : null
        mutations?.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
        window.addEventListener('resize', schedule)
        return () => {
          if (frame !== 0) window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', schedule)
          mutations?.disconnect()
          for (const observer of observers) observer.disconnect()
        }
      }, [])

      const adopt = (body) => {
        const nextFields = Array.isArray(body?.fields) ? body.fields : []
        const nextValues = body?.settings ?? {}
        const nextDraft = {}
        for (const field of nextFields) nextDraft[field.key] = toDraft(field, nextValues[field.key])
        setFields(nextFields)
        setValues(nextValues)
        setDraft(nextDraft)
        setScopes(Array.isArray(body?.scopes) ? body.scopes : [])
        if (body?.presets !== undefined) {
          setPresets({
            names: Array.isArray(body.presets?.names) ? body.presets.names : [],
            selected: typeof body.presets?.selected === 'string' ? body.presets.selected : '',
          })
        }
        if (Array.isArray(body?.injectIgnoreOptions)) setIgnoreOptions(body.injectIgnoreOptions)
        if (Array.isArray(body?.injectIgnoreLevels)) setIgnoreLevels(body.injectIgnoreLevels)
        setLoaded(true)
      }

      React.useEffect(() => {
        let live = true
        getJson(url)
          .then((body) => {
            if (!live) return
            adopt(body)
            setStatus(null)
          })
          .catch((error) => {
            // 语言不在依赖里：切语言只是一份新文案，不该再取一次数，更不该
            // 把还没保存的草稿换成磁盘上的旧值。
            if (live) setStatus({ tone: 'error', text: `${tRef.current('failed')}: ${error.message}` })
          })
        return () => {
          live = false
        }
      }, [url])

      /** @returns {object} only the fields the user actually changed. */
      const buildPatch = () => {
        const patch = {}
        for (const field of fields) {
          // A hidden field has no input, so its draft is whatever the last load
          // said — comparing it would post a stale value over one the panel
          // changed some other way (dragging a file, for instance).
          if (field.hidden === true) continue
          const next = fromDraft(field, draft[field.key])
          const current = field.type === 'list'
            ? (Array.isArray(values[field.key]) ? values[field.key] : [])
            : values[field.key]
          if (JSON.stringify(next) === JSON.stringify(current)) continue
          patch[field.key] = next
        }
        return patch
      }

      // 在飞的请求用 ref 挡，不靠 busy 这个 state：Enter 和按钮能在同一次渲染里
      // 各触发一次，那时 busy 还是 false，两个 POST 会一起上路。
      const inFlight = React.useRef(false)

      /**
       * Send one patch and adopt whatever comes back.
       *
       * @param {object} patch - only the keys to change.
       * @param {object} [labels] - wording overrides for the two outcomes.
       * @returns {Promise<boolean>} whether it landed.
       */
      const savePatch = async (patch, labels) => {
        if (inFlight.current) return false
        inFlight.current = true
        setBusy(true)
        setStatus(null)
        try {
          const body = await postJson(url, patch)
          adopt(body)
          setStatus({ tone: 'ok', text: labels?.ok ?? t('saved') })
          return true
        } catch (error) {
          setStatus({ tone: 'error', text: `${labels?.error ?? t('failed')}: ${error.message}` })
          return false
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }

      const save = async () => {
        if (inFlight.current) return
        const patch = buildPatch()
        if (Object.keys(patch).length === 0) {
          setStatus({ tone: 'ok', text: t('nothing') })
          return
        }
        await savePatch(patch)
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          save()
        }
      }

      const update = (field, next) => {
        setDraft((previous) => ({ ...previous, [field.key]: next }))
        setStatus(null)
      }

      /** @returns {object[]} the cards of the settings form. */
      const rows = chunks.settings === undefined
        ? [h('p', { key: 'chunk', style: textStyle }, t('loading'))]
        : chunks.settings.renderSettings({
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
          rowStyle,
          rowTextStyle,
          t,
          update,
        })

      // 只读一次改动量：按钮的可用状态和文案都看它。buildPatch 会对每个字段做一次
      // JSON.stringify，条目多的时候不算便宜，跟着草稿缓存而不是每次渲染重算。
      const changed = React.useMemo(
        () => (loaded ? Object.keys(buildPatch()).length : 0),
        [loaded, fields, values, draft],
      )

      /** @returns {object[]} the memory files of one scope. */
      /** @returns {object[]} the entries on one shelf (notebooks or days) of a scope. */
      const scopeEntries = (scope, shelf) => {
        const entry = scopes.find((item) => item.scope === scope)
        const list = shelf === 'log' ? entry?.logs : entry?.files
        return Array.isArray(list) ? list : []
      }

      /** @returns {string} where a scope's files live, or a hint until the overview arrives. */
      const directoryOf = (scope) =>
        scopes.find((entry) => entry.scope === scope)?.directory ?? t('browse.sub')

      // 正在拖的那一条的下标。用 ref：拖动过程中重渲染不该改变它。
      const dragFrom = React.useRef(null)

      /**
       * 把一条记忆文件挪到新位置，并把结果存成注入顺序。
       * @param {number} from - 原下标。
       * @param {number} to - 目标下标。
       * @returns {void}
       */
      const moveFile = (from, to) => {
        if (from === null || from === to || shelf !== 'memory') return
        const next = scopes.map((entry) => ({ ...entry }))
        const target = next.find((entry) => entry.scope === view)
        if (target === undefined || !Array.isArray(target.files)) return
        const files = [...target.files]
        const [moved] = files.splice(from, 1)
        if (moved === undefined) return
        files.splice(to, 0, moved)
        target.files = files
        setScopes(next)
        // 一份配置管两个作用域：合并时保持「Global 在前、Workspace 在后」，
        // 与不拖动时的注入顺序一致。
        const order = []
        for (const scope of ['Global', 'Workspace']) {
          const entry = next.find((item) => item.scope === scope)
          for (const item of entry?.files ?? []) order.push(item.fileName)
        }
        // 配置里可能还留着这次没显示的文件名（另一个工作区、已被删掉的文件），
        // 一次拖动不该把它们忘掉——排到末尾，和「没列出的按文件名跟在后头」一致。
        for (const name of values.fileOrder ?? []) {
          if (!order.includes(name)) order.push(name)
        }
        void savePatch({ fileOrder: order })
      }

      // 切作用域、切货架，右栏的选中项都属于上一个列表，必须清空，
      // 否则会拿着 A 页的文件名去 B 页查，得到一份空内容。
      React.useEffect(() => {
        setPicked(null)
        setFile(null)
        setFileError(null)
        setRailNote(null)
      }, [view, shelf])

      // 一个列表至少选一个：用户还没点，就先选第一个。
      React.useEffect(() => {
        if (view === 'settings') return
        const entries = scopeEntries(view, shelf)
        if (entries.length === 0) {
          setPicked(null)
          setFile(null)
          return
        }
        if (!entries.some((entry) => entry.fileName === picked)) setPicked(entries[0].fileName)
      }, [view, shelf, scopes, picked])

      // 预设页签：清单项先跟当前会话的选择对齐；会话没选就显示第一份，
      // 一份都没有就空着（右栏显示新建提示）。`''` 是「DSH 默认身份」那一行。
      React.useEffect(() => {
        if (view !== 'presets') return
        if (presetPicked === '') return
        if (presetPicked !== null && presets.names.includes(presetPicked)) return
        setPresetPicked(
          presets.names.includes(presets.selected)
            ? presets.selected
            : (presets.names[0] ?? null),
        )
      }, [view, presets, presetPicked])

      // 正文按需取：清单里只带名字，点开哪份才读哪份。
      React.useEffect(() => {
        if (view !== 'presets' || presetPicked === null || presetPicked === '') {
          setPresetText('')
          setPresetDraft('')
          setPresetLoading(false)
          setPresetError(null)
          return
        }
        let live = true
        setPresetLoading(true)
        setPresetError(null)
        const target = `${url}${url.includes('?') ? '&' : '?'}preset=${encodeURIComponent(presetPicked)}`
        getJson(target)
          .then((body) => {
            if (!live) return
            const text = typeof body?.preset?.text === 'string' ? body.preset.text : ''
            setPresetText(text)
            setPresetDraft(text)
          })
          .catch((error) => {
            if (live) setPresetError(String(error?.message ?? error))
          })
          .finally(() => {
            if (live) setPresetLoading(false)
          })
        return () => {
          live = false
        }
      }, [view, presetPicked, url])

      /**
       * 一次预设操作：四种 op 都走同一个 POST，服务端回整份清单与选中项。
       *
       * @param {object} payload - `{op, name, text?}`.
       * @returns {Promise<object|null>} the response, or null when it failed.
       */
      const postPreset = async (payload) => {
        if (presetInFlight.current) return null
        presetInFlight.current = true
        setPresetBusy(true)
        setPresetNote(null)
        try {
          const body = await postJson(url, { preset: payload })
          if (body?.presets !== undefined) {
            setPresets({
              names: Array.isArray(body.presets?.names) ? body.presets.names : [],
              selected: typeof body.presets?.selected === 'string' ? body.presets.selected : '',
            })
          }
          return body
        } catch (error) {
          setPresetNote({ tone: 'error', text: `${tRef.current('presets.failed')}: ${error?.message ?? error}` })
          return null
        } finally {
          presetInFlight.current = false
          setPresetBusy(false)
        }
      }

      const pickPreset = (name) => {
        setPresetPicked(name)
        setPresetSwitchTarget(null)
        setPresetConfirming(null)
        setPresetNote(null)
      }

      /**
       * 点「使用」：先只记下要换成哪一份（`''` 是 DSH 默认身份）并亮警告，
       * 确认后才真正写这个会话的选择。不切正在看的这一份——否则草稿会跟着没了。
       *
       * @param {string} name - 预设名，`''` 表示回默认身份。
       */
      const usePreset = (name) => {
        if (name === presets.selected) return
        setPresetSwitchTarget(name)
        setPresetConfirming(null)
        setPresetNote(null)
        if (presetPicked === null && name === '') setPresetPicked('')
      }

      const cancelPresetSwitch = () => {
        setPresetSwitchTarget(null)
      }

      const confirmPresetSwitch = async () => {
        if (presetSwitchTarget === null) return
        const body = await postPreset({ op: 'select', name: presetSwitchTarget })
        if (body === null) return
        const target = presetSwitchTarget
        setPresetSwitchTarget(null)
        setPresetNote({
          tone: 'ok',
          text: tRef.current(target === '' ? 'presets.defaultOn' : 'presets.selected'),
        })
      }

      const togglePresetCreate = () => {
        setPresetCreating((open) => !open)
        setPresetCreateText('')
        setPresetNote(null)
      }

      /** Escape / 「取消」：收起新建行，别把已经敲了一半的名字留着。 */
      const cancelPresetCreate = () => {
        setPresetCreating(false)
        setPresetCreateText('')
        setPresetNote(null)
      }

      const createPreset = async () => {
        const name = presetCreateText.trim()
        if (name === '') return
        const body = await postPreset({ op: 'create', name, text: '' })
        if (body === null) return
        setPresetCreating(false)
        setPresetCreateText('')
        setPresetPicked(name)
        setPresetText('')
        setPresetDraft('')
        setPresetNote({ tone: 'ok', text: tRef.current('presets.created') })
      }

      const savePresetText = async () => {
        if (presetPicked === null || presetDraft === presetText) return
        const body = await postPreset({ op: 'save', name: presetPicked, text: presetDraft })
        if (body === null) return
        setPresetText(presetDraft)
        setPresetNote({ tone: 'ok', text: tRef.current('saved') })
      }

      const togglePresetDelete = (name) => {
        setPresetConfirming((current) => (current === name ? null : name))
      }

      const deletePreset = async (name) => {
        const body = await postPreset({ op: 'remove', name })
        if (body === null) return
        setPresetConfirming(null)
        if (presetSwitchTarget === name) setPresetSwitchTarget(null)
        if (presetPicked === name) {
          setPresetPicked(null)
          setPresetText('')
          setPresetDraft('')
        }
        setPresetNote({ tone: 'ok', text: tRef.current('presets.deleted') })
      }

      /**
       * 整份文件的新建 / 删除。成功后重新拉作用域表，左栏就跟着变。
       *
       * 结果写在左栏上，不写进元数据卡的 `metaNote`：删日志、删掉最后一个文件
       * 之后右栏已经是空的，那份卡片根本不在，写了没人看得见。
       *
       * @param {object} action - `{op, fileName, kind}`.
       * @returns {Promise<boolean>} whether it landed.
       */
      const fileAction = async (action) => {
        setSavingPart(action.op)
        setRailNote(null)
        try {
          const body = await postJson(url, {
            [action.op === 'create' ? 'create' : 'remove']: {
              scope: view,
              kind: action.kind ?? shelf,
              fileName: action.fileName,
            },
          })
          if (Array.isArray(body?.scopes)) setScopes(body.scopes)
          if (action.op === 'create') {
            setPicked(body?.file?.fileName ?? action.fileName)
            setRailNote({ tone: 'ok', text: t('file.created') })
          } else {
            setPicked(null)
            setFile(null)
            setRailNote({ tone: 'ok', text: t('file.deleted') })
          }
          return true
        } catch (error) {
          setRailNote({ tone: 'error', text: `${t('action.failed')}: ${error.message}` })
          return false
        } finally {
          setSavingPart(null)
        }
      }

      const fileUrl = view === 'settings' || picked === null
        ? null
        : `${url}${url.includes('?') ? '&' : '?'}scope=${view}&kind=${shelf}&file=${encodeURIComponent(picked)}`

      /**
       * One heading's editable fields, with the defaults a whole draft uses.
       *
       * The same shape has to come out of `draftOfFile()` below and out of the
       * fallback a card uses before anything was typed, or "dirty" would flip on
       * its own the moment a card renders.
       *
       * @param {object} node - one heading from the route's tree.
       * @returns {{title: string, desc: string, keyword: string[]}} the draft.
       */
      const nodeDraft = (node) => ({
        title: String(node?.title ?? ''),
        desc: typeof node?.desc === 'string' ? node.desc : '',
        keyword: Array.isArray(node?.keyword) ? node.keyword.map(String) : [],
      })

      /**
       * Flatten the editable parts of one file into a draft.
       *
       * Chips and bodies are keyed by the heading path, JSON-encoded, because a
       * heading's identity *is* its path: the same title under two parents are
       * two different nodes.
       *
       * @param {object} document - the file payload from the route.
       * @returns {object} `{desc, format, injectIgnore, nodes}`.
       */
      const draftOfFile = (document) => {
        const nodes = {}
        const walk = (list, prefix) => {
          for (const node of Array.isArray(list) ? list : []) {
            const path = [...prefix, String(node.title ?? '')]
            nodes[JSON.stringify(path)] = nodeDraft(node)
            walk(node.children, path)
          }
        }
        walk(document?.tree, [])
        const meta = document?.meta ?? {}
        return {
          fileName: String(meta.fileName ?? document?.fileName ?? ''),
          desc: typeof meta.desc === 'string' ? meta.desc : '',
          format: typeof meta.format === 'string' ? meta.format : '',
          injectIgnore: Array.isArray(meta.injectIgnore) ? meta.injectIgnore.map(String) : [],
          nodes,
        }
      }

      React.useEffect(() => {
        if (fileUrl === null) return
        let live = true
        setFileError(null)
        getJson(fileUrl)
          .then((body) => {
            if (!live) return
            setFile(body?.file ?? null)
          })
          .catch((error) => {
            if (!live) return
            setFile(null)
            setFileError(error.message)
          })
        return () => {
          live = false
        }
      }, [fileUrl])

      // 保存成功回来的那一份文件：它的草稿已经在 saveFile 里就地合并过了，
      // 交给下面这个 effect 重来一遍会把另一半没保存的改动抹掉。
      const adoptedFile = React.useRef(null)

      // 换了一份文件就换一份草稿。保存成功也会换 file，但那是同一份文件的新内容，
      // 由 saveFile 自己按「保存的是哪一半」合并——这里只处理真正的换文件。
      React.useEffect(() => {
        if (adoptedFile.current !== null && adoptedFile.current === file) {
          adoptedFile.current = null
          return
        }
        setEditFile(file === null ? null : draftOfFile(file))
        setMetaNote(null)
        setContentNote(null)
        setPicker(null)
        setAdds([])
        // 待删标题是跟着某一份文件走的：在 A 标了要删、切到 B 还留着，
        // 保存 B 时就会把 A 的路径发出去，撞上同名标题就把 B 删了。
        setRemoved([])
        setAdding(null)
        setAddText('')
      }, [file])

      // 换一个菜单就收回子菜单，免得下次展开时停在上次那一层。
      React.useEffect(() => {
        setSubmenu(null)
      }, [picker])

      // 换了作用域、货架或者列表本身，那条删除确认就不该还挂着。
      React.useEffect(() => {
        setConfirming(null)
      }, [view, shelf, scopes])

      // 浮层收起：点外面或按 Esc。浮层和它的锚点都带 data-dsm-picker，
      // 点在它们身上不算「外面」，否则刚点开的菜单会被自己的 pointerdown 关掉。
      React.useEffect(() => {
        if (picker === null) return undefined
        const outside = (event) => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-dsm-picker]') !== null) return
          setPicker(null)
        }
        const escape = (event) => {
          if (event.key === 'Escape') setPicker(null)
        }
        document.addEventListener('pointerdown', outside)
        document.addEventListener('keydown', escape)
        return () => {
          document.removeEventListener('pointerdown', outside)
          document.removeEventListener('keydown', escape)
        }
      }, [picker])

      /** @returns {object} the draft with one heading's change folded in. */
      const patchNode = (key, change) => {
        setEditFile((previous) => {
          if (previous === null) return previous
          const current = previous.nodes[key] ?? { title: '', desc: '', keyword: [] }
          return { ...previous, nodes: { ...previous.nodes, [key]: { ...current, ...change } } }
        })
        setContentNote(null)
      }

      /** @returns {object} the draft with one metadata change folded in. */
      const patchMeta = (change) => {
        setEditFile((previous) => (previous === null ? previous : { ...previous, ...change }))
        setMetaNote(null)
      }

      /** Opens (or closes) a panel under the `+` that was just clicked. */
      const openPicker = (event, key) => {
        setPickerRect(event.currentTarget.getBoundingClientRect())
        setPicker((previous) => (previous === key ? null : key))
      }

      /**
       * @param {'meta'|'content'} part - which half of the draft to compare.
       * @returns {boolean} whether that half differs from what is on disk.
       */
      const fileDirty = (part) => {
        if (editFile === null || file === null) return false
        const base = draftOfFile(file)
        if (part === 'content') {
          // 还没落盘的新标题不在草稿里，也要算成「改过」。
          return adds.length > 0 || removed.length > 0 || JSON.stringify(editFile.nodes) !== JSON.stringify(base.nodes)
        }
        const pick = (draft) => [draft.fileName, draft.desc, draft.format, draft.injectIgnore]
        return JSON.stringify(pick(editFile)) !== JSON.stringify(pick(base))
      }

      /**
       * Write one half of the draft back through the same route the panel reads.
       *
       * Only that half is sent: 元数据和内容各有一份保存按钮，改一边不该把另一边
       * 未确认的草稿也带下去。写入仍由文件哈希把关，过期的标签页会被直接拒绝。
       *
       * @param {'meta'|'content'} part - which half to save.
       * @returns {Promise<void>} resolves once the answer is adopted.
       */
      const saveFile = async (part) => {
        if (editFile === null || file === null || fileUrl === null) return
        const note = part === 'meta' ? setMetaNote : setContentNote
        setSavingPart(part)
        note(null)
        try {
          const doomed = (headingPath) => removed.some((item) => underPath(headingPath, item))
          const liveAdds = adds.filter((entry) => !doomed(entry.parent))
          const newNodes = part !== 'content' || liveAdds.length === 0
            ? undefined
            : liveAdds.map((entry) => ({
              parent: entry.parent,
              title: entry.title,
              ...(entry.desc === undefined || entry.desc === '' ? {} : { desc: entry.desc }),
              ...(entry.keyword === undefined || entry.keyword.length === 0 ? {} : { keyword: entry.keyword }),
            }))
          const nodes = part !== 'content'
            ? undefined
            : Object.entries(editFile.nodes).filter(([key]) => !doomed(JSON.parse(key))).map(([key, value]) => ({
              path: JSON.parse(key),
              title: value.title,
              desc: value.desc,
              keyword: value.keyword,
            }))
          const body = await postJson(fileUrl, {
            file: {
              scope: file.scope,
              kind: file.kind,
              fileName: file.fileName,
              ...(part !== 'meta' || file.kind !== 'memory'
                ? {}
                : {
                  newFileName: editFile.fileName,
                  desc: editFile.desc,
                  format: editFile.format,
                  injectIgnore: editFile.injectIgnore,
                }),
              ...(nodes === undefined ? {} : { nodes }),
              ...(part !== 'content' || removed.length === 0 ? {} : { removed }),
              ...(newNodes === undefined ? {} : { newNodes }),
            },
          })
          if (Array.isArray(body?.scopes)) setScopes(body.scopes)
          const saved = body?.file ?? null
          if (part === 'content') {
            setAdds([])
            setRemoved([])
          }
          // 只把刚保存的那一半换成新值，另一半仍留着用户手上的草稿：
          // 改正文 → 改 desc → 保存元数据，不该把正文一起冲掉。
          if (saved !== null) {
            const live = draftOfFile(saved)
            setEditFile((previous) => {
              if (previous === null) return live
              if (part === 'meta') {
                return {
                  ...previous,
                  fileName: live.fileName,
                  desc: live.desc,
                  format: live.format,
                  injectIgnore: live.injectIgnore,
                }
              }
              // 内容落盘后待建卡清空，关键词输入框里的临时值跟着草稿留着。
              return { ...previous, nodes: live.nodes, pending: previous.pending }
            })
          }
          // 下面这个 ref 让「file 变了」的 effect 知道这是自己刚存回来的那份，
          // 不要按「换了一份文件」处理。
          adoptedFile.current = saved
          setFile(saved)
          // 改了名就把左栏的选中项换成新名字，否则右栏还挂在旧名下。
          if (typeof saved?.fileName === 'string') setPicked(saved.fileName)
          note({ tone: 'ok', text: t('saved') })
        } catch (error) {
          note({ tone: 'error', text: `${t('failed')}: ${error.message}` })
        } finally {
          setSavingPart(null)
        }
      }

      /**
       * A centred placeholder: what is missing, and what to do about it.
       * @param {string} title - the first line.
       * @param {string} hint - the second line, or '' for none.
       * @returns {object} the element.
       */
      const placeholder = (title, hint) => h('div', { style: emptyStyle },
        h('p', { style: emptyTitleStyle }, title),
        hint !== '' && h('p', { style: emptyHintStyle }, hint))

      /** @returns {object} a card-shaped placeholder while the file is loading. */
      const skeleton = () => h('div', { style: paneStyle, 'aria-hidden': true },
        h('span', { style: { ...paneTitleStyle }, className: 'dsm-skeleton', }, ''),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          [86, 72, 78, 54, 64].map((width, index) => h('div', {
            key: index,
            className: 'dsm-skeleton',
            style: { width: `${width}%` },
          }))))

      /**
       * A pane caption: a host icon and the label, on one baseline.
       * @param {Function} icon - the host icon component.
       * @param {string} text - the caption.
       * @returns {object} the caption row element.
       */
      const paneCaption = (icon, text) => h('span',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            color: 'var(--dsw-alias-label-tertiary)',
          },
        },
        // 图标描边用 currentColor，颜色交给它外面这层。
        icon === undefined ? null : h(icon, { size: 14 }),
        h('span', { style: paneTitleStyle }, text))

      /** @returns {string} a stored timestamp in local time, or as written when unparseable. */
      const when = (value) => {
        if (typeof value !== 'string' || value === '') return ''
        const at = new Date(value)
        if (Number.isNaN(at.getTime())) return value
        const pad = (number) => String(number).padStart(2, '0')
        return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
      }

      /**
       * 内部名 → 面板上的说法：「t1.desc」念作「一级标题 > 正文」。
       * 说法本身在字典里，英文界面才会跟着变。
       *
       * @param {string} value - one `inject_ignore` value.
       * @returns {string} the same value in words.
       */
      const ignoreLabel = (value) => String(value)
        .split('.')
        .map((part) => (part === '' ? part : t(`ignore.${part}`)))
        .join(' > ')

      /**
       * 一排可删的小标签。
       * @param {string[]} items - the values.
       * @param {(item: string) => void} onRemove - drop one.
       * @param {(item: string) => string} [label] - how to word it; raw by default.
       * @returns {object[]} the chips.
       */
      const chips = (items, onRemove, label) => items.map((item) => {
        const text = label === undefined ? item : label(item)
        return h('span', { key: item, style: chipStyle },
          text,
          h('button', {
            type: 'button',
            className: 'dsm-hover',
            'aria-label': `${text} ×`,
            onClick: () => onRemove(item),
            style: chipRemoveStyle,
          }, '×'))
      })

      /**
       * @param {boolean} open - whether its panel is showing.
       * @param {(event: object) => void} onClick - toggle; gets the click, so the panel can hang off it.
       * @param {string} label - what it adds, for readers.
       * @returns {object} the square.
       */
      const addButton = (open, onClick, label) => h('button', {
        type: 'button',
        className: 'dsm-hover',
        'aria-label': label,
        'aria-expanded': open,
        onClick,
        style: addButtonStyle,
      }, '+')

      /** @returns {boolean} whether two heading paths point at the same heading. */
      const samePath = (left, right) => left.length === right.length && left.every((item, index) => item === right[index])

      /**
       * A heading that is drafted but not saved yet: dashed card, removable.
       *
       * @param {{parent: string[], title: string}} entry - the pending heading.
       * @returns {object} the card element.
       */
      // 待建标题要能一直吃得着焦点，所以给它一个不随文字变化的身份。
      const addSerial = React.useRef(0)

      /**
       * 直接开一张待建卡：不再先要一个输入框，点「+」就长出卡片。
       *
       * @param {string[]} parentPath - where the new heading should hang.
       * @returns {void}
       */
      const spawnAdd = (parentPath) => {
        if (parentPath.length + 1 > MAX_DEPTH) return
        // 父标题收着的时候新卡会藏在看不见的地方，先展开它。
        setCollapsed((previous) => ({ ...previous, [JSON.stringify(parentPath)]: false }))
        setAdds((previous) => [...previous, {
          id: (addSerial.current += 1),
          parent: parentPath,
          title: '',
          desc: '',
          keyword: [],
        }])
      }

      /**
       * @param {string[]} headingPath - the heading to check.
       * @returns {boolean} whether that heading is waiting to be deleted.
       */
      const isRemoved = (headingPath) => removed.some((item) => samePath(item, headingPath))

      /**
       * @param {string[]} path - a heading path.
       * @param {string[]} prefix - the path being deleted.
       * @returns {boolean} whether path is prefix itself or hangs below it.
       */
      const underPath = (path, prefix) => path.length >= prefix.length
        && prefix.every((segment, index) => path[index] === segment)


      // 子菜单浮在那一行右侧，行和菜单间留着一道缝：鼠标跨过缝隙时会先离开行，
      // 所以延迟收起，进入任一侧都能取消——不然菜单在指到之前就没了，点不到。
      const closeTimer = React.useRef(null)
      const keepLevel = (level, rect) => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current)
        closeTimer.current = null
        setSubmenu({ level, rect })
      }
      const dropLevel = () => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current)
        closeTimer.current = setTimeout(() => setSubmenu(null), 140)
      }
      // 从行里跨到子菜单上时只取消收起，不再设一次，否则鼠标停在菜单上也会被收起。
      const keepSubmenu = () => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current)
        closeTimer.current = null
      }
      // 面板收起、换作用域时组件会卸载，那条 140ms 的等待必须跟着取消，
      // 否则它会在卸载之后 setState。
      React.useEffect(() => () => {
        if (closeTimer.current !== null) clearTimeout(closeTimer.current)
        closeTimer.current = null
      }, [])

      /** @returns {object} the right pane: the metadata card and the heading cards. */
      const detail = () => {
        if (chunks.file === undefined) {
          return h('div', panesStyle, skeleton(), skeleton())
        }
        return chunks.file.renderFile({
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
          keepSubmenu,
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
        })
      }

      /** @returns {object} the left rail of one scope plus its right pane. */
      const browserBody = (scope) => {
        if (chunks.browse === undefined) {
          return h('div', { style: browserStyle }, placeholder(t('loading'), ''))
        }
        return chunks.browse.renderBrowser({
          UI,
          browserStyle,
          confirming,
          createButtonStyle,
          createInputStyle,
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
        })
      }

      /**
       * 预设页签：左清单、右纯文本编辑器。清单与选中项随设置一起回来，
       * 正文按需取；交互全部回主包，chunk 只负责画。
       */
      const presetsBody = () => {
        const chunk = chunks.presets
        if (chunk === undefined) return placeholder(t('loading'), '')
        return chunk.renderPresets({
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
          names: presets.names,
          selected: presets.selected,
          picked: presetPicked,
          loading: presetLoading,
          error: presetError,
          note: presetNote,
          draft: presetDraft,
          dirty: presetPicked !== null && presetPicked !== '' && presetDraft !== presetText,
          busy: presetBusy,
          creating: presetCreating,
          createText: presetCreateText,
          switching: presetSwitchTarget !== null,
          confirming: presetConfirming,
          onPick: pickPreset,
          onUse: usePreset,
          onUseConfirm: confirmPresetSwitch,
          onUseCancel: cancelPresetSwitch,
          onCreateToggle: togglePresetCreate,
          onCreateText: setPresetCreateText,
          onCreateSubmit: createPreset,
          onCreateCancel: cancelPresetCreate,
          onDeleteToggle: togglePresetDelete,
          onDelete: deletePreset,
          onDraft: setPresetDraft,
          onSave: savePresetText,
        })
      }

      const tabs = [
        { id: 'presets', text: t('view.presets') },
        { id: 'Global', text: t('view.global') },
        { id: 'Workspace', text: t('view.workspace') },
        { id: 'settings', text: t('view.settings') },
      ]

      const shelves = [
        { id: 'memory', text: t('rail.memory') },
        { id: 'log', text: t('rail.log') },
      ]

      // 设置页签最上面那张卡：默认预设。它的值一选就提交，不等底部的「保存」——
      // 这个下拉和其余输入框不是同一种东西（无需草稿，也没有「改了没存」这回事）。
      const defaultPresetValue = typeof values.defaultPreset === 'string' ? values.defaultPreset : ''
      const defaultPresetLabel = defaultPresetValue === '' ? t('presets.none') : defaultPresetValue
      const defaultPresetCard = h('section', { key: 'preset-default', style: groupCardStyle },
        h('h4', { style: groupTitleStyle }, t('group.preset')),
        h('div', { style: rowStyle },
          h('div', { style: rowTextStyle },
            h('span', { style: labelStyle }, t('field.defaultPreset')),
            h('p', { style: hintStyle }, t('hint.defaultPreset'))),
          h(UI.Menu, {
            open: defaultPresetOpen && loaded && !busy,
            items: [
              { id: '', label: t('presets.none') },
              ...presets.names.map((name) => ({ id: name, label: name })),
            ],
            selectedId: defaultPresetValue,
            align: 'end',
            onClose: () => setDefaultPresetOpen(false),
            onSelect: (id) => {
              setDefaultPresetOpen(false)
              if (id === defaultPresetValue) return
              void savePatch({ defaultPreset: id })
            },
            anchor: h(UI.Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: busy || !loaded,
              'aria-label': t('field.defaultPreset'),
              'aria-haspopup': 'menu',
              'aria-expanded': defaultPresetOpen && !busy,
              onClick: () => setDefaultPresetOpen((value) => !value),
              children: h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                defaultPresetLabel,
                h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-caption)' } },
                  h(UI.IconChevronDownOutlineRegular, { size: 12 }))),
            }),
          })))

      const body = view === 'settings'
        ? [
            // 默认预设是设置表单里的第一张卡：它得跟着表单一起滚，不能当
            // 滚动层外面的固定栏——那会让「预设」永远贴在顶上。
            h('div', { key: 'form', style: settingsBodyStyle }, [defaultPresetCard, ...rows]),
            h('div', { key: 'actions', style: actionsStyle },
              h(UI.Button, {
                variant: 'primary',
                onClick: save,
                // 没改动就没什么可存的：按钮灰着比点了回一句「没有改动」更直接。
                disabled: busy || !loaded || changed === 0,
              }, busy ? t('saving') : t('save')),
              changed > 0 && h('span', { style: textStyle }, t('changed').replace('%s', String(changed))),
              status !== null && h('span', {
                role: status.tone === 'error' ? 'alert' : 'status',
                style: {
                  ...textStyle,
                  color: status.tone === 'error'
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-state-success-primary)',
                },
              }, status.text),
              !loaded && status === null && h('span', { style: textStyle }, t('loading'))),
          ]
        : [h('div', { key: 'browser', style: { display: 'flex', flex: '1 1 auto', minWidth: 0, minHeight: 0 } },
          view === 'presets' ? presetsBody() : browserBody(view))]

      return h('div', {
        ref: rootRef,
        // 量到的像素优先；还没量出来时退回 100%，由 minHeight 兜底。
        style: {
          ...pageStyle,
          height: panelHeight === 0 ? '100%' : `${panelHeight}px`,
          maxHeight: panelHeight === 0 ? '100%' : `${panelHeight}px`,
        },
        className: 'dsm-root',
      },
        h('header', { style: headerStyle },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 } },
            h('h3', { style: headingStyle }, t('title')),
            h('span', { style: subheadingStyle },
              view === 'settings'
                ? t('settings.sub')
                : (view === 'presets' ? t('presets.sub') : directoryOf(view)))),
          h(UI.SegmentedTabs, {
            items: tabs.map((tab) => ({ value: tab.id, label: tab.text })),
            value: view,
            label: t('title'),
            onChange: (next) => setView(next),
          })),
        ...body)
    }

    /**
     * 新会话那行「工作区 / 创造模式」最右边的预设选择。
     *
     * 宿主只在有 session 时渲染这个槽，所以拿到 sessionId 就能直接写进那个会话的
     * 预设状态：会话还没开口，第一条消息组装时 identity 就已经是选中的那份，
     * 不需要「使用 + 确认」——这里没有上下文可打断，也就没有缓存可毁。
     */
    function PresetSeat(props) {
      const t = props?.t ?? ((key) => key)
      const session = props?.sessionId === undefined ? undefined : String(props.sessionId)
      const [choices, setChoices] = React.useState([])
      const [selected, setSelected] = React.useState('')
      const [ready, setReady] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        if (session === undefined) return () => { alive.current = false }
        fetch(`${ROUTE}?session=${encodeURIComponent(session)}`, { headers: { accept: 'application/json' } })
          .then(async (res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
          })
          .then((body) => {
            if (!alive.current) return
            setChoices(Array.isArray(body?.presets?.names) ? body.presets.names.slice() : [])
            setSelected(typeof body?.presets?.selected === 'string' ? body.presets.selected : '')
          })
          // 读不到清单就整块不出现：宁可少一个控件，也不要在新建会话那里留个坏按钮。
          .catch(() => {})
          .finally(() => { if (alive.current) setReady(true) })
        return () => { alive.current = false }
      }, [session])

      // 一份预设都没有时没什么可选，别占着那一行右侧的位置。
      if (!ready || choices.length === 0) return null

      const items = [
        { id: '', label: t('presets.none') },
        ...choices.map((name) => ({ id: name, label: name })),
      ]
      const shown = selected === '' ? t('presets.none') : selected

      const pick = (id) => {
        setOpen(false)
        if (id === selected || busy) return
        const previous = selected
        // 先按点击结果更新，失败再退回去：菜单一关，界面就不该停在旧名字上等回包。
        setSelected(id)
        setBusy(true)
        postJson(`${ROUTE}?session=${encodeURIComponent(session)}`, { preset: { op: 'select', name: id } })
          .then((body) => {
            const next = body?.presets?.selected
            setSelected(typeof next === 'string' ? next : id)
          })
          .catch(() => setSelected(previous))
          .finally(() => setBusy(false))
      }

      // 照官方 hero 那一行的 seat 复刻：无边框透明按钮、13px/20px、左右 8px、chevron 用 caption 色。
      const seatStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        minHeight: 28,
        maxWidth: 'min(100%, 240px)',
        padding: '0 8px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        fontWeight: 500,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        cursor: busy ? 'default' : 'pointer',
      }
      const seatLabelStyle = ellipsisStyle
      const seatChevronStyle = { display: 'inline-flex', flex: 'none', color: 'var(--dsw-alias-label-caption)' }

      return h(UI.Menu, {
        open: open && !busy,
        items,
        selectedId: selected,
        align: 'end',
        onClose: () => setOpen(false),
        onSelect: pick,
        anchor: h('button', {
          type: 'button',
          disabled: busy,
          'aria-label': t('presets.seat'),
          'aria-haspopup': 'menu',
          'aria-expanded': open && !busy,
          style: seatStyle,
          onClick: () => setOpen((value) => !value),
          children: [
            h('span', { style: seatLabelStyle }, `${t('presets.seat')} · ${shown}`),
            h('span', { style: seatChevronStyle }, h(UI.IconChevronDownOutlineRegular, { size: 12 })),
          ],
        }),
      })
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES), 'memory: settings locale')
        ctx.effect(() => {
          setTranslate(ctx.locale.bind(NS))
          return ctx.locale.subscribe(() => setTranslate(ctx.locale.bind(NS)))
        }, 'memory: settings translate')
        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'memory-preset',
          order: 40,
          label: () => translate('presets.seat'),
          locale: NS,
        }, PresetSeat))
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'memory',
          order: 40,
          label: () => translate('tab'),
          locale: NS,
        }, MemorySettings))
      },
    }
  },
})

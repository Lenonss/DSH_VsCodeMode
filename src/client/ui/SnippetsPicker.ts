// @ts-nocheck
/**
 * dsh-vscode-mode client — 代码片段选择器（VS Code「Configure Snippets」形态）。
 *
 * 形态：**居中浮窗 + 二级弹窗**，复用插件原生模态样式（mcp.css 的 .vsm-mcp-dialog，
 * 与「添加 MCP」「工作区选择」同源），不自造视觉。
 * - 一级弹窗 mode='configure'：按语言分组的现有片段文件列表（全局 + 当前工作区项目），
 *   点击在文件编辑界面打开；底部按「当前文件语言」新建，或新建全语言片段。
 * - 二级弹窗：新建片段文件表单（语言下拉 + 文件名），语言决定默认文件名与写入的绑定语义。
 * - 一级弹窗 mode='insert'：当前语言生效条目列表，点击在光标处按片段语法展开。
 *
 * ⚠️ 浮层经 createPortal 挂 body，根节点必须带 `data-edrv-view`（与 CommandPalette /
 * ContextMenu 一致）：editor.css 的浮层样式全部以 `[data-edrv-view]` 作用域限定，
 * 漏挂会导致样式整块失效、内容以裸流形式铺在页面底部。
 * 作者 ddj 2026年09月10号
 */
import React from 'react'
import { createPortal } from 'react-dom'
import { rpc } from '../rpc.js'
import { invalidateSnippets, listSnippetsFor } from '../snippets/provider.js'
import {
  SNIPPET_LANGUAGES, languageLabelOf, normalizeSnippetFileName, snippetFileTemplate, snippetFileNameFor,
} from '../../shared/snippets.js'
// 显式声明对原生模态样式的依赖（.vsm-mcp-dialog / .vsm-primary）：
// 「添加 MCP」页当前也会引入它，但本组件不应依赖那一处的引入顺序。
import '../styles/mcp.css'

/** 片段文件行的第二行摘要：语言 + 条目数 + 相对路径。 */
export function fileMeta(info) {
  return languageLabelOf(info.language) + ' · ' + info.count + ' 条 · [' + info.relHint + info.file + ']'
}

/**
 * 语言下拉选项：全语言 + 语言目录（去重、保持目录序）。
 * @author ddj 2026年09月10号
 * @param languages 语言 id 目录（缺省用 shared 常量）
 * @returns 选项数组（{ id, label }）
 */
export function languageOptions(languages) {
  const ids = Array.isArray(languages) && languages.length ? languages : SNIPPET_LANGUAGES
  const seen = new Set()
  const out = [{ id: '', label: '全语言（所有文件生效）' }]
  for (const raw of ids) {
    const id = String(raw ?? '').trim().toLowerCase()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label: languageLabelOf(id) })
  }
  return out
}

/**
 * 片段选择器（浮窗 / 二级弹窗）。
 * @param props.mode 'configure'（管理文件）| 'insert'（插入条目）
 * @param props.sessionId 会话 id
 * @param props.cwd 当前会话工作区（项目片段分组与新建用）
 * @param props.language 当前编辑器文件绑定的语言 id（新建默认语言 / 插入过滤）
 * @param props.languages 可选语言目录（来自 monaco.languages.getLanguages；缺省用内置常量）
 * @param props.onOpenFile 在编辑界面打开片段文件回调(absPath)
 * @param props.onInsert 插入片段回调(entry)
 * @param props.onClose 关闭回调
 * @returns 浮层 React 元素
 */
export function SnippetsPicker(props) {
  const mode = props?.mode === 'insert' ? 'insert' : 'configure'
  const sessionId = props?.sessionId
  const cwd = props?.cwd
  const currentLanguage = String(props?.language ?? '').trim().toLowerCase()
  const options = React.useMemo(() => languageOptions(props?.languages), [props?.languages])
  const onOpenFile = props?.onOpenFile
  const onInsert = props?.onInsert
  const onClose = props?.onClose

  const [data, setData] = React.useState(null)
  const [entries, setEntries] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  // 二级弹窗草稿：null=未打开；否则 { scope, language, fileName, edited }
  const [draft, setDraft] = React.useState(null)
  const aliveRef = React.useRef(true)

  const isInsert = mode === 'insert'

  /** 拉取数据：管理模式取文件列表，插入模式取当前语言条目。 */
  const load = React.useCallback(() => {
    if (isInsert) {
      listSnippetsFor(currentLanguage).then((list) => {
        if (!aliveRef.current) return
        setEntries(list)
        setError('')
      }).catch((e) => { if (aliveRef.current) setError('读取代码片段失败：' + String(e)) })
      return
    }
    rpc('snippets.list', {}).then((res) => {
      if (!aliveRef.current) return
      if (res && res.ok) { setData(res); setError('') }
      else setError(res?.error ?? '读取代码片段失败')
    }).catch((e) => { if (aliveRef.current) setError('读取代码片段失败：' + String(e)) })
  }, [isInsert, currentLanguage])

  React.useEffect(() => {
    aliveRef.current = true
    load()
    return () => { aliveRef.current = false }
  }, [load])

  // Esc：二级弹窗优先关闭（二级 → 一级），避免一次按键直接退出整个流程
  React.useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      if (draft) closeDraft()
      else onClose?.()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [draft, onClose])

  /** 打开二级弹窗（按 scope + 语言新建）。 */
  const openDraft = (scope, language) => {
    setDraft({ scope, language, fileName: snippetFileNameFor(language), edited: false })
    setError('')
  }

  /** 关闭二级弹窗（回到一级浮窗）。 */
  const closeDraft = () => {
    setDraft(null)
    setError('')
  }

  /** 改语言：文件名未手改过则跟随语言联动（手改过则尊重用户输入）。 */
  const pickLanguage = (language) => {
    setDraft((prev) => (prev ? { ...prev, language, fileName: prev.edited ? prev.fileName : snippetFileNameFor(language) } : prev))
  }

  /** 改文件名：标记为手改，之后不再被语言联动覆盖。 */
  const editFileName = (value) => {
    setDraft((prev) => (prev ? { ...prev, fileName: value, edited: true } : prev))
  }

  /**
   * 创建并打开片段文件（二级弹窗提交）。
   * @author ddj 2026年09月10号
   */
  const createFile = () => {
    if (!draft) return
    const name = normalizeSnippetFileName(draft.fileName)
    if (!name) { setError('文件名不能为空'); return }
    if (draft.scope === 'project' && !cwd) { setError('当前会话没有工作区，无法新建项目片段'); return }
    setBusy(true)
    setError('')
    rpc('snippets.save', {
      scope: draft.scope,
      workspacePath: draft.scope === 'project' ? cwd : undefined,
      file: name,
      content: snippetFileTemplate(draft.language),
    }).then((res) => {
      if (!aliveRef.current) return
      if (!res || !res.ok) { setError(res?.error ?? '新建失败'); return }
      invalidateSnippets()
      closeDraft()
      onOpenFile?.(res.file.absPath)
      onClose?.()
    }).catch((e) => { if (aliveRef.current) setError('新建失败：' + String(e)) })
      .finally(() => { if (aliveRef.current) setBusy(false) })
  }

  /** 打开片段文件（在编辑界面打开，浮窗关闭）。 */
  const openFile = (info) => {
    onOpenFile?.(info.absPath)
    onClose?.()
  }

  /** 删除片段文件（confirm 后走 snippets.remove）。 */
  const removeFile = (info) => {
    if (!window.confirm('删除代码片段文件 ' + info.file + '？（不可恢复）')) return
    rpc('snippets.remove', { scope: info.scope, workspacePath: info.scope === 'project' ? cwd : undefined, file: info.file })
      .then((res) => {
        if (!aliveRef.current) return
        if (!res || !res.ok) { setError(res?.error ?? '删除失败'); return }
        invalidateSnippets()
        load()
      }).catch((e) => { if (aliveRef.current) setError('删除失败：' + String(e)) })
  }

  /** 一级浮窗主体：列表 / 空态 / 错误。 */
  const renderBody = () => {
    if (error && !draft) return React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error)
    if (isInsert) {
      const list = entries ?? []
      if (!list.length) {
        return React.createElement('div', { className: 'vsm-mcp-empty' },
          entries === null ? '正在读取代码片段…' : '当前文件没有可用代码片段，可用「代码片段：配置代码片段」新建')
      }
      return React.createElement('div', { className: 'edrv-snip-list' }, list.map((entry) => React.createElement('button', {
        key: entry.scope + ':' + entry.file + ':' + entry.key,
        className: 'edrv-snip-row',
        onClick: () => { onInsert?.(entry); onClose?.() },
      },
        React.createElement('span', { className: 'edrv-snip-row-main' },
          React.createElement('span', { className: 'edrv-snip-label' }, entry.prefix || entry.key),
          React.createElement('span', { className: 'edrv-snip-desc' }, entry.description || entry.key)),
        React.createElement('span', { className: 'edrv-snip-src' }, entry.file))))
    }
    if (!data) return React.createElement('div', { className: 'vsm-mcp-empty' }, '正在读取代码片段…')
    const project = (data.projects ?? []).find((item) => item.workspacePath === cwd) ?? null
    /** 行按语言再按文件名排序，同语言片段聚在一起（便于按文件类型找片段）。 */
    const sortByLanguage = (list) => [...list].sort((a, b) =>
      String(a.language).localeCompare(String(b.language)) || String(a.file).localeCompare(String(b.file)))
    const rows = (list) => sortByLanguage(list).map((info) => React.createElement('div', { key: info.scope + ':' + info.file, className: 'edrv-snip-row' },
      React.createElement('button', { className: 'edrv-snip-row-main', title: info.absPath, onClick: () => openFile(info) },
        React.createElement('span', { className: 'edrv-snip-label' }, info.file),
        React.createElement('span', { className: 'edrv-snip-desc' }, fileMeta(info))),
      info.error ? React.createElement('span', { className: 'vsm-mcp-chip edrv-snip-warn' }, 'JSON 解析失败') : null,
      React.createElement('button', { className: 'edrv-snip-act edrv-snip-danger', title: '删除', onClick: () => removeFile(info) }, '⌫')))
    const globalRows = rows(data.user ?? [])
    const projectRows = project ? rows(project.files ?? []) : []
    return React.createElement('div', { className: 'edrv-snip-list' },
      React.createElement('div', { className: 'edrv-snip-group' }, '全局代码片段（~/.dsh/snippets/）'),
      globalRows.length ? globalRows : React.createElement('div', { className: 'edrv-snip-empty' }, '还没有全局代码片段'),
      React.createElement('div', { className: 'edrv-snip-group' }, '项目代码片段' + (cwd ? '（' + cwd + '）' : '')),
      projectRows.length
        ? projectRows
        : React.createElement('div', { className: 'edrv-snip-empty' }, cwd ? '当前项目没有代码片段' : '当前会话没有工作区'))
  }

  /** 当前文件语言提示行（让「片段绑定到哪种文件」一目了然）。 */
  const languageBar = React.createElement('div', { className: 'edrv-snip-langbar' },
    currentLanguage
      ? React.createElement(React.Fragment, null,
          '当前文件语言：',
          React.createElement('b', null, languageLabelOf(currentLanguage)),
          '（' + currentLanguage + '）')
      : '当前没有打开文件：可新建全语言片段，或先打开文件再新建对应语言的片段')

  const dialog = React.createElement('div', { className: 'edrv-snip-mask', onClick: () => onClose?.() },
    React.createElement('div', { className: 'vsm-mcp-dialog edrv-snip-dialog', onClick: (event) => event.stopPropagation() },
      React.createElement('h3', null, isInsert ? '插入代码片段' : '代码片段：配置代码片段'),
      React.createElement('p', { className: 'edrv-snip-hint' }, isInsert
        ? '仅列出对当前文件语言生效的片段（选定后在光标处展开，支持 ${1:占位} 与 $TM_FILENAME 等变量）。'
        : '代码片段按语言绑定：`<语言>.code-snippets` 只对该类文件生效，`global.code-snippets` 对所有文件生效。选中文件即在编辑界面打开。'),
      isInsert ? null : languageBar,
      renderBody(),
      isInsert
        ? null
        : React.createElement('div', { className: 'vsm-mcp-dialog-actions' },
            React.createElement('button', {
              disabled: busy,
              onClick: () => openDraft('user', ''),
            }, '新建全语言片段…'),
            React.createElement('button', {
              className: 'vsm-primary',
              disabled: busy || !currentLanguage,
              title: currentLanguage ? '' : '请先打开一个文件，或改用「新建全语言片段…」',
              onClick: () => openDraft('user', currentLanguage),
            }, currentLanguage ? '新建 ' + languageLabelOf(currentLanguage) + ' 片段文件…' : '新建当前语言片段…'),
            React.createElement('button', {
              disabled: busy || !cwd,
              title: cwd ? '' : '当前会话没有工作区',
              onClick: () => openDraft('project', currentLanguage),
            }, '新建项目片段文件…'))))

  // 二级弹窗：新建片段文件（语言 + 文件名；叠在一级浮窗之上的独立遮罩）
  const createDialog = draft
    ? React.createElement('div', { className: 'edrv-snip-mask edrv-snip-mask-top', onClick: closeDraft },
        React.createElement('div', { className: 'vsm-mcp-dialog edrv-snip-dialog', onClick: (event) => event.stopPropagation() },
          React.createElement('h3', null, draft.scope === 'project' ? '新建项目代码片段文件' : '新建全局代码片段文件'),
          React.createElement('label', null, '生效语言',
            React.createElement('select', {
              value: draft.language,
              disabled: busy,
              onChange: (event) => { pickLanguage(event.target.value); setError('') },
            }, options.map((item) => React.createElement('option', { key: 'lang-' + item.id, value: item.id }, item.label)))),
          React.createElement('label', null, '文件名',
            React.createElement('input', {
              autoFocus: true,
              spellCheck: false,
              value: draft.fileName,
              placeholder: snippetFileNameFor(draft.language),
              onChange: (event) => { editFileName(event.target.value); setError('') },
              onKeyDown: (event) => { if (event.key === 'Enter') createFile() },
            })),
          React.createElement('div', { className: 'edrv-snip-hint' },
            (draft.scope === 'project' ? '将写入 ' + (cwd ?? '') + '/.dsh/snippets/' : '将写入 ~/.dsh/snippets/')
            + normalizeSnippetFileName(draft.fileName)
            + (draft.language
                ? '（仅对 ' + languageLabelOf(draft.language) + ' 文件生效）'
                : '（对所有文件生效）')),
          error ? React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error) : null,
          React.createElement('div', { className: 'vsm-mcp-dialog-actions' },
            React.createElement('button', { disabled: busy, onClick: closeDraft }, '取消'),
            React.createElement('button', { className: 'vsm-primary', disabled: busy, onClick: createFile }, busy ? '创建中…' : '创建并打开'))))
    : null

  // 根节点必须带 data-edrv-view：editor.css 浮层样式均以此为作用域前缀
  return createPortal(React.createElement('div', { 'data-edrv-view': '1' }, dialog, createDialog), document.body)
}

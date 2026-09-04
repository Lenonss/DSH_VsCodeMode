// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「规则」面板（Codebuddy 规则管理形态）。
 * 双 Tab：用户规则（~/.dsh/rules/）与项目规则（<工作区>/.dsh/rules/）；
 * 列表行 = 文件名 + 相对提示 + 类型徽标（总是/自动/手动）+ 描述 + 编辑/删除/启用开关；
 * 新建/编辑 = 内嵌表单（文件名 + 原始 .mdc 文本域，frontmatter 可见），保存走 rules.save。
 * 作者 ddj 2026年09月03号
 */
import React from 'react'
import { rpc } from '../../rpc.js'
import type { SidebarCtx } from '../types.js'
import { CACHE_KEY } from '../../paths.js'

/** 新建规则模板（frontmatter 字段与 host parseRuleMdc 对齐）。 */
const NEW_TEMPLATE = '---\ndescription: \nalwaysApply: true\n---\n\n'
const TYPE_LABEL = { always: '总是', auto: '自动', manual: '手动' }

/**
 * 读 localStorage（损坏/不可用安全）。
 * @author ddj 2026年09月03号
 * @param key 键
 * @returns 值或 null
 */
function readLocal(key) {
  try { return localStorage.getItem(key) } catch (e) { return null }
}

/**
 * 写 localStorage（不可用安全）。
 * @author ddj 2026年09月03号
 * @param key 键
 * @param value 值
 */
function writeLocal(key, value) {
  try { localStorage.setItem(key, value) } catch (e) { /* 忽略 */ }
}

/**
 * 类型徽标（总是=绿 / 自动=蓝 / 手动=灰）。
 * @author ddj 2026年09月03号
 * @param type 规则类型
 * @returns 徽标元素
 */
function typeBadge(type) {
  return React.createElement('span', { className: 'edrv-rules-type edrv-rules-type-' + type }, TYPE_LABEL[type] ?? type)
}

// --region 列表行
/**
 * 渲染一条规则行：文件名 + 相对提示 + 类型徽标，第二行描述；右侧编辑/删除/开关。
 * @author ddj 2026年09月03号
 * @param props.rule 规则元信息
 * @param props.onEdit 编辑回调
 * @param props.onRemove 删除回调
 * @param props.onToggle 开关回调
 * @returns 行元素
 */
function RuleRow(props) {
  const rule = props.rule
  const desc = [rule.error ? '解析失败：' + rule.error : null, rule.description || (rule.type === 'auto' ? 'globs: ' + rule.globs.join(', ') : '')]
    .filter(Boolean).join(' · ')
  return React.createElement('div', { className: 'edrv-rules-row' + (rule.enabled ? '' : ' off') },
    React.createElement('div', { className: 'edrv-rules-main', onClick: () => props.onEdit(rule), title: rule.absPath },
      React.createElement('span', { className: 'edrv-rules-file' }, rule.file),
      React.createElement('span', { className: 'edrv-rules-path' }, '[' + rule.relHint + rule.file + ']'),
      typeBadge(rule.type),
      !rule.enabled ? React.createElement('span', { className: 'edrv-rules-offtag' }, '已停用') : null),
    React.createElement('div', { className: 'edrv-rules-desc', title: desc }, desc ? '描述: ' + desc : '描述: —'),
    React.createElement('div', { className: 'edrv-rules-actions' },
      React.createElement('button', { className: 'edrv-rules-act', title: '编辑', onClick: () => props.onEdit(rule) }, '✏️'),
      React.createElement('button', { className: 'edrv-rules-act', title: '删除', onClick: () => props.onRemove(rule) }, '🗑'),
      React.createElement('button', {
        className: 'edrv-rules-switch' + (rule.enabled ? ' on' : ''), role: 'switch', 'aria-checked': rule.enabled,
        title: rule.enabled ? '已启用（点击停用）' : '已停用（点击启用）',
        onClick: () => props.onToggle(rule),
      }, React.createElement('span', { className: 'edrv-rules-knob' }))))
}
// --endregion

// --region 内嵌编辑器
/**
 * 新建/编辑表单：文件名（仅新建可改）+ 原始 .mdc 文本域 + 保存/取消。
 * @author ddj 2026年09月03号
 * @param props.form 表单状态（mode/scope/workspacePath/file/content/error/saving）
 * @param props.setForm 表单更新函数
 * @param props.onSave 保存回调
 * @param props.onCancel 取消回调
 * @returns 表单元素
 */
function RuleEditor(props) {
  const form = props.form
  const isNew = form.mode === 'new'
  return React.createElement('div', { className: 'edrv-rules-editor' },
    React.createElement('div', { className: 'edrv-rules-editor-head' },
      isNew ? '新建' + (form.scope === 'project' ? '项目' : '用户') + '规则' : '编辑：' + form.file,
      React.createElement('button', { className: 'edrv-rules-act', title: '取消', onClick: props.onCancel }, '✕')),
    React.createElement('div', { className: 'edrv-rules-editor-file' },
      React.createElement('label', null, '文件名'),
      React.createElement('input', {
        className: 'edrv-rules-input', value: form.file, disabled: !isNew, spellCheck: false,
        placeholder: 'my-rule.mdc', onChange: (e) => props.setForm({ ...form, file: e.target.value }),
      })),
    React.createElement('textarea', {
      className: 'edrv-rules-body', spellCheck: false,
      value: form.content,
      onChange: (e) => props.setForm({ ...form, content: e.target.value }),
    }),
    React.createElement('div', { className: 'edrv-rules-editor-hint' },
      'frontmatter 支持 description / alwaysApply / globs / enabled；无 frontmatter 的纯 markdown 视为「手动」规则'),
    form.error ? React.createElement('div', { className: 'edrv-rules-err' }, form.error) : null,
    React.createElement('div', { className: 'edrv-rules-editor-foot' },
      React.createElement('button', { className: 'edrv-rules-save', disabled: form.saving, onClick: props.onSave }, form.saving ? '保存中…' : '保存')))
}
// --endregion

/**
 * 规则面板主体。
 * @param props.ctx 面板共享上下文（notify 可选）
 */
export function RulesPanel(props) {
  const ctx = props?.ctx
  const notify = ctx?.notify ?? ((message) => {})
  // 当前会话工作区（EditorView 从 sessions 快照注入；项目 Tab 自动匹配，不提供手动切换）
  const cwd = ctx?.cwd ?? null
  const [tab, setTab] = React.useState(() => (readLocal(CACHE_KEY.rules + 'tab') === 'project' ? 'project' : 'user'))
  const [data, setData] = React.useState(null) // { user: RuleInfo[], projects: RuleProject[] }
  const [error, setError] = React.useState('')
  const [form, setForm] = React.useState(null) // 编辑器表单状态；null=列表态
  const mountedRef = React.useRef(true)

  /**
   * 当前工作区对应的项目聚合（按 ctx.cwd 自动匹配；无会话/未注册返回 null）。
   * @returns RuleProject 或 null
   */
  const activeProject = () => {
    if (!cwd) return null
    return (data?.projects ?? []).find((p) => p.workspacePath === cwd) ?? null
  }

  /** 拉取规则总列表（rules.list）。 */
  const load = () => {
    rpc('rules.list', {}).then((res) => {
      if (!mountedRef.current) return
      if (res && res.ok) { setData(res); setError('') } else setError(res?.error ?? '读取规则失败')
    }).catch((e) => { if (mountedRef.current) setError('读取规则异常: ' + String(e)) })
  }

  React.useEffect(() => {
    mountedRef.current = true
    load()
    return () => { mountedRef.current = false }
  }, [])

  /**
   * 切换 Tab（记忆到 localStorage）。
   * @param next 目标 Tab
   */
  const switchTab = (next) => {
    setTab(next)
    writeLocal(CACHE_KEY.rules + 'tab', next)
  }

  /**
   * 打开新建表单（按当前 Tab 决定作用域；项目规则跟随当前会话工作区）。
   */
  const openNew = () => {
    const scope = tab === 'project' ? 'project' : 'user'
    if (scope === 'project' && !cwd) { notify('当前会话没有工作区，无法新建项目规则'); return }
    setForm({ mode: 'new', scope, workspacePath: scope === 'project' ? cwd : undefined, file: '', content: NEW_TEMPLATE, error: '', saving: false })
  }

  /**
   * 打开编辑表单：先拉全文再进入编辑态。
   * @param rule 目标规则
   */
  const openEdit = (rule) => {
    rpc('rules.read', { scope: rule.scope, workspacePath: rule.scope === 'project' ? rule.workspacePath : undefined, file: rule.file })
      .then((res) => {
        if (res && res.ok) {
          setForm({ mode: 'edit', scope: rule.scope, workspacePath: rule.workspacePath, file: rule.file, content: res.content, error: '', saving: false })
        } else notify(res?.error ?? '读取规则失败')
      }).catch((e) => notify('读取规则异常: ' + String(e)))
  }

  /** 保存表单（rules.save；文件名仅新建校验非空）。 */
  const saveForm = () => {
    const next = { ...form, saving: true, error: '' }
    const file = String(form.file ?? '').trim()
    if (!file) { setForm({ ...next, saving: false, error: '文件名不能为空' }); return }
    setForm(next)
    rpc('rules.save', { scope: form.scope, workspacePath: form.workspacePath, file, content: form.content })
      .then((res) => {
        if (res && res.ok) {
          setForm(null)
          notify('规则已保存：' + file)
          load()
        } else setForm((prev) => ({ ...prev, saving: false, error: res?.error ?? '保存失败' }))
      }).catch((e) => setForm((prev) => ({ ...prev, saving: false, error: '保存异常: ' + String(e) })))
  }

  /**
   * 删除规则（confirm 后走 rules.remove）。
   * @param rule 目标规则
   */
  const removeRule = (rule) => {
    if (!window.confirm('删除规则 ' + rule.file + '？（不可恢复）')) return
    rpc('rules.remove', { scope: rule.scope, workspacePath: rule.workspacePath, file: rule.file })
      .then((res) => {
        if (res && res.ok) { notify('已删除：' + rule.file); load() } else notify(res?.error ?? '删除失败')
      }).catch((e) => notify('删除异常: ' + String(e)))
  }

  /**
   * 切换启用开关：本地乐观翻转（按 workspacePath+file 定位，失败回滚）。
   * @param rule 目标规则（project 已注入 workspacePath）
   */
  const toggleRule = (rule) => {
    const enabled = !rule.enabled
    const applyLocal = (on) => setData((prev) => prev ? {
      ...prev,
      user: prev.user.map((r) => (r.scope === 'user' && r.file === rule.file ? { ...r, enabled: on } : r)),
      projects: prev.projects.map((p) => (p.workspacePath === rule.workspacePath
        ? { ...p, rules: p.rules.map((r) => (r.file === rule.file ? { ...r, enabled: on } : r)) }
        : p)),
    } : prev)
    applyLocal(enabled)
    rpc('rules.toggle', { scope: rule.scope, workspacePath: rule.workspacePath, file: rule.file, enabled })
      .then((res) => {
        if (res && res.ok) { applyLocal(res.rule?.enabled === true); notify(res.rule?.enabled === false ? '已停用：' + rule.file : '已启用：' + rule.file) }
        else { applyLocal(!enabled); notify(res?.error ?? '切换失败') }
      }).catch((e) => { applyLocal(!enabled); notify('切换异常: ' + String(e)) })
  }

  /** 当前列表数据（按 Tab 取用户规则或当前工作区的项目规则）。 */
  const rowsOf = () => {
    if (!data) return []
    if (tab === 'user') return data.user
    return activeProject()?.rules ?? []
  }

  const renderTabs = () => React.createElement('div', { className: 'edrv-rules-tabs' },
    React.createElement('button', { className: 'edrv-rules-tab' + (tab === 'user' ? ' on' : ''), onClick: () => switchTab('user') }, '用户规则'),
    React.createElement('button', { className: 'edrv-rules-tab' + (tab === 'project' ? ' on' : ''), onClick: () => switchTab('project') }, '项目规则'),
    React.createElement('button', { className: 'edrv-rules-new', title: '新建规则', onClick: openNew }, '＋ 新建规则'))

  /** 项目 Tab 的工作区展示（不可编辑，自动跟随当前会话）。 */
  const renderWsLine = () => {
    if (tab !== 'project') return null
    return React.createElement('div', { className: 'edrv-rules-ws-line', title: cwd ?? '' },
      '工作区：' + (cwd ?? '当前会话未打开工作区'))
  }

  const renderEmpty = () => {
    if (tab === 'project') {
      if (!cwd) return '当前会话没有工作区，项目规则不可用（项目规则跟随会话所在工作区）'
      if (!data?.projects?.length) return '当前 DSH 没有已注册的工作区；在目标工作区打开一次会话后再来管理'
      if (!activeProject()) return '当前工作区未注册为 DSH workspace，暂不能管理其项目规则'
      return '<工作区>/.dsh/rules/ 还没有规则，点击「＋ 新建规则」创建'
    }
    return '还没有用户规则（~/.dsh/rules/），点击「＋ 新建规则」创建'
  }

  const renderBody = () => {
    if (form) return React.createElement(RuleEditor, { form, setForm, onSave: saveForm, onCancel: () => setForm(null) })
    if (!data) return React.createElement('div', { className: 'edrv-rules-empty' }, '加载中…')
    if (error) return React.createElement('div', { className: 'edrv-rules-err' }, error)
    const rows = rowsOf()
    if (!rows.length) return React.createElement('div', { className: 'edrv-rules-empty' }, renderEmpty())
    const common = {
      onEdit: (rule) => openEdit({ ...rule, workspacePath: rule.scope === 'project' ? cwd : undefined }),
      onRemove: (rule) => removeRule({ ...rule, workspacePath: rule.scope === 'project' ? cwd : undefined }),
      onToggle: (rule) => toggleRule({ ...rule, workspacePath: rule.scope === 'project' ? cwd : undefined }),
    }
    return React.createElement('div', { className: 'edrv-rules-list' },
      rows.map((rule) => React.createElement(RuleRow, { key: rule.scope + ':' + rule.file, rule, ...common })))
  }

  return React.createElement('div', { className: 'edrv-rules-panel' },
    renderTabs(),
    renderWsLine(),
    React.createElement('div', { className: 'edrv-rules-hint' },
      tab === 'user' ? '用户规则对所有会话生效（存放于 ~/.dsh/rules/）' : '项目规则仅对所在工作区的会话生效（存放于 <工作区>/.dsh/rules/）'),
    renderBody())
}

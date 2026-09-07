// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「规则」面板（Codebuddy 规则管理形态）。
 * 双 Tab：用户规则（~/.dsh/rules/）与项目规则（<工作区>/.dsh/rules/）；
 * 列表行 = 文件名 + 相对提示，第二行类型徽标与描述，右侧 编辑/删除 图标 + 滑动启用开关；
 * 新建/编辑 = 顶部面包屑 + 规则类型下拉（总是/自动/手动）+ 描述/globs 控件，与原始 .mdc
 * 文本域双向同步（控件改写 frontmatter，文本域回读控件），保存走 rules.save。
 * 作者 ddj 2026年09月03号（2026年09月07号 交互性调整）
 */
import React from 'react'
import { rpc } from '../../rpc.js'
import type { SidebarCtx } from '../types.js'
import { CACHE_KEY } from '../../paths.js'
import { parseRuleFm, applyRuleMeta } from '../../rulesMdc.js'

/** 新建规则模板（frontmatter 字段与 host parseRuleMdc 对齐）。 */
const NEW_TEMPLATE = '---\ndescription: \nalwaysApply: true\n---\n\n'
const TYPE_LABEL = { always: '总是', auto: '自动', manual: '手动' }
/** 列表行描述的基础显示上限（字符数；宽面板下的封顶值，超出省略号）。 */
const DESC_MAX = 24
/** 动态字数下限（极窄面板的保底可见字符数）。 */
const DESC_CAP_MIN = 8
/** 动态字数估算：描述之外的行内固定占用 px（动作区/类型标签/徽标/间距/省略余量）。 */
const DESC_RESERVE_PX = 210
/** 动态字数估算：单字符平均宽度 px（11px 字号，中英混排）。 */
const DESC_CHAR_PX = 10
/** 窄面板阈值：低于此宽度隐藏路径提示（编辑界面面包屑与悬停仍有完整路径）。 */
const NARROW_W = 420

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

/**
 * 按字符上限截断列表行描述，超出以省略号收尾（上限随面板宽度动态变化；
 * 窄面板下 CSS 省略号仍会按像素提前截断，二者取更小）。
 * @author ddj 2026年09月07号
 * @param text 完整描述
 * @param cap 本帧字符上限
 * @returns 截断后的展示文本
 */
function clampDesc(text, cap) {
  const chars = Array.from(String(text ?? '')) // 按码位切分，避免把 emoji 等代理对从中间截断
  const limit = Math.max(4, Number(cap) || DESC_MAX)
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : chars.join('')
}

/**
 * 由面板宽度估算描述可用字符数：随宽度动态变化，并与基础上限取小、极窄时保底。
 * @author ddj 2026年09月07号
 * @param panelWidth 面板内容宽度（px）
 * @returns 本帧描述字符上限
 */
function descCapOf(panelWidth) {
  const byWidth = Math.floor((Number(panelWidth) - DESC_RESERVE_PX) / DESC_CHAR_PX)
  return Math.max(DESC_CAP_MIN, Math.min(DESC_MAX, byWidth))
}

/**
 * 编辑图标（线性铅笔，与 DiffBox chevron 同风格：currentColor 描边装饰图）。
 * @author ddj 2026年09月07号
 * @returns 13×13 装饰性 SVG
 */
function pencilIcon() {
  return React.createElement('svg', {
    width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false,
  }, React.createElement('path', {
    d: 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

/**
 * 删除图标（线性垃圾桶，风格同 pencilIcon）。
 * @author ddj 2026年09月07号
 * @returns 13×13 装饰性 SVG
 */
function trashIcon() {
  return React.createElement('svg', {
    width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, focusable: false,
  }, React.createElement('path', {
    d: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14zM10 11v6M14 11v6',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }))
}

/**
 * 逗号分隔的 globs 输入串 → 数组（去空项）。
 * @author ddj 2026年09月07号
 * @param text 输入串
 * @returns glob 数组
 */
function globList(text) {
  return String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

/**
 * 由控件值重建 .mdc 全文：frontmatter 按类型/描述/globs 重写，正文与其余键不动。
 * @author ddj 2026年09月07号
 * @param base 当前全文
 * @param fmType 目标类型（always/auto/manual）
 * @param desc 描述文本
 * @param globsText globs 输入串
 * @returns 重写后的全文
 */
function rebuildContent(base, fmType, desc, globsText) {
  return applyRuleMeta(parseRuleFm(base), { type: fmType, description: desc, globs: globList(globsText) })
}

// --region 列表行
/**
 * 渲染一条规则行：左侧两行（文件名+相对提示 / 类型徽标+描述），右侧 编辑/删除 图标 + 滑动开关。
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
      React.createElement('div', { className: 'edrv-rules-line1' },
        React.createElement('span', { className: 'edrv-rules-file' }, rule.file),
        !props.narrow ? React.createElement('span', { className: 'edrv-rules-path' }, '[' + rule.relHint + rule.file + ']') : null,
        !rule.enabled ? React.createElement('span', { className: 'edrv-rules-offtag' }, '已停用') : null),
      React.createElement('div', { className: 'edrv-rules-sub' },
        React.createElement('span', { className: 'edrv-rules-sublabel' }, '类型:'),
        typeBadge(rule.type),
        desc ? React.createElement('span', { className: 'edrv-rules-desc', title: desc }, clampDesc(desc, props.descCap)) : null)),
    React.createElement('div', { className: 'edrv-rules-actions' },
      React.createElement('button', { className: 'edrv-rules-act', title: '编辑', onClick: () => props.onEdit(rule) }, pencilIcon()),
      React.createElement('button', { className: 'edrv-rules-act', title: '删除', onClick: () => props.onRemove(rule) }, trashIcon()),
      React.createElement('button', {
        className: 'edrv-rules-switch' + (rule.enabled ? ' on' : ''), role: 'switch', 'aria-checked': rule.enabled,
        title: rule.enabled ? '已启用（点击停用）' : '已停用（点击启用）',
        onClick: () => props.onToggle(rule),
      }, React.createElement('span', { className: 'edrv-rules-knob' }))))
}
// --endregion

// --region 内嵌编辑器
/**
 * 新建/编辑表单：面包屑头部 + 规则类型下拉/描述/globs 控件行 + 原始 .mdc 文本域 + 保存/取消。
 * @author ddj 2026年09月03号
 * @param props.form 表单状态（mode/scope/workspacePath/relHint/file/content/fmType/desc/globs/error/saving）
 * @param props.onType 类型下拉变更回调
 * @param props.onDesc 描述输入回调
 * @param props.onGlobs globs 输入回调
 * @param props.onBody 文本域编辑回调
 * @param props.onSave 保存回调
 * @param props.onCancel 取消回调
 * @returns 表单元素
 */
function RuleEditor(props) {
  const form = props.form
  const isNew = form.mode === 'new'
  const crumb = (form.scope === 'project' ? '项目规则' : '用户规则') + ' > ' + form.relHint + ' > ' + (form.file || '新建规则.mdc')
  return React.createElement('div', { className: 'edrv-rules-editor' },
    React.createElement('div', { className: 'edrv-rules-editor-head' },
      React.createElement('span', { className: 'edrv-rules-crumb', title: crumb }, crumb),
      React.createElement('button', { className: 'edrv-rules-act', title: '取消', onClick: props.onCancel }, '✕')),
    React.createElement('div', { className: 'edrv-rules-editor-ctl' },
      React.createElement('label', { className: 'edrv-rules-ctl-label' }, '规则类型'),
      React.createElement('select', { className: 'edrv-rules-select', value: form.fmType, onChange: props.onType },
        Object.keys(TYPE_LABEL).map((key) => React.createElement('option', { key, value: key }, TYPE_LABEL[key]))),
      React.createElement('label', { className: 'edrv-rules-ctl-label' }, '描述'),
      React.createElement('input', {
        className: 'edrv-rules-input edrv-rules-desc-input', value: form.desc, spellCheck: false,
        placeholder: isNew ? '规则用途说明（写入 frontmatter description）' : '规则用途说明', onChange: props.onDesc,
      })),
    form.fmType === 'auto' ? React.createElement('div', { className: 'edrv-rules-editor-ctl' },
      React.createElement('label', { className: 'edrv-rules-ctl-label' }, 'globs'),
      React.createElement('input', {
        className: 'edrv-rules-input', value: form.globs, spellCheck: false,
        placeholder: 'src/**/*.ts, *.md（逗号分隔，命中才注入）', onChange: props.onGlobs,
      })) : null,
    React.createElement('textarea', {
      className: 'edrv-rules-body', spellCheck: false,
      value: form.content,
      onChange: props.onBody,
    }),
    React.createElement('div', { className: 'edrv-rules-editor-hint' },
      '类型/描述/globs 与 frontmatter 双向同步；enabled 与其余键原样保留；无 frontmatter 的纯 markdown 视为「手动」规则'),
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
  const panelRef = React.useRef(null)
  const [panelW, setPanelW] = React.useState(0) // 面板内容宽度（ResizeObserver 跟踪；0=未测得）
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

  // 面板宽度跟踪：描述字数上限与窄面板模式都随宽度动态变化
  React.useEffect(() => {
    const el = panelRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setPanelW(el.clientWidth))
    observer.observe(el)
    setPanelW(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  // 描述字数上限与窄面板模式（未测得宽度前用基础上限/完整展示）
  const descCap = panelW > 0 ? descCapOf(panelW) : DESC_MAX
  const narrow = panelW > 0 && panelW < NARROW_W

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
    const parsed = parseRuleFm(NEW_TEMPLATE)
    setForm({
      mode: 'new', scope, workspacePath: scope === 'project' ? cwd : undefined,
      relHint: scope === 'project' ? '.dsh/rules/' : 'rules/', file: '', content: NEW_TEMPLATE,
      fmType: parsed.type, desc: parsed.description, globs: parsed.globs.join(', '), error: '', saving: false,
    })
  }

  /**
   * 打开编辑表单：先拉全文，再解析 frontmatter 回填类型/描述/globs 控件。
   * @param rule 目标规则
   */
  const openEdit = (rule) => {
    rpc('rules.read', { scope: rule.scope, workspacePath: rule.scope === 'project' ? rule.workspacePath : undefined, file: rule.file })
      .then((res) => {
        if (!res || !res.ok) { notify(res?.error ?? '读取规则失败'); return }
        const parsed = parseRuleFm(res.content)
        setForm({
          mode: 'edit', scope: rule.scope, workspacePath: rule.workspacePath, relHint: rule.relHint,
          file: rule.file, content: res.content,
          fmType: parsed.type, desc: parsed.description, globs: parsed.globs.join(', '), error: '', saving: false,
        })
      }).catch((e) => notify('读取规则异常: ' + String(e)))
  }

  /** 类型下拉变更：frontmatter 按新类型重写，控件同步。 */
  const onTypeChange = (e) => {
    const nextType = e.target.value
    setForm((prev) => ({ ...prev, fmType: nextType, content: rebuildContent(prev.content, nextType, prev.desc, prev.globs), error: '' }))
  }

  /** 描述输入变更：同步 frontmatter description 行。 */
  const onDescChange = (e) => {
    const nextDesc = e.target.value
    setForm((prev) => ({ ...prev, desc: nextDesc, content: rebuildContent(prev.content, prev.fmType, nextDesc, prev.globs), error: '' }))
  }

  /** globs 输入变更（自动规则）：同步 frontmatter globs 行。 */
  const onGlobsChange = (e) => {
    const nextGlobs = e.target.value
    setForm((prev) => ({ ...prev, globs: nextGlobs, content: rebuildContent(prev.content, prev.fmType, prev.desc, nextGlobs), error: '' }))
  }

  /** 文本域直接编辑：回读 frontmatter，同步类型/描述/globs 控件（文本域是唯一真源）。 */
  const onBodyChange = (e) => {
    const parsed = parseRuleFm(e.target.value)
    setForm((prev) => ({ ...prev, content: e.target.value, fmType: parsed.type, desc: parsed.description, globs: parsed.globs.join(', ') }))
  }

  /** 保存表单（rules.save；文件名非空 + 自动规则必须有 globs）。 */
  const saveForm = () => {
    const next = { ...form, saving: true, error: '' }
    const file = String(form.file ?? '').trim()
    if (!file) { setForm({ ...next, saving: false, error: '文件名不能为空' }); return }
    if (form.fmType === 'auto' && globList(form.globs).length === 0) { setForm({ ...next, saving: false, error: '自动规则需要至少一个 glob（逗号分隔）' }); return }
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
    if (form) {
      return React.createElement(RuleEditor, {
        form, onType: onTypeChange, onDesc: onDescChange, onGlobs: onGlobsChange, onBody: onBodyChange,
        onSave: saveForm, onCancel: () => setForm(null),
      })
    }
    if (!data) return React.createElement('div', { className: 'edrv-rules-empty' }, '加载中…')
    if (error) return React.createElement('div', { className: 'edrv-rules-err' }, error)
    const rows = rowsOf()
    if (!rows.length) return React.createElement('div', { className: 'edrv-rules-empty' }, renderEmpty())
    const common = {
      descCap,
      narrow,
      onEdit: (rule) => openEdit({ ...rule, workspacePath: rule.scope === 'project' ? cwd : undefined }),
      onRemove: (rule) => removeRule({ ...rule, workspacePath: rule.scope === 'project' ? cwd : undefined }),
      onToggle: (rule) => toggleRule({ ...rule, workspacePath: rule.scope === 'project' ? cwd : undefined }),
    }
    return React.createElement('div', { className: 'edrv-rules-list' },
      rows.map((rule) => React.createElement(RuleRow, { key: rule.scope + ':' + rule.file, rule, ...common })))
  }

  return React.createElement('div', { className: 'edrv-rules-panel', ref: panelRef },
    renderTabs(),
    renderWsLine(),
    React.createElement('div', { className: 'edrv-rules-hint' },
      tab === 'user' ? '用户规则对所有会话生效（存放于 ~/.dsh/rules/）' : '项目规则仅对所在工作区的会话生效（存放于 <工作区>/.dsh/rules/）'),
    renderBody())
}

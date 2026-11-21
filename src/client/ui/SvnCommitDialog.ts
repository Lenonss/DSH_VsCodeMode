// @ts-nocheck
/**
 * dsh-vscode-mode client — 原生提交对话框（22-agent-tools-and-commit）。
 *
 * 结构对齐「SVN 更新」窗口：标题栏（✕ 走 FloatingWindow 的 actions）+ 工具带 + 有列头的
 * 勾选表格 + 提交信息编排区 + 遥测行 + 页脚主操作。勾选范围是主信息，主按钮自带数量；
 * 分组头三态勾选；ignore-on-commit 与未版本控制默认不勾并在分组头就地标注。
 * 提交前仍单次 window.confirm 确认；AI 结果只回填文本框，**绝不自动提交**。
 * @author ddj 2026年11月15号
 */
import React from 'react'
import { FloatingWindow } from './FloatingWindow.js'
import { AI_COMMIT_STYLE_LABEL, AI_COMMIT_IDLE, runAiCommit } from '../aiCommit.js'
import { svnCommitNow, svnCommitPlan } from '../svnCommit.js'
import { SVN_STATUS_LABEL, SVN_STATUS_LETTER, SVN_STATUS_TONE } from '../../shared/svn.js'
import {
  commitHintOf,
  commitMessageErrorOf,
  commitResultLinesOf,
  commitSectionsOf,
  commitStatsOf,
  defaultCheckedOf,
  groupTriStateOf,
} from './svnCommitModel.js'

/** 状态分级的展示顺序（页脚计数同序，避免数字跳动）。 */
const TONE_ORDER = ['modified', 'added', 'deleted', 'conflict', 'plain']

/** 状态分级 → 中文标签。 */
const TONE_LABEL = { modified: '修改', added: '新增', deleted: '删除', conflict: '冲突', plain: '其他' }

/**
 * 勾选范围 → 一行计数文案（页脚左键位）。
 * @author ddj 2026年11月15号
 * @param stats 勾选统计
 * @returns 如「已选 6 / 17 个文件 · 修改 5 · 新增 1」
 */
function statsTextOf(stats) {
  const parts = ['已选 ' + stats.picked + ' / ' + stats.total + ' 个文件']
  for (const tone of TONE_ORDER) {
    const count = stats.byTone[tone] ?? 0
    if (count) parts.push(TONE_LABEL[tone] + ' ' + count)
  }
  return parts.join(' · ')
}

/**
 * 分组头右侧的默认不勾标记（勾选规则本身在模型层，这里只负责说清楚）。
 * @author ddj 2026年11月15号
 * @param section 分区
 * @returns 标记文案；默认勾选的分组返回 null
 */
function sectionNoteOf(section) {
  if (section.defaultChecked) return null

  return section.key === 'unversioned' ? '默认不选' : '默认不提交'
}

/**
 * 勾选里是否含未版本控制文件（提交确认文案用）。
 * @author ddj 2026年11月15号
 * @param sections 分区
 * @param checked 勾选路径集合
 * @returns 是否含未版本控制条目
 */
function hasUnversionedOf(sections, checked) {
  return sections.some((section) => section.key === 'unversioned'
    && section.entries.some((entry) => checked.has(entry.path)))
}

/**
 * 复选框元素（仓库 UI 原语无 Checkbox，沿用原生控件 + CSS 定制外观）。
 * @author ddj 2026年11月15号
 * @param checked 是否勾选 @param onToggle 切换回调 @param title 提示 @param indeterminate 半选
 * @returns 复选框元素
 */
function checkBoxEl(checked, onToggle, title, indeterminate = false) {
  return React.createElement('input', {
    type: 'checkbox',
    className: 'edrv-svncommit-cb',
    checked,
    title,
    onChange: () => onToggle(),
    ref: (node) => { if (node) node.indeterminate = indeterminate },
  })
}

/**
 * 分组头（吸顶）：三态勾选 + 分区名 + 默认不勾标记 + 条目数。
 * @author ddj 2026年11月15号
 * @param section 分区 @param tri 三态 @param onToggle 整组切换
 * @returns 分组头元素
 */
function sectionHeadEl(section, tri, onToggle) {
  const note = sectionNoteOf(section)
  return React.createElement('div', { className: 'edrv-svncommit-group', key: section.key },
    checkBoxEl(tri === 'all', onToggle, tri === 'part' ? '部分勾选，点击全选本分区' : '全选本分区', tri === 'part'),
    React.createElement('span', { className: 'edrv-svncommit-gname', title: section.label }, section.label),
    note ? React.createElement('span', { className: 'edrv-svncommit-gnote', title: '该分区默认不勾选；需要提交时逐条勾上' }, note) : null,
    React.createElement('span', { className: 'edrv-svncommit-gcount' }, section.entries.length + ' 项'))
}

/**
 * 单条待提交文件（勾选 / 状态字母 / 路径）。
 * @author ddj 2026年11月15号
 * @param entry 变更条目 @param checked 是否勾选 @param onToggle 切换
 * @returns 行元素
 */
function rowEl(entry, checked, onToggle) {
  const tone = SVN_STATUS_TONE[entry.status] ?? 'plain'
  return React.createElement('div', { className: 'edrv-svncommit-row', role: 'row', key: entry.path },
    React.createElement('span', { className: 'edrv-svncommit-pick', role: 'cell' }, checkBoxEl(checked, onToggle, entry.path)),
    React.createElement('span', {
      className: 'edrv-svn-ch edrv-svn-ch-' + tone,
      role: 'cell',
      title: SVN_STATUS_LABEL[entry.status] ?? entry.status,
    }, SVN_STATUS_LETTER[entry.status] ?? '?'),
    React.createElement('span', { className: 'edrv-svncommit-path', role: 'cell', title: entry.path }, entry.path))
}

/**
 * 勾选表格：列头固定，分组头与行在同一个滚动区里。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 表格元素
 */
function tableEl(s) {
  if (!s.sections.length) {
    return React.createElement('div', { className: 'edrv-svncommit-table' },
      React.createElement('div', { className: 'edrv-svncommit-empty' }, s.plan ? '没有可提交的变更' : '正在读取变更清单…'))
  }

  const body = []
  for (const section of s.sections) {
    body.push(sectionHeadEl(section, groupTriStateOf(section, s.checked), () => s.toggleSection(section)))
    for (const entry of section.entries) {
      body.push(rowEl(entry, s.checked.has(entry.path), () => s.toggle(entry.path)))
    }
  }
  return React.createElement('div', { className: 'edrv-svncommit-table' },
    React.createElement('div', { className: 'edrv-svncommit-cols' },
      React.createElement('span', null, '勾选'),
      React.createElement('span', null, '状态'),
      React.createElement('span', null, '路径')),
    React.createElement('div', { className: 'edrv-svncommit-list', role: 'table', 'aria-label': '待提交文件清单' }, ...body))
}

/**
 * 工具带：最近信息 / AI 风格 / AI 生成 / 保持锁定 / 已选计数。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 工具带元素
 */
function barEl(s) {
  const recent = s.plan?.recent?.length
    ? React.createElement('select', {
        className: 'edrv-svn-act edrv-svncommit-ctl',
        defaultValue: '',
        disabled: s.busy,
        title: '最近提交信息（选择后填入信息框）',
        onChange: (event) => {
          const index = Number(event.target.value)
          if (Number.isInteger(index) && index >= 0) s.setMessage(s.plan.recent[index] ?? '')
          event.target.value = ''
        },
      },
        React.createElement('option', { value: '' }, '最近信息…'),
        ...s.plan.recent.map((item, index) => React.createElement('option', {
          key: 'recent-' + index,
          value: String(index),
        }, item.split('\n')[0].slice(0, 60))))
    : null

  return React.createElement('div', { className: 'edrv-svncommit-bar' },
    recent,
    React.createElement('select', {
      className: 'edrv-svn-act edrv-svncommit-ctl',
      value: s.style,
      disabled: s.busy || s.aiBusy,
      title: 'AI 提交信息风格',
      onChange: (event) => s.setStyle(event.target.value),
    }, ...Object.keys(AI_COMMIT_STYLE_LABEL).map((key) => React.createElement('option', { key, value: key }, AI_COMMIT_STYLE_LABEL[key]))),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-svn-act edrv-svncommit-ctl',
      title: 'AI 只分析已勾选文件，产出提交信息草稿（不会自动提交）',
      disabled: s.aiBusy || s.busy || !s.paths.length,
      onClick: s.generate,
    }, '✨ AI 生成提交信息'),
    React.createElement('label', { className: 'edrv-svn-check', title: '提交后保留锁定（--no-unlock）' },
      React.createElement('input', {
        className: 'edrv-svncommit-cb',
        type: 'checkbox',
        checked: s.keepLocks,
        disabled: s.busy,
        onChange: () => s.setKeepLocks(!s.keepLocks),
      }),
      ' 保持锁定'),
    React.createElement('span', { className: 'edrv-svncommit-badge', title: '已勾选 / 清单内全部文件' },
      '已选 ' + s.stats.picked + ' / ' + s.stats.total))
}

/**
 * 提交信息编排区：标签行（首行计数 / 就地错误）+ 文本框。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 编排区元素
 */
function composeEl(s) {
  const error = s.message.trim() ? s.messageError : null
  return React.createElement('div', { className: 'edrv-svncommit-compose' },
    React.createElement('div', { className: 'edrv-svncommit-composehead' },
      React.createElement('span', { className: 'edrv-svncommit-label' }, '提交信息'),
      React.createElement('span', { className: 'edrv-svncommit-hint' }, commitHintOf(s.message)),
      error ? React.createElement('span', { className: 'edrv-svncommit-error' }, error) : null),
    React.createElement('textarea', {
      className: 'edrv-svncommit-msg',
      value: s.message,
      rows: 4,
      spellCheck: false,
      placeholder: '首行是提交标题，例如：修复删除道具后背包不刷新。空一行可写正文。',
      onChange: (event) => s.setMessage(event.target.value),
    }))
}

/**
 * 提交结果回显（新版本号 / 逐文件动作 / 跳过 / 冲突）。
 * @author ddj 2026年11月15号
 * @param result 提交结果
 * @returns 结果元素；无结果返回 null
 */
function resultEl(result) {
  if (!result) return null
  const lines = commitResultLinesOf(result)
  return React.createElement('div', { className: 'edrv-svncommit-result' + (result.revision !== undefined ? ' is-ok' : '') },
    ...lines.map((line, index) => React.createElement('div', { key: 'r-' + index }, line)))
}

/**
 * 遥测行：错误 / 截断告警 / AI 状态与模型。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 遥测元素
 */
function telemetryEl(s) {
  const error = s.failed || s.loadError
  const aiText = s.ai.phase === 'running' ? 'AI 生成中…' : 'AI：' + s.ai.note
  return React.createElement('div', { className: 'edrv-svncommit-telemetry', role: 'status' },
    error ? React.createElement('span', { className: 'edrv-svncommit-error' }, error) : null,
    s.plan?.truncated
      ? React.createElement('span', { className: 'edrv-svncommit-warn', title: '变更清单被截断，可能未列出全部变更；请缩小范围或先用命令行确认' }, '清单已截断，可能未列出全部变更')
      : null,
    React.createElement('span', { className: 'edrv-svncommit-ai' }, aiText),
    s.ai.model ? React.createElement('span', { className: 'edrv-svncommit-ai', title: s.ai.model }, s.ai.model) : null)
}

/**
 * 页脚：计数 + 取消 + 主操作（提交按钮自带数量）。
 * @author ddj 2026年11月15号
 * @param s 视图状态
 * @returns 页脚元素
 */
function footEl(s) {
  return React.createElement('div', { className: 'edrv-svncommit-foot' },
    React.createElement('span', { className: 'edrv-svncommit-counts' }, s.paths.length ? statsTextOf(s.stats) : '未勾选任何文件'),
    React.createElement('button', { type: 'button', className: 'edrv-svn-act', disabled: s.busy, title: '取消（不提交）', onClick: s.onClose }, '取消'),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-svn-act edrv-svncommit-primary',
      title: s.messageError ?? '提交已勾选文件',
      disabled: s.busy || Boolean(s.messageError) || !s.paths.length,
      onClick: s.submit,
    }, s.busy ? '提交中…' : '提交（' + s.paths.length + '）'))
}

/**
 * 读取提交计划与勾选态（seeded 时不再覆盖已有勾选，逐组提交预填优先）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @param seed 预填（路径 + 信息）
 * @returns 计划、分区、勾选集合与提交信息
 */
function useCommitLoad(sessionId, seed) {
  const [plan, setPlan] = React.useState(null)
  const [loadError, setLoadError] = React.useState('')
  const [sections, setSections] = React.useState([])
  const [checked, setChecked] = React.useState(() => new Set(seed?.paths ?? []))
  const [message, setMessage] = React.useState(() => seed?.message ?? '')
  const seeded = React.useRef(Boolean(seed?.paths?.length))

  React.useEffect(() => {
    let alive = true
    void svnCommitPlan(sessionId).then((outcome) => {
      if (!alive) return
      if (!outcome.ok || !outcome.plan) { setLoadError(outcome.message); return }

      setPlan(outcome.plan)
      const next = commitSectionsOf(outcome.plan.entries)
      setSections(next)
      if (!seeded.current) setChecked(defaultCheckedOf(next))
      if (!seeded.current && !message && outcome.plan.recent?.length) setMessage(outcome.plan.recent[0])
    })
    return () => { alive = false }
  }, [sessionId])

  return { plan, loadError, sections, checked, setChecked, message, setMessage }
}

/**
 * 提交对话框的写动作：AI 生成提交信息与提交本体（失败零重试）。
 * @author ddj 2026年11月15号
 * @param ctx 会话、勾选范围与提交口径
 * @returns 生成/提交动作及其状态
 */
function useCommitWrite(ctx) {
  const { sessionId, paths, sections, checked, setChecked, message, messageError, keepLocks, style, setMessage, notify, onCommitted } = ctx
  const [ai, setAi] = React.useState(AI_COMMIT_IDLE)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState(null)
  const [failed, setFailed] = React.useState('')
  const aiBusy = ai.phase === 'running'

  /**
   * AI 生成提交信息（只分析已勾选文件）。
   * @author ddj 2026年11月15号
   */
  const generate = () => {
    if (aiBusy || busy) return
    setAi({ phase: 'running', note: '生成中…' })
    void runAiCommit(sessionId, paths, style).then((outcome) => {
      setAi(outcome.state)
      if (outcome.text) setMessage(outcome.text)
      else if (outcome.state.error) setFailed(outcome.state.error)
    })
  }

  /**
   * 提交（单次确认；失败零重试）。
   * @author ddj 2026年11月15号
   */
  const submit = () => {
    if (busy || messageError || !paths.length) return
    const ok = typeof window === 'undefined' ? false : window.confirm(
      '确认提交以下 ' + paths.length + ' 个文件？\n提交后无法用 SVN 撤销（只能反向合并或再提交修复）。'
      + (hasUnversionedOf(sections, checked) ? '\n\n注意：未版本控制文件将先被 svn add 再提交。' : ''),
    )
    if (!ok) return

    setBusy(true)
    setFailed('')
    void svnCommitNow(sessionId, { paths, message, keepLocks }).then((outcome) => {
      if (!outcome.ok || !outcome.result) { setFailed(outcome.message); notify?.(outcome.message); return }

      setResult(outcome.result)
      notify?.(outcome.message)
      if (outcome.result.revision !== undefined) {
        setChecked(new Set())
        onCommitted?.(outcome.result)
      }
    }).finally(() => setBusy(false))
  }

  return { ai, aiBusy, busy, result, failed, generate, submit }
}

/**
 * 提交对话框的全部状态与动作（渲染在下面的 builder 里按同一份视图取值）。
 * @author ddj 2026年11月15号
 * @param sessionId 会话 id
 * @param seed 预填（路径 + 信息；来自 AI 逐组提交）
 * @param notify 状态栏反馈
 * @param onCommitted 提交成功回调（刷新变更清单）
 * @returns 视图状态
 */
function useCommitState(sessionId, seed, notify, onCommitted) {
  const { plan, loadError, sections, checked, setChecked, message, setMessage } = useCommitLoad(sessionId, seed)
  const [keepLocks, setKeepLocks] = React.useState(false)
  const [style, setStyle] = React.useState('plain')
  const paths = React.useMemo(() => [...checked], [checked])
  const stats = React.useMemo(() => commitStatsOf(sections, checked), [sections, checked])
  const messageError = commitMessageErrorOf(message)
  const write = useCommitWrite({
    sessionId, paths, sections, checked, setChecked, message, messageError, keepLocks, style, setMessage, notify, onCommitted,
  })

  /**
   * 单条勾选切换。
   * @author ddj 2026年11月15号
   * @param path 条目路径
   */
  const toggle = (path) => {
    const next = new Set(checked)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setChecked(next)
  }

  /**
   * 分区全选 / 全不选（半选时先全选）。
   * @author ddj 2026年11月15号
   * @param section 分区
   */
  const toggleSection = (section) => {
    const next = new Set(checked)
    const all = section.entries.every((entry) => next.has(entry.path))
    for (const entry of section.entries) {
      if (all) next.delete(entry.path)
      else next.add(entry.path)
    }
    setChecked(next)
  }

  return {
    plan, loadError, sections, checked, message, setMessage, keepLocks, setKeepLocks, style, setStyle,
    paths, stats, messageError, toggle, toggleSection,
    ai: write.ai, aiBusy: write.aiBusy, busy: write.busy, result: write.result, failed: write.failed,
    generate: write.generate, submit: write.submit,
  }
}

/**
 * 提交对话框。
 * @author ddj 2026年11月15号
 * @param props.sessionId 会话 id
 * @param props.seed 预填（路径 + 信息；来自 AI 逐组提交）
 * @param props.onClose 关闭回调
 * @param props.onCommitted 提交成功回调（刷新变更清单）
 * @param props.notify 状态栏反馈
 * @returns 浮窗元素
 */
export function SvnCommitDialog(props) {
  const { sessionId, seed, onClose, onCommitted, notify } = props
  const s = useCommitState(sessionId, seed, notify, onCommitted)
  const view = { ...s, onClose }
  return React.createElement(FloatingWindow, {
    title: 'SVN 提交',
    dialogClass: 'edrv-svncommit-dialog',
    width: 880,
    height: 680,
    // 提交进行中禁止 Esc 关闭：关窗会丢掉 onCommitted 的成功回填与清单刷新。
    closeOnEsc: !s.busy,
    onClose,
    actions: React.createElement('button', {
      type: 'button',
      className: 'edrv-svncommit-close',
      title: s.busy ? '提交进行中；请等待结果' : '关闭（不提交）',
      'aria-label': '关闭提交窗口',
      disabled: s.busy,
      onClick: onClose,
    }, '✕'),
  },
    barEl(view),
    tableEl(view),
    composeEl(view),
    resultEl(s.result),
    telemetryEl(view),
    footEl(view))
}

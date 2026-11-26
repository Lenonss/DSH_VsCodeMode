/**
 * dsh-vscode-mode client — 测试验收单页签：汇总条 + 工具栏 + 沙箱 iframe + 建单引导。
 *
 * 页面内容由插件用数据渲染（`shared/testCheckHtml.ts`），不要求模型写 HTML：
 * 每次轮询拿到派生视图，只有数据指纹变了才换 iframe 的 `srcDoc`，避免每秒重绘闪烁。
 * 没有 `items.json` 时这里给建单引导与五语言上报片段；工具栏还提供「手动上报」小表单。
 * @author ddj 2026年11月25号
 */
import React from 'react'
import { log } from '../log.js'
import { rpc } from '../rpc.js'
import { itemsTemplateOf, renderSheetHtml } from '../../shared/testCheckHtml.js'
import { reportSnippets, snippetsMarkdown } from '../../shared/testCheckSnippets.js'
import {
  TEST_CHECK_POLL_MS,
  TEST_CHECK_STATUSES,
  type TestCheckItemView,
  type TestCheckView,
} from '../../shared/testCheck.js'

//region 结构面

/** 面板输入（由 EditorView 从验收单页签装配）。 */
export interface TestCheckPanelProps {
  /** 当前会话。 */
  sessionId?: string
  /** 工作区（只用于展示，实际路径由 host 解析）。 */
  cwd?: string
  /** 单子 id。 */
  id?: string
  /** 页签标题。 */
  title?: string
}

/** 状态中文名（手动上报的下拉）。 */
const STATUS_LABEL: Record<string, string> = {
  pass: '通过',
  fail: '失败',
  blocked: '阻塞',
  skip: '跳过',
}

//endregion

//region 小工具

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

/**
 * 把文本写进剪贴板（浏览器不支持时返回 false，由调用方提示）。
 * @author ddj 2026年11月25号
 * @param text 文本
 * @returns 是否写入成功
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 剪贴板被拒：交给调用方提示 */
  }
  return false
}

/**
 * 把分组摊平成条目清单（手动上报的下拉用）。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @returns 条目清单
 */
function flatItems(view: TestCheckView | null): TestCheckItemView[] {
  if (!view) return []
  return view.groups.flatMap((group) => group.items)
}

//endregion

//region 页面块

/**
 * 汇总一句（工具栏用）。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @returns 一行文案；没有视图时为空串
 */
function tallyOf(view: TestCheckView | null): string {
  if (!view) return ''
  const c = view.counts
  return '通过 ' + String(c.pass) + '/' + String(c.total)
    + ' · 失败 ' + String(c.fail)
    + ' · 阻塞 ' + String(c.blocked)
    + ' · 需复验 ' + String(c.stale)
    + ' · 未验 ' + String(c.todo)
}

/**
 * 建单引导：模板 + 五语言片段 + 说明（缺定义或有错时显示）。
 * @author ddj 2026年11月25号
 * @param props 单子 id 与复制回调
 * @returns 引导元素
 */
function guideOf(props: { id: string; view: TestCheckView | null; onCopy: (text: string) => void }) {
  const { id, view, onCopy } = props
  const template = itemsTemplateOf(id)
  const snippets = snippetsMarkdown(id, view?.title ?? '')
  const missing = view === null || view.state === 'missing'
  return React.createElement('div', { className: 'edrv-testcheck-guide' },
    React.createElement('h3', null, missing ? '还没有验收单' : 'items.json 校验没通过'),
    missing
      ? React.createElement('p', null, '在 ', React.createElement('code', null, '.dsh/test-check/' + id + '/items.json'),
        ' 写这份定义；也可以把下面这段发给 AI 让它建单。')
      : React.createElement('ul', { className: 'edrv-testcheck-errors' },
        String(view?.error ?? '').split('\n').filter(Boolean).map((line, index) =>
          React.createElement('li', { key: String(index) }, line))),
    React.createElement('p', null, 'ID 形如 ', React.createElement('code', null, 'settings.claude-style.004'),
      '（<scope>.<area>.<3 位序号>），全局唯一、只增不改号；删条目把 ', React.createElement('code', null, 'retired'), ' 置 true。'),
    React.createElement('pre', { className: 'edrv-testcheck-pre' }, template),
    React.createElement('div', { className: 'edrv-testcheck-actions' },
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: () => onCopy(template) }, '复制 items.json 模板'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: () => onCopy(snippets) }, '复制上报片段')),
    React.createElement('p', null, '结果不用写进定义：每次验证往 ',
      React.createElement('code', null, '.dsh/test-check/' + id + '/events/'), ' 写一个 JSON 文件；必填只有 ',
      React.createElement('code', null, 'item'), ' 与 ', React.createElement('code', null, 'status'),
      '，没有 ', React.createElement('code', null, 'evidence'), ' 的 pass 不算通过。'),
    React.createElement('details', { className: 'edrv-testcheck-details' },
      React.createElement('summary', null, '各语言上报片段（C# / Lua / Python / bash / Node）'),
      reportSnippets(id).map((snippet) => React.createElement('div', { key: snippet.id, className: 'edrv-testcheck-snippet' },
        React.createElement('div', { className: 'edrv-testcheck-snippet-head' },
          React.createElement('span', null, snippet.label),
          React.createElement('button', {
            className: 'edrv-pill edrv-pill-ghost',
            onClick: () => onCopy(snippet.code),
          }, '复制')),
        React.createElement('pre', { className: 'edrv-testcheck-pre' }, snippet.code)))))
}

/**
 * 手动上报小表单（页面不放决策控件，勾选在页签这一侧做）。
 * @author ddj 2026年11月25号
 * @param props 条目清单、忙碌状态与提交回调
 * @returns 表单元素
 */
function manualFormOf(props: {
  items: TestCheckItemView[]
  busy: boolean
  onSubmit: (item: string, status: string, summary: string) => void
}) {
  const [item, setItem] = React.useState('')
  const [status, setStatus] = React.useState('pass')
  const [summary, setSummary] = React.useState('')
  const current = item || props.items[0]?.id || ''
  return React.createElement('div', { className: 'edrv-testcheck-manual' },
    React.createElement('select', { value: current, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setItem(event.target.value) },
      props.items.map((row) => React.createElement('option', { key: row.id, value: row.id },
        row.id + ' · ' + row.title))),
    React.createElement('select', { value: status, onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setStatus(event.target.value) },
      TEST_CHECK_STATUSES.map((value) => React.createElement('option', { key: value, value }, STATUS_LABEL[value] ?? value))),
    React.createElement('input', {
      className: 'edrv-testcheck-input',
      placeholder: '证据一句话：测试名 / 命令 / 日志路径',
      value: summary,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSummary(event.target.value),
    }),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-accent',
      disabled: props.busy || !current || !summary.trim(),
      onClick: () => props.onSubmit(current, status, summary.trim()),
    }, '上报'))
}

//endregion

//region 组件

/**
 * 验收单页签。
 * @author ddj 2026年11月25号
 * @param props 会话、工作区、单子 id 与标题
 * @returns 页签正文
 */
export function TestCheckPanel(props: TestCheckPanelProps) {
  const sessionId = String(props.sessionId ?? '')
  const sheetId = String(props.id ?? 'check')
  const [view, setView] = React.useState<TestCheckView | null>(null)
  const [error, setError] = React.useState('')
  const [notice, setNotice] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [manual, setManual] = React.useState(false)
  const alive = React.useRef(true)

  /**
   * 读一次视图（轮询与按钮共用）。
   * @author ddj 2026年11月25号
   * @param force 是否跳过 host 缓存
   */
  async function loadView(force = false): Promise<void> {
    try {
      const raw = await rpc('edrv.testCheck.get', { sessionId, id: sheetId, force })
      if (!alive.current) return
      if (raw.ok) {
        setView(raw.view)
        setError('')
      } else {
        setError(String(raw.error ?? '读取失败'))
      }
    } catch (cause) {
      if (alive.current) setError(messageOf(cause))
      log.warn('验收单读取失败：' + messageOf(cause))
    }
  }

  React.useEffect(() => {
    alive.current = true
    void loadView(true)
    const timer = window.setInterval(() => { void loadView(false) }, TEST_CHECK_POLL_MS)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sheetId])

  /** 复制并提示（失败时说清原因，不静默）。 */
  async function copyAndNotify(text: string): Promise<void> {
    const ok = await copyText(text)
    setNotice(ok ? '已复制到剪贴板' : '复制失败：浏览器拒绝了剪贴板写入，请手动选中复制')
  }

  /** 导出快照到 docs/acceptance-<id>.html。 */
  async function exportSheet(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const raw = await rpc('edrv.testCheck.snapshot', { sessionId, id: sheetId })
      setNotice(raw.ok ? '快照已导出：' + raw.path : '导出失败：' + String(raw.error ?? '未知原因'))
      if (raw.ok) setView(raw.view)
    } catch (cause) {
      setNotice('导出失败：' + messageOf(cause))
    }
    setBusy(false)
  }

  /**
   * 手动上报一条结果。
   * @author ddj 2026年11月25号
   * @param item 测试点 id
   * @param status pass / fail / blocked / skip
   * @param summary 证据
   */
  async function reportOne(item: string, status: string, summary: string): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const raw = await rpc('edrv.testCheck.report', {
        sessionId,
        id: sheetId,
        item,
        status: status as 'pass' | 'fail' | 'blocked' | 'skip',
        summary,
      })
      setNotice(raw.ok ? '已上报：' + item : '上报失败：' + String(raw.error ?? '未知原因'))
      if (raw.ok) setView(raw.view)
    } catch (cause) {
      setNotice('上报失败：' + messageOf(cause))
    }
    setBusy(false)
  }

  const html = React.useMemo(
    () => (view && view.state === 'ready' ? renderSheetHtml(view) : ''),
    // 只按数据指纹重算：轮询拿到同内容的视图时，iframe 不重绘。
    [view?.stamp, view?.state], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const items = flatItems(view)
  const ready = view?.state === 'ready'

  const toolbar = React.createElement('div', { className: 'edrv-testcheck-bar' },
    React.createElement('span', { className: 'edrv-testcheck-title', title: sheetId }, view?.title ?? props.title ?? sheetId),
    React.createElement('span', { className: 'edrv-testcheck-tally' }, tallyOf(view)),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost',
      disabled: busy || !ready,
      title: '打开手动上报：选条目、选状态、写一句证据',
      onClick: () => setManual((value) => !value),
    }, manual ? '收起上报' : '手动上报'),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost',
      disabled: busy || !ready,
      title: '导出 docs/acceptance-' + sheetId + '.html（单文件，脱离 DSH 也能打开）',
      onClick: () => { void exportSheet() },
    }, busy ? '导出中…' : '导出快照'),
    React.createElement('button', {
      className: 'edrv-pill edrv-pill-ghost',
      title: '立即重读（跳过 host 缓存）',
      onClick: () => { void loadView(true) },
    }, '⟳'))

  const noticeLine = notice ? React.createElement('div', { className: 'edrv-testcheck-notice' }, notice) : null
  const errorLine = error ? React.createElement('div', { className: 'edrv-testcheck-error', role: 'alert' }, error) : null

  let stage
  if (view === null || view.state !== 'ready') {
    stage = guideOf({ id: sheetId, view, onCopy: (text) => { void copyAndNotify(text) } })
  } else {
    stage = React.createElement(React.Fragment, null,
      view.ignored.length
        ? React.createElement('div', { className: 'edrv-testcheck-notice' },
            '已忽略 ' + String(view.ignored.length) + ' 个事件文件：' + view.ignored.slice(0, 3).map((row) => row.file + '（' + row.reason + '）').join('；'))
        : null,
      React.createElement('iframe', {
        className: 'edrv-testcheck-frame',
        title: view.title,
        sandbox: '',
        srcDoc: html,
      }))
  }

  return React.createElement('div', { className: 'edrv-testcheck', 'data-sheet-id': sheetId },
    toolbar,
    (manual && ready)
      ? manualFormOf({ items, busy, onSubmit: (item, status, summary) => { void reportOne(item, status, summary) } })
      : null,
    noticeLine,
    errorLine,
    stage)
}

//endregion

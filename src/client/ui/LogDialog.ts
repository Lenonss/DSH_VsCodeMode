// @ts-nocheck
/**
 * dsh-vscode-mode client — 诊断日志弹窗（居中弹窗形态，ModalShell 外壳）。
 *
 * 形态对齐 SvnLogDialog：单列日志区 + 头部工具栏 + 底部状态行。
 * 数据流：组件自取数据（edrv.dlog.list/read/clear/reveal），EditorView 只负责开与关；
 * 装载/动作集中在 useDlogData（单一数据资源），组件只留视图状态与渲染。
 * 级别过滤与文本搜索为**前端过滤**（日志文件 ≤512KB，整读后过滤，不回传服务端）。
 * 自动刷新：2s 轮询尾部读取（静默，不闪 busy）；开关「启用诊断日志」即改即生效
 * （client/rpc.ts 的 setDebugEnabled 写内存缓存 + localStorage，免刷新）。
 * 行格式（host debugLog 落盘）：`<ISO时间> [level] 文本`；旧格式无级别标记时 level 为空。
 * 作者 ddj 2026年09月17号
 */
import React from 'react'
import { ModalShell } from './ModalShell.js'
import { isDebug, rpc, setDebugEnabled } from '../rpc.js'

/** 弹窗宽度（日志行长可观，横向铺开；窄屏回落）。 */
const DIALOG_WIDTH = 'min(880px, calc(100vw - 40px))'
/** 自动刷新轮询间隔（毫秒）。 */
const AUTO_REFRESH_MS = 2000
/** 级别过滤档位（全部 + 四级别，与 LoggerLevel 对齐）。 */
const LEVEL_OPTIONS = ['all', 'debug', 'info', 'warn', 'error']
/** 级别 → 展示名（筛选下拉与行标签共用）。 */
const LEVEL_LABEL = { all: '全部', debug: '调试', info: '信息', warn: '警告', error: '错误' }

/**
 * 解析一行日志：`<ISO> [level] text`（旧格式无级别段 → level 为空串）。
 * @author ddj 2026年09月17号
 * @param line 原始行
 * @returns { at, level, text }（at 无法识别时为空串）
 */
export function parseLogLine(line) {
  const text = String(line ?? '')
  const matched = /^(\S+) (?:\[(debug|info|warn|error)\] )?([\s\S]*)$/.exec(text)
  if (!matched) return { at: '', level: '', text }
  const [, at, level, body] = matched
  return { at, level: level || '', text: body }
}

/**
 * 过滤日志行（级别 + 关键字；无级别旧行只在「全部」档显示）。
 * @author ddj 2026年09月17号
 * @param rows 已解析行数组
 * @param level 档位（'all' 或具体级别）
 * @param keyword 关键字（大小写不敏感；空串不过滤）
 * @returns 过滤后行
 */
export function filterRows(rows, level, keyword) {
  const key = String(keyword ?? '').trim().toLowerCase()
  return rows.filter((row) => {
    if (level !== 'all' && row.level !== level) return false
    if (!key) return true
    return (row.at + ' ' + row.text).toLowerCase().includes(key)
  })
}

/**
 * 字节数格式化（B / KB / MB，一位小数）。
 * @author ddj 2026年09月17号
 * @param bytes 字节数
 * @returns 展示文本
 */
export function formatBytes(bytes) {
  const n = Number(bytes ?? 0)
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * RPC 调用简包装：失败/网络异常统一回 null，错误文案取 error 字段。
 * @author ddj 2026年09月17号
 * @param sessionId 会话 id
 * @param method 方法名
 * @param args 参数
 * @returns 成功载荷或 null
 */
async function dlogRpc(sessionId, method, args) {
  try {
    const res = await rpc(method, { sessionId, ...args })
    return res.ok ? res : { ok: false, error: res.error }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/**
 * 诊断日志数据资源 hook：清单/尾部读取/清空/打开目录 + 自动刷新轮询。
 * 只做数据与装载动作，不含视图状态（级别/关键字/开关在组件侧）。
 * @author ddj 2026年09月17号
 * @param sessionId 会话 id
 * @param auto 是否自动刷新（2s 静默轮询尾部）
 * @returns 数据状态与动作（pick 切换文件；refresh 手动全量刷新）
 */
function useDlogData(sessionId, auto) {
  const [files, setFiles] = React.useState(null)
  const [current, setCurrent] = React.useState(null)
  const [picked, setPicked] = React.useState(null)
  const [read, setRead] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const busyRef = React.useRef(false)
  busyRef.current = busy

  /** 拉清单：首次取回后默认选中「本工作区」那份（不存在则选最近一份）。 */
  const loadList = async () => {
    const res = await dlogRpc(sessionId, 'edrv.dlog.list', {})
    if (!res.ok) { setError(res.error); return }
    setFiles(res.files)
    setCurrent(res.current)
    setPicked((prev) => prev ?? res.current ?? res.files[0]?.name ?? null)
  }

  /** 尾部读取指定文件（silent = 自动刷新静默模式，不闪 busy、不清旧内容）。 */
  const loadRead = async (name, silent) => {
    if (!name) { setRead(null); return }
    if (!silent) setBusy(true)
    const res = await dlogRpc(sessionId, 'edrv.dlog.read', { file: name })
    if (!res.ok) { setError(res.error); if (!silent) setRead(null) }
    else { setError(''); setRead(res) }
    if (!silent) setBusy(false)
  }

  // 首次进入：清单 + 默认文件；切换文件：重读
  React.useEffect(() => { void loadList() }, [sessionId])
  React.useEffect(() => { void loadRead(picked) }, [picked, sessionId])

  // 自动刷新：busy 中跳过本轮，避免与手动刷新打架
  React.useEffect(() => {
    if (!auto || !picked) return undefined
    const timer = setInterval(() => { if (!busyRef.current) void loadRead(picked, true) }, AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [auto, picked, sessionId])

  /** 手动刷新：清单 + 当前文件全量重拉。 */
  const refresh = async () => {
    await loadList()
    await loadRead(picked)
  }

  /** 清空当前日志文件后重读。 */
  const clear = async () => {
    if (!picked) return
    setBusy(true)
    const res = await dlogRpc(sessionId, 'edrv.dlog.clear', { file: picked })
    if (!res.ok) setError(res.error)
    else { setError(''); await loadRead(picked) }
    setBusy(false)
  }

  /** 打开日志根目录（OS 文件管理器）。 */
  const reveal = async () => {
    const res = await dlogRpc(sessionId, 'edrv.dlog.reveal', {})
    if (!res.ok) setError(res.error)
  }

  /** 切换查看的日志文件（清旧内容防闪烁）。 */
  const pick = (name) => { setPicked(name || null); setRead(null) }

  return { files, current, picked, read, busy, error, pick, refresh, clear, reveal }
}

/**
 * 级别 → 配色类名（error 红 / warn 黄 / info 蓝 / debug 灰 / 未知默认）。
 * @author ddj 2026年09月17号
 * @param level 行级别（可空）
 * @returns 类名后缀
 */
function toneClassOf(level) {
  return LEVEL_OPTIONS.includes(level) ? level : 'plain'
}

/**
 * 单行日志（时间 + 级别标签 + 文本；完整时间入 title）。
 * @author ddj 2026年09月17号
 * @param props.row 已解析行
 * @returns 行元素
 */
function LogRow(props) {
  const { row } = props
  return React.createElement('div', { className: 'edrv-dlog-row edrv-dlog-row-' + toneClassOf(row.level) },
    React.createElement('span', { className: 'edrv-dlog-at', title: row.at }, row.at ? row.at.slice(11, 19) : '--:--:--'),
    React.createElement('span', { className: 'edrv-dlog-lvl' }, row.level ? LEVEL_LABEL[row.level] : '·'),
    React.createElement('span', { className: 'edrv-dlog-text' }, row.text))
}

/**
 * 日志主体（滚动区；空态分「未加载 / 暂无日志 / 无匹配」三种）。
 * @author ddj 2026年09月17号
 * @param props.rows 过滤后行（null = 未加载）
 * @param props.busy 读取中
 * @param props.keyword 当前关键字
 * @param props.bodyRef 主体滚动容器 ref（自动滚到底）
 * @returns 主体元素
 */
function LogBody(props) {
  const { rows, busy, keyword, bodyRef } = props
  let inner
  if (rows === null) {
    inner = React.createElement('div', { className: 'edrv-tree-loading' }, busy ? '读取日志中…' : '尚未加载')
  } else if (!rows.length) {
    inner = React.createElement('div', { className: 'edrv-tree-loading' },
      keyword ? '无匹配行' : '暂无日志：开启下方「启用诊断日志」并触发一次差异渲染等操作后生成')
  } else {
    inner = rows.map((row, idx) => React.createElement(LogRow, { key: idx, row }))
  }
  return React.createElement('div', { className: 'edrv-dlog-scroll', ref: bodyRef }, inner)
}

/**
 * 头部工具栏（标题 + 文件选择 + 级别 + 搜索 + 动作按钮）。
 * @author ddj 2026年09月17号
 * @param props 见内部解构（files/picked/current/level/query/busy/auto 及回调）
 * @returns 头部元素
 */
function LogHead(props) {
  const { files, picked, current, level, query, busy, auto, onPick, onLevel, onQuery, onAuto, onRefresh, onCopy, onClear, onReveal, onClose } = props
  const options = (files || []).map((f) => React.createElement('option', {
    key: f.name, value: f.name,
  }, f.name + (f.name === current ? '（本工作区）' : '') + ' · ' + formatBytes(f.bytes)))
  return React.createElement('div', { className: 'edrv-dlog-head' },
    React.createElement('h3', { className: 'edrv-dlog-title' }, '诊断日志'),
    React.createElement('select', {
      className: 'edrv-dlog-file', value: picked ?? '', disabled: !(files && files.length),
      onChange: (event) => onPick(event.target.value),
    }, options.length ? options : React.createElement('option', { value: '' }, '（无日志文件）')),
    React.createElement('select', {
      className: 'edrv-dlog-level', value: level, onChange: (event) => onLevel(event.target.value),
    }, LEVEL_OPTIONS.map((lv) => React.createElement('option', { key: lv, value: lv }, LEVEL_LABEL[lv]))),
    React.createElement('input', {
      className: 'edrv-dlog-search', placeholder: '搜索日志文本', value: query,
      onChange: (event) => onQuery(event.target.value),
    }),
    React.createElement('label', { className: 'edrv-dlog-auto', title: '每 2 秒静默拉取一次尾部日志' },
      React.createElement('input', { type: 'checkbox', checked: auto, onChange: (event) => onAuto(event.target.checked) }),
      '自动刷新'),
    React.createElement('button', { className: 'edrv-svn-act', disabled: busy, title: '重新读取清单与日志', onClick: onRefresh }, busy ? '…' : '⟳'),
    React.createElement('button', { className: 'edrv-svn-act', title: '复制当前过滤后的日志内容', onClick: onCopy }, '复制'),
    React.createElement('button', { className: 'edrv-svn-act edrv-svn-act-danger', title: '清空当前日志文件', onClick: onClear }, '清空'),
    React.createElement('button', { className: 'edrv-svn-act', title: '在文件管理器中打开日志目录', onClick: onReveal }, '目录'),
    React.createElement('button', { className: 'edrv-svn-act', title: '关闭', onClick: onClose }, '✕'))
}

/**
 * 底部状态行（路径 + 统计 + 截头提示 + 诊断开关）。
 * @author ddj 2026年09月17号
 * @param props.read 读取结果（可 null）
 * @param props.total 过滤前总行数
 * @param props.shown 过滤后行数
 * @param props.enabled 诊断开关
 * @param props.copied 复制提示在途
 * @param props.onToggle 开关回调
 * @returns 底部元素
 */
function LogFoot(props) {
  const { read, total, shown, enabled, copied, onToggle } = props
  const stat = read
    ? '共 ' + total + ' 行' + (shown !== total ? '（过滤后 ' + shown + ' 行）' : '') + ' · ' + formatBytes(read.size) + (read.truncated ? ' · 已截头（仅保留尾部）' : '')
    : '未加载'
  return React.createElement('div', { className: 'edrv-dlog-foot' },
    React.createElement('span', { className: 'edrv-dlog-path', title: read?.path || '' }, read?.path || '—'),
    React.createElement('span', { className: 'edrv-dlog-stat' }, stat + (copied ? ' · 已复制到剪贴板' : '')),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('label', { className: 'edrv-dlog-switch', title: '开启后 client 诊断日志上报 host 落盘（立即生效，免刷新）' },
      React.createElement('input', { type: 'checkbox', checked: enabled, onChange: (event) => onToggle(event.target.checked) }),
      '启用诊断日志'))
}

/**
 * 诊断日志弹窗主体：数据经 useDlogData，组件只持视图状态与渲染。
 * @author ddj 2026年09月17号
 * @param props.sessionId 会话 id
 * @param props.onClose 关闭回调
 * @returns 弹窗元素
 */
export function LogDialog(props) {
  const { sessionId, onClose } = props
  const [level, setLevel] = React.useState('all')
  const [query, setQuery] = React.useState('')
  const [auto, setAuto] = React.useState(false)
  const [enabled, setEnabledState] = React.useState(isDebug())
  const [copied, setCopied] = React.useState(false)
  const bodyRef = React.useRef(null)
  const data = useDlogData(sessionId, auto)

  // 新内容到底：日志语义「最新在底部」，每次 read 更新后滚到底
  React.useEffect(() => {
    const host = bodyRef.current
    if (host) host.scrollTop = host.scrollHeight
  }, [data.read])

  // 复制提示自动消退
  React.useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const allRows = React.useMemo(() => {
    if (!data.read?.content) return []
    return data.read.content.split('\n').filter((line) => line.trim()).map(parseLogLine)
  }, [data.read])
  const rows = React.useMemo(() => filterRows(allRows, level, query), [allRows, level, query])

  /** 复制当前过滤后的日志行（还原级别标记，便于贴给他人排查）。 */
  const copy = async () => {
    if (!rows.length) return
    try {
      await navigator.clipboard.writeText(rows.map((r) => (r.at ? r.at + ' ' : '') + (r.level ? '[' + r.level + '] ' : '') + r.text).join('\n'))
      setCopied(true)
    } catch (e) { /* 剪贴板不可用：状态行已提示复制在途，此处静默 */ }
  }
  const toggleEnabled = (next) => {
    setDebugEnabled(next)
    setEnabledState(next)
  }

  const errLine = data.error ? React.createElement('div', { className: 'edrv-dlog-error' }, String(data.error)) : null
  return React.createElement(ModalShell, {
    dialogClass: 'edrv-dlog-dialog',
    width: DIALOG_WIDTH,
    onClose,
  },
    React.createElement(LogHead, {
      files: data.files, picked: data.picked, current: data.current, level, query, busy: data.busy, auto,
      onPick: data.pick, onLevel: setLevel, onQuery: setQuery, onAuto: setAuto,
      onRefresh: data.refresh, onCopy: copy, onClear: data.clear, onReveal: data.reveal, onClose,
    }),
    errLine,
    React.createElement(LogBody, { rows, busy: data.busy, keyword: query.trim(), bodyRef }),
    React.createElement(LogFoot, { read: data.read, total: allRows.length, shown: rows.length, enabled, copied, onToggle: toggleEnabled }))
}

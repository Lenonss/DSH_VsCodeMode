// @ts-nocheck
/**
 * dsh-vscode-mode client — SVN 日志统计窗（P1-10，对应 TortoiseSVN Statistics 三页 D23）。
 *
 * 纯前端聚合当前显示的条目（不发额外 RPC）；统计口径 = 传入条目集合，
 * 即官方「统计覆盖期间 = Log 对话框显示的期间」。内容对齐官方可达子集：
 * 概要（期间与修订数）· Commits by author（横条 + 饼图 + Others 阈值）·
 * Commits by date（按日柱状，normal/stacked）+ Authors case insensitive 开关（默认关，与官方一致）。
 * Esc 交由底层日志弹窗处理（嵌套 ModalShell 同键会连关两层，故统计窗只走 ✕/遮罩关闭）。
 * 作者 ddj 2026年09月17号
 */
import React from 'react'
import { ModalShell } from './ModalShell.js'

/** stacked 时间线展开的作者上限（其余并入「其他」）。 */
const STACK_TOP = 5
/** 作者配色（按占比序循环；饼图与 stacked 分段共用）。 */
const TONES = ['#4e9a06', '#3465a4', '#c17d11', '#75507b', '#cc0000', '#5c3566', '#ce5c00', '#888a85']

/**
 * 日期 → 本地日（YYYY-MM-DD；解析失败返回空串，该条不参与期间与按日统计）。
 * @author ddj 2026年09月17号
 * @param date ISO8601 字符串
 * @returns 日文本
 */
function dayTextOf(date) {
  const at = new Date(String(date ?? ''))
  if (Number.isNaN(at.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return at.getFullYear() + '-' + pad(at.getMonth() + 1) + '-' + pad(at.getDate())
}

/**
 * 聚合统计（P1-10 纯函数，供组件与单测共用）。
 * @author ddj 2026年09月17号
 * @param entries 日志条目
 * @param opts caseInsensitive 作者归并开关（默认 false = 区分大小写，与官方一致）
 * @returns total 总数 / minDate·maxDate 期间 / authors 作者分布（降序）/ days 按日分布（升序）
 */
export function svnLogStatsOf(entries, opts = {}) {
  const ci = opts.caseInsensitive === true
  const list = Array.isArray(entries) ? entries : []
  const authors = new Map()
  const days = new Map()
  let min = ''
  let max = ''
  for (const entry of list) {
    const name = entry.author || '（无作者）'
    const key = ci ? name.toLowerCase() : name
    const a = authors.get(key) || { name, count: 0 }
    a.count++
    authors.set(key, a)
    const day = dayTextOf(entry.date)
    if (!day) continue
    if (!min || day < min) min = day
    if (!max || day > max) max = day
    const d = days.get(day) || { count: 0, byKey: new Map() }
    d.count++
    d.byKey.set(key, (d.byKey.get(key) || 0) + 1)
    days.set(day, d)
  }
  const authorList = [...authors.entries()]
    .map(([key, a]) => ({ key, name: a.name, count: a.count }))
    .sort((x, y) => y.count - x.count || x.key.localeCompare(y.key))
  const dayList = [...days.entries()]
    .map(([day, d]) => ({ day, count: d.count, byKey: d.byKey }))
    .sort((x, y) => x.day.localeCompare(y.day))
  return { total: list.length, minDate: min, maxDate: max, authors: authorList, days: dayList }
}

/**
 * 作者分布按 Others 阈值拆分：占比 ≥ 阈值% 的保留，其余并入「其他」。
 * @author ddj 2026年09月17号
 * @param authorList 作者分布（降序）
 * @param othersPct 阈值（占总数百分比，0 = 不合并）
 * @param total 总修订数
 * @returns main 保留项（附 tone 下标）/ otherCount 其他合计
 */
function splitAuthors(authorList, othersPct, total) {
  const main = []
  let otherCount = 0
  for (const a of authorList) {
    if (total > 0 && (a.count / total) * 100 < othersPct) { otherCount += a.count; continue }
    main.push(a)
  }
  return { main, otherCount }
}

/**
 * 概要行（总数 / 期间 / 作者数）。
 * @author ddj 2026年09月17号
 * @param props.stats 聚合结果
 * @returns 元素
 */
function StatsHead(props) {
  const { stats } = props
  const period = stats.minDate ? stats.minDate + ' ~ ' + stats.maxDate : '—'
  return React.createElement('div', { className: 'edrv-svnlog-stat-line' },
    React.createElement('span', null, '修订总数：' + stats.total),
    React.createElement('span', null, '期间：' + period),
    React.createElement('span', null, '作者数：' + stats.authors.length))
}

/**
 * 作者横条（占比条形，Other 合并项垫底）。
 * @author ddj 2026年09月17号
 * @param props.stats 聚合结果
 * @param props.othersPct Others 阈值百分比
 * @returns 元素
 */
function AuthorBars(props) {
  const { stats, othersPct } = props
  if (!stats.total) return null
  const { main, otherCount } = splitAuthors(stats.authors, othersPct, stats.total)
  const row = (a, tone, name) => React.createElement('div', { key: a.key || name, className: 'edrv-svnlog-stat-row' },
    React.createElement('span', { className: 'edrv-svnlog-stat-name', title: name }, name),
    React.createElement('span', { className: 'edrv-svnlog-stat-barwrap' },
      React.createElement('span', {
        className: 'edrv-svnlog-stat-bar', style: { width: ((a.count / stats.total) * 100) + '%', background: tone },
      })),
    React.createElement('span', { className: 'edrv-svnlog-stat-count' }, String(a.count)))
  const rows = main.map((a, i) => row(a, TONES[i % TONES.length], a.name))
  if (otherCount > 0) rows.push(row({ key: '__others__', count: otherCount }, '#888a85', '其他'))
  return React.createElement('div', { className: 'edrv-svnlog-stat-hist' }, rows)
}

/**
 * 作者饼图（conic-gradient；份额低于阈值的并入「其他」灰块）。
 * @author ddj 2026年09月17号
 * @param props.stats 聚合结果
 * @param props.othersPct Others 阈值百分比
 * @returns 元素
 */
function AuthorPie(props) {
  const { stats, othersPct } = props
  if (!stats.total) return null
  const { main, otherCount } = splitAuthors(stats.authors, othersPct, stats.total)
  const stops = []
  let at = 0
  const seg = (share, tone) => {
    const from = (at / stats.total) * 360
    at += share
    const to = (at / stats.total) * 360
    stops.push(tone + ' ' + from.toFixed(2) + 'deg ' + to.toFixed(2) + 'deg')
  }
  for (const [i, a] of main.entries()) seg(a.count, TONES[i % TONES.length])
  if (otherCount > 0) seg(otherCount, '#888a85')
  return React.createElement('div', {
    className: 'edrv-svnlog-stat-pie',
    style: { background: 'conic-gradient(' + stops.join(',') + ')' },
    title: main.map((a) => a.name + ' ' + a.count).join('，') + (otherCount ? '，其他 ' + otherCount : ''),
  })
}

/**
 * 按日柱状（normal = 每日总量；stacked = 按作者分段，超出上限并入「其他」）。
 * @author ddj 2026年09月17号
 * @param props.stats 聚合结果
 * @param props.stacked 是否按作者分段
 * @returns 元素
 */
function DayBars(props) {
  const { stats, stacked } = props
  if (!stats.days.length) return null
  const max = Math.max(1, ...stats.days.map((d) => d.count))
  const topKeys = stats.authors.slice(0, STACK_TOP).map((a) => a.key)
  const toneOf = (key) => {
    const at = topKeys.indexOf(key)
    return at >= 0 ? TONES[at % TONES.length] : '#888a85'
  }
  const column = (d) => {
    const segs = []
    if (stacked) {
      const rest = { count: 0 }
      for (const [key, count] of d.byKey) {
        if (!topKeys.includes(key)) { rest.count += count; continue }
        segs.push({ key, count })
      }
      if (rest.count > 0) segs.push({ key: '__others__', count: rest.count })
    } else {
      segs.push({ key: '__all__', count: d.count })
    }
    return React.createElement('div', {
      key: d.day, className: 'edrv-svnlog-stat-day',
      title: d.day + '：' + d.count + ' 条',
    },
      segs.map((s) => React.createElement('span', {
        key: s.key, className: 'edrv-svnlog-stat-seg',
        style: { height: ((s.count / max) * 100) + '%', background: stacked ? toneOf(s.key) : '#3465a4' },
      })))
  }
  return React.createElement('div', { className: 'edrv-svnlog-stat-days' }, stats.days.map(column))
}

/**
 * 统计窗（嵌套在日志弹窗之上；z-index 192 落在既有阶梯内）。
 * @author ddj 2026年09月17号
 * @param props.entries 参与统计的条目（当前显示列表）
 * @param props.onClose 关闭回调
 * @returns 弹窗元素
 */
export function SvnLogStats(props) {
  const { entries, onClose } = props
  const [ci, setCi] = React.useState(false)
  const [othersPct, setOthersPct] = React.useState(0)
  const [stacked, setStacked] = React.useState(false)
  const stats = React.useMemo(() => svnLogStatsOf(entries, { caseInsensitive: ci }), [entries, ci])
  return React.createElement(ModalShell, {
    dialogClass: 'edrv-svnlog-stats',
    width: 'min(680px, calc(100vw - 40px))',
    zIndex: 192,
    closeOnEsc: false,
    onClose,
  },
    React.createElement('div', { className: 'edrv-svnlog-stats-head' },
      React.createElement('h3', { className: 'edrv-svnlog-title' }, 'Statistics'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-svn-act', title: '关闭', onClick: onClose }, '✕')),
    (stats.total === 0
      ? React.createElement('div', { className: 'edrv-svnlog-stats-body' },
          React.createElement('div', { className: 'edrv-tree-loading' }, '暂无可统计的条目'))
      : React.createElement('div', { className: 'edrv-svnlog-stats-body' },
          React.createElement(StatsHead, { stats }),
          React.createElement('div', { className: 'edrv-svnlog-stat-block' },
            React.createElement('div', { className: 'edrv-svnlog-stat-label' },
              'Commits by author',
              React.createElement('label', { className: 'edrv-svnlog-check', title: '作者名不区分大小写归并统计' },
                React.createElement('input', { type: 'checkbox', checked: ci, onChange: (e) => setCi(e.target.checked) }),
                'Authors case insensitive'),
              React.createElement('label', { className: 'edrv-svnlog-check', title: '占比低于阈值的作者并入「其他」' },
                '其他阈值 ' + othersPct + '%',
                React.createElement('input', { type: 'range', min: 0, max: 50, step: 5, value: othersPct, onChange: (e) => setOthersPct(Number(e.target.value)) }))),
            React.createElement('div', { className: 'edrv-svnlog-stat-duo' },
              React.createElement(AuthorBars, { stats, othersPct }),
              React.createElement(AuthorPie, { stats, othersPct }))),
          React.createElement('div', { className: 'edrv-svnlog-stat-block' },
            React.createElement('div', { className: 'edrv-svnlog-stat-label' },
              'Commits by date',
              React.createElement('label', { className: 'edrv-svnlog-check', title: '按作者分段堆叠（前 ' + STACK_TOP + ' 位作者，其余并入「其他」）' },
                React.createElement('input', { type: 'checkbox', checked: stacked, onChange: (e) => setStacked(e.target.checked) }),
                'stacked')),
            React.createElement(DayBars, { stats, stacked })))))
}

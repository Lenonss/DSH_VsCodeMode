/** Official immutable patch ledger; current files use the existing editor. @author ddj 2026年10月26号 */
import React from 'react'
import { rpc } from '../rpc.js'
import { openEditorView } from '../events.js'
import { refreshReview } from '../state/reviewFeed.js'
import type { ReviewDetail, ReviewItem, ReviewPage } from '../../shared/review.js'
const h = React.createElement
/** @private @author ddj 2026年10月26号 @param props Latest first-page metadata. @returns Paginated rows independent of expanded historical patch. */
export function ReviewLedger(props: { sessionId: string; first: ReviewPage | null; history?: boolean; path?: string }) {
  const [page, setPage] = React.useState<ReviewPage | null>(props.first)
  const [history, setHistory] = React.useState(props.history ?? false)
  const [cursor, setCursor] = React.useState(0)
  const [detail, setDetail] = React.useState<ReviewDetail | null>(null)
  const [error, setError] = React.useState('')
  const selected = React.useRef<AbortController | null>(null)
  React.useEffect(() => () => selected.current?.abort(), [])
  React.useEffect(() => {
    const controller = new AbortController()
    if (!history && !props.path && cursor === 0) { setPage(props.first); return () => controller.abort() }
    void rpc('edrv.review.list', { sessionId: props.sessionId, history, cursor, path: props.path }, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) { setPage(result.page); setError('') }
      else setError(result.error)
    }).catch((cause) => { if (!controller.signal.aborted) setError(String(cause)) })
    return () => controller.abort()
  }, [props.sessionId, props.first, props.path, cursor, history])

  /** @private @author ddj 2026年10月26号 @param item Frozen version identity; patch is never built from disk. */
  async function select(item: ReviewItem): Promise<void> {
    selected.current?.abort()
    const controller = new AbortController()
    selected.current = controller
    try {
      const result = await rpc('edrv.review.detail', { sessionId: props.sessionId, id: item.id }, controller.signal)
      if (controller.signal.aborted) return
      if (result.ok) { setDetail(result.detail); setError('') }
      else setError(result.error)
    } catch (cause) { if (!controller.signal.aborted) setError(String(cause)) }
  }
  return h('div', { style: { marginTop: 8 } },
    h('label', null, h('input', { type: 'checkbox', checked: history, onChange: () => { setHistory(!history); setCursor(0) } }), '显示已处理及被替换的历史'),
    page?.gaps.map((gap) => h('div', { key: `${gap.sessionId}:${gap.seq}`, role: 'status' }, `轮次 ${gap.turn} 采集不完整：${gap.error}`)),
    error ? h('div', { role: 'alert' }, error) : null,
    !page ? h('p', { role: 'status' }, '正在读取官方审查记录…') : null,
    page && !page.items.length ? h('p', null, history ? '暂无已落盘历史。' : '没有待处理的官方记录；可切换查看历史。') : null,
    h('div', { style: { maxHeight: 210, overflow: 'auto' } }, page?.items.map((item) => h('button', {
      key: item.id, type: 'button', onClick: () => { void select(item) },
      style: { display: 'block', width: '100%', textAlign: 'left', padding: '6px 4px' },
    }, `轮次 ${item.turn} · ${item.display}  +${item.added} −${item.deleted} · ${item.decision}${item.current ? '' : '（已被同轮新版本替换）'}`))),
    cursor > 0 ? h('button', { type: 'button', onClick: () => setCursor(Math.max(0, cursor - 50)) }, '上一页') : null,
    page?.nextCursor !== null && page?.nextCursor !== undefined ? h('button', { type: 'button', onClick: () => setCursor(page.nextCursor!) }, '下一页') : null,
    detail ? h(PatchDetail, { key: detail.item.id, sessionId: props.sessionId, detail, onChanged: () => { setDetail(null); refreshReview(props.sessionId) } }) : null)
}

/** @private @author ddj 2026年10月26号 @param props Immutable patch and current review revision. @returns Read-only source with explicit capability gates. */
function PatchDetail(props: { sessionId: string; detail: ReviewDetail; onChanged(): void }) {
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [operationId] = React.useState(() => crypto.randomUUID())
  const lifetime = React.useRef<AbortController | null>(null)
  React.useEffect(() => {
    lifetime.current = new AbortController()
    return () => lifetime.current?.abort()
  }, [])
  const { item, diff, capability } = props.detail
  /** @private @author ddj 2026年10月26号 Marks reviewed only; never writes disk. Stable operation id survives retries while mounted. */
  async function keep(): Promise<void> {
    setBusy(true)
    try {
      const result = await rpc('edrv.review.decide', { sessionId: props.sessionId, id: item.id, seq: item.seq, revision: item.revision,
        operationId, decision: 'accepted' }, lifetime.current?.signal)
      if (lifetime.current?.signal.aborted) return
      if (result.ok) props.onChanged()
      else setError(result.error)
    } catch (cause) { if (!lifetime.current?.signal.aborted) setError(String(cause)) }
    finally { if (!lifetime.current?.signal.aborted) setBusy(false) }
  }
  return h('article', { style: { marginTop: 10, borderTop: '1px solid var(--border-color, #d9dee7)', paddingTop: 8 } },
    h('strong', null, `${item.display} · 轮次 ${item.turn} / 事件 ${item.seq}`),
    h('div', null, `来源会话 ${item.sessionId} · 采集于 ${props.detail.capturedAt}`),
    h('p', null, capability.reason),
    diff.kind === 'text' ? h('div', null,
      h('div', null, `${diff.before ? '原文件存在' : '原文件不存在'} / ${diff.after ? '结果文件存在' : '结果文件不存在'}${diff.coarse ? ' · 粗粒度比较' : ''}`),
      h('pre', { style: { overflow: 'auto', maxHeight: 400, fontSize: 11, lineHeight: 1.6 }, 'aria-label': '官方历史差异（只读）' },
        diff.hunks.map((chunk, index) => h('div', { key: index },
          h('div', null, `@@ -${chunk.oldStart},${chunk.oldLines} +${chunk.newStart},${chunk.newLines} @@`),
          chunk.lines.map((line, position) => h('div', { key: position, style: { background: line.startsWith('+') ? 'light-dark(#e5f5e8, #173522)' : line.startsWith('-') ? 'light-dark(#fce9e9, #452323)' : undefined } }, line)))))
    ) : h('p', null, diff.kind === 'binary' ? '二进制文件：官方不提供文本差异。' : '文件超过官方大小限制：没有差异内容。'),
    error ? h('div', { role: 'alert' }, error) : null,
    h('button', { type: 'button', disabled: busy || !capability.keep, onClick: () => { void keep() } }, '标记已审（不改文件）'),
    h('button', { type: 'button', disabled: true, title: capability.reason }, '拒绝写回不可用'),
    h('button', { type: 'button', onClick: () => openEditorView(item.currentPath) }, '编辑当前文件'))
}

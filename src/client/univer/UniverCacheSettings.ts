/** Current-workspace owned Office cache management. @author ddj 2026年11月13号 */
import React from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { rpc } from '../rpc.js'
import { openEditorView, emitRefresh } from '../events.js'
import { forgetUniver } from './store.js'
import type { UniverCacheList } from '../../shared/univer.js'

/** @private @author ddj 2026年11月13号 @param bytes Actual size. @returns Readable MiB. */
function sizeLabel(bytes: number): string { return (bytes / 1024 / 1024).toFixed(2) + ' MiB' }

/** @public @author ddj 2026年11月13号 @param props Active-session accessor; never accepts arbitrary workspace roots. @returns Explicit selection cleanup surface. */
export function UniverCacheSettings(props: { getSession: () => string | undefined }): React.ReactElement {
  const [sessionId, setSessionId] = React.useState(props.getSession())
  React.useEffect(() => {
    const timer = window.setInterval(() => setSessionId(props.getSession()), 1000)
    return () => window.clearInterval(timer)
  }, [props.getSession])
  const [cache, setCache] = React.useState<UniverCacheList>()
  const [selected, setSelected] = React.useState(new Set<string>())
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const sequence = React.useRef(0)
  React.useEffect(() => {
    void refresh()
    return () => { sequence.current++ }
  }, [sessionId])
  /** @private @author ddj 2026年11月13号 @sideEffects Reads only current workspace; old-session responses never replace current results. */
  async function refresh(): Promise<void> {
    const generation = ++sequence.current
    setCache(undefined)
    setSelected(new Set())
    if (!sessionId) { setMessage('选择一个工作区会话后查看缓存'); return }
    setBusy(true)
    try {
      const result = await rpc('edrv.univer.cacheList', { sessionId })
      if (generation !== sequence.current) return
      if (!result.ok) throw new Error(result.error)
      setCache(result.cache)
      setMessage(result.cache.truncated ? '仅显示前500项，请分批管理' : '')
    } catch (error) { if (generation === sequence.current) setMessage(String(error)) }
    finally { if (generation === sequence.current) setBusy(false) }
  }
  /** @private @author ddj 2026年11月13号 @sideEffects Deletes only selected current revisions after explicit irreversible-loss confirmation. */
  async function clean(): Promise<void> {
    if (!sessionId || !cache || !cache.writable || busy) return
    const chosen = cache.entries.filter((entry) => selected.has(entry.id))
    if (!chosen.length || !window.confirm('清理所选 ' + chosen.length + ' 项缓存（' + sizeLabel(chosen.reduce((sum, entry) => sum + entry.bytes, 0)) + '）？可能包含尚未导出的编辑，删除不可恢复；原Office文件不受影响。占用条目会跳过。')) return
    setBusy(true)
    const generation = sequence.current
    try {
      const result = await rpc('edrv.univer.cacheClean', { sessionId, entries: chosen.map(({ id, revision }) => ({ id, revision })) })
      if (generation !== sequence.current) return
      if (!result.ok) throw new Error(result.error)
      const deleted = new Set(result.results.filter((entry) => entry.status === 'deleted').map((entry) => entry.id))
      forgetUniver(sessionId, chosen.filter((entry) => deleted.has(entry.id)).map((entry) => entry.file))
      emitRefresh({ kind: 'structure' })
      await refresh()
      setMessage(result.results.map((entry) => (entry.status === 'deleted' ? '已删除' : entry.status === 'skipped' ? '已跳过' : '失败') + '：' + (chosen.find((item) => item.id === entry.id)?.source ?? entry.id) + (entry.reason ? '；' + entry.reason : '')).join('\n'))
    } catch (error) { if (generation === sequence.current) setMessage(String(error)) }
    finally { if (generation === sequence.current) setBusy(false) }
  }
  return React.createElement('section', { className: 'edrv-uv-cache-settings' },
    React.createElement('h3', null, 'Univer 工作区缓存'),
    React.createElement('p', null, '缓存可能包含唯一的未导出编辑，不自动清除。服务占用时跳过，不自动停服务。'),
    cache ? React.createElement('p', { title: cache.root }, cache.workspace + ' · ' + cache.entries.length + ' 项 · ' + sizeLabel(cache.entries.reduce((sum, entry) => sum + entry.bytes, 0))) : null,
    React.createElement(Button, { disabled: busy, onClick: refresh }, '刷新'),
    React.createElement(Button, { disabled: busy || !cache?.writable || !selected.size, onClick: clean }, '清理所选'),
    cache?.entries.map((entry) => React.createElement('div', { key: entry.id, className: 'edrv-uv-cache-row' },
      React.createElement(Input, { type: 'checkbox', checked: selected.has(entry.id), disabled: busy || !cache.writable, 'aria-label': '选择 ' + entry.source, onChange: () => setSelected((current) => { const next = new Set(current); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next }) }),
      React.createElement('span', null, entry.source, React.createElement('small', null, new Date(entry.createdAt).toLocaleString() + ' · ' + sizeLabel(entry.bytes) + ' · ' + (entry.complete ? '已准备' : '未完成'))),
      React.createElement(Button, { disabled: busy, onClick: () => openEditorView(entry.file) }, '打开缓存'))),
    cache && !cache.entries.length ? React.createElement('p', null, '当前工作区没有受管理的缓存') : null,
    message ? React.createElement('p', { role: 'status', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, message) : null)
}

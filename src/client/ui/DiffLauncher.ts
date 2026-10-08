// @ts-nocheck
/**
 * dsh-vscode-mode client — DiffLauncher：全局差异总览 + 归档 圆角下拉。
 * 迁移自原 src/client/index.ts 的 DiffLauncher，语义不改。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { MONO, btn } from './shared.js'

/**
 * 文件与批次共同标识归档卡片，避免同文件多批次共用展开状态。
 * @author ddj 2026年09月30号
 * @param entry 归档摘要或展开详情
 * @returns 稳定卡片键
 */
export function archiveKey(entry) {
  return JSON.stringify([entry.path, entry.batch])
}

/**
 * 追加一页摘要并按文件/批次去重，保留已有卡片的顺序。
 * @author ddj 2026年09月30号
 * @param current 已加载页面
 * @param next 下一页
 * @returns 合并后的摘要列表
 */
export function mergeArchives(current, next) {
  const merged = [...(current ?? [])]
  const keys = new Set(merged.map(archiveKey))
  for (const entry of next) {
    const key = archiveKey(entry)
    if (keys.has(key)) continue
    keys.add(key)
    merged.push(entry)
  }
  return merged
}

/**
 * 全局差异面板：待处理文件列表（点击打开并跳转）+ 归档浏览/批次回滚。
 * 由状态栏差异 chip / header 角标触发。
 */
export function DiffLauncher(props) {
  const sessionId = props?.sessionId
  const sum = props?.sum
  const onClose = props?.onClose
  const onOpenFile = props?.onOpenFile
  const [tab, setTab] = React.useState(props?.tab === 'archive' ? 'archive' : 'pending') // 'pending' | 'archive'
  const [archives, setArchives] = React.useState(null)
  const [archiveDetail, setArchiveDetail] = React.useState(null)
  const [archivePath, setArchivePath] = React.useState(null)
  const [archiveErr, setArchiveErr] = React.useState(null)
  const [nextCursor, setNextCursor] = React.useState(null)
  const [moreBusy, setMoreBusy] = React.useState(false)
  const requestRef = React.useRef(0)
  const detailRef = React.useRef(0)
  const moreRef = React.useRef(false)
  const [error, setError] = React.useState(null)

  /** @author ddj 2026年09月30号 @description 仅加载一个归档摘要页并丢弃失效响应。 */
  const loadArchives = (cursor = null) => {
    if (!sessionId) { setArchiveErr('会话不存在'); return }
    if (cursor && moreRef.current) return
    if (cursor) { moreRef.current = true; setMoreBusy(true); setArchiveErr(null) }
    else { requestRef.current++; setArchives(null); setNextCursor(null); setArchiveErr(null) }
    const generation = requestRef.current
    rpc('edrv.archivePage', { sessionId, ...(cursor ? { cursor } : {}) }).then((res) => {
      if (generation !== requestRef.current) return
      if (res && res.ok && Array.isArray(res.entries)) {
        setArchives((current) => cursor ? mergeArchives(current, res.entries) : res.entries)
        setNextCursor(res.nextCursor ?? null)
        setArchiveErr(null)
      } else setArchiveErr(res?.error ? String(res.error) : '归档分页读取失败')
    }).catch((e) => { if (generation === requestRef.current) setArchiveErr('归档异常:' + String(e)) })
      .finally(() => { if (generation === requestRef.current) { moreRef.current = false; setMoreBusy(false) } })
  }
  /** @author ddj 2026年09月30号 @description 仅加载目标文件和批次详情。 */
  const loadArchiveDetail = (path, batch) => {
    if (!sessionId) return
    const generation = ++detailRef.current
    setArchiveDetail(null)
    rpc('edrv.archiveRead', { sessionId, path, batch }).then((res) => {
      if (generation !== detailRef.current) return
      if (res && res.ok && Array.isArray(res.batches)) setArchiveDetail(res.batches)
      else setArchiveErr(res?.error ? String(res.error) : '归档详情读取失败')
    }).catch((e) => { if (generation === detailRef.current) setArchiveErr('归档异常:' + String(e)) })
  }
  React.useEffect(() => {
    requestRef.current++
    detailRef.current++
    moreRef.current = false
    setMoreBusy(false)
    setArchiveDetail(null); setArchivePath(null); setArchiveErr(null)
    if (tab === 'archive') loadArchives()
    else { setArchives(null); setNextCursor(null) }
    return () => { requestRef.current++; detailRef.current++ }
  }, [tab, sessionId])

  let body
  if (tab === 'pending') {
    body = (sum.pendingFiles.length === 0
      ? React.createElement('div', { className: 'edrv-search-empty' }, '暂无待处理差异（已全部处理）')
      : sum.pendingFiles.map((f) => React.createElement('div', { key: f.path, className: 'edrv-launch-row', title: '打开并跳转到差异 ' + (f.label ?? f.path), onClick: () => onOpenFile(f.path) },
          React.createElement('span', { className: 'edrv-launch-path' }, f.label ?? f.path),
          React.createElement('span', { className: 'edrv-launch-cnt' }, '待处理 ' + f.pending + ' 处'),
          React.createElement('button', { className: 'edrv-btn-mini edrv-btn-keep', onClick: (e) => { e.stopPropagation(); onOpenFile(f.path) } }, '打开'))))
  } else {
    if (archiveErr && archives === null) body = React.createElement('div', { className: 'edrv-search-empty', style: { color: 'var(--dsw-alias-state-error-primary,#d9534f)' } }, '错误：' + String(archiveErr), React.createElement('button', { onClick: () => loadArchives(), style: btn(false) }, '重试'))
    else if (archives === null) body = React.createElement('div', { className: 'edrv-search-empty' }, '加载中…')
    else if (archives.length === 0) body = React.createElement('div', { className: 'edrv-search-empty' }, '暂无归档记录')
    else {
      const inner = archives.map((e) => {
        const entryKey = archiveKey(e)
        const open = archivePath === entryKey
        let detailEl = null
        if (open) {
          if (archiveDetail === null) detailEl = React.createElement('div', { style: { padding: 8, fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } }, '加载中…')
          else {
            const batches = archiveDetail.filter((b) => b.path === e.path && b.batch === e.batch)
            detailEl = batches.map((b) => (Array.isArray(b.records) ? b.records : []).map((rec) => {
              const lines = []
              const hunks = Array.isArray(rec.hunks) ? rec.hunks : []
              for (const h of hunks) {
                const oldLs = (h.oldText ?? '').split('\n')
                const newLs = (h.newText ?? '').split('\n')
                for (const t of oldLs) lines.push({ k: 'old', t })
                if (oldLs.length && newLs.length) lines.push({ k: 'sep', t: '' })
                for (const t of newLs) lines.push({ k: 'new', t })
              }
              const sm = rec.summary || { accepted: 0, rejected: 0, pending: 0, superseded: false }
              return React.createElement('div', { key: rec.callId, style: { padding: '5px 8px', borderTop: '1px solid var(--dsw-alias-border-l1,#333)' } },
                React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, marginBottom: 2 } },
                  React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary,#ddd)', fontWeight: 600 } },
                    rec.toolName === 'remote_ssh_write' ? (rec.create ? '远端新建' : '远端写入')
                      : rec.toolName === 'write' ? (rec.create ? '新建' : '写入') : '编辑'),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary,#2e9e44)' } }, '采纳 ' + sm.accepted),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary,#d9534f)' } }, '拒绝 ' + sm.rejected),
                  (rec.superseded ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-warn-primary,#b7791f)' } }, '被覆盖') : null),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary,#888)' } }, new Date(rec.at).toLocaleTimeString())),
                React.createElement('pre', { style: { margin: 0, whiteSpace: 'pre', fontFamily: MONO.fontFamily, fontSize: 11, lineHeight: 1.5, overflowX: 'auto' } }, lines.map((ln, i) => React.createElement('div', { key: i, style: { background: ln.k === 'old' ? 'rgba(239,68,68,.10)' : ln.k === 'new' ? 'rgba(34,197,94,.10)' : 'transparent', color: ln.k === 'old' ? 'var(--dsw-alias-state-error-primary,#d9534f)' : ln.k === 'new' ? 'var(--dsw-alias-state-success-primary,#2e9e44)' : 'var(--dsw-alias-label-tertiary,#888)' } }, (ln.k === 'old' ? '- ' : ln.k === 'new' ? '+ ' : '') + ln.t)))
              )
            }))
          }
        }
        return React.createElement('div', { key: entryKey, style: { border: '1px solid var(--dsw-alias-border-l1,#333)', borderRadius: 8, overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-1,transparent)', cursor: 'pointer', flexWrap: 'wrap' }, onClick: () => { if (open) { detailRef.current++; setArchivePath(null); setArchiveDetail(null) } else { setArchivePath(entryKey); loadArchiveDetail(e.path, e.batch) } } },
            React.createElement('span', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-primary,#ddd)', wordBreak: 'break-all' } }, e.displayPath ?? e.path),
            (e.batch != null ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } }, '批次 ' + e.batch) : null),
            (e.reason ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-warn-primary,#b7791f)' } }, e.reason) : null),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } }, new Date(e.at).toLocaleString()),
            React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } }, '采纳 ' + e.summary.accepted + ' · 拒绝 ' + e.summary.rejected + (e.summary.superseded ? ' · 覆盖 ' + e.summary.superseded : '')),
            React.createElement('button', { onClick: (ev) => {
              ev.stopPropagation()
              if (e.batch == null) return
              if (!window.confirm('将文件恢复到批次 ' + e.batch + ' 之前的状态？（当前活跃差异将一并归档）')) return
              rpc('edrv.rollback', { sessionId, path: e.path, batch: e.batch }).then((res) => {
                if (res && res.ok) {
                  setError(null); window.dispatchEvent(new CustomEvent('edrv:refresh'))
                  setArchivePath(null); setArchiveDetail(null); loadArchives()
                } else setError(res?.error ? String(res.error) : '回滚失败')
              }).catch((err) => setError('回滚异常:' + String(err)))
            }, style: btn(false) }, '回滚')),
          detailEl)
      })
      body = React.createElement('div', { className: 'edrv-launch-arch' }, inner,
        archiveErr ? React.createElement('div', { style: { color: 'var(--dsw-alias-state-error-primary,#d9534f)' } }, '归档异常：' + archiveErr,
          React.createElement('button', { onClick: () => { if (nextCursor) loadArchives(nextCursor); else loadArchives() }, style: btn(false) }, '重试')) : null,
        nextCursor || moreBusy ? React.createElement('button', {
          className: 'edrv-btn-mini', disabled: moreBusy || !!archiveErr,
          onClick: () => { if (nextCursor) loadArchives(nextCursor) },
        }, moreBusy ? '加载中…' : '加载更多') : null)
    }
  }

  return React.createElement('div', { className: 'edrv-launch', 'data-edrv-launch': '1' },
    React.createElement('div', { className: 'edrv-launch-head' },
      React.createElement('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary,#eee)', marginRight: 4 } }, '差异'),
      React.createElement('button', { className: 'edrv-launch-tab' + (tab === 'pending' ? ' on' : ''), onClick: () => setTab('pending') }, '待处理' + (sum.totalFiles ? ' (' + sum.totalFiles + ')' : '')),
      React.createElement('button', { className: 'edrv-launch-tab' + (tab === 'archive' ? ' on' : ''), onClick: () => setTab('archive') }, '归档'),
      React.createElement('span', { style: { flex: 1 } }),
      (error ? React.createElement('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary,#d9534f)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '40%' } }, '错误：' + String(error)) : null),
      React.createElement('button', { onClick: onClose, style: btn(false) }, '✕ 关闭')),
    React.createElement('div', { className: 'edrv-launch-body' }, body))
}

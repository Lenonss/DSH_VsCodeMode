// @ts-nocheck
/**
 * dsh-vscode-mode client — PerfSettings：「性能优化」设置子页（会话卫生 + 压缩调优）。
 * - 会话盘点：全工作区/每会话体积、活跃标记，按体积排序；
 * - 移出到归档（先规划→确认→执行→可恢复）与归档清除；
 * - DSH 内置压缩调优：写 profile patch（compaction-basic / tool-result-pruner 更低阈值，
 *   带备份与撤销，需重启生效）；
 * - 侧车摘要用法提示（agent/脚本取关键字段，不整份读 .dsh-edit-review.json）。
 * 作者 ddj 2026-09-02
 */
import React from 'react'
import { rpc } from '../rpc.js'
import '../styles/mcp.css'

/** 字节数人类可读。 */
function formatBytes(n) {
  if (!n) return '0B'
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + 'MB'
  if (n >= 1024) return (n / 1024).toFixed(0) + 'KB'
  return n + 'B'
}

/** 会话行 key：workspaceKey \u0000 sessionId。 */
const keyOf = (ws, id) => ws + '\u0000' + id

/** 单行会话。 */
function SessionRow({ row, checked, disabled, onToggle }) {
  const age = Math.max(0, (Date.now() - row.mtime) / (24 * 3600 * 1000))
  const when = age < 1 ? Math.round(age * 24) + 'h' : Math.round(age) + 'd'
  return React.createElement('label', { className: 'vsm-perf-row' },
    React.createElement('input', { type: 'checkbox', checked, disabled, onChange: onToggle }),
    React.createElement('span', { className: 'vsm-perf-cell vsm-perf-id', title: row.sessionId }, row.sessionId),
    React.createElement('span', { className: 'vsm-perf-cell vsm-perf-size ' + (row.bytes >= 1024 * 1024 ? 'big' : '') }, formatBytes(row.bytes)),
    React.createElement('span', { className: 'vsm-perf-cell vsm-perf-mtime', title: new Date(row.mtime).toLocaleString() }, when),
    row.active ? React.createElement('span', { className: 'vsm-perf-cell vsm-perf-active' }, '活跃') : null,
  )
}

/**
 * 会话卫生 + 压缩调优设置子页。
 * @author ddj 2026年09月02号
 */
export function PerfSettings() {
  const [inv, setInv] = React.useState(null)
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const [selected, setSelected] = React.useState({})
  const [confirm, setConfirm] = React.useState(null)
  const [moved, setMoved] = React.useState(null)
  const [config, setConfig] = React.useState(null)

  const load = React.useCallback(() => {
    setError('')
    Promise.all([rpc('edrv.perf.inventory', {}), rpc('edrv.perf.configGet', {})]).then(([i, c]) => {
      if (!i.ok) throw new Error(i.error)
      if (!c.ok) throw new Error(c.error)
      setInv(i)
      setConfig(c)
    }).catch((e) => setError(String(e)))
  }, [])

  React.useEffect(load, [load])

  const action = (id, method, args, patch) => {
    setBusy(id)
    setError('')
    return rpc(method, args).then((res) => {
      if (!res.ok) throw new Error(res.error)
      if (patch) patch(res)
      return res
    }).catch((e) => setError(String(e))).finally(() => setBusy(''))
  }

  /** 圈选 ≥ 1MB 的非活跃会话。 */
  const selectBig = () => {
    if (!inv) return
    const next = {}
    for (const s of inv.sessions) {
      if (s.bytes >= 1024 * 1024 && !s.active) next[keyOf(s.workspaceKey, s.sessionId)] = true
    }
    setSelected(next)
  }

  /** 清空选择。 */
  const clearSel = () => setSelected({})

  /** 规划移出所选（跨工作区按 sessionIds 一次规划）。 */
  const planMove = () => {
    const sessionIds = Object.keys(selected).map((k) => k.slice(k.indexOf('\u0000') + 1))
    if (!sessionIds.length) return
    action('plan', 'edrv.perf.movePlan', { sessionIds }).then((res) => {
      if (res.items?.length) setConfirm(res)
      else setError('所选会话没有可移出的项（活跃会话已排除）')
    })
  }

  /** 确认移出：按工作区分组逐组执行，成功后刷新并记录可恢复项。 */
  const doMove = () => {
    const grouped = {}
    for (const item of confirm.items) {
      const list = grouped[item.workspaceKey] ?? (grouped[item.workspaceKey] = [])
      list.push(item.sessionId)
    }
    const jobs = Object.entries(grouped).map(([ws, sessionIds]) => rpc('edrv.perf.moveOut', { workspaceKey: ws, sessionIds }))
    Promise.all(jobs).then((results) => {
      const allMoved = []
      const failures = []
      for (const res of results) {
        if (!res.ok) { failures.push(res.error); continue }
        allMoved.push(...(res.moved ?? []))
        failures.push(...(res.failures ?? []).map((f) => f.sessionId + ': ' + f.error))
      }
      setMoved({ moved: allMoved, failures, reclaimedBytes: allMoved.reduce((s, i) => s + i.bytes, 0) })
      setConfirm(null)
      setSelected({})
      load()
    }).catch((e) => setError(String(e)))
  }

  /** 恢复单个已移出会话。 */
  const doRestore = (item) => {
    action('restore', 'edrv.perf.restore', { workspaceKey: item.workspaceKey, sessionId: item.sessionId }).then(() => {
      setMoved((old) => old ? { ...old, moved: old.moved.filter((m) => !(m.workspaceKey === item.workspaceKey && m.sessionId === item.sessionId)) } : old)
      load()
    })
  }

  /** 清除归档区早于 N 天的会话（破坏性）。 */
  const doPurge = () => {
    if (!window.confirm('确认永久删除归档区中 30 天前的会话？此操作不可恢复（仅归档区，不影响当前 sessions）。')) return
    action('purge', 'edrv.perf.purgeArchive', { olderThanDays: 30 }).then((res) => {
      setError('已清除 ' + (res.removed ?? 0) + ' 个归档会话，释放 ' + formatBytes(res.reclaimedBytes ?? 0))
    })
  }

  /** 应用压缩调优到 profile patch。 */
  const applyConfig = () => {
    action('apply', 'edrv.perf.configApply', {}).then((res) => {
      setError('已写入压缩调优配置（备份 ' + res.backup + '），重启 DSH 后生效')
      load()
    })
  }

  /** 撤销压缩调优。 */
  const undoConfig = () => {
    action('undo', 'edrv.perf.configUndo', {}).then(() => {
      setError('已撤销压缩调优配置（恢复备份）')
      load()
    })
  }

  const totals = inv?.totals
  const summaryCards = totals ? React.createElement('div', { className: 'vsm-perf-cards' },
    React.createElement('div', { className: 'vsm-perf-card' }, React.createElement('span', null, '工作区'), React.createElement('b', null, String(totals.workspaces))),
    React.createElement('div', { className: 'vsm-perf-card' }, React.createElement('span', null, '会话数'), React.createElement('b', null, String(totals.sessions))),
    React.createElement('div', { className: 'vsm-perf-card' }, React.createElement('span', null, '压缩态总体积'), React.createElement('b', { className: totals.totalBytes >= 50 * 1024 * 1024 ? 'big' : '' }, formatBytes(totals.totalBytes))),
  ) : null

  const workspaceBlocks = inv?.workspaces ? inv.workspaces.map((ws) => {
    const rows = inv.sessions.filter((s) => s.workspaceKey === ws.workspaceKey)
    return React.createElement('div', { key: ws.workspaceKey, className: 'vsm-perf-ws' },
      React.createElement('div', { className: 'vsm-perf-ws-head' },
        React.createElement('span', { className: 'vsm-perf-ws-name', title: ws.workspaceKey }, ws.workspaceKey),
        React.createElement('span', { className: 'vsm-perf-ws-meta' }, rows.length + ' 会话 · ' + formatBytes(ws.totalBytes)),
      ),
      React.createElement('div', { className: 'vsm-perf-rows' },
        rows.length ? rows.map((row) => React.createElement(SessionRow, {
          key: keyOf(row.workspaceKey, row.sessionId),
          row,
          checked: !!selected[keyOf(row.workspaceKey, row.sessionId)],
          disabled: row.active || busy === 'move',
          onToggle: () => {
            const k = keyOf(row.workspaceKey, row.sessionId)
            setSelected((old) => { const next = { ...old }; if (next[k]) delete next[k]; else next[k] = true; return next })
          },
        })) : React.createElement('div', { className: 'vsm-mcp-empty' }, '无会话'),
      ),
    )
  }) : null

  const selCount = Object.keys(selected).length
  const confirmBody = confirm ? React.createElement('div', { className: 'vsm-perf-modal' },
    React.createElement('div', { className: 'vsm-perf-modal-card' },
      React.createElement('h3', null, '确认移出 ' + confirm.items.length + ' 个会话？'),
      React.createElement('p', { className: 'vsm-perf-modal-note' }, '将从 ~/.dsh/sessions 移出到 ~/.dsh/sessions-archive（可逆，重启后不再回放，释放 ' + formatBytes(confirm.reclaimedBytes) + '）。活跃会话已排除。'),
      React.createElement('ul', { className: 'vsm-perf-modal-list' }, confirm.items.slice(0, 20).map((item) => React.createElement('li', { key: item.workspaceKey + item.sessionId }, item.workspaceKey + ' / ' + item.sessionId + '（' + formatBytes(item.bytes) + '）'))),
      confirm.items.length > 20 ? React.createElement('div', { className: 'vsm-perf-modal-more' }, '…等 ' + confirm.items.length + ' 个') : null,
      React.createElement('div', { className: 'vsm-perf-modal-actions' },
        React.createElement('button', { className: 'vsm-primary', onClick: doMove, disabled: busy === 'move' }, busy === 'move' ? '执行中…' : '确认移出'),
        React.createElement('button', { className: 'vsm-secondary', onClick: () => setConfirm(null) }, '取消'),
      ),
    ),
  ) : null

  const movedBody = moved?.moved?.length ? React.createElement('div', { className: 'vsm-perf-moved' },
    React.createElement('h3', null, '已移出 ' + moved.moved.length + ' 个会话（释放 ' + formatBytes(moved.reclaimedBytes) + '）'),
    React.createElement('div', { className: 'vsm-perf-rows' }, moved.moved.map((item) => React.createElement('div', { key: item.workspaceKey + item.sessionId, className: 'vsm-perf-row' },
      React.createElement('span', { className: 'vsm-perf-cell vsm-perf-id' }, item.sessionId),
      React.createElement('span', { className: 'vsm-perf-cell vsm-perf-size' }, formatBytes(item.bytes)),
      React.createElement('button', { className: 'vsm-secondary vsm-small', onClick: () => doRestore(item), disabled: busy === 'restore' }, '恢复'),
    ))),
    moved.failures?.length ? React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, '失败：' + moved.failures.join('；')) : null,
  ) : null

  const configBody = config ? React.createElement('div', { className: 'vsm-perf-config' },
    React.createElement('h3', null, 'DSH 内置压缩调优'),
    React.createElement('p', null, '调低 compaction-basic / tool-result-pruner 触发阈值，让长循环会话更早压缩，降低模型可见上下文压力（减少 token 与防 context overflow）。'),
    React.createElement('p', { className: 'vsm-perf-note' }, '注意：压缩只追加 compaction 事件，不重写已持久化会话日志（append-only），因此不会缩小已存在的会话文件——存量瘦身请用上方「移出到归档」。packChunks 已默认开启，无需配置。'),
    React.createElement('div', { className: 'vsm-perf-config-state' },
      React.createElement('span', { className: 'vsm-perf-cell' }, '状态：' + (config.applied ? '已应用' : '未应用')),
      config.applied ? React.createElement('button', { className: 'vsm-secondary vsm-small', onClick: undoConfig, disabled: busy === 'undo' }, '撤销') : React.createElement('button', { className: 'vsm-primary vsm-small', onClick: applyConfig, disabled: busy === 'apply' }, '应用建议配置（需重启）'),
    ),
    React.createElement('pre', { className: 'vsm-perf-block' }, config.block),
  ) : null

  const guideBody = React.createElement('div', { className: 'vsm-perf-guide' },
    React.createElement('h3', null, '侧车摘要（agent/脚本取关键字段，不整份读 sidecar）'),
    React.createElement('p', null, '工作区根目录的 .dsh-edit-review.json（可能数 MB）只应通过摘要接口读取，禁止 agent 整份 read/write 进对话：'),
    React.createElement('pre', { className: 'vsm-perf-block' },
      "curl -s -X POST http://127.0.0.1:3080/edrv/rpc -H 'content-type: application/json' -d '{\"method\":\"edrv.perf.sidecarSummary\",\"args\":{}}'\n# 差异记录列表（含每文件 pending 摘要）：edrv.list\n# 历史归档：edrv.archiveList / edrv.archiveRead"),
  )

  return React.createElement('section', { className: 'vsm-perf-page' },
    React.createElement('h2', null, '会话性能'),
    React.createElement('p', null, 'DSH 启动会回放 ~/.dsh/sessions 全部会话（V8 展开约 10×），体积越大内存越吃紧。定期把巨型/旧会话移出到归档可显著降低启动内存。'),
    error ? React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error) : null,
    summaryCards,
    React.createElement('div', { className: 'vsm-perf-toolbar' },
      React.createElement('button', { className: 'vsm-secondary vsm-small', onClick: selectBig }, '圈选 ≥1MB 非活跃'),
      React.createElement('button', { className: 'vsm-secondary vsm-small', onClick: clearSel, disabled: !selCount }, '清空选择'),
      React.createElement('span', { className: 'vsm-perf-selcount' }, '已选 ' + selCount + ' 个'),
      React.createElement('button', { className: 'vsm-primary vsm-small', onClick: planMove, disabled: !selCount || busy === 'plan' }, busy === 'plan' ? '规划中…' : '移出所选'),
      React.createElement('button', { className: 'vsm-secondary vsm-small', onClick: doPurge, disabled: busy === 'purge' }, '清除归档(>30天)'),
      React.createElement('button', { className: 'vsm-secondary vsm-small', onClick: load, disabled: busy === 'load' }, '⟳ 刷新'),
    ),
    workspaceBlocks,
    movedBody,
    configBody,
    guideBody,
    confirmBody,
  )
}

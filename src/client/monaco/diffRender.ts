// @ts-nocheck
/**
 * dsh-vscode-mode client — 行内差异自绘（新增行绿底 + glyph margin '+'；删除块 view zone 红底）。
 * 迁移自原 src/client/index.ts 的 diff-render effect，语义不改。
 * 作者 ddj 2026-08-20
 */

/**
 * 差异渲染器（每 EditorView 挂载一个，内部持有 zone/decoration 状态）。
 * @param log 诊断日志函数（(sessionId, text) => void）
 */
export function createDiffRenderer(log) {
  let viewZoneIds = []
  let decorations = []

  /**
   * 渲染当前 pending 差异：绿底 decoration + 删除块 view zones + '-' 号 overlay（滚动同步）。
   * @param monaco window.monaco
   * @param editor Monaco 编辑器实例
   * @param pendingRegions 待处理差异区域
   * @param sessionId 会话 id
   */
  const render = (monaco, editor, pendingRegions, sessionId) => {
    const renderT0 = Date.now()
    const callIdAttr = (callId, idx) => String(callId) + ':' + String(idx)
    log(sessionId, '[diff-render] begin regs=' + pendingRegions.length + ' ' + pendingRegions.map((r) => callIdAttr(r.callId, r.idx) + '@' + (r.start ?? '?') + '-' + (r.end ?? '?') + '(-' + (r.oldLines ? r.oldLines.length : 0) + '/+' + (r.newLines ? r.newLines.length : 0) + ')').join('|'))

    const decos = []
    for (const r of pendingRegions) {
      if (r.start === undefined || r.end === undefined) continue
      if (!r.create && r.newLines && r.newLines.length) {
        decos.push({
          range: new monaco.Range(r.start, 1, Math.max(r.start, r.end - 1), 1),
          options: { isWholeLine: true, className: 'edrv-mn-add-line', linesDecorationsClassName: 'edrv-mn-gutter-add' },
        })
      }
    }
    decorations = editor.deltaDecorations(decorations, decos)

    // 删除块 view zones（红底 + 正文；- 号由独立 overlay 层渲染，定位在 decoration 列与 + 同列，
    // 不受 view zone 容器定位/裁剪影响；滚动用 translateY 同步）
    let createdZones = []
    editor.changeViewZones((accessor) => {
      for (const id of viewZoneIds) { try { accessor.removeZone(id) } catch (e) { /* 已移除 */ } }
      viewZoneIds = []
      const zones = []
      for (const r of pendingRegions) {
        if (r.create) continue
        const oldLines = r.oldLines && r.oldLines.length ? r.oldLines : null
        if (!oldLines) continue
        const after = Math.max(0, (r.start ?? 1) - 1)
        const domNode = document.createElement('div')
        domNode.className = 'edrv-del-zone'
        domNode.dataset.edrvHunk = callIdAttr(r.callId, r.idx)
        for (const t of oldLines) {
          const row = document.createElement('div')
          row.className = 'edrv-del-row'
          const text = document.createElement('span')
          text.className = 'edrv-del-text'
          text.textContent = t
          row.appendChild(text)
          domNode.appendChild(row)
        }
        const id = accessor.addZone({
          afterLineNumber: after,
          heightInLines: oldLines.length,
          domNode,
          suppressMouseDown: false,
        })
        viewZoneIds.push(id)
        zones.push({ domNode, after, n: oldLines.length })
      }
      createdZones = zones
    })

    if (createdZones.length) {
      const root = editor.getDomNode()
      if (root) {
        let overlay = root.querySelector('.edrv-minus-overlay')
        if (!overlay) {
          overlay = document.createElement('div')
          overlay.className = 'edrv-minus-overlay'
          root.appendChild(overlay)
        }
        overlay.innerHTML = ''
        const lineH = editor.getOption(monaco.editor.EditorOption.lineHeight) || 20
        let li = null
        try { li = editor.getLayoutInfo() } catch (e) { /* ignore */ }
        const left = li ? li.decorationsLeft : 0
        const width = li && li.decorationsWidth > 0 ? li.decorationsWidth : 16
        const lineCount = editor.getModel().getLineCount()
        let itemIdx = 0
        let zi = 0
        for (const z of createdZones) {
          // 用 Monaco 坐标 API 计算 view zone 顶部，避免离屏 zone DOM 未布局导致 getBoundingClientRect 为 0
          const anchor = Math.min(z.after + 1, lineCount)
          let zoneBottom = editor.getTopForLineNumber(anchor)
          if (z.after >= lineCount) zoneBottom += lineH
          const zoneTop = zoneBottom - z.n * lineH
          for (let i = 0; i < z.n; i++) {
            const item = document.createElement('div')
            item.className = 'edrv-minus-item'
            item.textContent = '-'
            item.style.width = width + 'px'
            item.style.height = lineH + 'px'
            item.dataset.zone = String(zi)
            item.dataset.row = String(i)
            item.style.top = (zoneTop + i * lineH) + 'px'
            item.style.left = left + 'px'
            overlay.appendChild(item)
            itemIdx++
          }
          zi++
        }
        log(sessionId, '[diff-render] placed zones=' + createdZones.length + ' items=' + itemIdx + ' left=' + left + ' w=' + width + ' t+' + (Date.now() - renderT0) + 'ms')
        // 滚动同步：overlay 随内容滚动（内容坐标 - scrollTop）
        const syncScroll = () => {
          const s2 = editor.getScrollTop() || 0
          if (overlay) overlay.style.transform = 'translateY(' + (-s2) + 'px)'
        }
        syncScroll()
        overlay.__edrvSync = syncScroll
        if (!overlay.__edrvBound) {
          overlay.__edrvBound = true
          editor.onDidScrollChange(syncScroll)
        }
        // 已可见的 zone 用真实 DOM 坐标做一次微调（离屏 zone 仍保留坐标 API 位置）
        setTimeout(() => {
          try {
            const edRect = root.getBoundingClientRect()
            const st = editor.getScrollTop() || 0
            const items = overlay.querySelectorAll('.edrv-minus-item')
            for (const item of items) {
              const zIndex = Number(item.dataset.zone)
              const rIndex = Number(item.dataset.row)
              const z = createdZones[zIndex]
              if (!z || !z.domNode.isConnected) continue
              const rowEl = z.domNode.querySelectorAll('.edrv-del-row')[rIndex]
              if (!rowEl) continue
              const rowRect = rowEl.getBoundingClientRect()
              if (rowRect.height > 0) {
                item.style.top = (rowRect.top - edRect.top + st) + 'px'
              }
            }
          } catch (e) { log(sessionId, '[diff-render] correct fail ' + String(e)) }
        }, 50)
      }
    } else {
      const root = editor.getDomNode()
      const overlay = root && root.querySelector('.edrv-minus-overlay')
      if (overlay) overlay.innerHTML = ''
    }
  }

  /** 卸载清理（EditorView unmount 时调用）。 */
  const dispose = () => {
    viewZoneIds = []
    decorations = []
  }

  return { render, dispose }
}

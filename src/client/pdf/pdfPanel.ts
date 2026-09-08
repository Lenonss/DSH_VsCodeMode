// @ts-nocheck
/**
 * dsh-vscode-mode client — PDF 面板控制器（命令式 DOM，React 只渲染外壳 div）。
 * 浏览：PDFViewer 组件（虚拟化渲染 + 文本层）；编辑：内置注释编辑器
 * （FreeText 文本框 / Ink 画笔 / Highlight 高亮），保存经 pdfDocument.saveDocument()
 * → base64 → edrv.saveBinary 回写原文件。接线方式对齐官方 viewer（web/app.js）。
 * 作者 ddj 2026-09-22
 */
import { rpc } from '../rpc.js'
import { bytesToBase64 } from '../pdfPreview.js'
import { loadPdfjs, PDFJS_CMAP_URL, PDFJS_FONT_URL } from './pdfLoader.js'

/** 无障碍占位 l10n：组件内 translate 为 fire-and-forget，stub 避免触发 locale 404。 */
const L10N_STUB = {
  get: async (key) => key,
  translate: async () => {},
  getDirection: () => 'ltr',
}

/**
 * PDF 面板控制器工厂。
 * @author ddj 2026年09月22号
 * @param deps 依赖：sessionId/path（保存回写目标）+ 状态栏回调
 * @returns 控制器：mount/destroy/savePdf/setMode/isDirty
 */
export function createPdfPanel(deps) {
  const status = (t) => { try { deps.setStatus(t) } catch { /* 状态栏回调异常忽略 */ } }

  let stage = null
  let pageLabel = null
  let eventBus = null
  let busAbort = null
  let editorTypes = null
  let pdfViewer = null
  let pdfDocument = null
  let loadingTask = null
  let modeButtons = null
  let destroyed = false
  let dirty = false
  let saving = false

  /** 脏状态上抛（tab 脏点）+ 本地记忆。 */
  const setDirty = (value) => {
    dirty = value
    if (modeButtons) modeButtons.save.classList.toggle('edrv-pdf-dirty', value)
    try { deps.onDirtyChange(value) } catch { /* 脏点回调异常忽略 */ }
  }

  /** 页码指示更新（pagechanging/pagesinit 事件）。 */
  const updatePageLabel = () => {
    if (!pageLabel || !pdfViewer) return
    pageLabel.textContent = pdfViewer.currentPageNumber + ' / ' + pdfViewer.pagesCount
  }

  /** 编辑模式按钮高亮同步（annotationeditormodechanged 事件；evt.mode 为枚举数值）。 */
  const syncModeButtons = (mode) => {
    if (!modeButtons || !editorTypes) return
    const byValue = { [editorTypes.NONE]: 'none', [editorTypes.FREETEXT]: 'freetext', [editorTypes.INK]: 'ink', [editorTypes.HIGHLIGHT]: 'highlight' }
    const key = byValue[mode] ?? 'none'
    for (const k of Object.keys(modeButtons.modes)) {
      modeButtons.modes[k].classList.toggle('edrv-pdf-mode-on', k === key)
    }
  }

  /** 编辑模式符号键 → AnnotationEditorType 数值（版本间枚举值有差异，禁止硬编码）。 */
  const modeValueOf = (key) => {
    if (!editorTypes) return null
    return { none: editorTypes.NONE, freetext: editorTypes.FREETEXT, ink: editorTypes.INK, highlight: editorTypes.HIGHLIGHT }[key] ?? null
  }

  /**
   * 切换编辑模式（进入注释编辑器某模式或退出回 NONE）。
   * @author ddj 2026年09月22号
   * @param key 模式符号键：none/freetext/ink/highlight
   */
  const applyMode = (key) => {
    if (!pdfViewer || !pdfDocument) { status('PDF 未就绪'); return }
    const mode = modeValueOf(key)
    if (mode === null) return
    try {
      pdfViewer.annotationEditorMode = { mode }
      status(key === 'none' ? '已退出编辑' : '编辑模式：' + (key === 'freetext' ? '文本框' : key === 'ink' ? '画笔' : '高亮'))
    } catch (error) {
      status('切换编辑模式失败：' + String(error))
    }
  }

  /**
   * 保存编辑：saveDocument 导出 → base64 → edrv.saveBinary 回写。
   * @author ddj 2026年09月22号
   * @returns Promise<boolean> 是否成功
   */
  const savePdf = async () => {
    if (saving) return false
    if (!pdfDocument) { status('PDF 未就绪'); return false }
    if (!dirty) { status('PDF 无未保存修改'); return true }
    saving = true
    status('正在保存 PDF…')
    try {
      const data = await pdfDocument.saveDocument()
      const res = await rpc('edrv.saveBinary', { sessionId: deps.sessionId, path: deps.path, content: bytesToBase64(data), encoding: 'base64' })
      if (res && res.ok) {
        setDirty(false)
        try { pdfDocument.annotationStorage.resetModified() } catch { /* 重置失败仅影响下次保存判定 */ }
        status('已保存 ' + new Date().toTimeString().slice(0, 8))
        return true
      }
      status('保存失败')
      try { deps.setError(res?.error ? String(res.error) : '保存失败') } catch { /* 错误回调异常忽略 */ }
      return false
    } catch (error) {
      status('保存失败')
      try { deps.setError('PDF 保存异常:' + String(error)) } catch { /* 错误回调异常忽略 */ }
      return false
    } finally {
      saving = false
    }
  }

  /** 工具条 DOM（页码/缩放/编辑模式/保存/刷新）。 */
  const buildToolbar = (root) => {
    const bar = document.createElement('div')
    bar.className = 'edrv-pdf-bar'
    const mkBtn = (text, title, onClick, cls) => {
      const b = document.createElement('button')
      b.className = cls || 'edrv-pill edrv-pill-ghost'
      b.textContent = text
      b.title = title
      b.addEventListener('click', onClick)
      bar.appendChild(b)
      return b
    }
    mkBtn('◀', '上一页', () => { if (pdfViewer) pdfViewer.currentPageNumber = Math.max(1, pdfViewer.currentPageNumber - 1) })
    pageLabel = document.createElement('span')
    pageLabel.className = 'edrv-pdf-page'
    pageLabel.textContent = '…'
    bar.appendChild(pageLabel)
    mkBtn('▶', '下一页', () => { if (pdfViewer) pdfViewer.currentPageNumber = Math.min(pdfViewer.pagesCount, pdfViewer.currentPageNumber + 1) })
    mkBtn('−', '缩小', () => { try { pdfViewer.decreaseScale() } catch { /* 缩放失败忽略 */ } }, 'edrv-pill edrv-pill-ghost edrv-pdf-zoom')
    mkBtn('＋', '放大', () => { try { pdfViewer.increaseScale() } catch { /* 缩放失败忽略 */ } }, 'edrv-pill edrv-pill-ghost edrv-pdf-zoom')
    bar.appendChild(document.createElement('span')).className = 'edrv-pdf-sep'
    const modes = {}
    modes.freetext = mkBtn('✎ 文本框', '插入文本框注释', () => applyMode('freetext'))
    modes.ink = mkBtn('🖌 画笔', '手绘画笔注释', () => applyMode('ink'))
    modes.highlight = mkBtn('🖍 高亮', '高亮选中文本', () => applyMode('highlight'))
    modes.none = mkBtn('☐ 选择', '退出编辑模式', () => applyMode('none'))
    modeButtons = { modes, save: null }
    bar.appendChild(document.createElement('span')).className = 'edrv-pdf-sep'
    mkBtn('⟳', '重新加载文件', () => { try { deps.onReload() } catch { /* 刷新回调异常忽略 */ } })
    modeButtons.save = mkBtn('💾 保存', '保存修改到文件 (Ctrl+S)', () => { void savePdf() })
    root.appendChild(bar)
  }

  /**
   * 挂载面板并加载 PDF 字节。
   * @author ddj 2026年09月22号
   * @param host React 渲染的外壳 div（挂载后保持引用稳定）
   * @param bytes PDF 原始字节
   * @returns Promise<void> 渲染就绪或失败（失败置 deps.setError）
   */
  const mount = async (host, bytes) => {
    try {
      const pdfjs = await loadPdfjs()
      if (destroyed) return
      editorTypes = pdfjs.lib.AnnotationEditorType
      busAbort = new AbortController()
      const onBus = (name, fn) => eventBus.on(name, fn, { signal: busAbort.signal })
      const root = document.createElement('div')
      root.className = 'edrv-pdf'
      buildToolbar(root)
      stage = document.createElement('div')
      stage.className = 'edrv-pdf-stage'
      const viewerDiv = document.createElement('div')
      viewerDiv.className = 'pdfViewer edrv-pdf-viewer'
      stage.appendChild(viewerDiv)
      root.appendChild(stage)
      host.textContent = ''
      host.appendChild(root)

      eventBus = new pdfjs.viewer.EventBus()
      const linkService = new pdfjs.viewer.PDFLinkService({ eventBus })
      pdfViewer = new pdfjs.viewer.PDFViewer({
        container: stage,
        viewer: viewerDiv,
        eventBus,
        linkService,
        l10n: L10N_STUB,
        textLayerMode: 1,
        annotationEditorMode: editorTypes.NONE,
      })
      linkService.setViewer(pdfViewer)
      onBus('pagechanging', updatePageLabel)
      onBus('pagesinit', () => {
        try { pdfViewer.currentScaleValue = 'page-width' } catch { /* 初始缩放失败用默认值 */ }
        updatePageLabel()
      })
      onBus('annotationeditormodechanged', (evt) => syncModeButtons(evt?.mode))

      loadingTask = pdfjs.lib.getDocument({ data: bytes, cMapUrl: PDFJS_CMAP_URL, cMapPacked: true, standardFontDataUrl: PDFJS_FONT_URL })
      pdfDocument = await loadingTask.promise
      if (destroyed) { void loadingTask.destroy(); return }
      const storage = pdfDocument.annotationStorage
      storage.onSetModified = () => setDirty(true)
      storage.onResetModified = () => setDirty(false)
      pdfViewer.setDocument(pdfDocument)
      linkService.setDocument(pdfDocument)
      status('PDF 已就绪（' + pdfDocument.numPages + ' 页）')
    } catch (error) {
      if (destroyed) return
      const message = String((error && (error.message || error.name)) || error)
      const friendly = message.includes('password') ? '不支持加密 PDF' : 'PDF 加载失败：' + message
      status('PDF 加载失败')
      try { deps.setError(friendly) } catch { /* 错误回调异常忽略 */ }
    }
  }

  /** 是否有未保存修改（EditorView Ctrl+S 分派用）。 */
  const isDirty = () => dirty

  /** 销毁：解绑事件、销毁文档与 DOM（重复调用安全）。 */
  const destroy = () => {
    destroyed = true
    try { busAbort?.abort() } catch { /* 已中止 */ }
    try { pdfViewer?.cleanup() } catch { /* 视图已销毁 */ }
    try { void loadingTask?.destroy() } catch { /* 任务已销毁 */ }
    try { void pdfDocument?.destroy() } catch { /* 文档已销毁 */ }
    if (stage?.parentNode) stage.parentNode.removeChild(stage)
    stage = null
    eventBus = null
    busAbort = null
    editorTypes = null
    pdfViewer = null
    pdfDocument = null
    loadingTask = null
    modeButtons = null
  }

  return { mount, destroy, savePdf, isDirty }
}

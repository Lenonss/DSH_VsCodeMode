// @ts-nocheck
/** 行内差异：共享色盘、删除代码高亮与原行号。 @author ddj 2026年10月09号 */
import { detectColorScheme, officialThemeOf, themeNameOf } from './theme.js'

// #region 显示数据
/** @private @author ddj 2026年10月09号 @param regions 待显示区域 @returns 内容敏感且无分隔符碰撞的展示键 */
function renderKey(regions) {
  return JSON.stringify(regions.map((r) => [r.callId, r.idx, r.start, r.end, r.oldStart, r.create, r.oldLines, r.newLines]))
}

/** @private @author ddj 2026年10月09号 @param node 接收样式的节点 @param colors Monaco 颜色 @returns 设置插件局部变量；不覆盖官方令牌 */
function setDiffColors(node, colors) {
  if (!node) return
  node.style.setProperty('--edrv-diff-add', colors['diffEditor.insertedLineBackground'])
  node.style.setProperty('--edrv-diff-del', colors['diffEditor.removedLineBackground'])
  node.style.setProperty('--edrv-diff-fg', colors['editor.foreground'] || '#1e1e1e')
  node.style.setProperty('--edrv-diff-number', colors['editorLineNumber.foreground'] || '#6c6c6c')
}

/** @private @author ddj 2026年10月09号 @param text 源码行 @returns 安全纯文本行；不把源码写入 HTML */
function codeRow(text) {
  const row = document.createElement('div')
  row.className = 'edrv-del-row'
  const span = document.createElement('span')
  span.className = 'edrv-del-text'
  span.textContent = text
  row.appendChild(span)
  return row
}

/** @private @author ddj 2026年10月09号 @param line 原行号（缺失则占位） @returns 旧行号与减号行 */
function marginRow(line) {
  const row = document.createElement('div')
  row.className = 'edrv-del-margin-row'
  const number = document.createElement('span')
  number.className = 'edrv-del-number'
  number.textContent = line === undefined ? '·' : String(line)
  if (line === undefined) number.title = '历史记录缺少可验证的原行号'
  const marker = document.createElement('span')
  marker.className = 'edrv-del-marker'
  marker.textContent = '−'
  row.appendChild(number)
  row.appendChild(marker)
  return row
}

/** @private @author ddj 2026年10月09号 @param region 差异区域 @returns 正文与边栏节点；Monaco 管理两者滚动 */
function zoneOf(region) {
  const domNode = document.createElement('div')
  domNode.className = 'edrv-del-zone'
  domNode.dataset.edrvHunk = String(region.callId) + ':' + region.idx
  const marginDomNode = document.createElement('div')
  marginDomNode.className = 'edrv-del-margin'
  const rows = []
  for (let index = 0; index < region.oldLines.length; index++) {
    const row = codeRow(region.oldLines[index])
    domNode.appendChild(row)
    rows.push(row.firstChild)
    marginDomNode.appendChild(marginRow(region.oldStart === undefined ? undefined : region.oldStart + index))
  }
  return { domNode, marginDomNode, rows, lines: region.oldLines, after: Math.max(0, region.start - 1) }
}
// #endregion

/**
 * 每个编辑器视图一个渲染器；持有并释放装饰、区域与监听。
 * @public @author ddj 2026年10月09号
 * @param log 诊断日志函数（失败不影响展示）
 * @returns render、refresh 与 dispose；不修改审查决策或编辑器模型
 */
export function createDiffRenderer(log) {
  let owner = null
  let api = null
  let model = null
  let language = null
  let session = null
  let pending = []
  let zones = []
  let decorations = []
  let listeners = []
  let lastKey = null
  let generation = 0
  let theme = themeNameOf()

  // #region 生命周期
  /** @private @author ddj 2026年10月09号 清除区域与异步代次；保留编辑器和监听以便刷新。 */
  function clear() {
    generation++
    lastKey = null
    if (owner) {
      try { decorations = owner.deltaDecorations(decorations, []) } catch { decorations = [] }
      /** @author ddj 2026年10月09号 @param accessor Monaco 区域事务 */
      function removeZones(accessor) {
        for (const zone of zones) accessor.removeZone(zone.id)
      }
      try { owner.changeViewZones(removeZones) } catch { /* 编辑器可能已销毁。 */ }
    }
    zones = []
  }

  /** @public @author ddj 2026年10月09号 释放所有本渲染器拥有的资源；允许之后重新绑定。 */
  function dispose() {
    for (const listener of listeners) listener.dispose()
    listeners = []
    clear()
    owner = model = api = null
    pending = []
  }

  /** @private @author ddj 2026年10月09号 模型切换时丢弃旧区域，等待 React 提供新模型的区域。 */
  function modelChanged() {
    clear()
    model = owner.getModel()
    pending = []
  }

  /** @private @author ddj 2026年10月09号 @param monaco Monaco API @param editor 编辑器；只订阅一次 */
  function bind(monaco, editor) {
    if (owner === editor) return
    dispose()
    owner = editor
    api = monaco
    for (const event of ['onDidChangeConfiguration', 'onDidChangeModelLanguage', 'onDidChangeModelOptions']) {
      if (typeof owner[event] === 'function') listeners.push(owner[event](refresh))
    }
    if (owner.onDidLayoutChange) listeners.push(owner.onDidLayoutChange(reflow))
    if (owner.onDidChangeModel) listeners.push(owner.onDidChangeModel(modelChanged))
    if (owner.onDidDispose) listeners.push(owner.onDidDispose(dispose))
  }
  // #endregion

  // #region 着色与布局
  /** @private @author ddj 2026年10月09号 @param zone 删除区域 @param epoch 发起代次；拒绝旧模型、语言和主题结果 */
  async function colorZone(zone, epoch) {
    if (typeof api.editor.colorize !== 'function') return
    const sourceModel = model
    const sourceLang = language
    const sourceTheme = theme
    const tabSize = sourceModel.getOptions?.().tabSize || 4
    try {
      const html = await api.editor.colorize(zone.lines.join('\n'), sourceLang, { tabSize })
      if (epoch !== generation || owner?.getModel() !== sourceModel || sourceModel.getLanguageId() !== sourceLang || theme !== sourceTheme) return
      // Monaco 生成的 HTML 已转义源码；逐行分配仅使用其输出，不拼接用户源码。
      const lines = html.split(/<br\s*\/?\s*>/i)
      if (lines.length === zone.rows.length + 1 && lines.at(-1) === '') lines.pop()
      if (lines.length !== zone.rows.length) return
      for (let index = 0; index < lines.length; index++) zone.rows[index].innerHTML = lines[index]
    } catch { /* 保留立即显示的安全纯文本。 */ }
  }

  /** @private @author ddj 2026年10月09号 @param zone 区域 @param colors 当前主题颜色；跟随 Monaco 实际字体/布局 */
  function layoutZone(zone, colors) {
    const layout = owner.getLayoutInfo()
    const font = owner.getOption(api.editor.EditorOption.fontInfo)
    const lineHeight = owner.getOption(api.editor.EditorOption.lineHeight) || 20
    const tabSize = model.getOptions?.().tabSize || 4
    owner.applyFontInfo?.(zone.domNode)
    owner.applyFontInfo?.(zone.marginDomNode)
    setDiffColors(zone.domNode, colors)
    setDiffColors(zone.marginDomNode, colors)
    zone.domNode.style.setProperty('--edrv-line-height', lineHeight + 'px')
    zone.domNode.style.tabSize = String(tabSize)
    zone.marginDomNode.style.setProperty('--edrv-line-height', lineHeight + 'px')
    zone.marginDomNode.style.setProperty('--edrv-number-left', layout.lineNumbersLeft + 'px')
    zone.marginDomNode.style.setProperty('--edrv-number-width', layout.lineNumbersWidth + 'px')
    zone.marginDomNode.style.setProperty('--edrv-marker-left', layout.decorationsLeft + 'px')
    zone.marginDomNode.style.setProperty('--edrv-marker-width', layout.decorationsWidth + 'px')
    let width = 0
    for (const line of zone.lines) width = Math.max(width, line.replace(/\t/g, ' '.repeat(tabSize)).length)
    // 中文/宽字符不能按半宽估算；宁可保留余量，也不截断旧代码横向滚动范围。
    const charWidth = Math.max(font?.typicalHalfwidthCharacterWidth || 8, font?.typicalFullwidthCharacterWidth || 0)
    return width * charWidth + 24
  }

  /** @private @author ddj 2026年10月09号 容器大小变化只更新边栏几何，不重新着色/重建区域。 */
  function reflow() {
    if (!owner || !model) return
    const colors = officialThemeOf(detectColorScheme()).colors
    for (const zone of zones) layoutZone(zone, colors)
  }

  /** @private @author ddj 2026年10月09号 @param accessor Monaco 区域事务 @param colors 共享色盘 */
  function addZones(accessor, colors) {
    for (const region of pending) {
      if (region.create || region.start === undefined || !region.oldLines?.length) continue
      const zone = zoneOf(region)
      const minWidthInPx = layoutZone(zone, colors)
      zone.id = accessor.addZone({
        afterLineNumber: zone.after, heightInLines: zone.lines.length,
        domNode: zone.domNode, marginDomNode: zone.marginDomNode,
        minWidthInPx, suppressMouseDown: false,
      })
      zones.push(zone)
      void colorZone(zone, generation)
    }
  }

  /** @private @author ddj 2026年10月09号 @returns 新增行整行背景和加号装饰 */
  function addDecorations() {
    const out = []
    for (const region of pending) {
      if (region.start === undefined || region.end === undefined || !region.newLines?.length) continue
      out.push({
        range: new api.Range(region.start, 1, Math.max(region.start, region.end - 1), 1),
        options: { isWholeLine: true, className: 'edrv-mn-add-line', marginClassName: 'edrv-mn-add-line', linesDecorationsClassName: 'edrv-mn-gutter-add' },
      })
    }
    return out
  }
  // #endregion

  // #region 渲染入口
  /** @private @author ddj 2026年10月09号 按内容/模型/语言展示；空区域也能清除残留。 */
  function paint() {
    if (!owner) return
    const nextModel = owner.getModel()
    if (!nextModel) { clear(); return }
    const nextLang = nextModel.getLanguageId()
    const key = renderKey(pending)
    if (lastKey === key && model === nextModel && language === nextLang) return
    clear()
    model = nextModel
    language = nextLang
    lastKey = key
    const colors = officialThemeOf(detectColorScheme()).colors
    setDiffColors(owner.getDomNode(), colors)
    decorations = owner.deltaDecorations([], addDecorations())
    /** @author ddj 2026年10月09号 @param accessor Monaco 区域事务 */
    function mountZones(accessor) { addZones(accessor, colors) }
    owner.changeViewZones(mountZones)
    try { log?.(session, '[diff-render] regions=' + pending.length + ' zones=' + zones.length) } catch { /* 诊断不可影响渲染。 */ }
  }

  /** @public @author ddj 2026年10月09号 @param themeId 新应用的主题名（事件参数不作为主题名） 更新字体、语言或主题后重新着色。 */
  function refresh(themeId) {
    if (typeof themeId === 'string') theme = themeId
    lastKey = null
    paint()
  }

  /** @public @author ddj 2026年10月09号 @param monaco Monaco API @param editor 编辑器 @param regions 待显示区域 @param sessionId 会话 id */
  function render(monaco, editor, regions, sessionId) {
    bind(monaco, editor)
    pending = regions
    session = sessionId
    paint()
  }
  // #endregion
  return { render, refresh, dispose }
}

// @ts-nocheck
/**
 * dsh-vscode-mode client — 只读并排差异视图（Monaco createDiffEditor 的通用封装）。
 *
 * 三处共用同一实现，避免各自处理 Monaco 的 model 生命周期与已知坑：
 * - P2 基线差异（BASE ↔ 工作区）
 * - P3 版本差异（REV-1 ↔ REV）
 * - P4 提交前预览（工作区 ↔ 即将提交内容，届时按需扩展）
 *
 * 关键实现要点（来自 P2 实测）：
 * - 复用既有 Monaco 单例（与编辑器同实例，主题跟随官方令牌），不占编辑器自身 model
 * - URI 必须先去前导 `/`：`'scheme:///' + '/abs'` 会拼出四斜杠 → Uri.parse 抛错 → 白屏
 * - 只销毁本视图创建的 model，复用到的留给下次打开（避免闪烁/重建）
 * - 左侧为 null 时不建编辑器，只显示说明（新增文件的正常语义，不是错误）
 *
 * 作者 ddj 2026年09月16号
 */
import React from 'react'
import { langOf } from '../monaco/loader.js'
import { themeNameOf } from '../monaco/theme.js'

/**
 * 构造 model URI（对齐 EditorView.getModel 的 edrv URI 约定；路径剥前导斜杠防四斜杠）。
 * @author ddj 2026年09月16号
 * @param scheme URI scheme
 * @param path 文件路径
 * @param side 侧别（同文件不同侧需不同 scheme，避免 model 冲突）
 * @returns Monaco Uri
 */
function uriOf(scheme, path, side) {
  return window.monaco.Uri.parse(scheme + '-' + side + ':///' + encodeURI(String(path ?? '').replace(/^\/+/, '')))
}

/**
 * 取（或建）指定 URI 的只读 model：命中则更新内容复用，未命中则创建。
 * @author ddj 2026年09月16号
 * @param monaco Monaco 实例
 * @param uri 目标 URI
 * @param text 内容
 * @param language Monaco language id
 * @param created 本视图创建的 model 收集器（卸载时只销毁自己建的）
 * @returns model
 */
function modelFor(monaco, uri, text, language, created) {
  const existing = monaco.editor.getModel(uri)
  if (existing) {
    existing.setValue(text)
    return existing
  }
  const model = monaco.editor.createModel(text, language, uri)
  created.push(model)
  return model
}

/**
 * 差异视图选项（W1-1：选项条驱动的非破坏视图开关）。
 */
export interface DiffViewOpts {
  /** 忽略行尾空白差异（Monaco 默认 true；关掉后行尾空格增删会算差异）。 */
  trimWhitespace?: boolean
  /** 折叠未变更区域（仅显示差异及其上下文；Monaco vendor 已支持，默认关）。 */
  hideUnchanged?: boolean
  /** 喂 model 前 EOL 规范化（CRLF/CR → LF；仅影响展示，不改变文件）。 */
  eolNormalize?: boolean
}

/** 选项条默认值（与 Monaco 默认一致：不勾选时现状行为不变）。 */
export const DEFAULT_DIFF_VIEW_OPTS = { trimWhitespace: true, hideUnchanged: false, eolNormalize: false }

/**
 * 比较前 EOL 规范化（W1-1）：CRLF/CR → LF。混合换行会让 Monaco 把每行都判差；
 * 规范化不改变行数，顶部跳转与统计行号不受影响。
 * @author ddj 2026年09月20号
 * @param text 原始文本
 * @returns 规范化后的文本（非字符串原样返回）
 */
export function normalizeEolOf(text) {
  return typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : text
}

/**
 * 差异行数统计（W1-3）：从 getLineChanges 清单聚合 +新增/修改行 与 −删除/修改行
 * （git diff --stat 口径：修改行两侧各计；纯增删只计存在的一侧）。
 * @author ddj 2026年09月20号
 * @param changes Monaco diff 的行变更清单（ILineChange[]）
 * @returns {{ added: number, deleted: number }} 行数统计
 */
export function diffStatsOf(changes) {
  let added = 0
  let deleted = 0
  for (const change of changes || []) {
    const origStart = Number(change?.originalStartLineNumber) || 1
    const origEnd = Number(change?.originalEndLineNumber) || 0
    const modStart = Number(change?.modifiedStartLineNumber) || 1
    const modEnd = Number(change?.modifiedEndLineNumber) || 0
    if (origEnd >= origStart) deleted += origEnd - origStart + 1
    if (modEnd >= modStart) added += modEnd - modStart + 1
  }
  return { added, deleted }
}

/**
 * 构造只读并排差异编辑器选项（集中一处，供单测守护）。
 * 差异视觉三要素：renderIndicators 行首 +/- 指示符、lineDecorationsWidth 给指示符留足宽度
 * （8px 会把 16px 的 codicon 裁没）、renderOverviewRuler 滚动条变化色标。
 * W1-1 增补视图开关：缺省行为与 Monaco 默认一致（行尾空白忽略开、折叠未变更关）。
 * @author ddj 2026年09月18号 / 2026年09月20号
 * @param themeName Monaco 主题 id
 * @param viewOpts 差异视图选项（缺省 = 默认视图行为）
 * @returns createDiffEditor 选项对象
 */
export function diffOptsOf(themeName, viewOpts) {
  return {
    theme: themeName,
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    renderIndicators: true,
    lineDecorationsWidth: 22,
    // 只读审阅：不要 minimap/字形栏等编辑态附属物
    minimap: { enabled: false },
    glyphMargin: false,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderOverviewRuler: true,
    wordWrap: 'off',
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 6 },
    // W1-1 视图开关：行尾空白忽略 + 折叠未变更区（对象缺省字段回落 Monaco 内建默认值）
    ignoreTrimWhitespace: !viewOpts || viewOpts.trimWhitespace !== false,
    hideUnchangedRegions: { enabled: Boolean(viewOpts && viewOpts.hideUnchanged === true) },
  }
}

/**
 * 挂载只读并排差异编辑器；返回 { diff, dispose }（diff 供顶部快速跳转使用）。
 * @author ddj 2026年09月16号 / 2026年09月18号 / 2026年09月20号
 * @param props.host 宿主 DOM 节点
 * @param props.monaco Monaco 实例
 * @param props.path 文件路径（决定语法高亮与 model URI）
 * @param props.left 左侧内容（null 表示该侧无内容）
 * @param props.right 右侧内容
 * @param props.scheme model URI scheme 前缀（区分不同来源，避免跨视图复用串内容）
 * @param props.viewOpts 差异视图选项（W1-1：EOL 规范化/行尾空白/折叠未变更）
 * @returns {{ diff: object, dispose: () => void }} diff 编辑器实例与卸载函数
 */
export function mountSideBySide(props) {
  const { host, monaco, path, left, right, scheme = 'edrv-diff', viewOpts } = props
  const created = []
  const language = langOf(path)
  // W1-1：EOL 规范化开关只影响喂给 model 的展示文本（不落盘），行数不变故导航不受影响
  const eolOn = viewOpts?.eolNormalize === true
  const leftText = eolOn ? normalizeEolOf(left ?? '') : (left ?? '')
  const rightText = eolOn ? normalizeEolOf(right ?? '') : (right ?? '')
  const leftModel = modelFor(monaco, uriOf(scheme, path, 'left'), leftText, language, created)
  const rightModel = modelFor(monaco, uriOf(scheme, path, 'right'), rightText, language, created)
  const diff = monaco.editor.createDiffEditor(host, diffOptsOf(themeNameOf(), viewOpts))
  diff.setModel({ original: leftModel, modified: rightModel })
  return {
    diff,
    dispose: () => {
      try { diff.dispose() } catch (error) { /* 已随宿主卸载 */ }
      for (const model of created) {
        try { model.dispose() } catch (error) { /* 已被其他持有者销毁 */ }
      }
    },
  }
}

/**
 * 计算差异跳转目标侧与行区间（有修改侧行走修改侧；纯删除/空修改落原侧；
 * inline 单栏模式下原侧是折叠残留，纯删除改为滚到修改侧的删除块锚点行）。
 * @author ddj 2026年09月18号
 * @param change getLineChanges 的单条（original/modified 的 Start/EndLineNumber）
 * @param inline 是否 inline 单栏模式（缺省按并排处理）
 * @returns {{ side: string, start: number, end: number }} side ∈ 'modified' | 'original'
 */
export function navTargetOf(change, inline) {
  const modStart = Number(change?.modifiedStartLineNumber) || 0
  const modEnd = Number(change?.modifiedEndLineNumber) || 0
  if (modEnd > 0 && modEnd >= modStart) return { side: 'modified', start: Math.max(1, modStart), end: modEnd }
  if (inline) {
    const anchor = Math.max(1, modStart)
    return { side: 'modified', start: anchor, end: anchor }
  }
  const origStart = Math.max(1, Number(change?.originalStartLineNumber) || 1)
  const origEnd = Math.max(origStart, Number(change?.originalEndLineNumber) || origStart)
  return { side: 'original', start: origStart, end: origEnd }
}

/**
 * 渲染差异条快速跳转簇（↑ i/N ↓；无差异时 0/0 且禁用，形态对齐自研审查条）。
 * @author ddj 2026年09月18号
 * @param nav 导航状态 { list: 差异清单, idx: 当前下标 }
 * @param onStep 步进回调（传入 ±1）
 * @returns 导航簇元素
 */
function navClusterEl(nav, onStep) {
  const total = nav.list.length
  return React.createElement('span', { className: 'edrv-svndiff-nav' },
    React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '上一个差异', disabled: !total, onClick: () => onStep(-1) }, '↑'),
    React.createElement('span', { className: 'edrv-svndiff-nav-count', title: '差异位置' }, total ? (nav.idx + 1) + '/' + total : '0/0'),
    React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '下一个差异', disabled: !total, onClick: () => onStep(1) }, '↓'))
}

/**
 * 选项条开关元素（W1-1：复用面板 checkbox 形态，紧凑放置差异条右端）。
 * @author ddj 2026年09月20号
 * @param key DiffViewOpts 键（trimWhitespace/hideUnchanged/eolNormalize）
 * @param label 开关文案
 * @param title tooltip 说明
 * @param viewOpts 当前选项
 * @param onToggle 切换回调（传入 key）
 * @returns label 元素
 */
function optCheckEl(key, label, title, viewOpts, onToggle) {
  return React.createElement('label', { className: 'edrv-svn-check edrv-svndiff-opt', title },
    React.createElement('input', {
      type: 'checkbox',
      checked: Boolean(viewOpts[key]),
      onChange: () => onToggle(key),
    }), label)
}

/**
 * 差异统计徽标元素（W1-3：+新增/修改 −删除/修改；无差异时不渲染）。
 * @author ddj 2026年09月20号
 * @param stats diffStatsOf 结果
 * @returns 元素或 null
 */
function statsEl(stats) {
  if (!stats.added && !stats.deleted) return null
  return React.createElement('span', {
    className: 'edrv-svndiff-stat',
    title: '差异行数：+新增/修改行 −删除/修改行（git diff --stat 口径）',
  },
    React.createElement('span', { className: 'edrv-svndiff-stat-add' }, '+' + stats.added),
    React.createElement('span', { className: 'edrv-svndiff-stat-del' }, '-' + stats.deleted))
}

/**
 * 只读并排差异视图（编辑器主体内的一个分支，非弹窗）。
 * @author ddj 2026年09月16号 / 2026年09月20号
 * @param props.monaco Monaco 实例（未就绪为 null，显示加载态）
 * @param props.path 文件路径
 * @param props.left 左侧内容（null = 无内容）
 * @param props.right 右侧内容
 * @param props.title 标题（通常为路径）
 * @param props.leftLabel 左侧标签（如「BASE」「r12」）
 * @param props.rightLabel 右侧标签（如「工作区」「r13」）
 * @param props.emptyNote 左侧无内容时的说明
 * @param props.message 补充说明
 * @param props.scheme model URI scheme 前缀
 * @param props.onBack 返回来源视图的回调（提供时渲染「← 返回日志」按钮）
 * @param props.onClose 关闭回调
 * @returns 差异视图元素
 */
export function SideBySideDiff(props) {
  const {
    monaco, path, left, right, title, leftLabel, rightLabel, emptyNote, message, scheme, onBack, onClose,
  } = props
  const hostRef = React.useRef(null)
  const diffRef = React.useRef(null)
  const [nav, setNav] = React.useState({ list: [], idx: 0 })
  // W1-1 视图选项：会话内状态（不持久化），切换经 mount/dispose 链重建编辑器
  const [viewOpts, setViewOpts] = React.useState(DEFAULT_DIFF_VIEW_OPTS)

  React.useEffect(() => {
    const host = hostRef.current
    if (!monaco || !host) return undefined
    const mounted = mountSideBySide({ host, monaco, path, left, right, scheme, viewOpts })
    diffRef.current = mounted.diff
    // diff 计算完成后取变更清单，驱动顶部 ↑ i/N ↓ 快速跳转
    const listener = mounted.diff.onDidUpdateDiff(() => {
      const list = mounted.diff.getLineChanges() || []
      setNav((prev) => ({ list, idx: Math.min(prev.idx, Math.max(0, list.length - 1)) }))
    })
    return () => {
      try { listener.dispose() } catch (error) { /* 随 diff 一并销毁 */ }
      diffRef.current = null
      mounted.dispose()
    }
  }, [monaco, path, left, right, scheme, viewOpts])

  /** 切换一个视图选项开关（W1-1）。 */
  const toggleOpt = (key) => setViewOpts((prev) => ({ ...prev, [key]: !prev[key] }))

  /** 顶部快速跳转：按 ±1 循环步进并滚动到对应差异处（inline 模式纯删除锚到修改侧）。 */
  const stepDiff = (delta) => {
    const diff = diffRef.current
    const total = nav.list.length
    if (!diff || !total) return
    const idx = (nav.idx + delta + total) % total
    setNav({ list: nav.list, idx })
    // DiffEditor 无 getDomNode：从自家宿主节点取 widget 根，按 side-by-side 类判定模式
    const diffRoot = hostRef.current?.querySelector('.monaco-diff-editor')
    const inline = diffRoot ? !diffRoot.classList.contains('side-by-side') : false
    const target = navTargetOf(nav.list[idx], inline)
    const editor = target.side === 'modified' ? diff.getModifiedEditor() : diff.getOriginalEditor()
    try { editor.revealLinesInCenter(target.start, target.end) } catch (error) { /* 区间异常忽略 */ }
  }

  const noLeft = left === null || left === undefined
  const noRight = right === null || right === undefined

  return React.createElement('div', { className: 'edrv-svndiff' },
    React.createElement('div', { className: 'edrv-svndiff-bar' },
      (onBack ? React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '返回 SVN 日志', onClick: onBack }, '← 返回日志') : null),
      navClusterEl(nav, stepDiff),
      statsEl(diffStatsOf(nav.list)),
      React.createElement('span', { className: 'edrv-svndiff-title', title: title ?? path }, String(title ?? path ?? '')),
      React.createElement('span', { className: 'edrv-svndiff-tag' }, (leftLabel || '左') + ' ↔ ' + (rightLabel || '右')),
      (message ? React.createElement('span', { className: 'edrv-svndiff-tag' }, String(message)) : null),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('div', { className: 'edrv-svndiff-opts' },
        optCheckEl('trimWhitespace', '行尾空白', '忽略行尾空白差异（对齐 svn diff -x --ignore-space-at-eol；Monaco 默认开启）', viewOpts, toggleOpt),
        optCheckEl('hideUnchanged', '折叠未变更', '折叠未变更区域，仅显示差异及其上下文', viewOpts, toggleOpt),
        optCheckEl('eolNormalize', 'EOL 规范化', '比较前把 CRLF/CR 规范化为 LF（仅影响展示；混合换行文件整行标差时勾选）', viewOpts, toggleOpt)),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '关闭差异视图', onClick: onClose }, '✕ 关闭')),
    ((noLeft && noRight) || !monaco
      ? React.createElement('div', { className: 'edrv-svndiff-empty' }, emptyNote || '无可比较内容')
      : React.createElement('div', { ref: hostRef, className: 'edrv-svndiff-host' })))
}

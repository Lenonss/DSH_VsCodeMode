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
 * 挂载只读并排差异编辑器；返回卸载函数。
 * @author ddj 2026年09月16号
 * @param props.host 宿主 DOM 节点
 * @param props.monaco Monaco 实例
 * @param props.path 文件路径（决定语法高亮与 model URI）
 * @param props.left 左侧内容（null 表示该侧无内容）
 * @param props.right 右侧内容
 * @param props.scheme model URI scheme 前缀（区分不同来源，避免跨视图复用串内容）
 * @returns 卸载函数
 */
export function mountSideBySide(props) {
  const { host, monaco, path, left, right, scheme = 'edrv-diff' } = props
  const created = []
  const language = langOf(path)
  const leftModel = modelFor(monaco, uriOf(scheme, path, 'left'), left ?? '', language, created)
  const rightModel = modelFor(monaco, uriOf(scheme, path, 'right'), right ?? '', language, created)
  const diff = monaco.editor.createDiffEditor(host, {
    theme: themeNameOf(),
    readOnly: true,
    originalEditable: false,
    renderSideBySide: true,
    // 只读审阅：不要 minimap/字形栏等编辑态附属物
    minimap: { enabled: false },
    glyphMargin: false,
    lineDecorationsWidth: 8,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    renderOverviewRuler: false,
    wordWrap: 'off',
    fontSize: 13,
    lineHeight: 20,
    padding: { top: 6 },
  })
  diff.setModel({ original: leftModel, modified: rightModel })
  return () => {
    try { diff.dispose() } catch (error) { /* 已随宿主卸载 */ }
    for (const model of created) {
      try { model.dispose() } catch (error) { /* 已被其他持有者销毁 */ }
    }
  }
}

/**
 * 只读并排差异视图（编辑器主体内的一个分支，非弹窗）。
 * @author ddj 2026年09月16号
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
 * @param props.onClose 关闭回调
 * @returns 差异视图元素
 */
export function SideBySideDiff(props) {
  const {
    monaco, path, left, right, title, leftLabel, rightLabel, emptyNote, message, scheme, onClose,
  } = props
  const hostRef = React.useRef(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!monaco || !host) return undefined
    return mountSideBySide({ host, monaco, path, left, right, scheme })
  }, [monaco, path, left, right, scheme])

  const noLeft = left === null || left === undefined
  const noRight = right === null || right === undefined

  return React.createElement('div', { className: 'edrv-svndiff' },
    React.createElement('div', { className: 'edrv-svndiff-bar' },
      React.createElement('span', { className: 'edrv-svndiff-title', title: title ?? path }, String(title ?? path ?? '')),
      React.createElement('span', { className: 'edrv-svndiff-tag' }, (leftLabel || '左') + ' ↔ ' + (rightLabel || '右')),
      (message ? React.createElement('span', { className: 'edrv-svndiff-tag' }, String(message)) : null),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '关闭差异视图', onClick: onClose }, '✕ 关闭')),
    ((noLeft && noRight) || !monaco
      ? React.createElement('div', { className: 'edrv-svndiff-empty' }, emptyNote || '无可比较内容')
      : React.createElement('div', { ref: hostRef, className: 'edrv-svndiff-host' })))
}

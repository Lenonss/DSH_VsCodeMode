/**
 * dsh-vscode-mode client — 非 UTF-8 文件的可编辑查看器。
 * 按检测到的编码解码后用 Monaco 打开（坏字节显示为 U+FFFD）：可以改，但保存前必须把占位都处理掉，
 * 否则拒绝写盘——解码文本写回会把坏字节永久覆盖。
 * 作者 ddj 2026-11-21
 */
import React from 'react'
import { langOf, loadMonaco } from '../monaco/loader.js'
import type { EncodingVerdict } from '../../textEncoding.js'
import { kindLabelOf, lossyCountOf } from '../../textEncoding.js'
import { commitText, previewText } from '../textCompat.js'

/** 查看器属性。 */
export interface CompatTextViewProps {
  sessionId: string
  path: string
  verdict: EncodingVerdict
  version: string
  canRepair: boolean
  onBack: () => void
  onRepair: () => void
  onSaved: () => void
}

/**
 * 可编辑只读边界：允许改，保存走「占位清零」校验。
 * @public @author ddj 2026年11月21号
 * @param props 会话、路径、判定与回调
 * @returns 查看器元素
 */
export function CompatTextView(props: CompatTextViewProps) {
  const hostRef = React.useRef(null)
  const modelRef = React.useRef<{ getValue: () => string } | null>(null)
  const [notice, setNotice] = React.useState('按 ' + kindLabelOf(props.verdict.kind) + ' 解码中…')
  const [dirty, setDirty] = React.useState(false)
  const [lossy, setLossy] = React.useState(0)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let disposed = false
    let view: { dispose: () => void; onDidChangeModelContent: (fn: () => void) => void } | null = null
    let model: { getValue: () => string; dispose: () => void } | null = null
    previewText(props.sessionId, props.path).then(async (result) => {
      if (disposed) return
      if (!result.ok) { setNotice('解码失败：' + result.error); return }
      const monaco = await loadMonaco(() => {})
      if (disposed || !hostRef.current || !monaco) return
      const createdModel = monaco.editor.createModel(result.text, langOf(props.path))
      const createdView = monaco.editor.create(hostRef.current, {
        model: createdModel, automaticLayout: true, minimap: { enabled: false },
        scrollBeyondLastLine: false, fontSize: 12, lineNumbers: 'on',
      })
      model = createdModel
      view = createdView
      modelRef.current = createdModel
      setLossy(lossyCountOf(result.text))
      createdView.onDidChangeModelContent(() => {
        if (disposed) return
        setDirty(true)
        setLossy(lossyCountOf(createdModel.getValue()))
      })
      setNotice('按 ' + kindLabelOf(props.verdict.kind) + ' 解码 · 可编辑；保存时才写盘')
    }).catch((failure) => { if (!disposed) setNotice('解码失败：' + String(failure)) })

    return () => { disposed = true; modelRef.current = null; if (view) view.dispose(); if (model) model.dispose() }
  }, [props.sessionId, props.path])

  /** @private @author ddj 2026年11月21号 @returns 保存编辑结果；占位未清时由宿主拒绝 */
  function save() {
    const model = modelRef.current
    if (!model || saving) return
    setSaving(true)
    setError(null)
    void commitText(props.sessionId, props.path, props.version, model.getValue()).then((result) => {
      setSaving(false)
      if (!result.ok) { setError(result.error); return }
      props.onSaved()
    })
  }

  const blocked = lossy > 0
  return React.createElement('div', { className: 'edrv-compat-view' },
    React.createElement('div', { className: 'edrv-compat-bar' },
      React.createElement('span', null, error === null ? notice : '保存失败：' + error),
      blocked ? React.createElement('span', { style: { color: '#dc2626' } }, '还有 ' + lossy + ' 处乱码占位未处理') : null,
      React.createElement('span', { className: 'edrv-compat-bar-grow' }),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-keep',
        disabled: saving || !dirty || blocked,
        onClick: save,
      }, '保存为 UTF-8'),
      props.canRepair
        ? React.createElement('button', { className: 'edrv-pill', onClick: props.onRepair }, '按推荐方式修复')
        : null,
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', onClick: props.onBack }, '返回诊断')),
    React.createElement('div', { ref: hostRef, className: 'edrv-compat-stage' }))
}

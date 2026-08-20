// @ts-nocheck
/**
 * @dsh-external/dsh-edit-review — 类 VSCode 的 Agent 文件编辑器（Client 半）
 * 挂点：conversation.view「文件编辑」页签（中央编辑器，Monaco 驱动，顶部=文件页签+搜索框）
 *      + conversation.session.header.utilities（差异角标，仅当前工作区存在差异时显示）。
 * 差异 UI 收敛为圆角悬浮框（交修要求）：
 *   - DiffBox：每个已打开且有差异的文件底部挂一个圆角矩形悬浮框（per-file hunk 采纳/不采纳/跳转/回滚/对比）；
 *   - DiffLauncher：全局差异总览 + 归档 的圆角下拉（statusbar 差异 chip / header 角标触发）；
 *   - 不再自动打开全部差异文件——差异文件只在用户手动操作（搜索框、DiffBox「其他差异文件」、Launcher、header 角标）时作为页签打开并定位。
 * 顶部 UI 只有文件页签 + 搜索框（QuickOpen / Ctrl+P）。
 * 与 Host 通信：同源 fetch('/edrv/rpc')。
 * 作者 ddj 2026-08-18
 */
import React from 'react'

export const inject = ['slots', 'timer', 'layout']

const ST = { PENDING: 'pending', ACCEPTED: 'accepted', REJECTED: 'rejected' }

function rpc(method, args) {
  return fetch('/edrv/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args })
  }).then((res) => res.json())
}

/**
 * 诊断日志：统一走 host edrv.debug 落盘，避免 console 刷屏。
 * @author ddj 2026年08月19号
 * @param {string} sessionId 会话 id
 * @param {string} text 日志文本
 */
function dbg(sessionId, text) {
  try {
    rpc('edrv.debug', { sessionId, text }).catch(() => {})
  } catch (e) { /* 日志失败忽略 */ }
}

function callIdAttr(callId, idx) { return String(callId) + ':' + String(idx) }

function statusAt(rec, idx) {
  if (!rec) return ST.PENDING
  if (Array.isArray(rec.decisions?.perHunk) && rec.decisions.perHunk[idx] !== undefined) return rec.decisions.perHunk[idx]
  return rec.decisions?.call ?? ST.PENDING
}

/** hunk 是否为空差异（old===new，无实际内容变化，不可操作）。create 记录不视为空差异。 */
function noopHunk(rec, h) {
  if (!rec || rec.create === true) return false
  const precise = rec.toolName === 'edit' && rec.callHunk ? rec.callHunk : h
  const oldText = precise?.oldText ?? null
  const newText = precise?.newText ?? null
  return oldText !== null && oldText === newText
}

/** 记录是否仍有待处理差异（superseded / 全部已决策 = false）。 */
function isRecPending(rec) {
  if (!rec || rec.superseded === true) return false
  const dec = rec.decisions || {}
  const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
  if (perHunk.length) {
    // 只认存在至少一个"非空差异且未决策"的 hunk
    for (let i = 0; i < perHunk.length; i++) {
      if (perHunk[i] !== 'accepted' && perHunk[i] !== 'rejected' && !noopHunk(rec, (rec.hunks || [])[i])) return true
    }
    return false
  }
  return dec.call === 'pending' || dec.call === undefined
}

/** 记录待处理差异"处"数（按 hunk，跳过空差异）。 */
function pendingCount(recs) {
  let n = 0
  for (const rec of recs) {
    if (!isRecPending(rec)) continue
    const dec = rec.decisions || {}
    const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
    if (perHunk.length) {
      for (let i = 0; i < perHunk.length; i++) {
        if (perHunk[i] === 'pending' && !noopHunk(rec, (rec.hunks || [])[i])) n++
      }
    } else {
      const hunks = Array.isArray(rec.hunks) ? rec.hunks : []
      for (const h of hunks) if (!noopHunk(rec, h)) n++
      if (!hunks.length && !noopHunk(rec, rec.callHunk)) n = Math.max(n, 1)
    }
  }
  return n
}

/** 按文件分组的差异摘要（角标/Launcher 用）。 */
function summarize(records) {
  const byPath = new Map()
  for (const r of records) {
    if (!byPath.has(r.path)) byPath.set(r.path, [])
    byPath.get(r.path).push(r)
  }
  const files = []
  for (const [path, recs] of byPath) files.push({ path, recs, pending: pendingCount(recs) })
  files.sort((a, b) => (a.path < b.path ? -1 : 1))
  const pendingFiles = files.filter((f) => f.pending > 0)
  return { files, pendingFiles, totalFiles: pendingFiles.length }
}

function btn(accept) {
  return { fontSize: 11, padding: '1px 8px', border: '1px solid var(--dsw-alias-border-l2,#555)', borderRadius: 4, cursor: 'pointer', background: 'var(--dsw-alias-bg-layer-1,transparent)', color: accept ? 'var(--dsw-alias-state-success-primary,#2e9e44)' : 'var(--dsw-alias-state-error-primary,#d9534f)' }
}

function countLinesBefore(text, index) {
  let n = 0
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/**
 * 行级公共前缀/后缀裁剪：old/new 首尾相同的行视为未变化（上下文），只保留真正变更的中间段。
 * @author ddj 2026年08月18号
 * @param {string[]} oldLines 替换前内容按行拆分
 * @param {string[]} newLines 替换后内容按行拆分
 * @returns {{ oldLines: string[], newLines: string[], shift: number }} 裁剪后的变更段与公共前缀行数
 */
function trimCommonLines(oldLines, newLines) {
  let prefix = 0
  const maxPrefix = Math.min(oldLines.length, newLines.length)
  while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) prefix++
  let suffix = 0
  const maxSuffix = Math.min(oldLines.length - prefix, newLines.length - prefix)
  while (suffix < maxSuffix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++
  return { oldLines: oldLines.slice(prefix, oldLines.length - suffix), newLines: newLines.slice(prefix, newLines.length - suffix), shift: prefix }
}

/** 计算文件内各差异区域（行范围 + old/new + 状态），用于行内绿标注与 DiffBox。 */
function diffRegions(records, content) {
  const regions = []
  if (content === null) return regions
  const lines = content.split('\n')
  for (const rec of records) {
    for (let i = 0; i < rec.hunks.length; i++) {
      const h = rec.hunks[i]
      if (noopHunk(rec, h)) continue // 空差异（old===new）无实际变化，跳过
      const status = statusAt(rec, i)
      if (rec.create) {
        regions.push({ callId: rec.callId, idx: i, start: 1, end: lines.length, oldLines: [], newLines: lines.slice(), whole: true, status, create: true, rec, superseded: rec.superseded === true })
        continue
      }
      const precise = rec.toolName === 'edit' && rec.callHunk ? rec.callHunk : h
      const newText = precise.newText ?? ''
      const at = content.indexOf(newText)
      if (at < 0) {
        regions.push({ callId: rec.callId, idx: i, stale: true, status, rec, superseded: rec.superseded === true })
        continue
      }
      const start = countLinesBefore(content, at) + 1
      const oldLines = precise.oldText === null ? [] : precise.oldText.split('\n')
      const newLines = newText.split('\n')
      const trimmed = trimCommonLines(oldLines, newLines)
      const regionStart = start + trimmed.shift
      regions.push({ callId: rec.callId, idx: i, start: regionStart, end: regionStart + trimmed.newLines.length, oldLines: trimmed.oldLines, newLines: trimmed.newLines, status, create: false, rec, superseded: rec.superseded === true })
    }
  }
  regions.sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity))
  return regions
}

function badgeOf(status) {
  return status === ST.ACCEPTED ? '已采纳' : status === ST.REJECTED ? '已拒绝' : '待处理'
}

const MONO = { fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)', fontSize: 12, lineHeight: 1.55 }

/* ═══ Monaco 中央编辑区基建 ═══════════════════════════════════ */

const MONACO_BASE = '/edrv/vendor/monaco/vs'
let monacoPromise = null
let edrvStylesDone = false

/** 扩展名 → Monaco language id（常见语言；未知回退 plaintext）。 */
const LANG_BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  lua: 'lua', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sql: 'sql',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart', dockerfile: 'dockerfile'
}

/**
 * 路径 → Monaco language id：取 basename 扩展名（dockerfile/Dockerfile 特判）。
 * @author ddj 2026年08月18号
 * @param {string} path 文件路径
 * @returns {string} language id
 */
function langOf(path) {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}

/**
 * 加载 Monaco Editor（AMD 构建，随插件包离线分发）：注入 loader.js → require.config → editor.main。
 * @author ddj 2026年08月18号
 * @returns {Promise<object>} window.monaco
 */
function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = new Promise((resolve, reject) => {
      const boot = () => {
        try {
          window.require.config({ paths: { vs: MONACO_BASE } })
          window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (err) => {
            monacoPromise = null
            reject(new Error('Monaco 模块加载失败：' + String(err)))
          })
        } catch (error) {
          monacoPromise = null
          reject(error)
        }
      }
      const existing = document.querySelector('script[data-edrv-monaco-loader]')
      if (existing) boot()
      else {
        const s = document.createElement('script')
        s.src = MONACO_BASE + '/loader.js'
        s.dataset.edrvMonacoLoader = '1'
        s.onload = boot
        s.onerror = () => { monacoPromise = null; reject(new Error('Monaco loader 加载失败')) }
        document.head.appendChild(s)
      }
    })
  }
  return monacoPromise
}

/** 注入编辑区样式（一次）：页签/搜索/差异框/Launcher/状态栏/差异行绿标注。 */
function ensureEdrvStyles() {
  if (edrvStylesDone || typeof document === 'undefined') return
  edrvStylesDone = true
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-vscode-mode'
  tag.dataset.pluginCss = 'edrv-editor'
  tag.textContent = [
    /* 浅色主题（对齐参考图：#f8f8f8 近白底 + 薄荷绿药丸 + 青绿文字 + 三文鱼 undo + 浅灰边框）：
       在 [data-edrv-view] 作用域内重定义 --dsw-alias-*，级联命中组件内联样式与 CSS。 */
    '[data-edrv-view] { --edrv-tab-h: 34px; --dsw-alias-bg-base: #f8f8f8; --dsw-alias-bg-layer-1: #ffffff; --dsw-alias-bg-layer-2: #f0f4f4; --dsw-alias-bg-overlay: #ffffff; --dsw-alias-label-primary: #1f2933; --dsw-alias-label-secondary: #52606d; --dsw-alias-label-tertiary: #9aa5b1; --dsw-alias-border-l1: #e0e6e8; --dsw-alias-border-l2: #cbd2d9; --dsw-alias-brand-primary: #0f9d58; --dsw-alias-state-success-primary: #0f9d58; --dsw-alias-state-error-primary: #d9534f; --dsw-alias-state-warn-primary: #d97706; --dsw-alias-interactive-bg-hover: rgba(15,157,88,.08); }',
    '[data-edrv-view] .edrv-tabs { display: flex; align-items: center; gap: 2px; padding: 2px 8px 0; background: var(--dsw-alias-bg-layer-1, transparent); overflow-x: auto; scrollbar-width: thin; flex-shrink: 0; }',
    '[data-edrv-view] .edrv-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px 0 12px; border: none; border-radius: 6px 6px 0 0; background: transparent; color: var(--dsw-alias-label-secondary, #aaa); font-size: 12px; cursor: pointer; white-space: nowrap; flex-shrink: 0; }',
    '[data-edrv-view] .edrv-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }',
    '[data-edrv-view] .edrv-tab.edrv-tab-active { background: var(--dsw-alias-bg-base, #111); color: var(--dsw-alias-label-primary, #eee); box-shadow: inset 0 -2px 0 var(--dsw-alias-brand-primary, #4f8cff); }',
    '[data-edrv-view] .edrv-tab .edrv-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #4f8cff); flex-shrink: 0; }',
    '[data-edrv-view] .edrv-tab .edrv-tab-x { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 4px; color: var(--dsw-alias-label-tertiary, #888); font-size: 11px; }',
    '[data-edrv-view] .edrv-tab .edrv-tab-x:hover { background: rgba(255,255,255,.12); color: var(--dsw-alias-label-primary, #eee); }',
    '[data-edrv-view] .edrv-tab-add { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin-left: 2px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #aaa); font-size: 14px; cursor: pointer; flex-shrink: 0; }',
    '[data-edrv-view] .edrv-tab-add:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }',
    '[data-edrv-view] .edrv-pathbar { display: flex; align-items: center; gap: 8px; height: 26px; padding: 0 10px; background: var(--dsw-alias-bg-layer-1, #ffffff); border-bottom: 1px solid var(--dsw-alias-border-l1, #e0e6e8); font-size: 12px; flex-shrink: 0; overflow: hidden; }',
    '[data-edrv-view] .edrv-pathbar .edrv-pb-name { font-weight: 600; color: var(--dsw-alias-label-primary, #1f2933); white-space: nowrap; }',
    '[data-edrv-view] .edrv-pathbar .edrv-pb-full { flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary, #9aa5b1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }',
    '[data-edrv-view] .edrv-path-input { flex: 1; min-width: 140px; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 6px; background: var(--dsw-alias-bg-base, #111); color: var(--dsw-alias-label-primary, #eee); font-size: 12px; outline: none; }',
    '[data-edrv-view] .edrv-search-wrap { position: relative; flex-shrink: 0; display: flex; align-items: center; padding: 2px 8px 2px 4px; }',
    '[data-edrv-view] .edrv-search { width: 190px; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 6px; background: var(--dsw-alias-bg-base, #111); color: var(--dsw-alias-label-primary, #eee); font-size: 12px; outline: none; }',
    '[data-edrv-view] .edrv-search:focus { border-color: var(--dsw-alias-brand-primary, #4f8cff); }',
    '[data-edrv-view] .edrv-search-pop { position: absolute; top: calc(100% + 4px); right: 8px; width: min(460px, calc(100vw - 24px)); max-height: 300px; overflow: auto; background: var(--dsw-alias-bg-overlay, #1c1c1c); border: 1px solid var(--dsw-alias-border-l2, #555); border-radius: 10px; box-shadow: 0 6px 20px rgba(0,0,0,.4); z-index: 60; padding: 4px; }',
    '[data-edrv-view] .edrv-search-item { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }',
    '[data-edrv-view] .edrv-search-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.07)); }',
    '[data-edrv-view] .edrv-search-item .n { color: var(--dsw-alias-label-primary, #eee); font-size: 12px; word-break: break-all; }',
    '[data-edrv-view] .edrv-search-item .d { color: var(--dsw-alias-label-tertiary, #888); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '[data-edrv-view] .edrv-search-empty { padding: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #888); }',
    '[data-edrv-view] .edrv-btn-mini { font-size: 11px; padding: 2px 9px; border: none; border-radius: 999px; cursor: pointer; color: #fff; font-weight: 600; white-space: nowrap; }',
    '[data-edrv-view] .edrv-btn-keep { background: var(--dsw-alias-state-success-primary, #2e9e44); }',
    '[data-edrv-view] .edrv-btn-undo { background: var(--dsw-alias-state-warn-primary, #d97706); }',
    '[data-edrv-view] .edrv-btn-mini:disabled { opacity: .45; cursor: default; }',
    '[data-edrv-view] .edrv-statusbar { display: flex; align-items: center; gap: 10px; padding: 3px 10px; border-top: 1px solid var(--dsw-alias-border-l1, #333); background: var(--dsw-alias-bg-layer-1, transparent); font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); flex-shrink: 0; white-space: nowrap; overflow: hidden; }',
    '[data-edrv-view] .edrv-statusbar .edrv-sp-path { flex: 1; overflow: hidden; text-overflow: ellipsis; }',
    '[data-edrv-view] .edrv-diffchip { font-size: 11px; padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 999px; background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-state-warn-primary, #b7791f); cursor: pointer; white-space: nowrap; flex-shrink: 0; }',
    '[data-edrv-view] .edrv-chip-btn { font-size: 12px; padding: 2px 6px; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #aaa); cursor: pointer; border-radius: 4px; flex-shrink: 0; }',
    '[data-edrv-view] .edrv-chip-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }',
    '[data-edrv-view] .edrv-mn-add-line { background: rgba(15,157,88,.10); }',
    '[data-edrv-view] .edrv-mn-gutter-add { color: #0f9d58 !important; font-weight: 700; display: flex !important; align-items: center; justify-content: center; }',
    '[data-edrv-view] .edrv-mn-gutter-add::before { content: "+"; }',
    '[data-edrv-view] .edrv-del-zone { background: #fdeaea; border-top: 1px solid rgba(217,83,79,.35); border-bottom: 1px solid rgba(217,83,79,.35); box-shadow: inset 0 0 0 1px rgba(217,83,79,.12); }',
    '[data-edrv-view] .edrv-del-row { white-space: pre; font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 12.5px; line-height: 20px; color: #c0392b; }',
    '[data-edrv-view] .edrv-del-text { display: inline-block; white-space: pre; }',
    '[data-edrv-view] .edrv-minus-overlay { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 6; }',
    '[data-edrv-view] .edrv-minus-item { position: absolute; width: 16px; text-align: center; color: #d9534f; font-weight: 700; font-size: 12.5px; line-height: 20px; }',
    '[data-edrv-view] .edrv-monaco-host { flex: 1; min-height: 0; position: relative; }',
    '[data-edrv-view] .edrv-monaco-host > div { position: absolute; inset: 0; }',
    '[data-edrv-view] .edrv-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; height: 100%; color: var(--dsw-alias-label-tertiary, #777); font-size: 13px; }',
    '[data-edrv-view] .edrv-diffbar { position: absolute; left: 0; right: 0; bottom: 10px; margin: 0 auto; z-index: 25; width: fit-content; max-width: calc(100% - 20px); border-radius: 10px; background: var(--dsw-alias-bg-overlay, #ffffff); border: 1px solid var(--dsw-alias-border-l2, #cbd2d9); box-shadow: 0 4px 16px rgba(31,41,51,.12); overflow: visible; display: flex; flex-direction: column; }',
    '[data-edrv-view] .edrv-diffbar-row { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; flex-wrap: nowrap; }',
    '[data-edrv-view] .edrv-diffbar-count { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f2933); min-width: 42px; text-align: center; white-space: nowrap; cursor: pointer; }',
    '[data-edrv-view] .edrv-diffbar-count.edrv-count-file { min-width: 64px; cursor: default; }',
    '[data-edrv-view] .edrv-diffbar-file { flex: 1; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa5b1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '[data-edrv-view] .edrv-pill { font-size: 11px; padding: 3px 10px; border: none; border-radius: 999px; cursor: pointer; white-space: nowrap; font-weight: 600; }',
    '[data-edrv-view] .edrv-pill-keep { background: #e8f8e8; color: #0f7a45; border: 1px solid rgba(15,157,88,.4); }',
    '[data-edrv-view] .edrv-pill-undo { background: #fdeaea; color: #c0392b; border: 1px solid rgba(217,83,79,.4); }',
    '[data-edrv-view] .edrv-pill-ghost { background: #ffffff; color: var(--dsw-alias-label-secondary, #52606d); border: 1px solid var(--dsw-alias-border-l1, #e0e6e8); }',
    '[data-edrv-view] .edrv-pill:disabled { opacity: .45; cursor: default; }',
    '[data-edrv-view] .edrv-diffbar-menu { position: absolute; right: 8px; bottom: calc(100% + 6px); z-index: 45; min-width: 160px; border-radius: 10px; background: var(--dsw-alias-bg-overlay, #ffffff); border: 1px solid var(--dsw-alias-border-l2, #cbd2d9); box-shadow: 0 6px 20px rgba(31,41,51,.16); padding: 4px; display: flex; flex-direction: column; gap: 2px; }',
    '[data-edrv-view] .edrv-diffmenu-item { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 10px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #1f2933); cursor: pointer; text-align: left; }',
    '[data-edrv-view] .edrv-diffmenu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(15,157,88,.08)); }',
    '[data-edrv-view] .edrv-diffmenu-item.danger { color: var(--dsw-alias-state-error-primary, #d9534f); }',
    '[data-edrv-view] .edrv-diffmenu-sep { height: 1px; margin: 2px 4px; background: var(--dsw-alias-border-l1, #e0e6e8); }',
    '[data-edrv-view] .edrv-diffbar-body { max-height: 130px; max-width: min(560px, calc(100vw - 40px)); overflow: auto; padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--dsw-alias-border-l1, #e0e6e8); }',
    '[data-edrv-view] .edrv-diffrow { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1, #e0e6e8); border-radius: 6px; background: var(--dsw-alias-bg-layer-2, #f0f4f4); cursor: pointer; flex-wrap: wrap; }',
    '[data-edrv-view] .edrv-diffrow:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(15,157,88,.08)); }',
    '[data-edrv-view] .edrv-diffrow-l { font-size: 11px; color: var(--dsw-alias-label-primary, #1f2933); min-width: 74px; font-family: var(--ds-font-family-code, ui-monospace, monospace); }',
    '[data-edrv-view] .edrv-diffrow-o { font-size: 11px; color: var(--dsw-alias-state-error-primary, #d9534f); font-family: var(--ds-font-family-code, ui-monospace, monospace); }',
    '[data-edrv-view] .edrv-diffrow-n { font-size: 11px; color: var(--dsw-alias-state-success-primary, #0f9d58); font-family: var(--ds-font-family-code, ui-monospace, monospace); }',
    '[data-edrv-view] .edrv-diffrow-tag { font-size: 11px; color: var(--dsw-alias-label-tertiary, #9aa5b1); }',
    '[data-edrv-view] .edrv-diffrow-stale { border-color: rgba(217,119,6,.5); cursor: default; }',
    '[data-edrv-view] .edrv-diffbox-others { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 2px 0; border-top: 1px solid var(--dsw-alias-border-l1, #e0e6e8); margin-top: 2px; }',
    '[data-edrv-view] .edrv-diffrow-file { font-size: 11px; padding: 2px 10px; border: 1px solid var(--dsw-alias-border-l1, #e0e6e8); border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #f0f4f4); color: var(--dsw-alias-label-secondary, #52606d); cursor: pointer; white-space: nowrap; max-width: 200px; overflow: hidden; text-overflow: ellipsis; }',
    '[data-edrv-view] .edrv-diffrow-file:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(15,157,88,.08)); color: var(--dsw-alias-label-primary, #1f2933); }',
    /* 编辑区 hover 差异块的 Keep/Undo 浮层 */
    '[data-edrv-view] .edrv-hoveract { position: absolute; z-index: 30; display: flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 8px; background: var(--dsw-alias-bg-overlay, #ffffff); border: 1px solid var(--dsw-alias-border-l2, #cbd2d9); box-shadow: 0 4px 14px rgba(31,41,51,.14); }',
    '[data-edrv-view] .edrv-launch { position: absolute; left: 12px; right: 12px; bottom: 12px; z-index: 40; border-radius: 10px; background: var(--dsw-alias-bg-overlay, #1c1c1c); border: 1px solid var(--dsw-alias-border-l2, #555); box-shadow: 0 6px 24px rgba(0,0,0,.5); display: flex; flex-direction: column; max-height: 60%; overflow: hidden; }',
    '[data-edrv-view] .edrv-launch-head { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, #333); }',
    '[data-edrv-view] .edrv-launch-tab { font-size: 12px; padding: 3px 12px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #aaa); cursor: pointer; }',
    '[data-edrv-view] .edrv-launch-tab.on { background: var(--dsw-alias-bg-layer-2, transparent); color: var(--dsw-alias-label-primary, #eee); font-weight: 600; }',
    '[data-edrv-view] .edrv-launch-body { flex: 1; min-height: 0; overflow: auto; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }',
    '[data-edrv-view] .edrv-launch-row { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 6px; cursor: pointer; flex-wrap: wrap; }',
    '[data-edrv-view] .edrv-launch-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }',
    '[data-edrv-view] .edrv-launch-path { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-primary, #eee); word-break: break-all; }',
    '[data-edrv-view] .edrv-launch-cnt { font-size: 11px; color: var(--dsw-alias-label-tertiary, #888); white-space: nowrap; }',
    '[data-edrv-view] .edrv-launch-arch { display: flex; flex-direction: column; gap: 6px; }',
    '[data-edrv-view] .monaco-editor, [data-edrv-view] .monaco-editor .margin, [data-edrv-view] .monaco-editor-background { background: transparent !important; }',
    '[data-edrv-view] .monaco-editor .scrollbar .slider { background: rgba(128,128,128,.3) !important; }'
  ].join('\n')
  document.head.appendChild(tag)
}

/**
 * 打开中央「文件编辑」页签：点击 shell 会话头部的视图页签（DOM 级，无需 store actions）。
 * @author ddj 2026年08月18号
 * @param {string|null} path 要打开的路径（可空）
 */
function openEditorView(path) {
  const tabs = document.querySelectorAll('div[role="tablist"] button[role="tab"]')
  for (const b of tabs) {
    if (b.textContent && b.textContent.includes('文件编辑')) { b.click(); break }
  }
  const p = path ?? null
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('edrv:open-editor', { detail: { path: p } }))
  }, 80)
}

/* ═══ QuickOpen：顶部搜索框（Ctrl+P 打开文件） ═══════════════════ */

function QuickOpen(props) {
  const sessionId = props?.sessionId
  const onOpen = props?.onOpen
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef(null)
  const seq = React.useRef(0)
  const timer = React.useRef(null)

  const search = (query) => {
    const s = ++seq.current
    const clean = String(query || '').trim()
    if (clean.length < 2) { setResults(null); return }
    rpc('edrv.searchFiles', { sessionId, query: clean }).then((res) => {
      if (s !== seq.current) return
      setResults((res && res.ok && Array.isArray(res.files)) ? res.files : [])
    }).catch(() => { if (s === seq.current) setResults([]) })
  }

  const onChange = (v) => {
    setQ(v); setOpen(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => search(v), 180)
  }

  const pick = (p) => {
    onOpen(p)
    setQ(''); setResults(null); setOpen(false)
    inputRef.current?.blur?.()
  }

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'p') {
        e.preventDefault(); e.stopPropagation()
        inputRef.current?.focus?.()
        setOpen(true)
      } else if (e.key === 'Escape') {
        setOpen(false); inputRef.current?.blur?.()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const dirText = (p) => {
    const base = String(p).split(/[\\/]/).pop() || String(p)
    return String(p).slice(0, Math.max(0, String(p).length - base.length)).replace(/[\\/]+$/, '') || String(p)
  }

  let pop = null
  if (open && Array.isArray(results) && q.trim().length >= 2) {
    if (results.length) {
      const items = results.map((p) => React.createElement('div', { key: p, className: 'edrv-search-item', onClick: () => pick(p) },
        React.createElement('span', { className: 'n' }, String(p).split(/[\\/]/).pop() || p),
        React.createElement('span', { className: 'd' }, dirText(p))))
      pop = React.createElement('div', { className: 'edrv-search-pop' }, ...items)
    } else {
      pop = React.createElement('div', { className: 'edrv-search-pop' }, React.createElement('div', { className: 'edrv-search-empty' }, '无匹配文件'))
    }
  }

  return React.createElement('div', { className: 'edrv-search-wrap' },
    React.createElement('input', {
      ref: inputRef, className: 'edrv-search', placeholder: '搜索文件 (Ctrl+P)',
      value: q,
      onChange: (e) => onChange(e.target.value),
      onFocus: () => { if (q.trim().length >= 2 && !results) setOpen(true) },
      onKeyDown: (e) => {
        if (e.key === 'Enter' && Array.isArray(results) && results.length) pick(results[0])
        if (e.key === 'Escape') setOpen(false)
      }
    }),
    pop)
}

/* ═══ DiffBar：每个文件底部紧凑差异条（⋮ 二级菜单含 KeepAll/UndoAll） ═══ */

function DiffBox(props) {
  const { pendingRegions, staleRegions, onAct, onAcceptFile, onUndoFile, onAcceptAllFiles, onUndoAllFiles, allPendingCount, onRollback, onJump, otherFiles, onOpenOther, onOpenLauncher, onRefresh, activePath, diffIdx, diffTotal, fileIdx, fileTotal, onPrevDiff, onNextDiff, onPrevFile, onNextFile } = props
  const [expanded, setExpanded] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)
  const canAct = pendingRegions.length > 0

  const base = String(activePath || '').split(/[\\/]/).pop() || ''

  let bodyEl = null
  if (expanded) {
    const rows = pendingRegions.map((r) => {
      const key = callIdAttr(r.callId, r.idx)
      return React.createElement('div', { key, className: 'edrv-diffrow', 'data-edrv-hunk': key, title: '跳转到 L' + (r.start ?? '?'), onClick: () => onJump(r) },
        React.createElement('span', { className: 'edrv-diffrow-l' }, 'L' + (r.start ?? '?') + '-' + (r.end ?? '?')),
        (r.oldLines.length ? React.createElement('span', { className: 'edrv-diffrow-o' }, '-' + r.oldLines.length) : null),
        (r.newLines.length ? React.createElement('span', { className: 'edrv-diffrow-n' }, '+' + r.newLines.length) : null),
        (r.create ? React.createElement('span', { className: 'edrv-diffrow-tag' }, '新建') : null),
        React.createElement('span', { style: { flex: 1 } }))
    })
    const stale = staleRegions.map((r) => React.createElement('div', { key: 'stale' + callIdAttr(r.callId, r.idx), className: 'edrv-diffrow edrv-diffrow-stale', title: '差异无法定位（文件可能已被手动修改）' },
      React.createElement('span', { className: 'edrv-diffrow-l' }, 'L' + (r.start ?? '?') + ' 无法定位'),
      React.createElement('span', { className: 'edrv-diffrow-tag' }, badgeOf(r.status))))
    let othersEl = null
    if (otherFiles.length) {
      othersEl = React.createElement('div', { className: 'edrv-diffbox-others' },
        React.createElement('span', { className: 'edrv-diffrow-tag' }, '其他差异文件 (' + otherFiles.length + '):'),
        otherFiles.map((f) => React.createElement('button', { key: f.path, className: 'edrv-diffrow-file', title: f.path, onClick: () => onOpenOther(f.path) },
          String(f.path).split(/[\\/]/).pop() + ' (' + f.pending + ')')))
    }
    bodyEl = React.createElement('div', { className: 'edrv-diffbar-body' }, ...rows, ...stale, othersEl)
  }

  const menu = menuOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 44 }, onClick: () => setMenuOpen(false) }),
        React.createElement('div', { className: 'edrv-diffbar-menu' },
          React.createElement('button', { className: 'edrv-diffmenu-item', disabled: !allPendingCount, onClick: () => { onAcceptAllFiles(); setMenuOpen(false) } }, '✓ Keep All（全部文件采纳）'),
          React.createElement('button', { className: 'edrv-diffmenu-item danger', disabled: !allPendingCount, onClick: () => { onUndoAllFiles(); setMenuOpen(false) } }, '↩ Undo All（全部文件不采纳）'),
          React.createElement('div', { className: 'edrv-diffmenu-sep' }),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('pending'); setMenuOpen(false) } }, '🗂 差异总览'),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('archive'); setMenuOpen(false) } }, '📁 归档'),
          React.createElement('div', { className: 'edrv-diffmenu-sep' }),
          React.createElement('button', { className: 'edrv-diffmenu-item', disabled: !canAct, onClick: () => { onRollback(); setMenuOpen(false) } }, '⟲ 回滚文件'),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onRefresh(); setMenuOpen(false) } }, '⟳ 刷新')))
    : null

  return React.createElement('div', { className: 'edrv-diffbar', 'data-edrv-diffbox': '1' },
    React.createElement('div', { className: 'edrv-diffbar-row' },
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '上一个差异', disabled: !canAct, onClick: onPrevDiff }, '↑'),
      React.createElement('span', { className: 'edrv-diffbar-count', title: '当前文件内差异位置（点击展开/收起差异列表）', onClick: () => setExpanded((v) => !v) }, diffTotal ? (diffIdx + 1) + '/' + diffTotal : '0/0'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '下一个差异', disabled: !canAct, onClick: onNextDiff }, '↓'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '上一个差异文件', disabled: !fileTotal, onClick: onPrevFile }, '←'),
      React.createElement('span', { className: 'edrv-diffbar-count edrv-count-file', title: '差异文件位置' }, fileTotal ? (fileIdx + 1) + '/' + fileTotal + ' 文件' : '0/0 文件'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '下一个差异文件', disabled: !fileTotal, onClick: onNextFile }, '→'),
      React.createElement('span', { className: 'edrv-diffbar-file', title: activePath || '' }, base),
      React.createElement('button', { className: 'edrv-pill edrv-pill-keep', title: '采纳当前文件的全部差异', disabled: !canAct, onClick: onAcceptFile }, '✓ Keep'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-undo', title: '不采纳当前文件的全部差异（回滚）', disabled: !canAct, onClick: onUndoFile }, '↩ Undo'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '更多操作', onClick: () => setMenuOpen((v) => !v) }, '⋮')),
    bodyEl,
    menu)
}

/* ═══ DiffBarEmpty：无文件打开 / 当前文件无差异但有差异文件时的空态底部浮窗 ═══ */

function DiffBarEmpty(props) {
  const { sum, active, staleCount, onNextFile, onOpenLauncher, onRefresh } = props
  const [menuOpen, setMenuOpen] = React.useState(false)
  const n = sum?.totalFiles ?? 0
  const tip = active
    ? (staleCount > 0 ? '当前文件有 ' + staleCount + ' 处差异无法定位（可能已被后续修改影响）' : '当前文件无待处理差异')
    : '未打开文件'

  const menu = menuOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 44 }, onClick: () => setMenuOpen(false) }),
        React.createElement('div', { className: 'edrv-diffbar-menu' },
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('pending'); setMenuOpen(false) } }, '🗂 差异总览'),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onOpenLauncher('archive'); setMenuOpen(false) } }, '📁 归档'),
          React.createElement('div', { className: 'edrv-diffmenu-sep' }),
          React.createElement('button', { className: 'edrv-diffmenu-item', onClick: () => { onRefresh(); setMenuOpen(false) } }, '⟳ 刷新')))
    : null

  return React.createElement('div', { className: 'edrv-diffbar', 'data-edrv-diffbox': '1' },
    React.createElement('div', { className: 'edrv-diffbar-row' },
      React.createElement('span', { className: 'edrv-diffbar-count' }, '⚠ 差异 ' + n + ' 文件'),
      React.createElement('span', { className: 'edrv-diffbar-file' }, tip),
      React.createElement('button', { className: 'edrv-pill edrv-pill-keep', title: '打开并跳转到下一个差异文件', onClick: onNextFile }, '查看下一个差异文件'),
      React.createElement('button', { className: 'edrv-pill edrv-pill-ghost', title: '更多操作', onClick: () => setMenuOpen((v) => !v) }, '⋮')),
    menu)
}

/* ═══ DiffLauncher：全局差异总览 + 归档 圆角下拉 ═════════════════ */

function DiffLauncher(props) {
  const sessionId = props?.sessionId
  const sum = props?.sum
  const onClose = props?.onClose
  const onOpenFile = props?.onOpenFile
  const [tab, setTab] = React.useState(props?.tab === 'archive' ? 'archive' : 'pending') // 'pending' | 'archive'
  const [archives, setArchives] = React.useState(null)
  const [archiveDetail, setArchiveDetail] = React.useState(null)
  const [archivePath, setArchivePath] = React.useState(null)
  const [archiveErr, setArchiveErr] = React.useState(null)
  const [error, setError] = React.useState(null)

  const loadArchives = () => {
    if (!sessionId) { setArchiveErr('会话不存在'); return }
    rpc('edrv.archiveList', { sessionId }).then((res) => {
      if (res && res.ok && Array.isArray(res.entries)) { setArchives(res.entries); setArchiveErr(null) }
      else setArchiveErr(res?.error ? String(res.error) : '归档列表读取失败')
    }).catch((e) => setArchiveErr('归档异常:' + String(e)))
  }
  const loadArchiveDetail = (path) => {
    if (!sessionId) return
    setArchiveDetail(null)
    rpc('edrv.archiveRead', { sessionId, path }).then((res) => {
      if (res && res.ok && Array.isArray(res.batches)) setArchiveDetail(res.batches)
      else setArchiveErr(res?.error ? String(res.error) : '归档详情读取失败')
    }).catch((e) => setArchiveErr('归档异常:' + String(e)))
  }
  React.useEffect(() => {
    if (tab !== 'archive') return
    setArchives(null); setArchiveDetail(null); setArchivePath(null); setArchiveErr(null)
    loadArchives()
  }, [tab, sessionId])

  let body
  if (tab === 'pending') {
    body = (sum.pendingFiles.length === 0
      ? React.createElement('div', { className: 'edrv-search-empty' }, '暂无待处理差异（已全部处理）')
      : sum.pendingFiles.map((f) => React.createElement('div', { key: f.path, className: 'edrv-launch-row', title: '打开并跳转到差异 ' + f.path, onClick: () => onOpenFile(f.path) },
          React.createElement('span', { className: 'edrv-launch-path' }, f.path),
          React.createElement('span', { className: 'edrv-launch-cnt' }, '待处理 ' + f.pending + ' 处'),
          React.createElement('button', { className: 'edrv-btn-mini edrv-btn-keep', onClick: (e) => { e.stopPropagation(); onOpenFile(f.path) } }, '打开'))))
  } else {
    if (archiveErr) body = React.createElement('div', { className: 'edrv-search-empty', style: { color: 'var(--dsw-alias-state-error-primary,#d9534f)' } }, '错误：' + String(archiveErr))
    else if (archives === null) body = React.createElement('div', { className: 'edrv-search-empty' }, '加载中…')
    else if (archives.length === 0) body = React.createElement('div', { className: 'edrv-search-empty' }, '暂无归档记录')
    else {
      const inner = archives.map((e) => {
        const open = archivePath === e.path
        let detailEl = null
        if (open) {
          if (archiveDetail === null) detailEl = React.createElement('div', { style: { padding: 8, fontSize: 11, color: 'var(--dsw-alias-label-tertiary,#888)' } }, '加载中…')
          else {
            const batches = archiveDetail.filter((b) => b.path === e.path)
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
                  React.createElement('span', { style: { color: 'var(--dsw-alias-label-primary,#ddd)', fontWeight: 600 } }, rec.toolName === 'write' ? (rec.create ? '新建' : '写入') : '编辑'),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary,#2e9e44)' } }, '采纳 ' + sm.accepted),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary,#d9534f)' } }, '拒绝 ' + sm.rejected),
                  (rec.superseded ? React.createElement('span', { style: { color: 'var(--dsw-alias-state-warn-primary,#b7791f)' } }, '被覆盖') : null),
                  React.createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary,#888)' } }, new Date(rec.at).toLocaleTimeString())),
                React.createElement('pre', { style: { margin: 0, whiteSpace: 'pre', fontFamily: MONO.fontFamily, fontSize: 11, lineHeight: 1.5, overflowX: 'auto' } }, lines.map((ln, i) => React.createElement('div', { key: i, style: { background: ln.k === 'old' ? 'rgba(239,68,68,.10)' : ln.k === 'new' ? 'rgba(34,197,94,.10)' : 'transparent', color: ln.k === 'old' ? 'var(--dsw-alias-state-error-primary,#d9534f)' : ln.k === 'new' ? 'var(--dsw-alias-state-success-primary,#2e9e44)' : 'var(--dsw-alias-label-tertiary,#888)' } }, (ln.k === 'old' ? '- ' : ln.k === 'new' ? '+ ' : '') + ln.t)))
              )
            }))
          }
        }
        return React.createElement('div', { key: e.at + e.path, style: { border: '1px solid var(--dsw-alias-border-l1,#333)', borderRadius: 8, overflow: 'hidden' } },
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-1,transparent)', cursor: 'pointer', flexWrap: 'wrap' }, onClick: () => { if (open) { setArchivePath(null); setArchiveDetail(null) } else { setArchivePath(e.path); loadArchiveDetail(e.path) } } },
            React.createElement('span', { style: { flex: 1, fontSize: 12, color: 'var(--dsw-alias-label-primary,#ddd)', wordBreak: 'break-all' } }, e.path),
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
      body = React.createElement('div', { className: 'edrv-launch-arch' }, inner)
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

/* ═══ DiffBadge：header 差异角标（仅工作区有差异时显示） ═══════════ */

function DiffBadge(props) {
  const sessionId = props?.sessionId
  const [n, setN] = React.useState(0)
  const seq = React.useRef(0)

  const load = React.useCallback(() => {
    if (!sessionId) return
    const s = ++seq.current
    rpc('edrv.list', { sessionId }).then((res) => {
      if (s !== seq.current || !res || !res.ok || !Array.isArray(res.records)) return
      setN(summarize(res.records).totalFiles)
    }).catch(() => {})
  }, [sessionId])

  React.useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    const onRefresh = () => load()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => { clearInterval(t); window.removeEventListener('edrv:refresh', onRefresh) }
  }, [load])

  if (!n) return null

  const click = () => {
    openEditorView(null)
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('edrv:show-launcher'))
    }, 120)
  }

  return React.createElement('button', {
    onClick: click,
    title: n + ' 个文件有差异，点击在编辑区查看',
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, padding: 0, background: 'transparent', border: 'none', borderRadius: 6, cursor: 'pointer' }
  },
    React.createElement('img', { src: '/edrv/assets/compare-select.png', alt: '差异', style: { width: 22, height: 22, display: 'block' } }),
    React.createElement('span', { style: { position: 'absolute', top: 1, right: 0, minWidth: 15, height: 15, padding: '0 3px', borderRadius: 8, background: 'var(--dsw-alias-state-warn-primary,#d97706)', color: '#fff', fontSize: 10, lineHeight: '15px', textAlign: 'center', fontWeight: 700, boxSizing: 'border-box' } }, String(n)))
}

/* ═══ EditorView：中央 VSCode 式文件编辑器 ═══════════════════════ */

function EditorView(props) {
  const sessionId = props?.sessionId
  const schedule = props.schedule
  const [monaco, setMonaco] = React.useState(null)
  const [monacoErr, setMonacoErr] = React.useState(null)
  const [records, setRecords] = React.useState({})
  const [tabs, setTabs] = React.useState([])
  const [active, setActive] = React.useState(null)
  const [dirtyMap, setDirtyMap] = React.useState({})
  const [content, setContent] = React.useState(null)
  const [status, setStatus] = React.useState('')
  const [error, setError] = React.useState(null)
  const [openInput, setOpenInput] = React.useState(false)
  const [pathDraft, setPathDraft] = React.useState('')
  const [cursor, setCursor] = React.useState('')
  const [launcherOpen, setLauncherOpen] = React.useState(false)
  const [launcherTab, setLauncherTab] = React.useState('pending')
  const [hoverAct, setHoverAct] = React.useState(null) // { region, top } 编辑区 hover 差异块的 Keep/Undo 浮层
  const [diffIdx, setDiffIdx] = React.useState(0) // 当前文件内差异位置（x/x 显示）
  const [fileIdx, setFileIdx] = React.useState(0) // 全局差异文件位置（x/x 文件 显示）
  const editorRef = React.useRef(null)
  const monacoRef = React.useRef(null)
  const modelsRef = React.useRef(new Map())
  const decorationsRef = React.useRef([])
  const saveTimerRef = React.useRef(null)
  const loadSeqRef = React.useRef(0)
  const programmaticRef = React.useRef(false)
  const bootRef = React.useRef(false)
  const pendingFocusRef = React.useRef(null) // { path, region } 内容加载后跳转
  const hoverRegionsRef = React.useRef([]) // 当前 pending 区域镜像（稳定回调读取）
  const lineRegionMapRef = React.useRef(new Map()) // 行 → 区域 映射（hover 命中）
  const hoverKeyRef = React.useRef(null) // 当前 hover 区域 key（区域不变不重渲染）
  const hoverTopRef = React.useRef(null) // 当前 hover 浮窗 top（滚动后位置变化才重定位）
  const hideTimerRef = React.useRef(null) // 延迟隐藏计时器（防闪烁）
  const batchBusyRef = React.useRef(false) // 批量 Keep All/Undo All 防重入

  ensureEdrvStyles()

  const currentRecords = React.useMemo(() => {
    const list = []
    for (const rec of Object.values(records)) if (rec.path === active) list.push(rec)
    return list
  }, [records, active])

  const regions = React.useMemo(() => diffRegions(currentRecords, content).filter((r) => !r.superseded), [currentRecords, content])
  // useMemo 稳定引用：否则 hover 等重渲染会让 view zone effect 反复重建（- 号闪烁）
  const pendingRegions = React.useMemo(() => regions.filter((r) => r.status === ST.PENDING && !r.stale), [regions])
  const staleRegions = React.useMemo(() => regions.filter((r) => r.status === ST.PENDING && r.stale), [regions])
  hoverRegionsRef.current = pendingRegions
  // 行 → 差异区域 映射（hover O(1) 命中；每行归属其区域）
  const lineRegionMap = React.useMemo(() => {
    const map = new Map()
    for (const r of pendingRegions) {
      if (r.start === undefined || r.end === undefined) continue
      const last = Math.max(r.start, r.end - 1)
      for (let ln = r.start; ln <= last; ln++) if (!map.has(ln)) map.set(ln, r)
    }
    return map
  }, [pendingRegions])
  lineRegionMapRef.current = lineRegionMap
  const sum = React.useMemo(() => summarize(Object.values(records)), [records])

  const addTab = (path, select) => {
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev
      return prev.concat([{ path }])
    })
    if (select) setActive(path)
  }

  const closeTab = (path) => {
    flushSave()
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.path === path)
      if (idx < 0) return prev
      const next = prev.filter((t) => t.path !== path)
      if (active === path) setActive(next[idx] ? next[idx].path : (next[idx - 1] ? next[idx - 1].path : null))
      return next
    })
  }

  const refreshRecords = () => {
    if (!sessionId) return
    rpc('edrv.list', { sessionId }).then((res) => {
      if (!res || !res.ok || !Array.isArray(res.records)) return
      const map = {}
      for (const r of res.records) map[r.callId] = r
      setRecords(map)
    }).catch((e) => setError('list异常:' + String(e)))
  }

  const loadContent = (path, sid) => {
    const seq = ++loadSeqRef.current
    rpc('edrv.read', { sessionId: sid, path }).then((res) => {
      if (seq !== loadSeqRef.current || path !== active) return
      if (res && res.ok) { setContent(res.content); setStatus('已加载') }
      else { setError(res?.error ? String(res.error) : '读取失败'); setStatus('读取失败') }
    }).catch((e) => { if (seq === loadSeqRef.current) { setError('read异常:' + String(e)); setStatus('读取失败') } })
  }

  // 挂载轮询 + 事件订阅
  React.useEffect(() => {
    if (!sessionId) return
    refreshRecords()
    const t = setInterval(refreshRecords, 5000)
    const onRefresh = () => refreshRecords()
    window.addEventListener('edrv:refresh', onRefresh)
    return () => { clearInterval(t); window.removeEventListener('edrv:refresh', onRefresh) }
  }, [sessionId])

  React.useEffect(() => {
    const onOpen = (e) => {
      const p = e?.detail?.path
      if (p) addTab(p, true)
    }
    const onShowLauncher = () => setLauncherOpen(true)
    window.addEventListener('edrv:open-editor', onOpen)
    window.addEventListener('edrv:show-launcher', onShowLauncher)
    return () => {
      window.removeEventListener('edrv:open-editor', onOpen)
      window.removeEventListener('edrv:show-launcher', onShowLauncher)
    }
  }, [sessionId])

  // localStorage v2 恢复页签
  React.useEffect(() => {
    if (bootRef.current || !sessionId) return
    bootRef.current = true
    try {
      const raw = localStorage.getItem('edrv.editor.v2.' + String(sessionId))
      if (raw) {
        const saved = JSON.parse(raw)
        if (Array.isArray(saved.tabs) && saved.tabs.length) {
          setTabs(saved.tabs.map((p) => ({ path: p })))
          if (typeof saved.active === 'string') setActive(saved.active)
        }
      }
    } catch (e) { /* 损坏忽略 */ }
  }, [sessionId])

  React.useEffect(() => {
    if (!sessionId) return
    try { localStorage.setItem('edrv.editor.v2.' + String(sessionId), JSON.stringify({ tabs: tabs.map((t) => t.path), active })) }
    catch (e) { /* 忽略 */ }
  }, [tabs, active, sessionId])

  React.useEffect(() => {
    if (!active) return
    setContent(null); setStatus('加载中…')
    loadContent(active, sessionId)
  }, [active, sessionId])

  React.useEffect(() => {
    if (monaco || monacoErr) return
    let alive = true
    loadMonaco().then((m) => { if (alive) setMonaco(m) }).catch((e) => { if (alive) { setMonacoErr(String(e?.message ?? e)); setStatus('Monaco 不可用') } })
    return () => { alive = false }
  }, [monaco, monacoErr])

  monacoRef.current = monaco

  const getModel = (path, text) => {
    const cache = modelsRef.current
    let model = cache.get(path)
    if (!model) {
      model = window.monaco.editor.createModel(text ?? '', langOf(path), window.monaco.Uri.parse('edrv:///' + encodeURI(path)))
      cache.set(path, model)
    } else if (text !== undefined && model.getValue() !== text) {
      programmaticRef.current = true
      model.setValue(text)
      programmaticRef.current = false
    }
    return model
  }

  const flushSave = () => {
    if (saveTimerRef.current) { saveTimerRef.current(); saveTimerRef.current = null }
  }

  const doSave = (silent) => {
    const ed = editorRef.current
    if (!active || !ed) return
    const text = ed.getValue()
    if (!silent) setStatus('保存中…')
    rpc('edrv.save', { sessionId, path: active, content: text }).then((res) => {
      if (res && res.ok) {
        setStatus('已保存 ' + new Date().toTimeString().slice(0, 8))
        setContent(text)
        setDirtyMap((d) => Object.assign({}, d, { [active]: false }))
        refreshRecords()
        window.dispatchEvent(new CustomEvent('edrv:refresh'))
      } else { setStatus('保存失败'); setError(res?.error ? String(res.error) : '保存失败') }
    }).catch((e) => { setStatus('保存失败'); setError('保存异常:' + String(e)) })
  }

  const onEdit = () => {
    const ed = editorRef.current
    if (!ed || !active) return
    setDirtyMap((d) => Object.assign({}, d, { [active]: true }))
    setStatus('编辑中…')
    if (saveTimerRef.current) saveTimerRef.current()
    saveTimerRef.current = schedule(() => doSave(true), 700)
  }

  // model 同步（当前内容）
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || content === null) return
    const ed = editorRef.current
    const model = getModel(active, content)
    if (ed.getModel() !== model) ed.setModel(model)
  }, [monaco, active, content])

  // 行内差异自绘：新增行绿底 + glyph margin '+'；删除块用 view zone（红底、无行号、不占行号）
  const viewZoneRefs = React.useRef([])
  React.useEffect(() => {
    if (!monaco || !editorRef.current || !active || content === null) return
    const ed = editorRef.current
    const renderT0 = Date.now()
    dbg(sessionId, '[diff-render] begin active=' + active + ' regions=' + pendingRegions.length + ' regs=' + pendingRegions.map((r) => callIdAttr(r.callId, r.idx) + '@' + (r.start ?? '?') + '-' + (r.end ?? '?') + '(-' + (r.oldLines ? r.oldLines.length : 0) + '/+' + (r.newLines ? r.newLines.length : 0) + ')').join('|'))
    const decos = []
    for (const r of pendingRegions) {
      if (r.start === undefined || r.end === undefined) continue
      if (!r.create && r.newLines && r.newLines.length) {
        decos.push({
          range: new window.monaco.Range(r.start, 1, Math.max(r.start, r.end - 1), 1),
          options: { isWholeLine: true, className: 'edrv-mn-add-line', linesDecorationsClassName: 'edrv-mn-gutter-add' }
        })
      }
    }
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, decos)
    // 删除块 view zones（红底 + 正文；- 号由独立 overlay 层渲染，定位在 decoration 列与 + 同列，
    // 不受 view zone 容器定位/裁剪影响；滚动用 translateY 同步）
    let createdZones = []
    ed.changeViewZones((accessor) => {
      for (const id of viewZoneRefs.current) { try { accessor.removeZone(id) } catch (e) { /* 已移除 */ } }
      viewZoneRefs.current = []
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
          suppressMouseDown: false
        })
        viewZoneRefs.current.push(id)
        zones.push({ domNode, after, n: oldLines.length })
      }
      createdZones = zones
    })

    if (createdZones.length) {
      const root = ed.getDomNode()
      if (root) {
        let overlay = root.querySelector('.edrv-minus-overlay')
        if (!overlay) {
          overlay = document.createElement('div')
          overlay.className = 'edrv-minus-overlay'
          root.appendChild(overlay)
        }
        overlay.innerHTML = ''
        const lineH = ed.getOption(window.monaco.editor.EditorOption.lineHeight) || 20
        let li = null
        try { li = ed.getLayoutInfo() } catch (e) { /* ignore */ }
        const left = li ? li.decorationsLeft : 0
        const width = li && li.decorationsWidth > 0 ? li.decorationsWidth : 16
        const lineCount = ed.getModel().getLineCount()
        let itemIdx = 0
        let zi = 0
        for (const z of createdZones) {
          // 用 Monaco 坐标 API 计算 view zone 顶部，避免离屏 zone DOM 未布局导致 getBoundingClientRect 为 0
          const anchor = Math.min(z.after + 1, lineCount)
          let zoneBottom = ed.getTopForLineNumber(anchor)
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
        dbg(sessionId, '[diff-render] placed zones=' + createdZones.length + ' items=' + itemIdx + ' left=' + left + ' w=' + width + ' t+' + (Date.now() - renderT0) + 'ms')
        // 滚动同步：overlay 随内容滚动（内容坐标 - scrollTop）
        const syncScroll = () => {
          const s2 = ed.getScrollTop() || 0
          if (overlay) overlay.style.transform = 'translateY(' + (-s2) + 'px)'
        }
        syncScroll()
        overlay.__edrvSync = syncScroll
        if (!overlay.__edrvBound) {
          overlay.__edrvBound = true
          ed.onDidScrollChange(syncScroll)
        }
        // 已可见的 zone 用真实 DOM 坐标做一次微调（离屏 zone 仍保留坐标 API 位置）
        setTimeout(() => {
          try {
            const edRect = root.getBoundingClientRect()
            const st = ed.getScrollTop() || 0
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
          } catch (e) { dbg(sessionId, '[diff-render] correct fail ' + String(e)) }
        }, 50)
      }
    } else {
      const root = ed.getDomNode()
      const overlay = root && root.querySelector('.edrv-minus-overlay')
      if (overlay) overlay.innerHTML = ''
    }
  }, [monaco, active, content, pendingRegions])

  React.useEffect(() => () => {
    flushSave()
    if (editorRef.current) { editorRef.current.dispose(); editorRef.current = null }
    for (const m of modelsRef.current.values()) m.dispose()
    modelsRef.current.clear()
    viewZoneRefs.current = []
    const root = editorRef.current && editorRef.current.getDomNode ? editorRef.current.getDomNode() : null
    if (root) {
      const ov = root.querySelector('.edrv-minus-overlay')
      if (ov) ov.remove()
    }
  }, [])

  // 普通 Monaco 编辑器（可编辑、单列行号）+ 自绘行内差异（decoration 绿底+ / view zone 删除块）
  const ensureEditor = React.useCallback((node) => {
    if (!node) {
      if (editorRef.current) { editorRef.current.dispose(); editorRef.current = null }
      return
    }
    if (editorRef.current || !monacoRef.current) return
    const m = monacoRef.current
    const ed = m.editor.create(node, {
      value: '',
      language: 'plaintext',
      theme: 'vs',
      fontFamily: 'var(--ds-font-family-code, ui-monospace, monospace)',
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: true, scale: 1 },
      glyphMargin: true,
      lineDecorationsWidth: 16,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      renderWhitespace: 'selection',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 8 }
    })
    ed.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => { flushSave(); doSave(false) })
    ed.onDidChangeModelContent(() => {
      if (!ed.getModel() || programmaticRef.current) return
      onEdit()
    })
    ed.onDidChangeCursorPosition((e) => {
      setCursor('Ln ' + e.position.lineNumber + ', Col ' + e.position.column)
    })
    // hover 差异块 → 浮出 Keep/Undo（req：鼠标移到编辑区差异块时显示）
    // 防闪烁：① 区域不变不 setState（浮窗锚定差异块起始行，不跟随鼠标）；② 延迟隐藏；
    // ③ 浮窗自身 onMouseEnter 取消隐藏计时（鼠标在浮窗与编辑器间移动不闪）。
    const hideSoon = () => {
      if (hideTimerRef.current) return
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null
        hoverKeyRef.current = null
        hoverTopRef.current = null
        setHoverAct(null)
      }, 180)
    }
    ed.onMouseMove((e) => {
      const line = e?.target?.position?.lineNumber
      const map = lineRegionMapRef.current
      if (!line || !map.size) { hideSoon(); return }
      const hit = map.get(line)
      if (!hit) { hideSoon(); return }
      const key = callIdAttr(hit.callId, hit.idx)
      const top = Math.max(0, ed.getTopForLineNumber(Math.max(1, hit.start)) - ed.getScrollTop())
      if (hoverKeyRef.current === key && hoverTopRef.current === top) return // 同区域同位置不重复更新
      hoverKeyRef.current = key
      hoverTopRef.current = top
      if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null }
      setHoverAct({ region: hit, top })
    })
    ed.onMouseLeave(hideSoon)
    editorRef.current = ed
  }, [])

  // 打开文件后的差异聚焦跳转（内容/差异就绪后执行一次）
  React.useEffect(() => {
    const pf = pendingFocusRef.current
    if (!pf || pf.path !== active || content === null) return
    const target = pf.region || pendingRegions[0]
    const ed = editorRef.current
    if (!target || !ed) return
    pendingFocusRef.current = null
    ed.revealLineInCenter(Math.max(1, target.start ?? 1))
    ed.setPosition({ lineNumber: Math.max(1, target.start ?? 1), column: 1 })
    ed.focus()
  }, [active, content, pendingRegions])

  const jumpTo = (region) => {
    if (editorRef.current) {
      editorRef.current.revealLineInCenter(Math.max(1, region?.start ?? 1))
      editorRef.current.setPosition({ lineNumber: Math.max(1, region?.start ?? 1), column: 1 })
      editorRef.current.focus()
    } else {
      pendingFocusRef.current = { path: active, region }
    }
  }

  // 索引校正：差异/文件被处理后 pending 列表变化，clamp 到有效范围
  React.useEffect(() => {
    if (diffIdx >= pendingRegions.length && pendingRegions.length > 0) setDiffIdx(pendingRegions.length - 1)
    else if (pendingRegions.length === 0) setDiffIdx(0)
  }, [pendingRegions.length])
  React.useEffect(() => {
    const i = sum.pendingFiles.findIndex((f) => f.path === active)
    if (i >= 0) { if (i !== fileIdx) setFileIdx(i) }
  }, [sum.pendingFiles, active])

  // 上下箭头：当前文件内差异切换（x/x）
  const gotoDiff = (delta) => {
    if (!pendingRegions.length) return
    const next = (diffIdx + delta + pendingRegions.length) % pendingRegions.length
    setDiffIdx(next)
    jumpTo(pendingRegions[next])
  }
  // 左右箭头：全局差异文件切换（x/x 文件），打开并跳转
  const gotoFile = (delta) => {
    if (!sum.pendingFiles.length) return
    const next = (fileIdx + delta + sum.pendingFiles.length) % sum.pendingFiles.length
    setFileIdx(next)
    openFile(sum.pendingFiles[next].path, true)
  }

  const reloadFile = () => {
    if (!active) return
    loadContent(active, sessionId)
    refreshRecords()
  }

  /**
   * 对单个差异区域执行采纳/不采纳。
   * @author ddj 2026年08月19号
   * @param {object} region 差异区域（callId/idx/create）
   * @param {boolean} reject true=不采纳（回滚），false=采纳
   * @param {boolean} silent 批量时抑制中间 reload/报错，由批量方统一收尾
   * @returns {Promise<boolean>} 是否成功
   */
  const actHunk = (region, reject, silent) => {
    const method = reject ? 'edrv.reject' : 'edrv.accept'
    return rpc(method, { sessionId, callId: region.callId, scope: region.create ? 'call' : 'hunk', hunkIndex: region.idx }).then((res) => {
      if (res && res.ok) {
        setRecords((prev) => Object.assign({}, prev, { [region.callId]: res.record }))
        if (!silent) { reloadFile(); window.dispatchEvent(new CustomEvent('edrv:refresh')) }
        return true
      }
      if (!silent) setError(res?.error ? String(res.error) : '操作失败')
      return false
    }).catch((e) => {
      if (!silent) setError('操作异常:' + String(e))
      return false
    })
  }

  const acceptFile = () => { for (const r of pendingRegions) actHunk(r, false) }
  const undoFile = () => { for (const r of [...pendingRegions].reverse()) actHunk(r, true) }

  // 所有差异文件的待处理 hunk 列表（二级菜单 Keep All / Undo All 用）
  const allPending = React.useMemo(() => {
    const out = []
    for (const rec of Object.values(records)) {
      if (rec.superseded === true) continue
      const dec = rec.decisions || {}
      const perHunk = Array.isArray(dec.perHunk) ? dec.perHunk : []
      const hunks = Array.isArray(rec.hunks) ? rec.hunks : []
      for (let i = 0; i < hunks.length; i++) {
        const st = perHunk.length ? perHunk[i] : dec.call
        if (st === 'pending' && !noopHunk(rec, hunks[i])) out.push({ callId: rec.callId, idx: i, create: rec.create === true, at: rec.at })
      }
    }
    return out
  }, [records])

  /**
   * 批量处理所有差异文件：采纳全部 / 不采纳全部。不采纳按 at 降序（新改先回滚）串行执行。
   * @author ddj 2026年08月19号
   * @param {boolean} reject true=全部不采纳（回滚），false=全部采纳
   */
  const actAllPending = (reject) => {
    if (batchBusyRef.current || !allPending.length) return
    batchBusyRef.current = true
    const list = reject ? [...allPending].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.idx - a.idx)) : allPending
    let ok = 0, fail = 0
    const run = async () => {
      for (const r of list) {
        if (await actHunk(r, reject, true)) ok++
        else fail++
      }
      batchBusyRef.current = false
      reloadFile()
      window.dispatchEvent(new CustomEvent('edrv:refresh'))
      setStatus((reject ? '已不采纳 ' : '已采纳 ') + ok + ' 处差异' + (fail ? '，' + fail + ' 处失败' : ''))
      if (fail) setError(fail + ' 处差异处理失败（可能已被后续修改影响），可刷新后重试')
    }
    run()
  }
  const acceptAllFiles = () => actAllPending(false)
  const undoAllFiles = () => actAllPending(true)
  const rollbackFile = () => {
    if (!active) return
    if (!window.confirm('回滚当前文件到修改前状态？（相关差异将归档）')) return
    rpc('edrv.rollback', { sessionId, path: active }).then((res) => {
      if (res && res.ok) {
        setStatus('已回滚'); reloadFile()
        window.dispatchEvent(new CustomEvent('edrv:refresh'))
      } else setError(res?.error ? String(res.error) : '回滚失败')
    }).catch((e) => setError('回滚异常:' + String(e)))
  }

  const openFile = (path, focusDiff) => {
    if (!path) return
    addTab(path, true)
    if (focusDiff) pendingFocusRef.current = { path, region: null }
  }

  const openPath = () => {
    const p = (pathDraft || '').trim()
    if (!p) return
    setStatus('打开中…')
    rpc('edrv.read', { sessionId, path: p }).then((res) => {
      if (res && res.ok) {
        openFile(p, false)
        setOpenInput(false); setPathDraft(''); setStatus('已打开'); setError(null)
      } else { setStatus('打开失败'); setError(res?.error ? String(res.error) : '打开失败') }
    }).catch((e) => { setStatus('打开失败'); setError('打开异常:' + String(e)) })
  }

  const tabsEl = React.createElement('div', { className: 'edrv-tabs', style: { flex: '1 1 auto', minWidth: 0 } },
    tabs.map((t) => React.createElement('div', {
      key: t.path,
      className: 'edrv-tab' + (t.path === active ? ' edrv-tab-active' : ''),
      title: t.path,
      onClick: () => { if (t.path !== active) { flushSave(); setActive(t.path) } }
    },
      React.createElement('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 } }, t.path.split(/[\\/]/).pop() || t.path),
      (dirtyMap[t.path] ? React.createElement('span', { className: 'edrv-tab-dot' }) : null),
      React.createElement('span', { className: 'edrv-tab-x', onClick: (e) => { e.stopPropagation(); closeTab(t.path) } }, '×'))),
    (openInput
      ? React.createElement('input', { className: 'edrv-path-input', autoFocus: true, placeholder: '输入工作区相对/绝对路径，回车打开', value: pathDraft, onChange: (e) => setPathDraft(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') openPath(); if (e.key === 'Escape') setOpenInput(false) } })
      : React.createElement('button', { className: 'edrv-tab-add', title: '打开文件（输入路径）', onClick: () => setOpenInput(true) }, '+')))

  const pathBar = React.createElement('div', { className: 'edrv-pathbar', title: active || '' },
    React.createElement('span', { className: 'edrv-pb-name' }, active ? String(active).split(/[\\/]/).pop() : '未打开文件'),
    React.createElement('span', { className: 'edrv-pb-full' }, active || '使用右上搜索框 (Ctrl+P) 打开文件'))

  const tabRow = React.createElement('div', { style: { display: 'flex', alignItems: 'center', background: 'var(--dsw-alias-bg-layer-1,transparent)', flexShrink: 0 } },
    tabsEl,
    React.createElement(QuickOpen, { sessionId, onOpen: (p) => openFile(p, false) }))

  const statusBar = React.createElement('div', { className: 'edrv-statusbar' },
    React.createElement('span', null, '编辑'),
    React.createElement('span', null, active ? langOf(active) : ''),
    React.createElement('span', null, cursor),
    (status ? React.createElement('span', null, status) : null),
    React.createElement('span', { style: { flex: 1 } }),
    (sum.totalFiles > 0
      ? React.createElement('button', { className: 'edrv-diffchip', title: '打开差异总览/归档', onClick: () => setLauncherOpen((o) => !o) }, '⚠ 差异 ' + sum.totalFiles + ' 文件')
      : null),
    React.createElement('button', { className: 'edrv-chip-btn', title: '刷新', onClick: reloadFile }, '⟳'))

  const otherFiles = sum.pendingFiles.filter((f) => f.path !== active)

  let body
  if (!monaco && !monacoErr) {
    body = React.createElement('div', { className: 'edrv-empty' }, '正在加载 Monaco 编辑器…')
  } else if (monacoErr) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, 'Monaco 编辑器加载失败：' + String(monacoErr)),
      React.createElement('div', { style: { fontSize: 11 } }, '请确认插件包 assets/vendor/monaco 完整（/edrv/vendor 路由可达）'))
  } else if (!active) {
    body = React.createElement('div', { className: 'edrv-empty' },
      React.createElement('div', null, '暂无打开的文件'),
      React.createElement('div', { style: { fontSize: 12 } }, '使用右上搜索框 (Ctrl+P) 打开工作区文件；agent 修改文件后顶部会出现差异角标'))
  } else if (content === null) {
    body = React.createElement('div', { className: 'edrv-empty' }, '加载中…')
  } else {
    body = React.createElement('div', { className: 'edrv-monaco-host' },
      React.createElement('div', { ref: ensureEditor }))
  }

  const hoverEl = (hoverAct && !launcherOpen)
    ? React.createElement('div', {
        className: 'edrv-hoveract',
        style: { top: hoverAct.top, right: 12 },
        onMouseEnter: () => { if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null } },
        onMouseLeave: () => { const t = setTimeout(() => { hideTimerRef.current = null; hoverKeyRef.current = null; hoverTopRef.current = null; setHoverAct(null) }, 180); hideTimerRef.current = t }
      },
        React.createElement('button', { className: 'edrv-pill edrv-pill-keep', onClick: () => actHunk(hoverAct.region, false) }, '✓ Keep'),
        React.createElement('button', { className: 'edrv-pill edrv-pill-undo', onClick: () => actHunk(hoverAct.region, true) }, '↩ Undo'))
    : null

  const overlay = launcherOpen
    ? React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'fixed', inset: 0, zIndex: 30 }, onClick: () => setLauncherOpen(false) }),
        React.createElement(DiffLauncher, { sessionId, sum, tab: launcherTab, onClose: () => setLauncherOpen(false), onOpenFile: (p) => { openFile(p, true); setLauncherOpen(false) } }))
    : (pendingRegions.length > 0
        ? React.createElement(DiffBox, {
            pendingRegions, staleRegions,
            onAct: actHunk,
            onAcceptFile: acceptFile,
            onUndoFile: undoFile,
            onAcceptAllFiles: acceptAllFiles,
            onUndoAllFiles: undoAllFiles,
            allPendingCount: allPending.length,
            onRollback: rollbackFile,
            onJump: jumpTo,
            otherFiles,
            onOpenOther: (p) => openFile(p, true),
            onOpenLauncher: (tab) => { setLauncherTab(tab || 'pending'); setLauncherOpen(true) },
            onRefresh: reloadFile,
            activePath: active,
            diffIdx, diffTotal: pendingRegions.length,
            fileIdx, fileTotal: sum.pendingFiles.length,
            onPrevDiff: () => gotoDiff(-1), onNextDiff: () => gotoDiff(1),
            onPrevFile: () => gotoFile(-1), onNextFile: () => gotoFile(1)
          })
        : (sum.pendingFiles.length > 0
            ? React.createElement(DiffBarEmpty, {
                sum, active, staleCount: staleRegions.length,
                onNextFile: () => { if (sum.pendingFiles.length) openFile(sum.pendingFiles[0].path, true) },
                onOpenLauncher: (tab) => { setLauncherTab(tab || 'pending'); setLauncherOpen(true) },
                onRefresh: reloadFile
              })
            : null))

  return React.createElement('div', { 'data-edrv-view': '1', style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-bg-base,transparent)', overflow: 'hidden' } },
    pathBar,
    tabRow,
    React.createElement('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      body,
      hoverEl,
      overlay),
    statusBar)
}

export function apply(ctx) {
  const schedule = (fn, ms) => ctx.timeout(fn, ms)

  // 中央「文件编辑」页签：类 VSCode 编辑器（顶部=文件页签+搜索框，差异 UI=文件底部圆角悬浮框）
  ctx.slots.register({
    name: 'conversation.view',
    id: 'edrv-editor',
    order: 5,
    label: '文件编辑',
    inject: (sessionId) => ({ sessionId })
  }, (props) => React.createElement(EditorView, Object.assign({}, props, { schedule })))

  // header 差异角标：仅当前工作区存在差异时渲染
  ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'edrv-diff-badge', order: 90, label: '差异' }, (props) => React.createElement(DiffBadge, Object.assign({}, props)))
}

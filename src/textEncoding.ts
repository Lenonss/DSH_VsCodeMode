/**
 * dsh-vscode-mode — 非 UTF-8 文本的判定与修复（纯函数：无 IO、无 React、无 node 依赖）。
 * 只在严格 UTF-8 解码失败后使用：整体能被 GB18030 严格解码时做无损转码；
 * 其余情况只标注坏字节位置，绝不猜测字节含义（决策 3：mixed 不写盘）。
 * 作者 ddj 2026-11-21
 */

// #region 类型

/** 判定类别：utf-8 正常、gb18030 整体可转、mixed 局部坏字节、binary 含 NUL。 */
export type EncodingKind = 'utf-8' | 'gb18030' | 'mixed' | 'binary'

/** 一处坏字节。 */
export interface EncodingBadRun {
  /** 字节偏移（0 基）。 */
  offset: number
  /** 所在行号（1 基）。 */
  line: number
  /** 该处首字节起的十六进制表示。 */
  bytes: string
  /** 所在行片段（坏字节显示为 U+FFFD）。 */
  context: string
}

/** 判定结果。 */
export interface EncodingVerdict {
  kind: EncodingKind
  size: number
  /** 坏字节序列数；仅在 mixed 有意义，超过扫描上限时为下界。 */
  badBytes: number
  /** 去重升序的行号；仅在 mixed 有意义。 */
  lines: number[]
  /** 前若干处样例；仅在 mixed 有意义。 */
  samples: EncodingBadRun[]
  /** 是否以 UTF-8 BOM 开头；转码时原样保留。 */
  bom: boolean
}

/** edrv.textCompat 请求。 */
export interface TextCompatArgs {
  sessionId?: string
  path: string
  mode: 'probe' | 'preview' | 'repair' | 'undo' | 'commit'
  /** undo/commit 必带：写入前的文件版本，不匹配则拒绝写。 */
  rev?: string
  /** commit 必带：用户编辑后的 UTF-8 正文。 */
  text?: string
}

/** edrv.textCompat 成功载荷。 */
export type TextCompatOk =
  | { mode: 'probe'; verdict: EncodingVerdict; version: string; size: number }
  | { mode: 'preview'; verdict: EncodingVerdict; version: string; size: number; text: string; truncated: boolean }
  | { mode: 'repair'; verdict: EncodingVerdict; version: string; backup: string }
  | { mode: 'commit'; version: string; backup: string }
  | { mode: 'undo'; version: string }

// #endregion

// #region 常量

/** 预览最多回传的 UTF-8 字节数。 */
export const COMPAT_PREVIEW_BYTES = 256 * 1024
/** 每份判定最多枚举的坏字节样例数。 */
const SAMPLE_LIMIT = 20
/** 坏字节扫描的硬上限，避免大文件把内存打满。 */
const SCAN_LIMIT = 200
/** 上下文片段的最大字符数。 */
const CONTEXT_CHARS = 44

// #endregion

// #region 判定

/**
 * 判定字节流的编码类别。
 * @public @author ddj 2026年11月21号
 * @param bytes 原始字节（调用方负责大小上限）
 * @returns 判定结果；不可判定时退回 mixed 并给出坏点
 */
export function classifyEncoding(bytes: Uint8Array): EncodingVerdict {
  const size = bytes.length
  const bom = hasUtf8Bom(bytes)

  if (bytes.includes(0)) return verdictOf('binary', size, bom)
  if (isUtf8(bytes)) return verdictOf('utf-8', size, bom)
  // GBK 文本几乎不产生 3/4 字节 UTF-8 序列：比例高说明是「UTF-8 正文带几个坏字节」，
  // 不能整体当 GBK 转码，否则正文会被转成乱码。
  const evidence = utf8Evidence(bytes)
  if (evidence.high > 0 && evidence.wide * 4 >= evidence.high) return mixedVerdict(bytes, size, bom)
  if (isGb18030(bytes)) return verdictOf('gb18030', size, bom)

  return mixedVerdict(bytes, size, bom)
}

/**
 * 构造混合判定：扫描坏字节并汇总行号。
 * @private @author ddj 2026年11月21号
 * @param bytes 原始字节 @param size 字节数 @param bom 是否带 BOM
 * @returns 完整判定
 */
function mixedVerdict(bytes: Uint8Array, size: number, bom: boolean): EncodingVerdict {
  const samples = scanBadRuns(bytes)
  const lines = [...new Set(samples.map((run) => run.line))].sort((left, right) => left - right)

  return { kind: 'mixed', size, badBytes: samples.length, lines, samples: samples.slice(0, SAMPLE_LIMIT), bom }
}

/**
 * UTF-8 证据：高字节总数与其中落在 3/4 字节序列里的字节数。
 * GBK 文本几乎不产生 3 字节序列，故比例高即「UTF-8 正文带洞口」。
 * @private @author ddj 2026年11月21号
 * @param bytes 原始字节
 * @returns 统计结果
 */
function utf8Evidence(bytes: Uint8Array): { high: number; wide: number } {
  let high = 0
  let wide = 0
  let at = 0

  while (at < bytes.length) {
    if (bytes[at]! < 0x80) { at++; continue }
    const width = utf8Width(bytes, at)
    if (width === 0) { high++; at++; continue }
    high += width
    if (width >= 3) wide += width
    at += width
  }

  return { high, wide }
}

/** @private @author ddj 2026年11月21号 @param kind 类别 @param size 字节数 @param bom 是否带 BOM @returns 无坏点的判定 */
function verdictOf(kind: EncodingKind, size: number, bom: boolean): EncodingVerdict {
  return { kind, size, badBytes: 0, lines: [], samples: [], bom }
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @returns 是否以 UTF-8 BOM 开头 */
function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @returns 严格 UTF-8 是否成立 */
function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch { return false }
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @returns GB18030 严格解码是否成立（运行时不支持则为 false） */
function isGb18030(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('gb18030', { fatal: true }).decode(bytes)
    return true
  } catch { return false }
}

// #endregion

// #region 坏字节扫描

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @returns 坏字节样例（最多 SCAN_LIMIT 处） */
function scanBadRuns(bytes: Uint8Array): EncodingBadRun[] {
  const starts = lineStartsOf(bytes)
  const runs: EncodingBadRun[] = []
  let index = 0

  while (index < bytes.length && runs.length < SCAN_LIMIT) {
    const width = utf8Width(bytes, index)
    if (width > 0) { index += width; continue }

    runs.push({
      offset: index,
      line: lineOf(starts, index),
      bytes: hexOf(bytes, index),
      context: contextOf(bytes, starts, index),
    })
    index += 1 + continuationCount(bytes, index + 1)
  }

  return runs
}

/**
 * 该位置起是否是一段合法 UTF-8。
 * @private @author ddj 2026年11月21号
 * @param bytes 原始字节 @param at 起始偏移
 * @returns 合法序列宽度；0 表示这里非法
 */
function utf8Width(bytes: Uint8Array, at: number): number {
  const lead = bytes[at] ?? 0
  if (lead < 0x80) return 1
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0
  if (need === 0 || at + need > bytes.length) return 0
  for (let step = 1; step < need; step++) {
    if ((bytes[at + step]! & 0xc0) !== 0x80) return 0
  }

  return overlongOrSurrogate(bytes, at, need) ? 0 : need
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @param at 起始偏移 @param need 序列宽度 @returns 是否过长编码或代理区（UTF-8 不允许） */
function overlongOrSurrogate(bytes: Uint8Array, at: number, need: number): boolean {
  const second = bytes[at + 1]! & 0x3f
  if (need === 2) return (bytes[at]! & 0x1f) < 2
  if (need === 3) {
    const code = ((bytes[at]! & 0x0f) << 12) | (second << 6) | (bytes[at + 2]! & 0x3f)
    return code < 0x800 || (code >= 0xd800 && code <= 0xdfff)
  }
  const code = ((bytes[at]! & 0x07) << 18) | (second << 12) | ((bytes[at + 2]! & 0x3f) << 6) | (bytes[at + 3]! & 0x3f)
  return code < 0x10000 || code > 0x10ffff
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @param at 起始偏移 @returns 紧随其后的续字节数量（最多 3） */
function continuationCount(bytes: Uint8Array, at: number): number {
  let count = 0
  while (count < 3 && at + count < bytes.length && (bytes[at + count]! & 0xc0) === 0x80) count++
  return count
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @returns 每行起始偏移（第 1 行为 0） */
function lineStartsOf(bytes: Uint8Array): number[] {
  const starts = [0]
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 0x0a && index + 1 < bytes.length) starts.push(index + 1)
  }
  return starts
}

/** @private @author ddj 2026年11月21号 @param starts 行起始偏移 @param offset 字节偏移 @returns 行号（1 基） */
function lineOf(starts: number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @param at 起始偏移 @returns 最多 4 字节的十六进制 */
function hexOf(bytes: Uint8Array, at: number): string {
  let text = ''
  for (let step = 0; step < 4 && at + step < bytes.length; step++) {
    if (step > 0 && (bytes[at + step]! & 0xc0) !== 0x80) break
    text += bytes[at + step]!.toString(16).padStart(2, '0')
  }
  return text
}

/** @private @author ddj 2026年11月21号 @param bytes 原始字节 @param starts 行起始偏移 @param offset 坏字节位置 @returns 该行片段 */
function contextOf(bytes: Uint8Array, starts: number[], offset: number): string {
  const line = lineOf(starts, offset)
  const begin = starts[line - 1] ?? 0
  const end = line < starts.length ? starts[line]! : bytes.length
  const text = new TextDecoder('utf-8').decode(bytes.subarray(begin, end)).replace(/[\r\n]+$/, '').trim()
  if (text.length <= CONTEXT_CHARS) return text

  const column = Math.max(0, Math.min(text.length - CONTEXT_CHARS, offset - begin - 12))
  return '…' + text.slice(column, column + CONTEXT_CHARS) + '…'
}

// #endregion

// #region 预览与修复

/**
 * 按判定结果解码一段只读预览（绝不回写）。
 * @public @author ddj 2026年11月21号
 * @param bytes 原始字节 @param verdict 判定结果
 * @returns 预览文本与是否被截断；binary 返回空文本
 */
export function decodePreview(bytes: Uint8Array, verdict: EncodingVerdict): { text: string; truncated: boolean } {
  const truncated = bytes.length > COMPAT_PREVIEW_BYTES
  const slice = truncated ? bytes.subarray(0, COMPAT_PREVIEW_BYTES) : bytes
  if (verdict.kind === 'binary') return { text: '', truncated }

  const encoding = verdict.kind === 'gb18030' ? 'gb18030' : 'utf-8'
  return { text: new TextDecoder(encoding).decode(slice), truncated }
}

/**
 * 生成可写入的 UTF-8 文本；只有 gb18030 可无损转码。
 * @public @author ddj 2026年11月21号
 * @param bytes 原始字节 @param verdict 判定结果
 * @returns 成功给文本，失败给拒绝原因
 */
export function repairBytes(bytes: Uint8Array, verdict: EncodingVerdict): { ok: true; text: string } | { ok: false; reason: string } {
  if (verdict.kind !== 'gb18030') return { ok: false, reason: refusalOf(verdict.kind) }

  try {
    return { ok: true, text: new TextDecoder('gb18030', { fatal: true, ignoreBOM: true }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'GB18030 解码未通过，未写入任何字节' }
  }
}

/**
 * 该类别的拒绝说明。
 * @public @author ddj 2026年11月21号
 * @param kind 判定类别
 * @returns 面向用户的一句话
 */
export function refusalOf(kind: EncodingKind): string {
  if (kind === 'mixed') return '文件含局部非法字节，按推荐方式不改字节，请用只读预览'
  if (kind === 'binary') return '文件疑似二进制（含 NUL），不支持转码'
  if (kind === 'utf-8') return '文件已是合法 UTF-8，无需修复'
  return '当前运行时缺少 GB18030 解码能力，无法转码'
}

/**
 * 统计正文里仍未处理的坏字节占位（U+FFFD）。
 * @public @author ddj 2026年11月21号
 * @param text 待保存文本
 * @returns 占位数量
 */
export function lossyCountOf(text: string): number {
  let count = 0
  for (const char of text) if (char === '\uFFFD') count++
  return count
}

/**
 * 类别显示名。
 * @public @author ddj 2026年11月21号
 * @param kind 判定类别
 * @returns 面板用的短标签
 */
export function kindLabelOf(kind: EncodingKind): string {
  if (kind === 'gb18030') return 'GB18030'
  if (kind === 'mixed') return '局部非法字节'
  if (kind === 'binary') return '二进制'
  return 'UTF-8'
}

/**
 * 确定性备份路径（撤销只认这一条）。
 * @public @author ddj 2026年11月21号
 * @param path 目标文件相对路径
 * @returns 同级备份路径
 */
export function backupPathOf(path: string): string {
  return path + '.utf8bak'
}

/**
 * 读取失败文案是否属于编码问题。
 * @public @author ddj 2026年11月21号
 * @param message 宿主错误原文
 * @returns 是否可由编码兼容面板接手
 */
export function isEncodingError(message: string): boolean {
  return /invalid utf-?8|not valid for encoding|utf-8 text/i.test(String(message ?? ''))
}

// #endregion

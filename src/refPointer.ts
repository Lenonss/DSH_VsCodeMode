/**
 * dsh-vscode-mode host — 引用路径解析（剪贴板 / 拖拽里的文件线索 → 工作区相对路径）。
 *
 * 场景：用户把文件从资源管理器拖进对话输入框、粘贴一个文件、或粘贴一段
 * `@相对路径 Lx-Ly` 文本时，客户端拿到的只是路径片段（绝对路径 / 相对路径 / 裸文件名）。
 * 本模块把它落到工作区相对路径：先按绝对路径 → 相对路径 → 文件名检索逐级解析，
 * 多义时给出候选而不是瞎猜（插错引用的代价比提示一次更大）。
 *
 * @author ddj 2026年11月15号
 */
import { relative } from 'node:path'
import type { Ctx, Session } from './store.js'
import { resolveTarget } from './store.js'
import { searchRoot } from './search/ripgrep.js'
import { normalizeRel } from './tree.js'

/** 引用解析输入。 */
export interface RefResolveInput {
  ctx: Ctx
  session: Session
  /** 会话工作区目录（相对路径的基准）。 */
  cwd: string
  /** 剪贴板/拖拽里的路径片段（可带 `@`、引号、反斜杠）。 */
  ref: string
  /** 当前活动文件（多义时优先同目录）。 */
  activePath?: string
  /** 文件名检索（通常是工作区文件搜索编排器）。 */
  search: (query: string) => Promise<{ files: string[] }>
}

/** 引用解析结果（`path` 为工作区相对路径）。 */
export interface RefResolveResult {
  path: string
  /** 同等优先级的候选（多义时非空，调用方应提示而不是直接插入）。 */
  ambiguous?: string[]
}

/** Windows 盘符绝对路径（`C:/...`）。 */
const DRIVE_PATH = /^[A-Za-z]:\//

/**
 * 清洗路径片段：去 `@`、去包裹引号、统一分隔符、去首尾空白与末尾斜杠。
 * @author ddj 2026年11月15号
 * @param ref 原始片段
 * @returns 清洗后的路径文本（空串表示无有效内容）
 */
export function cleanRefText(ref: string): string {
  let text = String(ref ?? '').trim()
  if (text.startsWith('@')) text = text.slice(1)
  text = text.trim().replace(/^["'`]|["'`]$/g, '')
  text = text.split('\\').join('/').trim()
  while (text.length > 1 && text.endsWith('/')) text = text.slice(0, -1)
  return text
}

/**
 * 取路径末段文件名。
 * @author ddj 2026年11月15号
 * @param path 路径文本
 * @returns 文件名（无分隔符时为原文）
 */
export function baseNameOfPath(path: string): string {
  return String(path ?? '').split('/').filter(Boolean).pop() ?? ''
}

/**
 * 目录部分（无目录时返回空串）。
 * @author ddj 2026年11月15号
 * @param path 路径文本
 * @returns 目录前缀
 */
export function dirNameOfPath(path: string): string {
  const segments = String(path ?? '').split('/').filter(Boolean)
  return segments.length > 1 ? segments.slice(0, -1).join('/') : ''
}

/**
 * 为文件名检索结果打分排序：优先与活动文件同目录，其次层级更浅、路径更短。
 * @author ddj 2026年11月15号
 * @param files 候选相对路径
 * @param activePath 当前活动文件
 * @returns 排序后的候选
 */
export function rankCandidates(files: string[], activePath?: string): string[] {
  const activeDir = dirNameOfPath(String(activePath ?? ''))
  const unique = [...new Set(files.map((file) => String(file ?? '').split('\\').join('/')).filter(Boolean))]
  const score = (file: string): number => {
    const sameDir = activeDir !== '' && dirNameOfPath(file) === activeDir ? 0 : 1
    const depth = file.split('/').filter(Boolean).length
    return sameDir * 10000 + depth * 100 + file.length
  }
  return unique.map((file) => ({ file, score: score(file) })).sort((left, right) => left.score - right.score || left.file.localeCompare(right.file)).map((item) => item.file)
}

/**
 * 判定「是否多义到不能自动插入」。
 *
 * 规则（比单纯排序更保守）：只有唯一候选、或活动文件所在目录里恰好只有一个同名候选时才自动插入；
 * 其余情况都算多义，交给调用方提示，避免「粘贴 index.ts 被悄悄插成 src/index.ts」。
 * @author ddj 2026年11月15号
 * @param ranked 已排序候选
 * @param activePath 当前活动文件
 * @returns 多义候选（空数组 = 可以自动插入）
 */
export function ambiguityOf(ranked: string[], activePath?: string): string[] {
  if (ranked.length < 2) return []
  const activeDir = dirNameOfPath(String(activePath ?? ''))
  if (!activeDir) return ranked.slice(0, 5)
  const sameDir = ranked.filter((file) => dirNameOfPath(file) === activeDir)
  if (sameDir.length === 1) return []
  return (sameDir.length > 1 ? sameDir : ranked).slice(0, 5)
}

/**
 * 解析引用片段为工作区相对路径。
 * @author ddj 2026年11月15号
 * @param input 解析输入
 * @returns 解析结果；无法解析时返回 null
 * @sideEffects 只读（stat / 文件检索），不写盘
 */
export async function resolveRefPath(input: RefResolveInput): Promise<RefResolveResult | null> {
  const text = cleanRefText(input.ref)
  if (!text) return null

  const absolute = text.startsWith('/') || DRIVE_PATH.test(text)
  if (absolute) {
    const resolved = await resolveAbsolute(input, text)
    if (resolved !== null) return { path: resolved }
  } else {
    const rel = normalizeRel(text)
    if (rel) {
      const found = await isWorkspaceFile(input, rel)
      if (found) return { path: rel }
    }
  }

  const base = baseNameOfPath(text)
  if (!base) return null
  let files: string[] = []
  try {
    files = (await input.search(base)).files
  } catch (error) {
    files = []
  }
  const matches = files.filter((file) => baseNameOfPath(file).toLowerCase() === base.toLowerCase())
  const ranked = rankCandidates(matches, input.activePath)
  if (!ranked.length) return null
  const ambiguous = ambiguityOf(ranked, input.activePath)
  return ambiguous.length > 0 ? { path: ranked[0], ambiguous } : { path: ranked[0] }
}

/**
 * 绝对路径 → 工作区相对路径（越界返回 null）。
 * @author ddj 2026年11月15号
 * @param input 解析输入
 * @param text 绝对路径文本
 * @returns 相对路径或 null
 */
async function resolveAbsolute(input: RefResolveInput, text: string): Promise<string | null> {
  const fs = input.ctx.get('fs')
  if (!fs) return null
  try {
    const target = await resolveTarget(input.ctx, input.session, text)
    const info = await fs.stat(target)
    if (!info || info.type !== 'file') return null
    const root = await searchRoot(input.ctx, input.session)
    const hostPath = fs.processPath(target)
    const rel = relative(root, hostPath).split('\\').join('/')
    if (!rel || rel.startsWith('../')) return null
    return rel
  } catch (error) {
    return null
  }
}

/**
 * 相对路径是否指向工作区内真实文件。
 * @author ddj 2026年11月15号
 * @param input 解析输入
 * @param rel 工作区相对路径
 * @returns 是否命中普通文件
 */
async function isWorkspaceFile(input: RefResolveInput, rel: string): Promise<boolean> {
  const fs = input.ctx.get('fs')
  if (!fs) return false
  try {
    const target = await resolveTarget(input.ctx, input.session, rel)
    const info = await fs.stat(target)
    return Boolean(info) && info.type === 'file'
  } catch (error) {
    return false
  }
}

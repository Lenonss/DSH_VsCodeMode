/**
 * dsh-vscode-mode host — 原生提交（P4）+ 提交计划与最近提交信息（22-agent-tools-and-commit）。
 *
 * 为什么自建提交而不是继续跳 TortoiseProc：提交是提交前整理（changelist/勾选/自动 add·delete）
 * 的终点，只有在本插件内执行才能保证「勾选了什么就提交什么」；Tortoise 对话框拿不到我们的勾选态。
 *
 * 关键纪律（对齐 svn-workflow 与远程项目的既有经验）：
 * - **先 status 重查**：客户端清单可能已过期，只提交仍处于变更态的路径，其余进 skipped；
 * - **不分块**：提交分块会拆成多个 revision，超上限一律拒绝而不是半提交；
 * - **中文日志**：UTF-8 临时文件 + §--encoding utf-8 -F§，避开 Windows GBK 控制台；
 * - **不擅自解决冲突**：冲突路径单列并提示先更新，绝不顺带 resolve。
 * @author ddj 2026年11月15号
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SvnChangeEntry, SvnCommitEntry, SvnCommitPlan, SvnCommitResult } from './shared/svn.js'
import { BATCH_PATHS_CAP, COMMIT_MSG_MAX, COMMIT_PATHS_CAP, SVN_READONLY_CODE } from './shared/svn.js'
import { commitResultOf } from './svnText.js'
import { classifySvnError } from './svnCore.js'
import { hashOf, userCacheDir } from './paths.js'

/** 提交子进程基础超时（大工作副本/慢网络留足预算；设置倍数再放大）。 */
export const COMMIT_GRACE_MS = 300_000
/** 自动 add/delete 子进程基础超时。 */
export const PREPARE_GRACE_MS = 120_000
/** 最近提交信息保留条数。 */
export const RECENT_MAX = 20
/** 最近提交信息单条上限（字符）。 */
export const RECENT_ITEM_MAX = 2000

/** 提交作用域（会话工作区 + 工作副本根）。 */
export interface SvnCommitScope {
  /** 会话工作区目录。 */
  cwd: string
  /** 工作副本根（绝对路径）。 */
  root: string
}

/** 提交模块依赖（由 svn.ts 注入，避免与 createSvnRpc 互相 import）。 */
export interface SvnCommitDeps {
  /** svn 执行器（只读门禁在 svnCore，此处不再判）。 */
  run: (cwd: string, argv: string[], graceMs: number, stdoutCap?: number, allowFallback?: boolean) => Promise<{ code: number | null; stdout: string; stderr: string }>
  /** 会话 → 作用域（含「不受管理/无 CLI」错误文案）。 */
  scopeOf: (sessionId?: string) => Promise<SvnCommitScope | { err: string }>
  /** 变更清单读取（force = 强制重查）。 */
  changesOf: (root: string, force?: boolean) => Promise<{ entries: SvnChangeEntry[]; truncated: boolean }>
  /** 作废变更/状态缓存（提交与自动整理后必做）。 */
  invalidate: (root: string) => void
  /** 工作区相对路径 → svn 目标（越界返回 null）。 */
  targetOf: (cwd: string, root: string, rel: string) => string | null
  /** 只读是否开启（提交入口兜底；正常路径已被执行器拦截）。 */
  readOnly: () => boolean
  /** 提交前自动整理默认开关（请求未显式给出时生效；缺省按开启）。 */
  defaults?: () => { autoAdd: boolean; autoDelete: boolean }
}

/** 提交请求（与 RPC 契约同形）。 */
export interface SvnCommitRequest {
  sessionId?: string
  paths: string[]
  message: string
  changelist?: string
  keepLocks?: boolean
  autoAdd?: boolean
  autoDelete?: boolean
}

/** 提交计划结果。 */
export type SvnCommitPlanOutcome = { ok: true; plan: SvnCommitPlan } | { ok: false; error: string }

/** 提交结果（ok:false 带可读错误与可选拒绝码）。 */
export type SvnCommitOutcome =
  | ({ ok: true } & SvnCommitResult)
  | { ok: false; error: string; code?: string }

/** 提交动作字母 → 中文说明。 */
const ACTION_LABEL: Record<SvnCommitEntry['action'], string> = {
  M: '已修改',
  A: '已新增',
  D: '已删除',
  R: '已替换',
}

/** 提交输出里单文件动作行（英文 / 常见中文输出）。 */
const ENTRY_PATTERNS: Array<{ action: SvnCommitEntry['action']; re: RegExp }> = [
  { action: 'M', re: /^(?:Sending|正在发送)\s+(.+)$/ },
  { action: 'A', re: /^(?:Adding|正在添加)\s+(.+)$/ },
  { action: 'D', re: /^(?:Deleting|正在删除)\s+(.+)$/ },
  { action: 'R', re: /^(?:Replacing|正在替换)\s+(.+)$/ },
]

/**
 * 解析提交输出里的逐文件动作。
 * @author ddj 2026年11月15号
 * @param output 合并后的提交输出
 * @returns 逐文件动作（保持输出顺序；无法识别的行忽略）
 */
export function commitEntriesOf(output: string): SvnCommitEntry[] {
  const entries: SvnCommitEntry[] = []
  for (const raw of String(output ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    for (const pattern of ENTRY_PATTERNS) {
      const matched = pattern.re.exec(line)
      if (!matched) continue
      const path = matched[1].trim()
      if (!path) continue
      entries.push({ path, action: pattern.action, label: ACTION_LABEL[pattern.action] })
      break
    }
  }
  return entries
}

/**
 * 提交信息校验（首行 → subject，其余 → body；总长受限）。
 * @author ddj 2026年11月15号
 * @param message 完整提交信息
 * @returns 错误文案；合法为 null
 */
export function messageErrorOf(message: string): string | null {
  const text = String(message ?? '')
  if (!text.trim()) return '提交信息不能为空'
  if (text.length > COMMIT_MSG_MAX) return '提交信息最长 ' + COMMIT_MSG_MAX + ' 字符'
  if (text.includes('\u0000')) return '提交信息包含非法字符'
  return null
}

/**
 * 最近提交信息文件路径（按工作副本根哈希隔离，与 sidecar 口径一致）。
 * @author ddj 2026年11月15号
 * @param root 工作副本根
 * @returns 文件绝对路径
 */
export function recentFileOf(root: string): string {
  return join(userCacheDir(), 'svn-commit-msg', hashOf(root) + '.json')
}

/**
 * 读取最近提交信息（缺失/损坏一律空表，不抛错）。
 * @author ddj 2026年11月15号
 * @param root 工作副本根
 * @returns 提交信息列表（新→旧）
 */
export async function readRecent(root: string): Promise<string[]> {
  try {
    const raw = await readFile(recentFileOf(root), 'utf8')
    const parsed = JSON.parse(raw) as { messages?: unknown }
    const list = Array.isArray(parsed?.messages) ? parsed.messages : []
    return list.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/**
 * 追加最近提交信息（去重上浮、截断到上限；写盘失败不影响提交结果）。
 * @author ddj 2026年11月15号
 * @param root 工作副本根
 * @param message 本次提交信息
 */
export async function pushRecent(root: string, message: string): Promise<void> {
  const trim = String(message ?? '').trim().slice(0, RECENT_ITEM_MAX)
  if (!trim) return
  try {
    const previous = await readRecent(root)
    const next = [trim, ...previous.filter((item) => item !== trim)].slice(0, RECENT_MAX)
    const file = recentFileOf(root)
    await mkdir(join(userCacheDir(), 'svn-commit-msg'), { recursive: true })
    await writeFile(file, JSON.stringify({ messages: next }), 'utf8')
  } catch {
    /* 最近信息是便利功能，失败不影响提交 */
  }
}

/**
 * 创建提交能力（计划 + 执行）。
 * @author ddj 2026年11月15号
 * @param deps 依赖
 * @returns 计划与提交方法
 */
export function createSvnCommit(deps: SvnCommitDeps) {
  /**
   * 提交计划：变更清单 + 既有 changelist + 最近信息。
   * @author ddj 2026年11月15号
   * @param sessionId 会话 id
   * @returns 计划或错误
   */
  async function planOf(sessionId?: string): Promise<SvnCommitPlanOutcome> {
    const scope = await deps.scopeOf(sessionId)
    if ('err' in scope) return { ok: false, error: scope.err }
    try {
      const changes = await deps.changesOf(scope.root, false)
      const names = new Set<string>()
      for (const entry of changes.entries) if (entry.changelist) names.add(entry.changelist)
      return {
        ok: true,
        plan: {
          entries: changes.entries,
          changelists: [...names].sort((a, b) => a.localeCompare(b)),
          recent: await readRecent(scope.root),
          truncated: changes.truncated,
        },
      }
    } catch (error) {
      return { ok: false, error: '读取提交计划失败：' + String(error instanceof Error ? error.message : error) }
    }
  }

  /**
   * 提交已选路径：status 重查 → 自动整理 → commit → 解析 → 作废缓存。
   * @author ddj 2026年11月15号
   * @param request 提交请求
   * @returns 提交结果
   */
  async function commitOf(request: SvnCommitRequest): Promise<SvnCommitOutcome> {
    if (deps.readOnly()) return { ok: false, code: SVN_READONLY_CODE, error: '只读模式已开启：提交被拒绝（可在设置里关闭 svnReadOnly）' }
    const messageError = messageErrorOf(request.message)
    if (messageError) return { ok: false, error: messageError }
    const requested = Array.isArray(request.paths) ? [...new Set(request.paths.map((item) => String(item ?? '').trim()).filter(Boolean))] : []
    if (!requested.length) return { ok: false, error: '未选择任何文件' }
    if (requested.length > COMMIT_PATHS_CAP) return { ok: false, error: '一次最多提交 ' + COMMIT_PATHS_CAP + ' 个路径（提交不分块，避免拆成多个版本）' }

    const scope = await deps.scopeOf(request.sessionId)
    if ('err' in scope) return { ok: false, error: scope.err }
    // 闭包内 TS 不保留联合类型收窄，先落成局部常量
    const scopeCwd = scope.cwd
    const scopeRoot = scope.root

    let changes: { entries: SvnChangeEntry[]; truncated: boolean }
    try {
      changes = await deps.changesOf(scope.root, true)
    } catch (error) {
      return { ok: false, error: '提交前状态重查失败：' + String(error instanceof Error ? error.message : error) }
    }

    const byPath = new Map<string, SvnChangeEntry>()
    for (const entry of changes.entries) byPath.set(entry.path, entry)

    const skipped: string[] = []
    const conflicts: string[] = []
    const addable: string[] = []
    const deletable: string[] = []
    const targets: string[] = []
    const fallback = deps.defaults?.() ?? { autoAdd: true, autoDelete: true }
    const autoAdd = request.autoAdd ?? fallback.autoAdd
    const autoDelete = request.autoDelete ?? fallback.autoDelete

    for (const path of requested) {
      const entry = byPath.get(path)
      if (!entry || (entry.status === 'normal' || entry.status === 'external')) { skipped.push(path); continue }
      if (entry.status === 'ignored') { skipped.push(path); continue }
      if (request.changelist && entry.changelist !== request.changelist) { skipped.push(path); continue }
      if (entry.status === 'conflicted') { conflicts.push(path); continue }
      if (entry.status === 'unversioned') {
        if (!autoAdd) { skipped.push(path); continue }
        addable.push(path)
        continue
      }
      if (entry.status === 'missing') {
        if (!autoDelete) { skipped.push(path); continue }
        deletable.push(path)
        continue
      }
      targets.push(path)
    }

    if (conflicts.length && !targets.length && !addable.length && !deletable.length) {
      return { ok: false, error: '所选文件全部处于冲突状态：请先更新并解决冲突后再提交（' + conflicts.slice(0, 5).join('、') + '）' }
    }
    if (!targets.length && !addable.length && !deletable.length) {
      return { ok: false, error: '所选文件均无待提交变更（可能已提交或已被还原）' }
    }

    /** @author ddj 2026年11月15号 @param verb 子命令 @param paths 相对路径 @returns 失败文案或 null */
    async function prepare(verb: 'add' | 'delete', paths: readonly string[]): Promise<string | null> {
      for (let start = 0; start < paths.length; start += BATCH_PATHS_CAP) {
        const chunk = paths.slice(start, start + BATCH_PATHS_CAP)
        const resolved = chunk.map((rel) => deps.targetOf(scopeCwd, scopeRoot, rel))
        if (resolved.some((item) => item === null)) return '目标不在 SVN 工作副本内'
        const outcome = await deps.run(scopeRoot, [verb, '--', ...resolved.map((item) => item as string)], PREPARE_GRACE_MS)
        if (outcome.code !== 0) {
          const info = classifySvnError([outcome.stderr, outcome.stdout].filter(Boolean).join('\n'))
          return '自动 ' + verb + ' 失败：' + info.message
        }
      }
      return null
    }

    const prepareError = await prepare('add', addable) ?? await prepare('delete', deletable)
    if (prepareError) {
      deps.invalidate(scope.root)
      return { ok: false, error: prepareError }
    }

    const commitPaths = [...targets, ...addable, ...deletable]
    const resolved = commitPaths.map((rel) => deps.targetOf(scope.cwd, scope.root, rel))
    if (resolved.some((item) => item === null)) return { ok: false, error: '目标不在 SVN 工作副本内' }

    const argv = ['commit', '--encoding', 'utf-8', '-F', '']
    if (request.keepLocks) argv.push('--no-unlock')
    if (request.changelist) argv.push('--changelist', request.changelist)
    const messageFile = join(tmpdir(), 'dsh-vscode-commit-' + process.pid + '-' + Date.now() + '.txt')
    let outcome: { code: number | null; stdout: string; stderr: string }
    try {
      await writeFile(messageFile, request.message.replace(/\r\n/g, '\n'), 'utf8')
      argv[argv.indexOf('')] = messageFile
      outcome = await deps.run(scope.root, [...argv, '--', ...resolved.map((item) => item as string)], COMMIT_GRACE_MS)
    } catch (error) {
      deps.invalidate(scope.root)
      return { ok: false, error: '提交失败：' + String(error instanceof Error ? error.message : error) }
    } finally {
      try { await unlink(messageFile) } catch { /* 临时文件由系统清理，删除失败不影响结果 */ }
    }

    deps.invalidate(scope.root)
    const parsed = commitResultOf(outcome.stdout, outcome.stderr, outcome.code, '提交')
    const entries = commitEntriesOf(parsed.output)

    if (outcome.code !== 0) {
      let freshConflicts: string[] = []
      try {
        const fresh = await deps.changesOf(scope.root, true)
        freshConflicts = fresh.entries.filter((entry) => entry.status === 'conflicted').map((entry) => entry.path)
      } catch { /* 冲突补测失败就按原冲突清单 */ }
      const info = classifySvnError(parsed.output)
      const conflictPaths = [...new Set([...conflicts, ...freshConflicts])]
      return {
        ok: false,
        error: '提交失败：' + (info.kind === 'conflict' ? info.message : parsed.output ? info.message : '未知错误') + (conflictPaths.length ? '（冲突：' + conflictPaths.slice(0, 5).join('、') + '）' : ''),
      }
    }

    await pushRecent(scope.root, request.message)
    const result: SvnCommitResult = {
      summary: parsed.summary,
      conflicts,
      entries,
      skipped,
      output: parsed.output,
    }
    if (parsed.revision !== undefined) result.revision = parsed.revision
    return { ok: true, ...result }
  }

  return { planOf, commitOf }
}

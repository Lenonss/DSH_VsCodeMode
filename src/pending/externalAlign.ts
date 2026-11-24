/**
 * 外部改动补扫：拿版本库当基线，把「插件还没记录过」的工作副本改动用 `source='scan'` 补录，
 * 同时提供 watch 采集需要的两个只读能力（改动集合与基线内容）。
 *
 * 设计取舍：
 * - 候选只来自一条 `git status` / `svn status` 命令，不遍历目录树；因此 200 MB 仓库的启动对齐
 *   与定时补扫都只花「一条命令 + 少量读盘」。
 * - 不在版本库改动集合里的路径一律不建记录：内容变化只能来自版本库同步，记成 agent 改动会
 *   污染审查队列并让撤销误伤（见任务书验收 4）。
 * - 基线与读盘都有硬上限（条数、字节、截止时间），超限写 `gaps`，绝不静默截断。
 * 作者 ddj 2026-11-24
 */
import { sessionOf } from '../registry.js'
import type { Ctx } from '../store.js'
import { policyOf } from '../store.js'
import type { PendingWrite } from './capture.js'
import { noteCaptureGap, readText } from './capture.js'
import type { ShellLike, VcsStatus } from './vcs.js'
import { vcsBaselineOf, vcsStatus } from './vcs.js'
import { pathKeyOf } from './provenance.js'
import { loadEntries } from './persist.js'
import type { StoredEntry } from './persist.js'
import { log } from '../log.js'

// --region 预算

/** 单次补扫的预算：候选条数、总读取字节、总耗时、基线读取条数。 */
export interface AlignBudget {
  paths: number
  bytes: number
  deadlineMs: number
  baselines: number
}

/** 默认预算：大仓下也只是一条 status 命令加几十次读盘。 */
export const ALIGN_BUDGET: AlignBudget = { paths: 2000, bytes: 16 << 20, deadlineMs: 5000, baselines: 32 }

/** 单文件读取上限：与待审采集一致，超出只标 oversized 不读全文。 */
export const ALIGN_FILE_MAX = 1024 * 1024

// --endregion

// --region 只读能力

/** 补扫可用的版本库作用域：shell 已绑定会话沙箱策略。 */
export interface VcsScope {
  shell: ShellLike
  cwd: string
  sessionId: string
}

/**
 * @author ddj 2026-11-24
 * @description: 取本会话可用的版本库能力；没有 shell 服务或会话不存在时返回 null。
 * @param ctx Host 上下文
 * @param cwd 工作区
 * @param sessionId 会话
 * @returns 作用域或 null
 */
export function vcsScopeOf(ctx: Ctx, cwd: string, sessionId: string): VcsScope | null {
  const raw = ctx.get('shell') as ShellLike | undefined
  if (!raw || typeof raw.resolve !== 'function') return null
  const policy = policyOf(ctx, sessionOf(ctx, sessionId))
  return {
    cwd: String(cwd),
    sessionId,
    shell: {
      resolve: (request) => raw.resolve(policy ? { ...request, sandboxPolicy: policy } : request),
      execute: (spec) => raw.execute(spec),
    },
  }
}

// --endregion

// --region 补扫

/** 一次补扫的结果。 */
export interface AlignOutcome {
  /** 新建或更新的条目数。 */
  imported: number
  /** 版本库报告的改动条数（含已记录、已跳过的）。 */
  changed: number
  /** 因预算、编码、读取失败等原因没处理的说明。 */
  gaps: string[]
}

/** 补扫需要的外部依赖（便于单测注入）。 */
export interface AlignDeps {
  /** 读磁盘内容（严格 UTF-8 往返）；缺失返回 null，不可读抛错。 */
  read(absolute: string): Promise<string | null>
  /** 落库；由调用方提供（复用待审采集 sink）。 */
  record(write: PendingWrite): void
  /** 已落库条目（按比较键索引）。 */
  entries(): Map<string, StoredEntry>
  now?(): number
}

/**
 * @author ddj 2026-11-24
 * @description: 一次补扫：版本库候选 → 逐条对比已知内容 → 未记录的补录（source='scan'）。
 * 无版本库或状态命令不可用时降级为「只对齐已记录条目」，并把原因写进 gaps。
 * @param scope 版本库作用域（可为空：无 shell 时走降级）
 * @param deps 读盘与落库能力
 * @param budget 预算
 * @returns 结果
 */
export async function alignExternal(scope: VcsScope | null, deps: AlignDeps, budget: AlignBudget = ALIGN_BUDGET): Promise<AlignOutcome> {
  const started = Date.now()
  const now = deps.now ?? Date.now
  const gaps: string[] = []
  const known = deps.entries()

  const status = scope ? await vcsStatus(scope.shell, scope.cwd) : null
  if (!status) {
    const reason = scope ? '版本库状态不可用（非 git/svn 或命令失败）：补扫只对齐已记录条目' : '当前环境没有 shell 能力：补扫只对齐已记录条目'
    gaps.push(reason)
    const imported = await reconcileKnown(scope, deps, known, budget, started, now, gaps)
    return { imported, changed: 0, gaps }
  }

  const candidates = [...status.entries]
  if (candidates.length > budget.paths) {
    gaps.push(`版本库报告 ${candidates.length} 个改动，本次只处理前 ${budget.paths} 个`)
  }
  let imported = 0
  let bytes = 0
  let baselines = 0

  for (const [key, entry] of candidates.slice(0, budget.paths)) {
    if (Date.now() - started > budget.deadlineMs) {
      gaps.push(`补扫超过 ${budget.deadlineMs}ms，剩余改动留到下一轮`)
      break
    }
    const stored = known.get(key)
    const absolute = entry.path
    try {
      if (entry.status === 'deleted') {
        // 版本库里已删：已知内容照旧当基线才能恢复；没有条目时按「基线未知」留档
        if (stored && stored.flags.missing) continue
        deps.record(writeOf(scope, absolute, stored ? stored.entry.newText : null, null, now(), 'external',
          stored ? 'known' : 'unknown'))
        imported += 1
        continue
      }
      const content = await deps.read(absolute)
      if (content === null) continue
      if (content.length > ALIGN_FILE_MAX) { gaps.push(absolute + ': 超过单文件上限，未补扫'); continue }
      if (stored && stored.entry.newText === content) continue
      if (bytes + content.length > budget.bytes) { gaps.push(absolute + ': 补扫读取预算已用尽，未补扫'); continue }
      bytes += content.length
      if (stored) {
        deps.record(writeOf(scope, absolute, stored.entry.newText, content, now(), 'external', 'known'))
        imported += 1
        continue
      }
      // 版本库说新增（未跟踪/added）：修改前内容就是"不存在"，撤销语义是删除文件
      if (entry.status === 'added') {
        deps.record(writeOf(scope, absolute, null, content, now(), 'external', 'absent'))
        imported += 1
        continue
      }
      // 已跟踪的修改但没有既有条目：修改前内容只能取版本库基线，读不到就标未知（撤销置灰）
      let base: string | null = null
      if (baselines < budget.baselines) {
        baselines += 1
        base = await vcsBaselineOf(scope!.shell, status, absolute)
      } else {
        gaps.push(absolute + ': 基线读取预算已用尽，记为基线未知')
      }
      deps.record(writeOf(scope, absolute, base, content, now(), 'external', base === null ? 'unknown' : 'vcs'))
      imported += 1
    } catch (error) {
      gaps.push(absolute + ': ' + String(error))
    }
  }
  return { imported, changed: candidates.length, gaps }
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 降级路径：只把已记录条目与磁盘对齐（条目数很小，不会遍历仓库）。
 * @param scope 版本库作用域
 * @param deps 读盘与落库能力
 * @param known 已落库条目
 * @param budget 预算
 * @param started 起始时间
 * @param now 时钟
 * @param gaps 缺口输出
 * @returns 无
 */
async function reconcileKnown(
  scope: VcsScope | null, deps: AlignDeps, known: Map<string, StoredEntry>,
  budget: AlignBudget, started: number, now: () => number, gaps: string[],
): Promise<number> {
  let bytes = 0
  let imported = 0
  for (const stored of known.values()) {
    if (Date.now() - started > budget.deadlineMs) { gaps.push('降级补扫超过截止时间，剩余条目留到下一轮'); break }
    try {
      // 必须用条目里的真实路径读盘：比较键在 Windows 上折叠过大小写，不能当路径用。
      const content = await deps.read(stored.entry.id)
      if (content === null) {
        if (stored.flags.missing) continue
        deps.record(writeOf(scope, stored.entry.path, stored.entry.newText, null, now(), 'external', 'known'))
        imported += 1
        continue
      }
      if (content === stored.entry.newText) continue
      if (bytes + content.length > budget.bytes) { gaps.push(stored.entry.path + ': 补扫读取预算已用尽，未补扫'); break }
      bytes += content.length
      deps.record(writeOf(scope, stored.entry.path, stored.entry.newText, content, now(), 'external', 'known'))
      imported += 1
    } catch (error) {
      gaps.push(stored.entry.path + ': ' + String(error))
    }
  }
  return imported
}

/**
 * @private
 * @author ddj 2026-11-24
 * @description: 组装一条待审写入；补扫只产出 `source='scan'` 的记录。
 * @param scope 版本库作用域
 * @param absolute 绝对路径
 * @param before 修改前内容（null = 当时不存在或未知，由 baseKind 区分）
 * @param after 当前内容（null = 已删除）
 * @param at 时间
 * @param origin 归属
 * @param baseKind 基线可信度
 * @returns 待审写入
 */
function writeOf(
  scope: VcsScope | null, absolute: string, before: string | null, after: string | null,
  at: number, origin: 'external' | 'agent', baseKind: 'known' | 'vcs' | 'absent' | 'unknown',
): PendingWrite {
  return {
    cwd: scope?.cwd ?? '',
    sessionId: scope?.sessionId ?? '',
    path: absolute,
    identity: absolute,
    before,
    after,
    now: at,
    tool: 'scan',
    origin,
    baseKind,
  }
}

// --endregion

// --region Host 装配

/**
 * @author ddj 2026-11-24
 * @description: 用 Host 能力跑一次补扫：版本库候选 + 待审库条目 + ctx.fs 读盘。
 * @param ctx Host 上下文
 * @param cwd 工作区
 * @param sessionId 会话
 * @param record 落库回调（复用待审采集 sink）
 * @param budget 预算
 * @returns 结果
 */
export async function alignInWorkspace(
  ctx: Ctx, cwd: string, sessionId: string, record: (write: PendingWrite) => void, budget: AlignBudget = ALIGN_BUDGET,
): Promise<AlignOutcome> {
  const fs = ctx.get('fs')
  if (!fs) return { imported: 0, changed: 0, gaps: ['缺少 fs 服务：补扫未执行'] }
  const entries = new Map<string, StoredEntry>()
  for (const stored of loadEntries(cwd)) entries.set(pathKeyOf(stored.entry.id), stored)
  const deps: AlignDeps = {
    read: async (absolute) => {
      try {
        const target = await fs.resolve(absolute, { cwd })
        return await readText(fs, target)
      } catch (error) {
        noteCaptureGap(cwd, sessionId, absolute, error)
        throw error
      }
    },
    record,
    entries: () => entries,
  }
  try {
    const outcome = await alignExternal(vcsScopeOf(ctx, cwd, sessionId), deps, budget)
    for (const gap of outcome.gaps) log.debug('补扫：' + gap)
    return outcome
  } catch (error) {
    log.warn('补扫失败：' + String(error))
    return { imported: 0, changed: 0, gaps: ['补扫失败：' + String(error)] }
  }
}

// --endregion

/**
 * dsh-vscode-mode host — SVN 统一执行核心（22-agent-tools-and-commit）。
 *
 * 为什么单独成模块：原生提交、agent 工具与既有面板 RPC 必须共用**同一条**执行路径，
 * 否则「只读门禁 / 超时倍数 / 操作数防注入 / 错误分类」会出现多份实现并各自漂移。
 * 本模块只放执行与校验基元（无状态、依赖可注入、可单测）；会话与工作副本作用域仍在 §src/svn.ts§。
 *
 * 与既有 §runSvn§ 的等价性（不改行为）：argv 不经 shell、自动加 §--non-interactive§、
 * stdin ignore、stdio 管道收集（spawn 级失败回退 inherit，输出降级为空）、graceMs 超时。
 * 新增能力：只读门禁（写类子命令统一拒绝）、超时倍数、操作数 §-§ 前缀拒绝、连接错误分类。
 * @author ddj 2026年11月15号
 */
import type { Ctx } from './store.js'
import { SVN_CLI_DEFAULT, SVN_READONLY_CODE, SVN_READONLY_ERROR } from './shared/svn.js'

/** svn 子进程输出（与 svn.ts 的 SvnRunOutcome 同形）。 */
export interface SvnRunOutcome {
  /** 退出码（null = 进程异常终止）。 */
  code: number | null
  /** 标准输出。 */
  stdout: string
  /** 标准错误。 */
  stderr: string
}

/**
 * 写类子命令字面量（命中即受只读门禁约束）。
 * §export§ 计写（会落盘）；§update§/§cleanup§ 计写（改工作副本）；§changelist§ 计写（改工作副本元数据）。
 */
export const SVN_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'add', 'delete', 'remove', 'rm', 'revert', 'commit', 'ci', 'update', 'up',
  'switch', 'sw', 'merge', 'propset', 'propdel', 'propedit', 'mkdir', 'copy', 'cp',
  'move', 'mv', 'import', 'export', 'cleanup', 'resolve', 'lock', 'unlock',
  'relocate', 'upgrade', 'changelist', 'patch',
])

/** 只读模式拒绝错误：带稳定 code，工具层据此返回结构化失败。 */
export class SvnReadOnlyError extends Error {
  /** 稳定拒绝码（§SVN_READONLY§）。 */
  readonly code = SVN_READONLY_CODE

  /** @author ddj 2026年11月15号 */
  constructor() {
    super(SVN_READONLY_CODE + ': ' + SVN_READONLY_ERROR)
    this.name = 'SvnReadOnlyError'
  }
}

/**
 * 异常 → 结构化失败（只读拒绝带 code；其余 code 为空）。
 * @author ddj 2026年11月15号
 * @param error 捕获到的异常
 * @returns code（可能为空）与可读文案
 */
export function svnErrorOf(error: unknown): { code?: string; error: string } {
  if (error instanceof SvnReadOnlyError) return { code: error.code, error: SVN_READONLY_ERROR }
  const message = error instanceof Error ? error.message : String(error)
  return { error: message }
}

/**
 * 取 argv 里的子命令（跳过前置选项），小写。
 * @author ddj 2026年11月15号
 * @param argv 参数列表（不含可执行文件名）
 * @returns 子命令字面量（空 argv 返回 ''）
 */
export function svnCommandOf(argv: readonly string[]): string {
  for (const item of argv) {
    if (typeof item === 'string' && item && item !== '--non-interactive') return item.toLowerCase()
  }
  return ''
}

/**
 * argv 是否写类子命令。
 * @author ddj 2026年11月15号
 * @param argv 参数列表
 * @returns 是否写
 */
export function svnCommandIsWrite(argv: readonly string[]): boolean {
  return SVN_WRITE_COMMANDS.has(svnCommandOf(argv))
}

/**
 * 位置参数校验：拒 §-§ 开头（防 §--config-dir=§ 之类把 svn 变成外部程序执行）。
 * @author ddj 2026年11月15号
 * @param value 待校验值（属性名 / changelist 名 / URL / 分支路径等）
 * @returns 错误文案；合法为 null
 */
export function svnOperandErrorOf(value: unknown): string | null {
  if (typeof value !== 'string') return '参数必须是字符串'
  const trimmed = value.trim()
  if (!trimmed) return '参数不能为空'
  if (trimmed.startsWith('-')) return '参数不能以 - 开头（防被 svn 当成选项）'
  return null
}

/**
 * 超时倍数收敛（设置越界一律夹到 0.2–20，非数值按 1）。
 * @author ddj 2026年11月15号
 * @param scale 设置值
 * @returns 可用倍数
 */
export function svnScaleOf(scale: unknown): number {
  const value = typeof scale === 'number' ? scale : Number(scale)
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(20, Math.max(0.2, value))
}

/**
 * 按倍数放大命令超时。
 * @author ddj 2026年11月15号
 * @param baseMs 基础超时（毫秒）
 * @param scale 设置倍数
 * @returns 实际超时（毫秒）
 */
export function svnGraceOf(baseMs: number, scale: unknown): number {
  return Math.max(1_000, Math.round(baseMs * svnScaleOf(scale)))
}

/** 连接/权限类错误分类（用于把 svn 原始 stderr 变成可读文案）。 */
export type SvnErrorKind = 'offline' | 'no-repository' | 'auth' | 'conflict' | 'not-wc' | 'other'

/**
 * svn 输出 → 错误分类与可读文案（不推断原因，只按已知错误码/短语映射）。
 * @author ddj 2026年11月15号
 * @param text 合并后的 stdout/stderr
 * @returns 分类与文案
 */
export function classifySvnError(text: string): { kind: SvnErrorKind; message: string } {
  const raw = String(text ?? '').trim()
  if (!raw) return { kind: 'other', message: 'svn 命令失败（无输出）' }
  if (/E170013/.test(raw)) return { kind: 'offline', message: '服务器不可达（E170013）：请检查网络、代理或版本库地址' }
  if (/E210005/.test(raw)) return { kind: 'no-repository', message: '该 URL 已没有版本库（E210005）：可能被改名、删除或停用' }
  if (/E170001|E215004|authorization failed|认证失败/i.test(raw)) return { kind: 'auth', message: '认证失败：请检查凭据或缓存密码' }
  if (/E155015|E155004|remains in conflict|冲突/.test(raw)) return { kind: 'conflict', message: '存在冲突或工作副本被锁：请先更新/解决冲突' }
  if (/E155007|not a working copy|不是工作副本/i.test(raw)) return { kind: 'not-wc', message: '目标不是 SVN 工作副本（E155007）' }
  return { kind: 'other', message: raw }
}

/** 执行器设置读取面（setupOpenSettings 提供；字段可缺省以兼容旧设置）。 */
export interface SvnRunnerSettings {
  /** SVN 路径 / 只读 / 超时倍数。 */
  svn: () => { svnPath: string; readOnly?: boolean; commandTimeoutScale?: number }
}

/** 执行器依赖（spawn 与 fs 解析可注入，便于单测）。 */
export interface SvnRunnerDeps {
  /** host 上下文（取 fs 服务做路径规范化）。 */
  ctx: Ctx
  /** 设置读取面。 */
  settings: SvnRunnerSettings
  /** subprocess 服务取值（缺失返回 null）。 */
  spawn: () => unknown
}

/** 执行器实例。 */
export interface SvnRunner {
  /**
   * 执行 svn（语义与既有 runSvn 一致）。
   * @param cwd 运行目录（绝对路径）
   * @param argv 参数（不含可执行文件名；自动加 --non-interactive）
   * @param graceMs 基础超时（会乘设置倍数）
   * @param stdoutCap stdout 收集上限
   * @param allowFallback 管道失败时是否回退 inherit
   * @returns 退出码与输出
   */
  run: (cwd: string, argv: string[], graceMs: number, stdoutCap?: number, allowFallback?: boolean) => Promise<SvnRunOutcome>
  /** 只读是否开启。 */
  readOnly: () => boolean
  /** 当前超时倍数。 */
  scale: () => number
}

/** 默认 stdout 收集上限（1MB，对齐既有 runSvn）。 */
const DEFAULT_STDOUT_CAP = 1 << 20

/**
 * 创建 SVN 执行器（无状态除设置外）。
 * @author ddj 2026年11月15号
 * @param deps 依赖
 * @returns 执行器
 */
export function createSvnRunner(deps: SvnRunnerDeps): SvnRunner {
  /** @author ddj 2026年11月15号 @returns 设置快照 */
  function configuration() {
    return deps.settings.svn()
  }

  /** @author ddj 2026年11月15号 @param argv 参数 @returns 是否只读拒绝 */
  function blocked(argv: readonly string[]): boolean {
    return svnCommandIsWrite(argv) && configuration().readOnly === true
  }

  /** @author ddj 2026年11月15号 @param cwd 运行目录 @returns 规范化后的绝对目录 */
  async function resolveCwd(cwd: string): Promise<string> {
    const fs = deps.ctx.get('fs') as
      | { resolve?: (p: string, o: object) => Promise<unknown>; processPath?: (t: unknown) => string }
      | null
      | undefined
    if (!fs?.resolve || !fs?.processPath) return cwd
    return fs.processPath(await fs.resolve(cwd, {}))
  }

  /** @author ddj 2026年11月15号 @param cwd 运行目录 @param argv 参数 @param graceMs 超时 @param stdoutCap 上限 @param allowFallback 回退 @returns 结果 */
  async function run(
    cwd: string,
    argv: string[],
    graceMs: number,
    stdoutCap = DEFAULT_STDOUT_CAP,
    allowFallback = true,
  ): Promise<SvnRunOutcome> {
    if (blocked(argv)) throw new SvnReadOnlyError()
    const spawn = deps.spawn() as
      | ((options: unknown) => {
          collected?: { stdout?: { readFrom: (at: number) => { text: string } }; stderr?: { readFrom: (at: number) => { text: string } } }
          done: Promise<{ exitCode?: number | null; code?: number | null }>
        })
      | null
      | undefined
    if (!spawn) throw new Error('缺少 subprocess 服务')

    const configured = configuration()
    const exe = configured.svnPath.trim() || SVN_CLI_DEFAULT
    const realCwd = await resolveCwd(cwd)
    const timeout = svnGraceOf(graceMs, configured.commandTimeoutScale)
    /** @author ddj 2026年11月15号 @param mode 收集模式 @returns 进程句柄 */
    const attempt = (mode: 'pipe' | 'inherit') => spawn({
      argv: [exe, '--non-interactive', ...argv],
      cwd: realCwd,
      stdio: mode === 'pipe'
        ? { stdout: { maxBytes: stdoutCap }, stderr: { maxBytes: DEFAULT_STDOUT_CAP }, stdin: 'ignore' }
        : { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
      graceMs: timeout,
    })
    try {
      const handle = attempt('pipe')
      const outcome = await handle.done
      return {
        code: outcome?.exitCode ?? outcome?.code ?? null,
        stdout: handle.collected?.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected?.stderr?.readFrom(0).text ?? '',
      }
    } catch (error) {
      if (!allowFallback) throw error
      // 受管环境管道 spawn EPERM：回退 inherit（只拿退出码，输出为空）
      const handle = attempt('inherit')
      const outcome = await handle.done
      return { code: outcome?.exitCode ?? outcome?.code ?? null, stdout: '', stderr: '' }
    }
  }

  return { run, readOnly: () => configuration().readOnly === true, scale: () => svnScaleOf(configuration().commandTimeoutScale) }
}

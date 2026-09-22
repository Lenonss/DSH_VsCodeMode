/**
 * dsh-vscode-mode client — SVN 动作**执行器**表（与 shared/svnActions.ts 的元数据表配对）。
 *
 * 为什么与元数据分开：元数据要能被 host/shared 引用（纯数据、可单测），而执行器必然带
 * RPC 副作用与 UI 回调。三个入口（命令栏/文件树菜单/页签菜单）与 EditorView 分派都只
 * 需要「id → 执行器」，不再各自手写一份调用逻辑。
 *
 * 执行器约定：`(ctx) => void`，内部自行 await RPC 并回报文案；
 * 破坏性动作的 confirm 守卫由执行器承担（避免各入口各自实现，漏一处就少一道保护）。
 * 作者 ddj 2026年09月16号
 */
import type { SvnActionDef } from '../shared/svnActions.js'
import { svnCleanup } from './svnLog.js'
import { refreshSvnChanges, svnAdd, svnDiffBase, svnPatchText, svnRevert, svnTortoise, svnUpdate } from './svnStatus.js'

/** 动作执行上下文（各入口把自身能力投影进来）。 */
export interface SvnActionRunCtx {
  /** 会话 id。 */
  sessionId?: string
  /** 状态作用域（刷新缓存用）。 */
  scope?: string | null
  /** 目标工作区相对路径（'' = 工作区根；缺省 = 无目标）。 */
  path?: string
  /** 反馈（状态栏/notify）。 */
  notify?: (message: string) => void
  /** 打开基线差异视图（diff-base 动作）。 */
  openSvnDiff?: (path: string) => void
  /** 打开版本差异视图（日志条目差异）。 */
  openSvnDiffRev?: (path: string, revision: number) => void
  /** 打开日志弹窗（log 动作）。 */
  openSvnLog?: (path?: string) => void
  /** 打开补丁对话框（create-patch 动作；执行器完成 RPC 后把载荷交回 UI）。 */
  openPatchDialog?: (payload: { path: string; text: string; truncated: boolean; binary: boolean }) => void
  /** 打开目录对比对话框（diff-summarize 动作；目标目录相对路径，'' = 工作副本根）。 */
  openSumDialog?: (path: string) => void
  /** 重查变更清单（写操作后）。 */
  refreshChanges?: () => void
  /** 就地打开文件（日志面板点击变更文件）。 */
  openFile?: (path: string) => void
  /** 确认对话框（缺省 window.confirm；测试可注入）。 */
  confirm?: (message: string) => boolean
  /** 清理动作的破坏性选项（默认仅清锁）。 */
  cleanupOptions?: { removeUnversioned?: boolean; removeIgnored?: boolean }
}

/** 单条动作执行器。 */
export type SvnActionRunner = (ctx: SvnActionRunCtx) => void

/** 确认对话框（缺省走 window.confirm；无 window 环境视为拒绝，避免误执行破坏性动作）。 */
function askConfirm(ctx: SvnActionRunCtx, message: string): boolean {
  if (ctx.confirm) return ctx.confirm(message)
  if (typeof window === 'undefined') return false
  return window.confirm(message)
}

/** 统一收尾：回报文案 + 成功后重查变更（写操作让面板/徽标跟随）。 */
function afterWrite(ctx: SvnActionRunCtx, promise: Promise<{ ok: boolean; message: string }>): void {
  void promise.then((outcome) => {
    ctx.notify?.(outcome.message)
    if (outcome.ok) ctx.refreshChanges?.()
  })
}

/**
 * 动作执行器表（key = shared/svnActions.ts 的动作 id）。
 *
 * 注意：这里不出现任何显隐判断——可见性完全由 shared 的 `svnActionOn` 决定，
 * 保证「同一动作在三处入口的可见条件」逐字一致。
 */
export const SVN_ACTION_RUNNERS: Record<string, SvnActionRunner> = {
  update: (ctx) => {
    void svnUpdate(ctx.sessionId, ctx.path ?? '').then((outcome) => {
      ctx.notify?.(outcome.message)
      if (outcome.ok) ctx.refreshChanges?.()
    })
  },
  'refresh-changes': (ctx) => {
    ctx.refreshChanges?.()
    ctx.notify?.('已刷新 SVN 变更')
  },
  'diff-base': (ctx) => {
    if (!ctx.path) { ctx.notify?.('无活动文件'); return }
    ctx.openSvnDiff?.(ctx.path)
  },
  add: (ctx) => {
    if (!ctx.path) { ctx.notify?.('无目标路径'); return }
    afterWrite(ctx, svnAdd(ctx.sessionId, [ctx.path]))
  },
  // 键必须与 shared/svnActions.ts 的动作 id 完全一致（不一致会静默不执行，故有单测守护）
  'revert-cli': (ctx) => {
    if (!ctx.path) { ctx.notify?.('无目标路径'); return }
    // 破坏性动作的确认唯一入口（各调用方不得绕过）
    const ok = askConfirm(ctx, '确认还原「' + ctx.path + '」的本地改动？新增（A）文件在磁盘上会保留，仅取消登记。')
    if (!ok) return
    afterWrite(ctx, svnRevert(ctx.sessionId, [ctx.path]))
  },  log: (ctx) => {
    ctx.openSvnLog?.(ctx.path || undefined)
  },
  // W2-1：补丁生成（只读，仅生成不落盘应用）；RPC 后把载荷交给 UI 对话框
  'create-patch': (ctx) => {
    if (!ctx.path) { ctx.notify?.('无活动文件'); return }
    const target = ctx.path
    void svnPatchText(ctx.sessionId, target).then((outcome) => {
      if (!outcome.ok || typeof outcome.text !== 'string') { ctx.notify?.(outcome.message); return }
      ctx.openPatchDialog?.({ path: target, text: outcome.text, truncated: outcome.truncated === true, binary: outcome.binary === true })
    })
  },
  // W2-2：目录对比（RPC 在对话框内做，执行器只负责打开并传入默认目标目录）
  'diff-summarize': (ctx) => {
    ctx.openSumDialog?.(ctx.path ?? '')
  },
  cleanup: (ctx) => {
    const options = ctx.cleanupOptions ?? {}
    const destructive = options.removeUnversioned === true || options.removeIgnored === true
    if (destructive) {
      const scopeText = options.removeUnversioned ? '未纳入版本控制的文件与目录' : '被忽略的文件'
      const ok = askConfirm(ctx, '确认删除工作副本中的' + scopeText + '？该操作会从磁盘真实删除，且无法通过 SVN 恢复。')
      if (!ok) return
    }
    afterWrite(ctx, svnCleanup(ctx.sessionId, options))
  },
  // Tortoise 组：统一由 svnTortoise 发射（action 由 id 后缀解析）
  'tortoise-commit': (ctx) => runTortoiseAction(ctx, 'commit'),
  'tortoise-log': (ctx) => runTortoiseAction(ctx, 'log'),
  'tortoise-diff': (ctx) => runTortoiseAction(ctx, 'diff'),
  'tortoise-blame': (ctx) => runTortoiseAction(ctx, 'blame'),
  'tortoise-revert': (ctx) => runTortoiseAction(ctx, 'revert'),
}

/** Tortoise 动作统一执行（需要目标；日志/提交允许根）。 */
function runTortoiseAction(ctx: SvnActionRunCtx, action: 'commit' | 'log' | 'diff' | 'blame' | 'revert'): void {
  if (action === 'log') { ctx.openSvnLog?.(ctx.path || undefined); return }
  const target = ctx.path ?? ''
  if (!target && action !== 'commit') { ctx.notify?.('无活动文件'); return }
  void svnTortoise(ctx.sessionId, action, target).then((outcome) => ctx.notify?.(outcome.message))
}

/**
 * 执行一条动作（入口唯一调用点）。
 * @author ddj 2026年09月16号
 * @param action 动作定义（来自 shared 目录）
 * @param ctx 执行上下文
 * @returns 是否找到并执行了执行器
 */
export function runSvnAction(action: SvnActionDef, ctx: SvnActionRunCtx): boolean {
  const runner = SVN_ACTION_RUNNERS[action.id]
  if (!runner) return false
  runner(ctx)
  return true
}

/** 供 UI 使用的动作元数据 + 执行器合并视图。 */
export interface SvnActionEntry {
  def: SvnActionDef
  run: () => void
}

/**
 * 把动作定义表映射为可点击条目（统一注入执行上下文）。
 * @author ddj 2026年09月16号
 * @param actions 可见动作（已过滤）
 * @param ctx 执行上下文
 * @returns 条目数组
 */
export function toActionEntries(actions: readonly SvnActionDef[], ctx: SvnActionRunCtx): SvnActionEntry[] {
  return actions.map((def) => ({ def, run: () => runSvnAction(def, ctx) }))
}

// 便于 svnStatus 的动作封装在其它模块复用
export { refreshSvnChanges, svnAdd, svnDiffBase, svnRevert, svnUpdate }

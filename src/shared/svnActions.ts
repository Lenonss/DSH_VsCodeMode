/**
 * dsh-vscode-mode shared — SVN **动作目录**（单一事实源：纯元数据，无副作用）。
 *
 * 为什么要这层：P1/P2 每个 SVN 动作要在四处各写一遍（命令栏 / 文件树菜单 / 页签菜单 /
 * EditorView 分派），加一个动作改四处、四处显隐规则还会各自漂移（P2 的「加入/还原」
 * 状态矩阵就已经手写了两份）。这里把「有哪些动作、叫什么、出现在哪些入口、什么条件下可见、
 * 需要什么目标类型/能力/状态」收敛成一份数据；各入口只做「过滤 + 映射」。
 *
 * 分工：本文件只放**纯元数据**（可被 host/client 双面引用、可单测）；
 * 执行器（RPC 副作用）放 client/svnActions.ts，避免 shared 引入 node/react 依赖。
 * 作者 ddj 2026年09月16号
 */
import type { SvnFeature, SvnItemStatus } from './svn.js'

/** 动作可出现的入口（一个动作可在多处出现）。 */
export type SvnSurface = 'palette' | 'tree' | 'tab'

/** 动作所需能力：cli = svn 命令可用；tortoise = TortoiseProc 可用；none = 无需 SVN 能力。 */
export type SvnCapability = 'cli' | 'tortoise' | 'none'

/** 动作适用的目标类型。 */
export type SvnTargetType = 'file' | 'directory' | 'root' | 'editor'

/** 动作可见性所需的条目状态条件（未列状态 = 不限制）。 */
export type SvnStateGate = 'versioned' | 'unversioned' | 'changed' | 'diffable'

/** 一条 SVN 动作定义（纯元数据）。 */
export interface SvnActionDef {
  /** 稳定动作 id（同 id 在三个入口复用，如 'update' / 'diff-base' / 'log'）。 */
  id: string
  /** 命令栏命令 id（`edrv.svn*`）；仅 palette 入口需要。 */
  commandId?: string
  /** 展示文案（菜单与命令栏共用，避免两处漂移）。 */
  label: string
  /** 命令栏分组排序（小者靠前）。 */
  order: number
  /** 可出现的入口集合。 */
  surfaces: readonly SvnSurface[]
  /** 所需能力（缺省 'cli'）。 */
  capability?: SvnCapability
  /** 适用目标类型（缺省全部）。 */
  targets?: readonly SvnTargetType[]
  /** 破坏性动作（danger 样式 + 调用方须 confirm）。 */
  danger?: boolean
  /** 菜单前置分隔线（分组首条）。 */
  separator?: boolean
  /** 状态条件（对目标文件的变更条目状态求值）。 */
  gates?: readonly SvnStateGate[]
  /** 命令栏可用性是否额外要求存在活动编辑器模型。 */
  needsEditorModel?: boolean
  /**
   * 该动作已被**自研能力**替代时声明对应能力标志（仅 Tortoise 过渡项使用）。
   * 一旦 `ctx.svnFeatures` 含该能力，本项即隐藏——落实「自研替换时间线」，
   * 避免自研项与 Tortoise 同名项并列、用户误点到官方弹窗。
   */
  coveredBy?: SvnFeature
}

/**
 * SVN 动作目录（顺序 = 命令栏展示顺序）。
 *
 * 显隐口径（详见各 gates）：
 * - update：受管理且 CLI 可用即可（文件/目录/根都合法）
 * - diff-base：需「可比较」——文本文件（图片/PDF 无文本差异）
 * - add：仅未纳入版本控制的目标
 * - revert：仅受版本控制且有本地改动的目标
 * - log：受版本控制的目标（含目录）
 * - cleanup：不受目标状态限制（修工作副本锁）
 * - Tortoise 组：仅 Windows 且 TortoiseProc 可用
 */
export const SVN_ACTIONS: readonly SvnActionDef[] = [
  {
    id: 'update',
    commandId: 'edrv.svnUpdate',
    label: 'SVN 更新',
    order: 10,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'cli',
  },
  {
    id: 'refresh-changes',
    commandId: 'edrv.svnRefreshChanges',
    label: 'SVN 刷新变更（工作副本状态）',
    order: 15,
    surfaces: ['palette'],
    capability: 'cli',
  },
  {
    id: 'diff-base',
    commandId: 'edrv.svnDiffBase',
    label: '与基线比较',
    order: 16,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'cli',
    targets: ['file', 'editor'],
    gates: ['diffable'],
    needsEditorModel: true,
  },
  {
    id: 'add',
    commandId: 'edrv.svnAdd',
    label: '加入版本控制',
    order: 17,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'cli',
    targets: ['file', 'directory'],
    gates: ['unversioned'],
    needsEditorModel: true,
  },
  {
    // id 保持 'revert-cli'（P2 以来的菜单 id `svn-revert-cli` 与命令 id `edrv.svnRevertCli` 不变，
    // 避免仅为重构而改动既有 id；'cli' 后缀用于与 Tortoise 还原区分）
    id: 'revert-cli',
    commandId: 'edrv.svnRevertCli',
    label: 'SVN 还原',
    order: 18,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'cli',
    targets: ['file', 'directory'],
    gates: ['versioned', 'changed'],
    danger: true,
    needsEditorModel: true,
  },
  {
    id: 'log',
    commandId: 'edrv.svnLog',
    label: '查看日志',
    order: 19,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'cli',
    targets: ['file', 'directory'],
    gates: ['versioned'],
  },
  {
    id: 'cleanup',
    commandId: 'edrv.svnCleanup',
    label: '清理工作副本',
    order: 22,
    surfaces: ['palette'],
    capability: 'cli',
  },
  {
    id: 'tortoise-commit',
    commandId: 'edrv.svnTortoiseCommit',
    label: 'TortoiseSVN 提交',
    order: 30,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'tortoise',
    targets: ['file', 'directory', 'root', 'editor'],
    separator: true,
  },
  {
    id: 'tortoise-log',
    commandId: 'edrv.svnTortoiseLog',
    label: 'TortoiseSVN 日志',
    order: 31,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'tortoise',
    targets: ['file', 'directory'],
    // 自研「查看日志」（P3）已提供等价能力 → 自研就绪后隐藏本项
    coveredBy: 'log',
  },
  {
    id: 'tortoise-diff',
    commandId: 'edrv.svnTortoiseDiff',
    label: 'TortoiseSVN 差异',
    order: 32,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'tortoise',
    targets: ['file', 'editor'],
    // 自研「与基线比较」（P2）已提供等价能力 → 自研就绪后隐藏本项
    coveredBy: 'diff',
  },
  {
    id: 'tortoise-blame',
    commandId: 'edrv.svnTortoiseBlame',
    label: 'TortoiseSVN 追溯',
    order: 33,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'tortoise',
    targets: ['file', 'editor'],
    // 追溯尚无自研实现（P5 另议）→ 不声明 coveredBy，保留官方能力
  },
  {
    id: 'tortoise-revert',
    commandId: 'edrv.svnTortoiseRevert',
    label: 'TortoiseSVN 还原',
    order: 34,
    surfaces: ['palette', 'tree', 'tab'],
    capability: 'tortoise',
    targets: ['file', 'directory'],
    danger: true,
    // 自研「SVN 还原」（P2 revert -R）已提供等价能力 → 自研就绪后隐藏本项
    coveredBy: 'revert',
  },
]

/** 动作 id → 定义（查表用）。 */
export const SVN_ACTION_BY_ID: Record<string, SvnActionDef> = Object.fromEntries(
  SVN_ACTIONS.map((action) => [action.id, action]),
)

/** 某入口的动作表（按 order 升序）。 */
export function svnActionsFor(surface: SvnSurface): SvnActionDef[] {
  return SVN_ACTIONS.filter((action) => action.surfaces.includes(surface))
    .slice()
    .sort((a, b) => a.order - b.order)
}

/** 动作可见性的求值上下文（各入口把自身状态投影到这一形状）。 */
export interface SvnActionContext {
  /** 工作区是否受 SVN 管理。 */
  managed: boolean
  /** svn CLI 是否可用。 */
  svnCli: boolean
  /** TortoiseProc 是否可用。 */
  tortoise: boolean
  /** 已由自研界面提供等价能力的功能集合（落实「自研替换时间线」；缺省空 = 不隐藏）。 */
  svnFeatures?: readonly SvnFeature[]
  /** 目标类型（缺省视为 editor）。 */
  target?: SvnTargetType
  /** 目标是否为受版本控制（不在变更清单里视为受版本控制）。 */
  versioned?: boolean
  /** 目标当前的变更状态（不在清单里为 undefined）。 */
  status?: SvnItemStatus
  /** 目标是否为可比较的文本文件（按扩展名判定）。 */
  diffable?: boolean
}

/**
 * 该动作是否已被自研能力覆盖（用于隐藏 Tortoise 过渡项）。
 * @author ddj 2026年09月16号
 * @param action 动作定义
 * @param features 已就绪的自研能力集合
 * @returns 是否应因自研覆盖而隐藏
 */
export function svnActionCovered(action: SvnActionDef, features: readonly SvnFeature[] | undefined): boolean {
  if (!action.coveredBy) return false
  return Array.isArray(features) && features.includes(action.coveredBy)
}

/**
 * 动作在给定上下文下是否可用（能力 + 目标类型 + 状态门禁，全部满足才可用）。
 *
 * 这是三入口**唯一**的显隐判定实现：树菜单/页签菜单/命令栏都调它，
 * 从根上消除「同一动作两处手写规则各自漂移」的历史问题。
 *
 * @author ddj 2026年09月16号
 * @param action 动作定义
 * @param ctx 求值上下文
 * @returns 是否可用
 */
export function svnActionOn(action: SvnActionDef, ctx: SvnActionContext): boolean {
  if (!ctx.managed) return false
  // 自研替换时间线：自研已有等价能力时隐藏对应 Tortoise 过渡项
  if (svnActionCovered(action, ctx.svnFeatures)) return false
  const capability = action.capability ?? 'cli'
  if (capability === 'cli' && !ctx.svnCli) return false
  if (capability === 'tortoise' && !ctx.tortoise) return false
  if (action.targets && action.targets.length) {
    const target = ctx.target ?? 'editor'
    if (!action.targets.includes(target)) return false
  }
  for (const gate of action.gates ?? []) {
    if (!gatePasses(gate, ctx)) return false
  }
  return true
}

/**
 * 单条状态门禁求值。
 * @author ddj 2026年09月16号
 * @param gate 门禁
 * @param ctx 求值上下文
 * @returns 是否通过
 */
function gatePasses(gate: SvnStateGate, ctx: SvnActionContext): boolean {
  const status = ctx.status
  if (gate === 'versioned') return ctx.versioned === true
  if (gate === 'unversioned') return ctx.versioned === false
  if (gate === 'diffable') return ctx.diffable === true && ctx.versioned !== false
  // changed：在变更清单里且不是 normal/external（未版本控制也算有改动）
  if (gate === 'changed') return status !== undefined && status !== 'normal' && status !== 'external'
  return false
}

/**
 * 过滤出某入口当前可见的动作（已排序）。
 * @author ddj 2026年09月16号
 * @param surface 入口
 * @param ctx 求值上下文
 * @returns 可见动作（保持 order）
 */
export function visibleSvnActions(surface: SvnSurface, ctx: SvnActionContext): SvnActionDef[] {
  return svnActionsFor(surface).filter((action) => svnActionOn(action, ctx))
}

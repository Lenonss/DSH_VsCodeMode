/**
 * dsh-vscode-mode client — 文件管理右键菜单内置项。
 * 内置项：「在文件浏览器中打开」（文件→OS Explorer 定位选中、目录→打开目录）；
 * 「添加引用到对话」（文件/文件夹引用注入当前会话对话输入框）；
 * 「SVN 组」——动作清单与显隐规则来自 shared/svnActions.ts（三入口共用一份，不再各写一遍）。
 * 反馈统一走 ctx.notify（由 EditorView 提供，落到编辑区路径栏状态）。
 * 作者 ddj 2026-08-27 / 2026-09-03 / 2026-09-16
 */
import { isSvnDiffable } from '../../shared/svn.js'
import type { SvnChangeEntry } from '../../shared/svn.js'
import { svnActionOn, svnActionsFor } from '../../shared/svnActions.js'
import type { SvnActionContext, SvnTargetType } from '../../shared/svnActions.js'
import { runSvnAction } from '../svnActions.js'
import type { SvnActionRunCtx } from '../svnActions.js'
import { revealInExplorer } from '../fileReveal.js'
import { statusOfAdd } from '../addToConversation.js'
import type { TreeMenuItem } from './contextMenu.js'
import type { SidebarCtx } from './types.js'
import type { TreeMenuTarget } from './contextMenu.js'

/** 目标路径对应的变更条目（不在清单里返回 undefined）。 */
function svnEntryOf(target: TreeMenuTarget, ctx: SidebarCtx): SvnChangeEntry | undefined {
  if (!target.path) return undefined
  const map = ctx.svnChangeMap
  return map ? map[target.path] : undefined
}

/**
 * 把树菜单目标投影为动作求值上下文（能力 + 目标类型 + 状态门禁）。
 * 显隐判定统一交给 shared 的 svnActionOn，避免与页签菜单/命令栏漂移。
 * @author ddj 2026年09月16号
 * @param target 右键目标
 * @param ctx 面板上下文
 * @returns 求值上下文；无 SVN 状态返回 null
 */
function svnContextOf(target: TreeMenuTarget, ctx: SidebarCtx): SvnActionContext | null {
  const svn = ctx.svn
  if (!svn) return null
  const entry = svnEntryOf(target, ctx)
  const isRoot = target.path === ''
  const targetType: SvnTargetType = isRoot ? 'root' : (target.type === 'directory' ? 'directory' : 'file')
  return {
    managed: svn.managed,
    svnCli: svn.svnCli,
    tortoise: svn.tortoise,
    // 自研能力集合：驱动「自研替换时间线」（隐藏已被自研覆盖的 Tortoise 项）
    svnFeatures: svn.svnFeatures,
    target: targetType,
    // 不在变更清单里视为受版本控制（干净文件）；未版本控制条目显式为 false
    versioned: entry ? entry.versioned : true,
    status: entry?.status,
    diffable: isSvnDiffable(target.path, entry?.status),
  }
}

/**
 * 树菜单动作执行上下文（RPC 与反馈经面板 ctx 注入）。
 * @author ddj 2026年09月16号
 * @param target 右键目标
 * @param ctx 面板上下文
 * @returns 执行上下文
 */
function treeRunCtx(target: TreeMenuTarget, ctx: SidebarCtx): SvnActionRunCtx {
  return {
    sessionId: ctx.sessionId,
    scope: ctx.scope,
    path: target.path,
    notify: (message) => ctx.notify?.(message),
    openSvnDiff: (p) => ctx.openSvnDiff?.(p),
    openSvnLog: ctx.openSvnLog,
    refreshChanges: ctx.refreshSvnChanges,
    // 确认对话框可注入（测试/宿主可替换；缺省走 window.confirm）
    confirm: ctx.confirm,
  }
}

/**
 * 构造 SVN 组菜单项（动作清单来自 shared/svnActions.ts）。
 *
 * 收敛收益：此前每个动作在这里手写一项、页签菜单再手写一遍、命令栏第三遍，
 * 显隐规则三处漂移（P2 的「加入/还原」状态矩阵就重复过两份）。现在只做映射。
 * @author ddj 2026年09月16号
 * @returns SVN 组条目
 */
function svnMenuItems(): TreeMenuItem[] {
  return svnActionsFor('tree').map((action) => ({
    id: 'svn-' + action.id,
    label: action.label,
    order: action.order,
    danger: action.danger === true,
    separator: action.separator === true,
    visible: (target: TreeMenuTarget, ctx: SidebarCtx) => {
      const context = svnContextOf(target, ctx)
      return context !== null && svnActionOn(action, context)
    },
    run: (target: TreeMenuTarget, ctx: SidebarCtx) => {
      runSvnAction(action, treeRunCtx(target, ctx))
    },
  }))
}

/**
 * 构造内置右键菜单项列表（后续内置项直接追加）。
 * @author ddj 2026年08月27号
 * @returns 内置菜单项数组
 */
export function createDefaultFileMenuItems(): TreeMenuItem[] {
  return [
    {
      id: 'reveal-in-explorer',
      label: '在文件浏览器中打开',
      order: 0,
      run: (target, ctx) => {
        void revealInExplorer(ctx.sessionId, target.path).then((outcome) => {
          ctx.notify?.(outcome.ok ? '已在文件浏览器中打开' : '打开失败：' + (outcome.error ?? '未知错误'))
        })
      },
    },
    {
      id: 'add-to-conversation',
      label: '添加引用到对话',
      order: 1,
      // 排除根目录空白区（path==='' 无意义）、无会话、动作集缺失时隐藏
      visible: (target, ctx) => Boolean(target.path && ctx.sessionId && ctx.addToConversation),
      run: (target, ctx) => {
        const isDir = target.type === 'directory'
        const add = ctx.addToConversation
        if (!add) {
          ctx.notify?.('添加到对话不可用')
          return
        }
        const okText = isDir ? '已添加文件夹引用' : '已添加文件引用'
        void add.appendReference(ctx.sessionId, target.path, undefined, isDir ? 'folder' : 'file').then((outcome) => {
          ctx.notify?.(statusOfAdd(outcome, okText))
        })
      },
    },
    ...svnMenuItems(),
  ]
}

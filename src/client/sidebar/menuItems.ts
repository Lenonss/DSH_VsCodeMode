/**
 * dsh-vscode-mode client — 文件管理右键菜单内置项。
 * 内置项：「在文件浏览器中打开」（文件→OS Explorer 定位选中、目录→打开目录）；
 * 「添加引用到对话」（文件/文件夹引用注入当前会话对话输入框）。
 * 反馈统一走 ctx.notify（由 EditorView 提供，落到编辑区路径栏状态）。
 * 作者 ddj 2026-08-27 / 2026-09-03
 */
import { revealInExplorer } from '../fileReveal.js'
import { statusOfAdd } from '../addToConversation.js'
import type { TreeMenuItem } from './contextMenu.js'

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
  ]
}

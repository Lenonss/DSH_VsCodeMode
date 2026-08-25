/**
 * dsh-vscode-mode client — 文件管理右键菜单内置项。
 * 首个内置项：「在文件浏览器中打开」（文件→OS Explorer 定位选中、目录→打开目录）。
 * 反馈统一走 ctx.notify（由 EditorView 提供，落到编辑区路径栏状态）。
 * 作者 ddj 2026-08-27
 */
import { revealInExplorer } from '../fileReveal.js'
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
  ]
}

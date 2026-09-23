/**
 * dsh-vscode-mode client — UI 原语图标跨版本出口（消费方导出名保持 ≤0.1.6 旧名）。
 * 背景：DSH 0.1.7 图标命名重构——`Icon<Name>16`（0.1.6 及更旧）→
 * `Icon<Name>Regular/Medium`（0.1.7+，size 参数化 + 双笔画档），旧名在 0.1.7
 * 全树已不存在（整树 grep 实证）。解析策略：namespace import 属性探测，旧名优先
 * （现网 0.1.6）→ 新名次之（0.1.7+）→ 皆缺走通用占位（第三态不炸渲染）；
 * 打包期 external 不校验成员存在性，两代运行时均稳（能力探测，不做版本判定）。
 * 调用点零语义变化：导出名与旧垫片一致，仅改 import 来源。
 * @author ddj 2026年09月22号
 */
import React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { EdrvIconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/** 图标组件形状（与垫片 EdrvIconProps 兼容）。 */
type IconComponent = (props: EdrvIconProps) => unknown

/**
 * 通用占位图标（两代皆缺的第三态兜底：空态方框，不抛错不白屏）。
 * @author ddj 2026年09月22号
 * @param props 图标 props（size/className 透传）
 * @returns React 元素
 */
function fallbackIcon(props: EdrvIconProps): unknown {
  return React.createElement('svg', {
    width: props.size ?? 16,
    height: props.size ?? 16,
    viewBox: '0 0 16 16',
    className: props.className,
    'aria-hidden': true,
    focusable: false,
  }, React.createElement('rect', {
    x: 3.5, y: 3.5, width: 9, height: 9, rx: 2,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.2, opacity: 0.45,
  }))
}

/**
 * 按候选名序列解析图标组件（首个存在的函数命中；皆缺返回占位）。
 * @author ddj 2026年09月22号
 * @param names 候选导出名（旧名在前、新名在后）
 * @returns 图标组件
 */
function iconOf(...names: string[]): IconComponent {
  const table = primitives as unknown as Record<string, unknown>
  for (const name of names) {
    const hit = table[name]
    if (typeof hit === 'function') return hit as IconComponent
  }
  return fallbackIcon
}

// 两代语义等价的图标对（旧名 → 0.1.7 Regular 档；Medium 档不用于本插件 16px 场景）
/** 目录闭合图标（官方文件树同款）。 */
export const IconFolderClose16 = iconOf('IconFolderClose16', 'IconFolderCloseRegular')
/** 目录展开图标（官方文件树同款）。 */
export const IconFolderOpen16 = iconOf('IconFolderOpen16', 'IconFolderOpenRegular')
/** 目录轮廓图标（活动栏「文件管理」）。 */
export const IconFolderOpenOutline16 = iconOf('IconFolderOpenOutline16', 'IconFolderOpenOutlineRegular')
/** 刷新图标（面板工具条）。 */
export const IconRefreshOutline16 = iconOf('IconRefreshOutline16', 'IconRefreshOutlineRegular')
/** 搜索图标（活动栏「搜索」）。 */
export const IconSearchOutline16 = iconOf('IconSearchOutline16', 'IconSearchOutlineRegular')
/** 列表+笔图标（活动栏「规则」）。 */
export const IconListPenOutline16 = iconOf('IconListPenOutline16', 'IconListPenOutlineRegular')
/** 代码图标（活动栏「大纲」）。 */
export const IconCodeOutline16 = iconOf('IconCodeOutline16', 'IconCodeOutlineRegular')
/** 分支图标（SVN 面板）。 */
export const IconBranchOutline16 = iconOf('IconBranchOutline16', 'IconBranchOutlineRegular')

// 两代同名存活的原语：直通再导出（0.1.6/0.1.7 实证均在）
export { FileTypeIcon, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'

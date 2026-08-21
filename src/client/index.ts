/**
 * dsh-vscode-mode client — 浏览器半入口：slot 注册 + 装配。
 * 挂点：conversation.view「文件编辑」页签（中央 Monaco 编辑器）+ header 差异角标。
 * 与 Host 通信：同源 fetch('/edrv/rpc')（shared/rpc 契约）。
 *
 * ⚠️ 跨版本 slot 装配（2026-08-21）：新版 DSH 的 slots 系统要求 slot 必须由父 entry
 * 的 children table 先声明，直接 `ctx.slots.register({name:'conversation.view'})` 在
 * 声明未就绪时抛 `slot ... is not declared (a parent entry's children table must declare it)`。
 * 正确写法 = `ctx.slots.inject(name, () => ctx.slots.register(...))`：声明存在时同步
 * 执行，否则等待声明（官方 ui-conversation 自身即此模式）；旧版（rc.8 及更早）同样支持，
 * 故跨版本兼容。slot 名未变：conversation.view / conversation.session.header.utilities。
 * 作者 ddj 2026-08-20
 */
import React from 'react'
import './styles/editor.css'
import { EditorView } from './ui/EditorView.js'
import { DiffBadge } from './ui/DiffBadge.js'

export const inject = ['slots', 'timer']

/**
 * 装配客户端：注册中央编辑区视图与 header 差异角标。
 * @author ddj 2026年08月20号
 * @param ctx 客户端根上下文（slots + timer 服务）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apply(ctx: any): void {
  const schedule = (fn: () => void, ms: number) => ctx.timeout(fn, ms)

  // 中央「文件编辑」页签：类 VSCode 编辑器（顶部=文件页签+搜索框，差异 UI=文件底部圆角悬浮框）
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'edrv-editor',
    order: 5,
    label: '文件编辑',
    inject: (sessionId: string) => ({ sessionId }),
  }, (props: unknown) => React.createElement(EditorView, Object.assign({}, props, { schedule }))))

  // header 差异角标：仅当前工作区存在差异时渲染
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
    { name: 'conversation.session.header.utilities', id: 'edrv-diff-badge', order: 90, label: '差异' },
    (props: unknown) => React.createElement(DiffBadge, Object.assign({}, props)),
  ))
}

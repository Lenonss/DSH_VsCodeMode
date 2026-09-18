/**
 * dsh-vscode-mode client — 编辑区 Markdown 预览面板。
 *
 * 需求 4：.md 文件支持预览。渲染复用官方 UI 原语 MarkdownText（GFM + KaTeX，走 --dsw-*
 * 令牌自动跟随 DSH 主题与皮肤），不引入任何第三方 Markdown 依赖。
 *
 * 与既有图片 / PDF 面板的形态保持一致：工具条（meta + 切换按钮 + 刷新）+ 内容区。
 * 本面板为**只读**视图（编辑仍在 Monaco 文本态完成），故不接收编辑回调、不参与脏标记。
 *
 * ⚠️ 兼容降级：旧版 DSH 的 primitives 可能没有 MarkdownText。此时渲染只读 <pre> 并给出
 * 提示，绝不抛错白屏（与 pdf.js / Monaco 加载失败的降级口径一致）。
 * 作者 ddj 2026年09月18号
 */
import React from 'react'
import type { ComponentType, ReactNode } from 'react'
import { MarkdownDelegateProvider, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { isComponentType } from './componentType.js'

/**
 * 渲染 chrome 常量。必须是模块级稳定引用：MarkdownText 的 memo 以 labels 身份
 * 参与缓存判定，每次渲染新建对象会让渲染缓存在流式场景反复失效。
 */
const MD_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
}

/**
 * 官方原语声明在 client-primitives.d.ts 的手写垫片里，组件返回值只能声明为 unknown
 * （该虚拟模块不入本地 node_modules，无法在环境声明中引用 react 类型）。
 * 故在此把垫片面收敛成 react 可接受的组件类型，仅本文件承担这层转换；
 * 原语在运行时缺失时由下方 hasMarkdownPrimitive 守卫降级。
 */
type MdTextProps = { text: string; streaming?: boolean; labels: MarkdownLabels; variant?: 'body' | 'compact' }
type MdProviderProps = { children?: ReactNode; openFile?: (path: string, options?: { line?: number }) => void }

const MdText = MarkdownText as unknown as ComponentType<MdTextProps>
const MdProvider = MarkdownDelegateProvider as unknown as ComponentType<MdProviderProps>

/** 官方 Markdown 原语是否可用（旧版 DSH 缺该导出时为 false）。 */
const hasMarkdownPrimitive = isComponentType(MarkdownText)

/** 文本行数（meta 展示用；空文本计 0 行）。 */
function lineCountOf(text: string): number {
  const value = String(text ?? '')
  return value ? value.split(/\r?\n/).length : 0
}

/** 预览面板 props（面板由 EditorView 装配，故用宽松形状避免跨文件类型耦合）。 */
interface MarkdownPanelProps {
  /** Markdown 原文（取自编辑器已加载内容，无需额外 RPC）。 */
  text?: string
  /** 切回源码编辑（工具条按钮）。 */
  onToggleSource?: () => void
  /** 重新读取文件（工具条刷新按钮）。 */
  onReload?: () => void
  /** 打开 Markdown 内的本地文件链接（可空：不给则链接保持纯文本）。 */
  onOpenFile?: (path: string, options?: { line?: number }) => void
}

/**
 * Markdown 预览面板。
 * @author ddj 2026年09月18号
 * @param props 面板输入（原文与三个动作回调）
 * @returns 预览面板元素
 */
export function MarkdownPanel(props: MarkdownPanelProps) {
  const text = String(props?.text ?? '')
  const onToggleSource = props?.onToggleSource
  const onReload = props?.onReload
  const onOpenFile = props?.onOpenFile
  const chars = text.length
  const lines = lineCountOf(text)

  const body = hasMarkdownPrimitive
    ? React.createElement(MdProvider, {
        openFile: typeof onOpenFile === 'function' ? onOpenFile : undefined,
      }, React.createElement(MdText, { text, streaming: false, labels: MD_LABELS, variant: 'body' }))
    : React.createElement('div', { className: 'edrv-mdview-fallback' },
        React.createElement('div', null, '当前 DSH 版本不含 Markdown 渲染原语，已降级为纯文本预览。'),
        React.createElement('pre', { className: 'edrv-mdview-pre' }, text))

  return React.createElement('div', { className: 'edrv-mdview' },
    React.createElement('div', { className: 'edrv-mdview-bar' },
      React.createElement('span', { className: 'edrv-mdview-meta' }, lines + ' 行 · ' + chars + ' 字符'),
      React.createElement('span', { style: { flex: 1 } }),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '切回源码编辑',
        onClick: () => onToggleSource?.(),
      }, '以源码打开'),
      React.createElement('button', {
        className: 'edrv-pill edrv-pill-ghost', title: '重新读取文件',
        onClick: () => onReload?.(),
      }, '⟳ 刷新')),
    React.createElement('div', { className: 'edrv-mdview-stage' },
      React.createElement('div', { className: 'edrv-mdview-doc' }, body)))
}

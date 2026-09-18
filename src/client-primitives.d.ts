/**
 * 官方 UI 原语虚拟模块的最小类型垫片（@deepseek-ai/dsh-client-ui-primitives）。
 *
 * 该模块由 DSH web 前端的 loader 在运行时提供（磁盘上没有对应包目录，官方 40+ 个
 * 客户端包同样以 require 方式消费），本垫片只声明本插件用到的成员，供 tsc 类型检查；
 * 运行时取值为 loader 注入实例。完整成员清单见官方前端产物导出表。
 * 作者 ddj 2026-09-10
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 图标组件通用 props（官方 Icon* 组件与 FileTypeIcon 共用形状）。 */
  export interface EdrvIconProps {
    /** 图标边长（px）；省略时用图标自带尺寸。 */
    size?: number
    className?: string
  }

  /** 按文件名（或扩展名）分类的官方文件类型判别符（未知类型返回 'other'）。 */
  export function classifyFileType(name: string): string

  /** 官方文件类型图标：按 classifyFileType 的 kind 渲染（跟随官方主题配色）。 */
  export const FileTypeIcon: (props: EdrvIconProps & { kind: string }) => unknown

  /** 目录闭合图标（官方文件树同款）。 */
  export const IconFolderClose16: (props: EdrvIconProps) => unknown
  /** 目录展开图标（官方文件树同款）。 */
  export const IconFolderOpen16: (props: EdrvIconProps) => unknown
  /** 目录轮廓图标（活动栏「文件管理」）。 */
  export const IconFolderOpenOutline16: (props: EdrvIconProps) => unknown
  /** 刷新图标（面板工具条）。 */
  export const IconRefreshOutline16: (props: EdrvIconProps) => unknown
  /** 搜索图标（活动栏「搜索」）。 */
  export const IconSearchOutline16: (props: EdrvIconProps) => unknown
  /** 列表+笔图标（活动栏「规则」）。 */
  export const IconListPenOutline16: (props: EdrvIconProps) => unknown
  /** 代码图标（活动栏「大纲」）。 */
  export const IconCodeOutline16: (props: EdrvIconProps) => unknown

  /** 代码块复制按钮文案（MarkdownText 的 labels.code）。 */
  export interface MarkdownCodeLabels {
    /** 复制按钮空闲态文案。 */
    copyLabel: string
    /** 复制后确认窗口期文案。 */
    copiedLabel: string
  }

  /** Markdown 渲染的本地化 chrome（labels 引用须稳定，否则流式渲染缓存失效）。 */
  export interface MarkdownLabels {
    code: MarkdownCodeLabels
    /** 脚注段落标题。 */
    footnotes: string
  }

  /**
   * Markdown 渲染原语（GFM + KaTeX；raw HTML 与不安全协议被禁用）。
   * `streaming: false` 走一次性完整解析；`variant: 'body'` 为文档级排版。
   * 旧版 DSH 可能无此导出，调用方须做 typeof 守卫并降级。
   */
  export const MarkdownText: (props: {
    text: string
    streaming?: boolean
    labels: MarkdownLabels
    variant?: 'body' | 'compact'
  }) => unknown

  /** Markdown 导航作用域：普通外链与本地文件链接的打开能力（不提供则保持原生/纯文本）。 */
  export function MarkdownDelegateProvider(props: {
    children?: unknown
    openExternalLink?: (href: string) => void
    openFile?: (path: string, options?: { line?: number }) => void
  }): unknown
}

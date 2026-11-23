/**
 * dsh-vscode-mode client — 官方审阅扩展位（DSH 0.2.3 forge.changes）。
 * 四处 slot：变更视图工具条、文件菜单、行注解（keyed，按注解源 id）、评论按钮；
 * 外加一个注解源注册（ctx.forgeChanges.registerAnnotations）。
 * 刻意不 import @deepseek-ai/* 官方包（形状用本地最小 interface 描述），也不 import
 * compat.ts 的 registerSlotSafely（接线由 index.ts 统一做），故自带最小安全注册。
 * 约束：官方 slot 的组件契约是返回 ReactNode，这里一律用 React.createElement 造元素。
 * 作者 ddj 2026年11月23号
 */
import React from 'react'
import { ANNOTATION_ID, annotationSource, type AnnotationSource } from './officialAnnotations.js'

// #region 依赖与宿主形状

/** 依赖：由 lead 在 src/client/index.ts 接线时注入，流内不得 import 这些实现。 */
export interface ReviewDeps {
  /** 在插件编辑器打开一个文件路径。 */
  openInEditor: (path: string) => void
  /** 把路径加入插件待审列表（对话草稿引用）。 */
  addPending: (path: string) => void
  /** 文案：工具条按钮 / 文件菜单两行 / 注解条 / 评论按钮。 */
  labels: { toolbar: string; openFile: string; addPending: string; annotation: string; comment: string }
  /** 诊断出口，缺省静默。 */
  logger?: (message: string) => void
}

/** 官方注解服务的最小形状：只用到注册入口。 */
interface ForgeAnnotations {
  registerAnnotations?: (source: unknown) => unknown
}

/** 官方 slot / 注解服务的最小宿主形状（只声明本流用到的部分）。 */
export interface ReviewHost {
  get?: (name: string) => unknown
  slots?: {
    inject?: (name: string, register: () => unknown) => unknown
    register?: (...args: unknown[]) => unknown
  }
  forgeChanges?: unknown
}

/** slot 注册描述：list 槽用 id，keyed 槽用 key。 */
interface SlotSpec {
  name: string
  id?: string
  key?: string
  order?: number
  label?: string
}

/** 官方注解入参里本流读到的字段。 */
interface AnnotationProps {
  path?: unknown
  annotation?: { place?: unknown; version?: unknown }
  target?: { sessionId?: unknown }
}

/** 诊断出口：makeLog 归一化后的安全日志函数。 */
type Warn = (message: string) => void

// #endregion

// #region 常量

/** 官方变更视图的工具条 slot 名。 */
const TOOLBAR_SLOT = 'forge.changes.toolbar'
/** 官方变更视图的文件菜单 slot 名。 */
const FILE_MENU_SLOT = 'forge.changes.file.menu'
/** 官方变更视图的行注解 slot 名（keyed，key 必须等于注解源 id）。 */
const ANNOTATION_SLOT = 'forge.diff.line.annotation'
/** 官方行评论表单的按钮 slot 名。 */
const COMMENT_SLOT = 'forge.diff.comment.actions'
/** 工具条「在插件编辑器打开」项 id。 */
const OPEN_ITEM_ID = 'dsh-vscode-mode:open'
/** 文件菜单「加入待审」项 id。 */
const ADD_ITEM_ID = 'dsh-vscode-mode:add'
/** 评论按钮 id。 */
const COMMENT_ITEM_ID = 'dsh-vscode-mode:comment'
/** list 槽共用的排序值：官方视图内不抢位，保持默认次序。 */
const ITEM_ORDER = 10
/** 按钮类名：与编辑器既有样式复用。 */
const BUTTON_CLASS = 'edrv-forge-slot-button'

// #endregion

// #region 基础工具

/**
 * @author ddj 2026年11月23号
 * @description 归一化诊断出口：缺省静默，出口自身抛错也不外泄。
 * @param logger 注入的诊断出口（可缺省）
 * @returns 安全日志函数
 */
function makeLog(logger?: (message: string) => void): Warn {
  if (typeof logger !== 'function') return () => {}
  return (message) => {
    try { logger(message) } catch { /* 诊断出口自身异常不得打断装配 */ }
  }
}

/**
 * @author ddj 2026年11月23号
 * @description 从官方 slot props 取文件路径，优先 path，其次 file.path，最后 file.name。
 * @param props 官方渲染入参
 * @returns 路径；三处都取不到或为空串时 undefined
 */
function slotPathOf(props: unknown): string | undefined {
  if (!props || typeof props !== 'object') return undefined
  const slotProps = props as { path?: unknown; file?: { path?: unknown; name?: unknown } }
  const candidates = [slotProps.path, slotProps.file?.path, slotProps.file?.name]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return undefined
}

/**
 * @author ddj 2026年11月23号
 * @description 造一个带类名的按钮元素；点击回调由调用方给。
 * @param label 按钮文案
 * @param onClick 点击回调
 * @returns React 按钮元素
 */
function slotButton(label: string, onClick: () => void): React.ReactElement {
  return React.createElement('button', { type: 'button', className: BUTTON_CLASS, onClick }, label)
}

// #endregion

// #region 组件

/**
 * 工具条按钮：点开当前改动文件。
 * @author ddj 2026年11月23号
 * @param deps 接线注入的打开能力与文案
 * @param warn 诊断出口
 * @returns 组件
 */
function toolbarOf(deps: ReviewDeps, warn: Warn): (props: unknown) => React.ReactElement | null {
  return (props) => {
    const targetPath = slotPathOf(props)
    if (!targetPath) {
      warn('官方工具条 slot 取不到文件路径，跳过渲染')
      return null
    }
    return slotButton(deps.labels.toolbar, () => deps.openInEditor(targetPath))
  }
}

/**
 * 文件菜单两行：打开到插件编辑器、加入待审列表。
 * @author ddj 2026年11月23号
 * @param deps 接线注入的打开/加待审能力与文案
 * @param warn 诊断出口
 * @returns 组件
 */
function menuOf(deps: ReviewDeps, warn: Warn): (props: unknown) => React.ReactElement | null {
  return (props) => {
    const targetPath = slotPathOf(props)
    if (!targetPath) {
      warn('官方文件菜单 slot 取不到文件路径，跳过渲染')
      return null
    }
    return React.createElement('div', { className: 'edrv-forge-menu' },
      slotButton(deps.labels.openFile, () => deps.openInEditor(targetPath)),
      slotButton(deps.labels.addPending, () => deps.addPending(targetPath)))
  }
}

/**
 * 行注解条：挂在待审差异块上，点开插件编辑器。
 * 文案只说「待审」：行号范围由官方定位，版本号只用于判断是否重画。
 * @author ddj 2026年11月23号
 * @param deps 接线注入的打开能力与文案
 * @param warn 诊断出口
 * @returns 组件
 */
function annotationOf(deps: ReviewDeps, warn: Warn): (props: unknown) => React.ReactElement | null {
  return (props) => {
    const slotProps = (props && typeof props === 'object' ? props : {}) as AnnotationProps
    const path = typeof slotProps.path === 'string' ? slotProps.path : ''
    if (!path || !slotProps.annotation) {
      warn('官方注解 slot 缺少路径或注解，跳过渲染')
      return null
    }
    const title = spanOf(slotProps.annotation.place) ?? path
    return React.createElement('button', { type: 'button', className: BUTTON_CLASS, title, onClick: () => deps.openInEditor(path) }, deps.labels.annotation)
  }
}

/**
 * @author ddj 2026年11月23号
 * @description 把官方 place 读成「文件:行号区间」提示；形状不认识就返回 undefined。
 * @param place 官方注解位置
 * @returns 提示文案或 undefined
 */
function spanOf(place: unknown): string | undefined {
  if (!place || typeof place !== 'object') return undefined
  const range = place as { side?: unknown; startLine?: unknown; endLine?: unknown }
  if (typeof range.startLine !== 'number' || typeof range.endLine !== 'number') return undefined
  const side = range.side === 'L' ? '旧侧' : '新侧'
  return side + ' ' + range.startLine + '–' + range.endLine + ' 行待审'
}

/**
 * 评论按钮：把评论所在文件加入插件待审列表。
 * @author ddj 2026年11月23号
 * @param deps 接线注入的加待审能力与文案
 * @param warn 诊断出口
 * @returns 组件
 */
function commentOf(deps: ReviewDeps, warn: Warn): (props: unknown) => React.ReactElement | null {
  return (props) => {
    const selection = (props as { selection?: { path?: unknown } } | undefined)?.selection
    const path = typeof selection?.path === 'string' ? selection.path : ''
    if (!path) {
      warn('官方评论 slot 取不到选中文件，跳过渲染')
      return null
    }
    return slotButton(deps.labels.comment, () => deps.addPending(path))
  }
}

// #endregion

// #region 注册与卸载

/**
 * @author ddj 2026年11月23号
 * @description 安全注册单个 slot：走 inject(name, () => register(...)) 等待声明模式，
 * 服务缺失或注册抛错都只记日志并返回 null，让其余 slot 继续注册。
 * @param ctx 官方 slot 宿主
 * @param spec slot 描述（名称/id 或 key/排序/文案）
 * @param render 组件（入参为官方 props）
 * @param warn 诊断出口
 * @returns 注销函数；未注册或宿主未给 disposer 时 null
 */
function registerSlot(ctx: ReviewHost, spec: SlotSpec, render: (props: unknown) => unknown, warn: Warn): (() => void) | null {
  const slots = ctx?.slots
  const slotInject = slots?.inject
  const slotRegister = slots?.register
  if (typeof slotInject !== 'function' || typeof slotRegister !== 'function') {
    warn('slots 服务不可用，跳过官方 slot ' + spec.name)
    return null
  }
  try {
    // register 是依赖 this 的宿主方法，必须挂回 slots 调用，解构后裸调会静默失败。
    const disposer = slotInject.call(slots, spec.name, () => slotRegister.call(slots, spec, render))
    return typeof disposer === 'function' ? disposer as () => void : null
  } catch (error) {
    warn('官方 slot ' + spec.name + ' 注册失败（' + String(error) + '），已跳过')
    return null
  }
}

/**
 * @author ddj 2026年11月23号
 * @description 读官方注解服务：优先 ctx.get（不需要 inject），再退回属性取值，两处都失败返回 undefined。
 * @param ctx 客户端上下文
 * @returns 注解服务或 undefined
 */
function forgeOf(ctx: ReviewHost): ForgeAnnotations | undefined {
  const get = ctx?.get
  if (typeof get === 'function') {
    try {
      const service = get.call(ctx, 'forgeChanges')
      if (service && typeof service === 'object') return service as ForgeAnnotations
    } catch { /* 服务未提供：退回属性取值 */ }
  }
  try {
    const service = ctx?.forgeChanges
    if (service && typeof service === 'object') return service as ForgeAnnotations
  } catch { /* 服务不可用 */ }
  return undefined
}

/**
 * @author ddj 2026年11月23号
 * @description 注册注解源；服务缺失或注册抛错都只记日志，返回 null。
 * @param ctx 客户端上下文
 * @param source 注解源
 * @param warn 诊断出口
 * @returns 注销函数；未注册时 null
 */
function registerAnnotations(ctx: ReviewHost, source: AnnotationSource, warn: Warn): (() => void) | null {
  const service = forgeOf(ctx)
  const register = service?.registerAnnotations
  if (typeof register !== 'function') {
    warn('forgeChanges 服务不可用，跳过官方行注解')
    return null
  }
  try {
    const disposer = register.call(service, source)
    return typeof disposer === 'function' ? disposer as () => void : null
  } catch (error) {
    warn('官方注解源注册失败（' + String(error) + '），已跳过')
    return null
  }
}

/**
 * @author ddj 2026年11月23号
 * @description 逐个安全卸载：单个注销抛错不拖垮其余，重复调用等价于空操作。
 * @param disposers 已成功注册的注销函数
 * @param warn 诊断出口
 * @returns 无
 */
function disposeAll(disposers: Array<() => void>, warn: Warn): void {
  for (const dispose of disposers.splice(0)) {
    try {
      dispose()
    } catch (error) {
      warn('官方 slot 卸载失败（' + String(error) + '）')
    }
  }
}

// #endregion

// #region 安装

/**
 * 安装官方审阅扩展位；返回组合 disposer；Host 无 slots 时零注册且不抛。
 * @author ddj 2026年11月23号
 * @description 先注册注解源，成功后才注册 keyed 注解 slot（key 必须等于源 id），
 * 其余三条 list slot 各自独立降级；卸载只撤成功的注册。
 * @param ctx 官方宿主（缺 slots / forgeChanges 时相应链路跳过）
 * @param deps 接线注入的打开/加待审能力与文案
 * @returns 组合 disposer（可重复调用，永不抛错）
 */
export function installOfficialReview(ctx: ReviewHost, deps: ReviewDeps): () => void {
  const warn = makeLog(deps.logger)
  const disposers: Array<() => void> = []

  const toolbar = registerSlot(ctx, { name: TOOLBAR_SLOT, id: OPEN_ITEM_ID, order: ITEM_ORDER, label: deps.labels.toolbar }, toolbarOf(deps, warn), warn)
  if (toolbar) disposers.push(toolbar)
  const menu = registerSlot(ctx, { name: FILE_MENU_SLOT, id: ADD_ITEM_ID, order: ITEM_ORDER, label: deps.labels.addPending }, menuOf(deps, warn), warn)
  if (menu) disposers.push(menu)
  const comment = registerSlot(ctx, { name: COMMENT_SLOT, id: COMMENT_ITEM_ID, order: ITEM_ORDER, label: deps.labels.comment }, commentOf(deps, warn), warn)
  if (comment) disposers.push(comment)

  const source = registerAnnotations(ctx, annotationSource(), warn)
  if (source) {
    disposers.push(source)
    const annotation = registerSlot(ctx, { name: ANNOTATION_SLOT, key: ANNOTATION_ID }, annotationOf(deps, warn), warn)
    if (annotation) disposers.push(annotation)
  }

  return () => disposeAll(disposers, warn)
}

// #endregion

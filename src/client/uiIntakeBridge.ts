/**
 * dsh-vscode-mode client — UI 材料页桥（官方 HTML 预览 ↔ 当前会话）。
 *
 * 正常流程：
 *  1. 宿主工具 `ui_builder_intake` 生成页面；本模块监听会话事件里的工具结果，
 *     用官方 sidebarRight.openResource 在官方 HTML 预览中打开。
 *  2. 页面通过 postMessage 发 hello / submit；本模块用 `iframe[data-html-preview]`
 *     的 contentWindow 比对来源窗口，再读回页面内嵌配置核对令牌、路径与会话。
 *  3. submit 先走官方 fileUpload 暂存附件（失败回退 base64 RPC），宿主落盘后
 *     用官方 session.prompt 把清单发给当前会话；只有受理成功才回 accepted。
 *
 * 页面所在 iframe 是 opaque origin，不能靠固定 origin 判真伪：来源窗口身份 +
 * 页面内随机令牌 + 宿主重新读页面校验，三者缺一不可。
 * @author ddj 2026年11月26号
 */
import { rpc } from './rpc.js'
import { requestOpen } from './openReceipt.js'
import { buildFileAddress, detectOfficial } from './officialSidebar.js'
import { hasOfficialHtmlPreview } from './htmlPreview.js'
import { readSessionScope, subscribeScope } from './sessionScope.js'
import { log } from './log.js'
import type { AddToConversation } from './addToConversation.js'
import { buildIntakeMessage, parseIntakePageConfig, UI_INTAKE_HOST_SOURCE, UI_INTAKE_TOOL, type UiIntakePageConfig } from '../shared/uiIntake.js'
import {
  base64Of,
  bytesOf,
  intakeBindingOk,
  intakeMessageOf,
  intakeToolPayloadOf,
  pathUnder,
  receiptOf,
  sendOutcomeOf,
  toolTextOf,
  uploadErrorOf,
  type IntakePageMessage,
  type IntakeToolPayload,
} from './uiIntakeProtocol.js'

/** 客户端上下文最小面。 */
export interface IntakeCtx {
  get: (name: string) => unknown
}

/** 会话绑定里的最小事件窗口面。 */
interface FeedSnapshot {
  revision: number
  entries: readonly unknown[]
  change: { kind: string; entries?: readonly unknown[] }
}

/** 会话事件窗口。 */
interface EventSourceLike {
  getSnapshot: () => FeedSnapshot
  subscribe: (listener: () => void) => unknown
}

/** 会话服务最小面。 */
interface SessionsLike {
  binding?: (id: string) => { eventSource?: EventSourceLike } | undefined
}

/** 官方 fileUpload 客户端服务最小面。 */
interface FileUploadLike {
  upload: (
    sessionId: string,
    data: Blob,
    name?: string,
    signal?: AbortSignal,
    onProgress?: (progress: { loaded: number; total?: number }) => void,
  ) => Promise<unknown>
}

/** 页面提交的一张图片（已归一为字节）。 */
interface PageFile {
  role: 'mock' | 'material'
  originalName: string
  mediaType: string
  width?: number
  height?: number
  bytes: Uint8Array
}

/** 一次材料页的归属授权（首次 hello 或自动打开时建立）。 */
interface IntakeGrant {
  token: string
  pagePath: string
  pagesDir: string
  projectRoot: string
  cwd: string
  sessionId: string
  frame: HTMLIFrameElement
  config: UiIntakePageConfig
  lastSeen: number
}

/** 一次提交的客户端状态（同令牌同提交编号去重）。 */
interface SubmitState {
  accepted: boolean
  manifestPath?: string
}

/** 安装选项。 */
export interface IntakeBridgeOptions {
  addToConversation: AddToConversation
  /** 生命周期归属的延时调度器（官方 HTML 预览晚于工具结果就绪时重试）。 */
  schedule?: (fn: () => void, delay: number) => unknown
}

/** 工具调用缓存（tool/call → tool/result 配对）。 */
interface PendingToolCall {
  name: string
  args: Record<string, unknown>
}

/** 取异常的展示文案。 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/** 读可选服务（缺失/抛错一律 undefined）。 */
function serviceOf<T>(ctx: IntakeCtx, name: string): T | undefined {
  try {
    return ctx.get(name) as T | undefined
  } catch {
    return undefined
  }
}

/** 拼接绝对路径（只做 / 归一，不做 fs 解析）。 */
function joinPath(root: string, rel: string): string {
  return root.replace(/\\/g, '/').replace(/\/+$/u, '') + '/' + rel.replace(/^\/+/u, '')
}

/** 把绝对路径折算成相对会话工作区的路径（供官方 file session 地址使用）。 */
function sessionRelPath(cwd: string, absolute: string): string | null {
  const base = cwd.replace(/\\/g, '/').replace(/\/+$/u, '')
  const target = absolute.replace(/\\/g, '/')
  if (!base || !target) return null
  if (target === base) return ''
  if (target.startsWith(base + '/')) return target.slice(base.length + 1)
  const baseParts = base.split('/')
  const targetParts = target.split('/')
  let index = 0
  while (index < baseParts.length && index < targetParts.length && baseParts[index].toLowerCase() === targetParts[index].toLowerCase()) index += 1
  const up = baseParts.length - index
  return [...Array.from({ length: up }, () => '..'), ...targetParts.slice(index)].join('/')
}

/** 从消息事件里找到承载它的官方 HTML 预览 iframe。 */
function frameOf(source: MessageEventSource | null): HTMLIFrameElement | null {
  if (!source || typeof document === 'undefined') return null
  const frames = document.querySelectorAll<HTMLIFrameElement>('iframe[data-html-preview]')
  for (const frame of Array.from(frames)) if (frame.contentWindow === source) return frame
  return null
}

/** iframe 是否处于可见布局中（后台会话/隐藏页签不绑定）。 */
function frameVisible(frame: HTMLIFrameElement): boolean {
  try {
    if (frame.getClientRects().length === 0) return false
    return getComputedStyle(frame).visibility !== 'hidden'
  } catch {
    return false
  }
}

/** 向页面回消息（targetOrigin 只能是 *：页面是 opaque origin，父窗口 origin 不可知）。 */
function postTo(frame: HTMLIFrameElement, payload: Record<string, unknown>): void {
  try {
    frame.contentWindow?.postMessage({ source: UI_INTAKE_HOST_SOURCE, ...payload }, '*')
  } catch {
    /* 页面已卸载 */
  }
}

/** 读页面配置并核对消息归属。 */
async function readPageConfig(
  ctx: IntakeCtx,
  sessionId: string,
  projectRoot: string,
  pagePath: string,
): Promise<{ ok: true; config: UiIntakePageConfig } | { ok: false; code: string; message: string }> {
  const absolute = joinPath(projectRoot, pagePath)
  let rawRes: unknown
  try {
    rawRes = await rpc('edrv.read', { sessionId, path: absolute })
  } catch (error) {
    return { ok: false, code: 'read-failed', message: '读取材料页失败：' + messageOf(error) }
  }
  const raw = rawRes as { ok?: boolean; content?: unknown; error?: unknown }
  if (raw?.ok !== true || typeof raw.content !== 'string') {
    return { ok: false, code: 'read-failed', message: '读取材料页失败：' + String(raw?.error ?? '文件不存在') }
  }
  const config = parseIntakePageConfig(raw.content)
  if (!config) return { ok: false, code: 'page-invalid', message: '材料页配置无法读取，请重新生成材料页' }
  if (config.projectRoot !== projectRoot || config.pagePath !== pagePath) {
    return { ok: false, code: 'page-mismatch', message: '材料页与本次请求不匹配' }
  }
  return { ok: true, config }
}

/**
 * 校验/建立材料页归属：来源窗口必须是一次 hello/submit，且页面令牌、路径、
 * 项目根与当前会话一致。已有归属属于别的会话时直接拒绝，避免切会话串话。
 * @author ddj 2026年11月26号
 * @param ctx 客户端上下文
 * @param grants 当前安装实例的归属表
 * @param message 页面消息
 * @param frame 来源 iframe
 * @param requireVisible 首次绑定时是否要求页面可见（后台页签不绑定）
 * @returns 归属与页面配置，或可回给页面的错误
 */
async function grantOf(
  ctx: IntakeCtx,
  grants: Map<string, IntakeGrant>,
  message: IntakePageMessage,
  frame: HTMLIFrameElement,
  requireVisible: boolean,
): Promise<{ ok: true; grant: IntakeGrant } | { ok: false; code: string; message: string; retry?: boolean }> {
  const scope = readSessionScope(ctx)
  if (!scope.sessionId) return { ok: false, code: 'no-session', message: '当前没有活动会话，请回到对话页面再提交' }
  const projectRoot = typeof message.projectRoot === 'string' ? message.projectRoot.replace(/\\/g, '/').replace(/\/+$/u, '') : ''
  const pagePath = typeof message.pagePath === 'string' ? message.pagePath.replace(/\\/g, '/') : ''
  const token = typeof message.token === 'string' ? message.token : ''
  if (!projectRoot || !pagePath || !token) return { ok: false, code: 'bad-message', message: '材料页消息缺少页面路径或令牌' }
  if (!scope.cwd || !pathUnder(projectRoot, scope.cwd)) {
    return { ok: false, code: 'workspace-mismatch', message: '材料页不属于当前会话的工作区' }
  }

  const existing = grants.get(token)
  if (existing) {
    if (existing.sessionId !== scope.sessionId) {
      return { ok: false, code: 'session-mismatch', message: '材料页属于另一个会话，请回到原会话提交，或重新创建材料页' }
    }
    if (existing.pagePath !== pagePath) return { ok: false, code: 'page-mismatch', message: '材料页路径与已绑定页面不一致' }
    existing.frame = frame
    existing.lastSeen = Date.now()
    existing.cwd = scope.cwd
    return { ok: true, grant: existing }
  }
  if (requireVisible && !frameVisible(frame)) {
    return { ok: false, code: 'not-visible', message: '材料页当前不可见，切到该页签后再提交', retry: true }
  }
  const read = await readPageConfig(ctx, scope.sessionId, projectRoot, pagePath)
  if (!read.ok) return read
  if (!intakeBindingOk(read.config, message, read.config.pagesDir)) {
    return { ok: false, code: 'token-mismatch', message: '材料页令牌不匹配（页面可能已被重建），请关闭后重新打开材料页' }
  }
  const grant: IntakeGrant = {
    token,
    pagePath,
    pagesDir: read.config.pagesDir,
    projectRoot,
    cwd: scope.cwd,
    sessionId: scope.sessionId,
    frame,
    config: read.config,
    lastSeen: Date.now(),
  }
  grants.set(token, grant)
  return { ok: true, grant }
}

/** 页面文件校验（数量/类型/单张/总量），宿主仍会再核一次。 */
function filesOf(message: IntakePageMessage, limits: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; mediaTypes: string[] }): { ok: true; files: PageFile[] } | { ok: false; message: string } {
  const raw = Array.isArray(message.files) ? message.files : []
  if (raw.length > limits.maxFiles) return { ok: false, message: '一次最多提交 ' + limits.maxFiles + ' 张图片' }
  let total = 0
  const files: PageFile[] = []
  for (const item of raw) {
    const row = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {}
    const role = row.role === 'mock' || row.role === 'material' ? row.role : null
    const originalName = typeof row.originalName === 'string' ? row.originalName : ''
    const mediaType = typeof row.mediaType === 'string' ? row.mediaType : ''
    const bytes = bytesOf(row.bytes)
    if (!role || !originalName || !bytes) return { ok: false, message: '图片数据不完整：' + (originalName || '未命名') }
    if (!limits.mediaTypes.includes(mediaType)) return { ok: false, message: '不支持的图片类型：' + originalName }
    if (bytes.byteLength === 0) return { ok: false, message: '图片为空：' + originalName }
    if (bytes.byteLength > limits.maxFileBytes) return { ok: false, message: '单张图片超过大小上限：' + originalName }
    total += bytes.byteLength
    if (total > limits.maxTotalBytes) return { ok: false, message: '一次提交的图片总量超过上限，请减少图片' }
    files.push({
      role,
      originalName,
      mediaType,
      ...(typeof row.width === 'number' ? { width: row.width } : {}),
      ...(typeof row.height === 'number' ? { height: row.height } : {}),
      bytes,
    })
  }
  return { ok: true, files }
}

/** 把页面文件上传到官方附件服务；失败返回 null 让调用方走 base64。 */
async function uploadFiles(
  ctx: IntakeCtx,
  sessionId: string,
  files: PageFile[],
  signal: AbortSignal,
  onProgress: (done: number, total: number, loaded?: number, size?: number) => void,
): Promise<string[] | null> {
  const service = serviceOf<FileUploadLike>(ctx, 'fileUpload')
  if (!service || typeof service.upload !== 'function') return null
  const receipts: string[] = []
  try {
    for (const [index, file] of files.entries()) {
      const blob = new Blob([file.bytes as unknown as BlobPart], { type: file.mediaType })
      const result = await service.upload(sessionId, blob, file.originalName, signal, (progress) => {
        onProgress(index, files.length, progress.loaded, file.bytes.byteLength)
      })
      const receipt = receiptOf(result)
      if (!receipt) throw new Error(uploadErrorOf(result))
      receipts.push(receipt)
      onProgress(index + 1, files.length)
    }
    return receipts
  } catch (error) {
    if (signal.aborted) return null
    log.warn('UI 材料附件上传失败，改用内嵌传输：' + messageOf(error))
    return null
  }
}

/** 把提交结果转成页面结果消息。 */
function resultPayload(result: {
  ok: boolean
  stage: 'saved' | 'send'
  submissionId: string
  manifestPath?: string
  message?: string
  unconfirmed?: boolean
  sending?: boolean
}): Record<string, unknown> {
  return {
    type: 'result',
    ok: result.ok,
    stage: result.stage,
    submissionId: result.submissionId,
    ...(result.manifestPath ? { manifestPath: result.manifestPath } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.unconfirmed ? { unconfirmed: true } : {}),
    ...(result.sending ? { sending: true } : {}),
  }
}

/**
 * 安装材料页桥：消息监听 + 工具结果自动打开 + 提交/重试流水线。
 * @author ddj 2026年11月26号
 * @param ctx 客户端上下文
 * @param options 会话投递门面
 * @returns 卸载器（移除监听、退订事件、终止在途上传）
 */
export function installUiIntakeBridge(ctx: IntakeCtx, options: IntakeBridgeOptions): () => void {
  const grants = new Map<string, IntakeGrant>()
  const states = new Map<string, SubmitState>()
  const inflight = new Map<string, Promise<void>>()
  const controller = new AbortController()
  let disposed = false

  /** 记录已受理，后续同提交直接回 accepted（不重复发送）。 */
  function rememberAccepted(token: string, submissionId: string, manifestPath?: string): void {
    states.set(token + '|' + submissionId, { accepted: true, ...(manifestPath ? { manifestPath } : {}) })
  }

  /** 向页面回一条错误。 */
  function postError(frame: HTMLIFrameElement, stage: string, message: string, extra: Record<string, unknown> = {}): void {
    postTo(frame, { type: 'result', ok: false, stage, message, ...extra })
  }

  /** 回读最近提交（刷新/插件重载后的状态恢复）。 */
  async function latestOf(grant: IntakeGrant): Promise<Record<string, unknown> | null> {
    try {
      const result = await rpc('edrv.uiIntake.latest', {
        sessionId: grant.sessionId,
        pagePath: grant.pagePath,
        token: grant.token,
      })
      if (!result.ok || !result.found || !result.submissionId) return null
      return {
        submissionId: result.submissionId,
        manifestPath: result.manifestPath,
        ...(result.sentAt ? { sentAt: result.sentAt } : {}),
        sentConfirmed: result.sentConfirmed !== false,
        ...(result.form ? { form: result.form } : {}),
        ...(result.assets ? { assets: result.assets.map((asset) => ({ role: asset.role, originalName: asset.originalName, relativePath: asset.relativePath })) } : {}),
        ...(result.message ? { message: result.message } : {}),
      }
    } catch (error) {
      log.warn('读取材料页最近提交失败：' + messageOf(error))
      return null
    }
  }

  /** hello：校验归属并把最近提交状态回给页面。 */
  async function hello(message: IntakePageMessage, frame: HTMLIFrameElement): Promise<void> {
    const granted = await grantOf(ctx, grants, message, frame, true)
    if (!granted.ok) {
      postTo(frame, { type: 'hello-ack', ok: false, code: granted.code, message: granted.message, retry: granted.retry === true })
      return
    }
    const last = await latestOf(granted.grant)
    postTo(frame, { type: 'hello-ack', ok: true, interactive: true, last, limits: granted.grant.config.limits })
  }

  /** 宿主保存（receipt 失败自动回退 base64；返回 null 表示失败原因已处理）。 */
  async function saveWithFallback(
    grant: IntakeGrant,
    submissionId: string,
    form: unknown,
    files: PageFile[],
    receipts: string[] | null,
  ): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; message: string }> {
    const build = (mode: 'receipt' | 'base64'): unknown[] => files.map((file, index) => ({
      role: file.role,
      originalName: file.originalName,
      mediaType: file.mediaType,
      ...(file.width === undefined ? {} : { width: file.width }),
      ...(file.height === undefined ? {} : { height: file.height }),
      ...(mode === 'receipt' ? { receiptId: receipts?.[index] } : { data: base64Of(file.bytes) }),
    }))
    try {
      const saved = await rpc('edrv.uiIntake.save', {
        sessionId: grant.sessionId,
        pagePath: grant.pagePath,
        token: grant.token,
        submissionId,
        form: form as never,
        files: build(receipts ? 'receipt' : 'base64') as never,
      })
      if (!saved.ok) {
        if (receipts && saved.code === 'receipt-unavailable') {
          const retry = await rpc('edrv.uiIntake.save', {
            sessionId: grant.sessionId,
            pagePath: grant.pagePath,
            token: grant.token,
            submissionId,
            form: form as never,
            files: build('base64') as never,
          })
          if (!retry.ok) return { ok: false, message: retry.error }
          return { ok: true, result: retry as unknown as Record<string, unknown> }
        }
        return { ok: false, message: saved.error }
      }
      return { ok: true, result: saved as unknown as Record<string, unknown> }
    } catch (error) {
      return { ok: false, message: '保存材料失败：' + messageOf(error) }
    }
  }

  /** 标记送达（失败只记日志，不影响已确认的受理结果）。 */
  async function markSent(grant: IntakeGrant, submissionId: string, confirmed: boolean): Promise<string | undefined> {
    try {
      const result = await rpc('edrv.uiIntake.markSent', {
        sessionId: grant.sessionId,
        pagePath: grant.pagePath,
        token: grant.token,
        submissionId,
        confirmed,
      })
      return result.ok ? result.sentAt : undefined
    } catch (error) {
      log.warn('记录材料送达状态失败：' + messageOf(error))
      return undefined
    }
  }

  /** 用已有回执/纯文本把清单发给当前会话，并回页面最终状态。 */
  async function deliver(
    grant: IntakeGrant,
    frame: HTMLIFrameElement,
    submissionId: string,
    messageText: string,
    receipts: string[] | null,
  ): Promise<void> {
    postTo(frame, { type: 'progress', stage: 'send' })
    const receiptList = receipts ?? []
    const sendFiles = receiptList.length ? options.addToConversation.sendTaskWithFiles : undefined
    let result: unknown
    try {
      result = sendFiles
        ? await sendFiles.call(options.addToConversation, grant.sessionId, messageText, receiptList, 'queue')
        : await options.addToConversation.sendTaskResult?.(grant.sessionId, messageText, 'queue')
    } catch (error) {
      postError(frame, 'send', '发送失败：' + messageOf(error), { saved: true, submissionId })
      return
    }
    const outcome = sendOutcomeOf(result)
    if (outcome === 'accepted') {
      rememberAccepted(grant.token, submissionId)
      const sentAt = await markSent(grant, submissionId, true)
      postTo(frame, { type: 'result', ok: true, stage: 'accepted', submissionId, ...(sentAt ? { sentAt } : {}) })
      return
    }
    if (outcome === 'unconfirmed') {
      await markSent(grant, submissionId, false)
      postTo(frame, {
        type: 'result',
        ok: true,
        stage: 'unconfirmed',
        submissionId,
        message: '材料已保存并已发出，但当前宿主没有提供投递确认；请回到对话确认 Agent 是否收到。',
      })
      return
    }
    postError(frame, 'send', '材料已保存，但发送失败：' + String((result as { status?: string } | null)?.status ?? '未知原因') + '。可重试发送，不会重复保存。', {
      saved: true,
      submissionId,
    })
  }

  /** submit：上传 → 保存 → 只发送一次。 */
  async function submit(message: IntakePageMessage, frame: HTMLIFrameElement): Promise<void> {
    const granted = await grantOf(ctx, grants, message, frame, true)
    if (!granted.ok) {
      postError(frame, 'save', granted.message)
      return
    }
    const grant = granted.grant
    const submissionId = typeof message.submissionId === 'string' ? message.submissionId : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u.test(submissionId)) {
      postError(frame, 'save', '提交编号无效，请刷新页面后重试')
      return
    }
    const key = grant.token + '|' + submissionId
    const previous = states.get(key)
    if (previous?.accepted) {
      postTo(frame, { type: 'result', ok: true, stage: 'accepted', submissionId, ...(previous.manifestPath ? { manifestPath: previous.manifestPath } : {}) })
      return
    }
    if (inflight.has(key)) {
      postError(frame, 'save', '这次提交正在处理中，请稍候')
      return
    }
    const checked = filesOf(message, grant.config.limits)
    if (!checked.ok) {
      postError(frame, 'save', checked.message)
      return
    }
    const run = (async () => {
      const receipts = checked.files.length
        ? await uploadFiles(ctx, grant.sessionId, checked.files, controller.signal, (done, total, loaded, size) => {
          postTo(frame, { type: 'progress', stage: 'upload', done, total, ...(loaded === undefined ? {} : { loaded, size }) })
        })
        : []
      if (controller.signal.aborted) return
      postTo(frame, { type: 'progress', stage: 'save' })
      const saved = await saveWithFallback(grant, submissionId, message.form, checked.files, receipts)
      if (!saved.ok) {
        postError(frame, 'save', saved.message)
        return
      }
      const result = saved.result as {
        submissionId: string
        manifestPath: string
        message: string
        duplicate?: boolean
        sentAt?: string
        title?: string
        screen?: { w: number; h: number }
      }
      const manifestPath = String(result.manifestPath ?? '')
      if (result.sentAt) {
        rememberAccepted(grant.token, submissionId, manifestPath)
        postTo(frame, { type: 'result', ok: true, stage: 'accepted', submissionId, manifestPath })
        return
      }
      postTo(frame, { type: 'result', ok: true, stage: 'saved', submissionId, manifestPath, sending: true })
      const messageText = String(result.message ?? buildIntakeMessage({
        pagesDir: grant.pagesDir,
        slug: grant.config.slug,
        manifestPath,
        title: String(result.title ?? ''),
        screen: result.screen ?? grant.config.screen,
        assets: [],
        hasMockPath: false,
      }))
      await deliver(grant, frame, submissionId, messageText, receipts)
    })().catch((error: unknown) => {
      postError(frame, 'save', '材料处理失败：' + messageOf(error))
    }).finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, run)
    await run
  }

  /** saved：本机材料服务已落盘，只负责把清单发给当前会话（不重复保存）。 */
  async function saved(message: IntakePageMessage, frame: HTMLIFrameElement): Promise<void> {
    const granted = await grantOf(ctx, grants, message, frame, true)
    if (!granted.ok) {
      postError(frame, 'send', granted.message, { saved: true })
      return
    }
    const grant = granted.grant
    const submissionId = typeof message.submissionId === 'string' ? message.submissionId : ''
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/u.test(submissionId)) {
      postError(frame, 'send', '提交编号无效，请刷新页面后重试', { saved: true })
      return
    }
    const last = await latestOf(grant)
    if (!last || last.submissionId !== submissionId) {
      postError(frame, 'send', '没有找到这次材料提交，请重新提交', { saved: true })
      return
    }
    if (last.sentAt && last.sentConfirmed) {
      rememberAccepted(grant.token, submissionId)
      postTo(frame, { type: 'result', ok: true, stage: 'accepted', submissionId, ...(last.manifestPath ? { manifestPath: last.manifestPath } : {}) })
      return
    }
    if (!last.message) {
      postError(frame, 'send', '材料清单缺少继续指令，请重新提交', { saved: true })
      return
    }
    await deliver(grant, frame, submissionId, String(last.message), null)
  }

  /** retry-send：只重发清单文本；已受理/已确认的直接回成功。 */
  async function retrySend(message: IntakePageMessage, frame: HTMLIFrameElement): Promise<void> {
    const granted = await grantOf(ctx, grants, message, frame, true)
    if (!granted.ok) {
      postError(frame, 'send', granted.message)
      return
    }
    const grant = granted.grant
    const submissionId = typeof message.submissionId === 'string' ? message.submissionId : ''
    if (!submissionId) {
      postError(frame, 'send', '缺少提交编号')
      return
    }
    const state = states.get(grant.token + '|' + submissionId)
    if (state?.accepted) {
      postTo(frame, { type: 'result', ok: true, stage: 'accepted', submissionId, ...(state.manifestPath ? { manifestPath: state.manifestPath } : {}) })
      return
    }
    const last = await latestOf(grant)
    if (!last || last.submissionId !== submissionId) {
      postError(frame, 'send', '找不到这次提交的清单，请重新提交')
      return
    }
    if (last.sentAt) {
      if (last.sentConfirmed === false) {
        postTo(frame, { type: 'result', ok: true, stage: 'unconfirmed', submissionId, message: '这次提交此前已发出，但宿主无法确认送达；为避免重复，不再自动重发。' })
        return
      }
      rememberAccepted(grant.token, submissionId, String(last.manifestPath ?? ''))
      postTo(frame, { type: 'result', ok: true, stage: 'accepted', submissionId, manifestPath: last.manifestPath })
      return
    }
    const text = String(last.message ?? '')
    if (!text) {
      postError(frame, 'send', '清单里没有可发送的消息，请重新提交')
      return
    }
    await deliver(grant, frame, submissionId, text, null)
  }

  /** 处理页面消息：只接受来自官方 HTML 预览 iframe 的消息。 */
  async function onMessage(event: MessageEvent): Promise<void> {
    if (disposed) return
    const frame = frameOf(event.source)
    if (!frame) return
    const message = intakeMessageOf(event.data)
    if (!message) return
    if (message.type === 'hello') await hello(message, frame)
    else if (message.type === 'submit') await submit(message, frame)
    else if (message.type === 'saved') await saved(message, frame)
    else if (message.type === 'retry-send') await retrySend(message, frame)
  }

  /** 安全包装：任何处理异常都回给页面，不让监听器抛进 window。 */
  function onWindowMessage(event: MessageEvent): void {
    void onMessage(event).catch((error: unknown) => {
      const frame = frameOf(event.source)
      if (frame) postError(frame, 'submit', '材料页处理失败：' + messageOf(error))
      log.warn('材料页消息处理失败：' + messageOf(error))
    })
  }

  window.addEventListener('message', onWindowMessage)

  /**
   * 用官方 sidebarRight 打开 HTML 预览；官方渲染器探针可能晚于工具结果就绪，
   * 先有界等待再回退（早期直接 requestOpen 会把页面开成源码编辑器）。
   * @author ddj 2026年11月26号
   * @param page 工具结果里的页面路径
   * @param sessionId 所属会话
   * @param attempt 当前重试次数
   */
  function openMaterials(page: IntakeToolPayload, sessionId: string, attempt = 0): void {
    const absolute = page.absolutePath
    if (!absolute) return
    const official = (() => {
      try {
        return detectOfficial(ctx)
      } catch {
        return undefined
      }
    })()
    const canOpen = official !== undefined && typeof official.service.openResource === 'function'
    const previewReady = hasOfficialHtmlPreview()
    if (canOpen && (previewReady || attempt >= 12)) {
      try {
        // 官方 text 页的 canOpen 只接受 session 域地址；绝对地址会被本插件的
        // file claim 接走，显示成源码编辑器。折算成会话相对路径并强制 text kind。
        const cwd = readSessionScope(ctx).cwd ?? ''
        const relative = sessionRelPath(cwd, absolute)
        const address = relative !== null && relative !== '' ? buildFileAddress(relative, sessionId) : buildFileAddress(absolute, sessionId)
        official!.service.openResource!(address, { kind: 'text' })
        return
      } catch (error) {
        log.warn('打开材料页官方预览失败：' + messageOf(error))
      }
    } else if (attempt < 12 && typeof options.schedule === 'function') {
      if (attempt === 0) log.info('等待官方 HTML 预览就绪后打开材料页…')
      options.schedule(() => openMaterials(page, sessionId, attempt + 1), 1000)
      return
    }
    void requestOpen(absolute, undefined, undefined, sessionId, { preview: true }).catch(() => {})
    log.warn('当前宿主没有官方 HTML 预览通道，材料页已用编辑器打开；页面可能无法自动提交')
  }

  // 工具结果 → 自动打开材料页。只认 live 追加，恢复历史时不重开旧页面。
  let feed: EventSourceLike | undefined
  let feedOwner = ''
  let feedCwd = ''
  let offFeed: (() => void) | undefined
  let revision: number | undefined
  let watermark = -1
  const pendingCalls = new Map<string, PendingToolCall>()
  const seen = new Set<string>()

  /** 取当前会话的事件窗口（旧宿主/无会话返回 undefined）。 */
  function feedOf(sessionId: string): EventSourceLike | undefined {
    try {
      const sessions = serviceOf<SessionsLike>(ctx, 'sessions')
      if (!sessionId || typeof sessions?.binding !== 'function') return undefined
      const source = sessions.binding(sessionId)?.eventSource
      return source && typeof source.getSnapshot === 'function' && typeof source.subscribe === 'function' ? source : undefined
    } catch {
      return undefined
    }
  }

  /** 解析一条事件；命中材料页工具结果时返回待打开页面。 */
  function reduceEntry(entry: unknown, live: boolean): IntakeToolPayload | undefined {
    const row = entry !== null && typeof entry === 'object' ? entry as { type?: unknown; event?: { type?: unknown; seq?: unknown; data?: unknown } } : undefined
    const event = row?.event
    if (!event || typeof event.type !== 'string') return undefined
    const data = event.data !== null && typeof event.data === 'object' ? event.data as Record<string, unknown> : {}
    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : ''
      const name = typeof data.name === 'string' ? data.name : ''
      if (callId && name === UI_INTAKE_TOOL) {
        let args: Record<string, unknown> = {}
        if (typeof data.arguments === 'string') {
          try {
            const parsed: unknown = JSON.parse(data.arguments)
            if (parsed !== null && typeof parsed === 'object') args = parsed as Record<string, unknown>
          } catch {
            args = {}
          }
        }
        pendingCalls.set(callId, { name, args })
      }
      return undefined
    }
    if (event.type !== 'tool/result') return undefined
    const message = data.message !== null && typeof data.message === 'object' ? data.message as Record<string, unknown> : {}
    const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
    const call = callId ? pendingCalls.get(callId) : undefined
    if (callId) pendingCalls.delete(callId)
    if (!call || call.name !== UI_INTAKE_TOOL || !live || message.isError === true || data.error) return undefined
    if (seen.has(callId)) return undefined
    const text = toolTextOf(message.content)
    const payload = intakeToolPayloadOf(text)
    if (!payload) return undefined
    seen.add(callId)
    if (seen.size > 128) seen.delete(seen.values().next().value as string)
    return payload
  }

  /** 消费一次事件窗口增量。 */
  function consume(snapshot: FeedSnapshot): void {
    if (disposed) return
    const baseline = revision === undefined || snapshot.change?.kind === 'replace'
    revision = snapshot.revision
    if (baseline) {
      pendingCalls.clear()
      watermark = -1
    }
    const entries = baseline ? snapshot.entries : snapshot.change?.kind === 'append' ? snapshot.change.entries ?? [] : []
    for (const entry of entries) {
      if (entry !== null && typeof entry === 'object' && (entry as { type?: unknown }).type === 'transient') continue
      const event = (entry as { event?: { seq?: unknown } } | null)?.event
      const seq = typeof event?.seq === 'number' ? event.seq : undefined
      const live = !baseline && (seq === undefined || seq > watermark)
      if (seq !== undefined) watermark = Math.max(watermark, seq)
      const payload = reduceEntry(entry, live)
      if (payload) {
        const scope = readSessionScope(ctx)
        if (scope.sessionId === feedOwner && payload.absolutePath) openMaterials(payload, scope.sessionId)
      }
    }
    while (pendingCalls.size > 128) pendingCalls.delete(pendingCalls.keys().next().value as string)
  }

  /** 绑定当前会话的事件窗口；切会话/换工作区时重建。 */
  function attachFeed(): void {
    const scope = readSessionScope(ctx)
    const sessionId = scope.sessionId ?? ''
    const cwd = scope.cwd ?? ''
    if (sessionId === feedOwner && cwd === feedCwd) return
    offFeed?.()
    feed = undefined
    offFeed = undefined
    feedOwner = sessionId
    feedCwd = cwd
    revision = undefined
    watermark = -1
    pendingCalls.clear()
    seen.clear()
    const next = feedOf(sessionId)
    feed = next
    if (!next) return
    try {
      consume(next.getSnapshot())
      const off = next.subscribe(() => {
        try {
          consume(next.getSnapshot())
        } catch (error) {
          log.warn('材料页事件窗口读取失败：' + messageOf(error))
        }
      })
      offFeed = typeof off === 'function' ? off as () => void : undefined
    } catch (error) {
      log.warn('材料页事件窗口订阅失败：' + messageOf(error))
    }
  }

  attachFeed()
  const offScope = subscribeScope(ctx, attachFeed)

  return () => {
    disposed = true
    controller.abort()
    window.removeEventListener('message', onWindowMessage)
    offScope()
    offFeed?.()
    offFeed = undefined
    grants.clear()
    states.clear()
    inflight.clear()
    pendingCalls.clear()
    seen.clear()
  }
}

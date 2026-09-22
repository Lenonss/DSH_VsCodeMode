/**
 * dsh-vscode-mode — 调试（DAP）双面契约：调试会话状态、事件投影视图、调试配置与
 * edrv.dap.* RPC 载荷。纯类型与纯函数，禁 node/react（同 shared 纯度规则）。
 * 适配器 = 用户已装扩展清单 contributes.debuggers 声明的 DAP 适配器（通用，不限定语言）。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */

/** 调试会话相位。 */
export type DapPhase = 'idle' | 'starting' | 'waiting' | 'running' | 'paused' | 'terminated'

/** 系统进程条目（进程枚举投影视图）。 */
export interface DapProcessInfo {
  pid: number
  /** 窗口标题（processName 匹配目标，与 VS Code 扩展语义一致）。 */
  title: string
  /** 可执行文件完整路径。 */
  path: string
  /** 路径 basename（如 Unity.exe）。 */
  name: string
}

/** 调试配置（launch.json configuration 投影视图 + raw 原样透传）。 */
export interface DapDebugConfig {
  /** 配置名（工具条下拉显示）。 */
  name: string
  /** 适配器类型（= 扩展清单 contributes.debuggers.type，如 emmylua_attach / coreclr / unity）。 */
  type: string
  /** DAP request：attach | launch（缺省 launch；emmylua_attach 旧配置缺 request 时按 attach 兼容）。 */
  request?: string
  /** 进程名（标题或文件名包含匹配；attach 型按它自动选 pid）。 */
  processName?: string
  /** 直接指定 pid（>0 时跳过进程枚举）。 */
  pid?: number
  /** 附加目标 pid（coreclr/unity 等适配器的 launch.json processId 字段）。 */
  processId?: number
  /** emmylua_new 型：目标 emmy_core 监听地址。 */
  host?: string
  port?: number
  /** 源码根目录列表（chunkname → 文件映射辅助）。 */
  sourcePaths?: string[]
  /** 源码扩展名（emmylua 用；通用适配器按声明 languages 推导）。 */
  ext?: string[]
  /** 附加时捕获 Unity 日志（emmy_tool -capture-log）。 */
  captureLog?: boolean
  /** launch.json 原始配置（attach/launch 请求参数原样透传，含全部未识别字段，变量已替换）。 */
  raw?: Record<string, unknown>
}

/** launch.json「添加配置」下拉条目（扩展清单 configurationSnippets / initialConfigurations 投影）。 */
export interface DapConfigSnippet {
  /** 下拉显示名（%nls% 占位符已解析）。 */
  label: string
  /** 条目说明（%nls% 占位符已解析；无则空）。 */
  description?: string
  /** 适配器类型（= body.type，缺失时由清单条目补齐）。 */
  type: string
  /** 片段主体 JSON 文本（对象；%nls% 已解析，插入方按目标文件缩进重排）。 */
  bodyText: string
  /** 适配器可用性（与工具条同源 debuggerDecls 裁决；false = 下拉过滤不给插入；缺省 = 老 host 未标注，按可用处理）。 */
  available?: boolean
  /** 不可用原因（available=false 时给出，如「适配器入口不存在」）。 */
  reason?: string
}

/** 调试事件投影视图（host 缓冲、客户端 poll 拉增量）。 */
export interface DapEventView {
  /** 事件游标（单调递增，poll since 用）。 */
  seq: number
  kind: 'output' | 'stopped' | 'continued' | 'terminated'
  /** output 文本 / stopped 原因。 */
  text?: string
  reason?: string
}

/** 调用栈帧视图（file 已归一为工作区相对路径，空串=未能映射）。 */
export interface DapFrameView {
  id: number
  name: string
  file: string
  rawFile: string
  line: number
}

/** 作用域视图（Variables=局部+upvalue / ENV）。 */
export interface DapScopeView {
  name: string
  ref: number
  hint?: string
}

/** 变量视图（ref>0 表示可继续展开）。 */
export interface DapVariableView {
  name: string
  value: string
  type?: string
  ref: number
}

/** 停帧首栈视图（命中断点时驱动文件跳转与行高亮）。 */
export interface DapTopFrame {
  file: string
  rawFile: string
  line: number
  name: string
}

/** 调试会话状态视图（poll 返回，客户端渲染依据）。 */
export interface DapStateView {
  phase: DapPhase
  configName?: string
  configType?: string
  pid?: number
  error?: string
  topFrame?: DapTopFrame | null
}

/** poll 增量结果。 */
export interface DapPollResult {
  state: DapStateView
  events: DapEventView[]
  nextSeq: number
}

/** 断点输入（path 相对工作区根，'/' 分隔；host 负责转绝对路径给适配器）。 */
export interface DapBreakpointInput {
  path: string
  line: number
  condition?: string
  hitCondition?: string
  logMessage?: string
}

/** 调试控制动作（edrv.dap.command）。 */
export type DapAction = 'continue' | 'next' | 'stepIn' | 'stepOut' | 'pause' | 'disconnect'

/** 全部合法动作（运行时校验用）。 */
export const DAP_ACTIONS: readonly DapAction[] = ['continue', 'next', 'stepIn', 'stepOut', 'pause', 'disconnect']

/** 调试配置文件（工作区相对路径；插件专属，与 VS Code 的 .vscode/launch.json 互不干扰）。 */
export const DAP_LAUNCH_REL = '.dsh/launch.json'

/** 旧共用配置路径（仅首读迁移源：复制到 DAP_LAUNCH_REL 后不再读取，永不回写）。 */
export const DAP_LEGACY_LAUNCH_REL = '.vscode/launch.json'

/** 断点确认结果（适配器真实回执；适配器可能挪行或判不可验证）。 */
export interface DapBreakpointAck {
  line: number
  verified: boolean
  /** 适配器说明（如「该行无可执行代码」）。 */
  message?: string
}

/** 配置来源。 */
export type DapConfigSource = 'launchjson' | 'settings' | 'none'

/** 调试适配器声明（扩展清单 contributes.debuggers 条目投影视图）。 */
export interface DapAdapterDecl {
  /** 调试类型（launch.json type 匹配键，= initialize.adapterID）。 */
  type: string
  /** 显示名（下拉与错误提示用）。 */
  label: string
  /** 来源扩展 id（publisher.name）。 */
  extensionId: string
  /** 来源扩展根目录（emmylua 兼容 shim 的 extensionPath 来源）。 */
  extensionPath: string
  /** 适配器入口绝对路径（已按平台解析 program/windows.program）。 */
  program: string
  /** 清单声明的启动参数（如 clrdbg 的 --interpreter=vscode）。 */
  args: string[]
  /** 运行时：'node' = 用 node 跑 js 入口；空 = 直接 spawn program。 */
  runtime?: string
  /** 声明语言（如 ['lua'] / ['csharp']）。 */
  languages: string[]
  /** 该适配器可下断点的文件扩展名（小写、带点；空 = 不限）。 */
  exts: string[]
  /** 入口是否真实存在（DotRush 等按需下载的适配器可能缺失）。 */
  available: boolean
  /** 不可用原因（available=false 时给出）。 */
  reason?: string
}

/** 下发客户端的适配器可用性视图（edrv.dap.configs.adapters 元素）。 */
export interface DapAdapterInfo {
  type: string
  label: string
  available: boolean
  reason?: string
}

/**
 * chunkname 与候选文件的 basename 匹配（纯函数，可单测）。
 * 适配器 findFileReq 的 file 是 Lua chunkname（可能带 @ 前缀/相对点路径/反斜杠，
 * 且常常不含 .lua 扩展名——xLua 惯例）；匹配口径：剥 @、统一分隔符后，
 * 完整相对路径相等 / basename 相等 / basename 去扩展名 stem 相等（大小写不敏感）。
 * @author ddj 2026年09月29号
 * @param chunk 适配器上报的 chunkname
 * @param relPath 候选文件工作区相对路径（'/' 分隔）
 * @returns 是否命中
 */
export function chunkMatchesFile(chunk: string, relPath: string): boolean {
  const clean = String(chunk || '').replace(/^@/, '').replace(/\\/g, '/')
  const rel = String(relPath || '').replace(/\\/g, '/')
  if (!clean || !rel) return false
  if (clean === rel) return true
  const chunkBase = (clean.split('/').pop() ?? '').toLowerCase()
  const fileBase = (rel.split('/').pop() ?? '').toLowerCase()
  if (!chunkBase || !fileBase) return false
  if (chunkBase === fileBase) return true
  return chunkBase === fileBase.replace(/\.[^.]+$/, '')
}

/**
 * 配置 → DAP request 类型：显式 request 优先；emmylua_attach 旧配置缺 request 时按 attach 兼容。
 * @author ddj 2026年09月21号
 * @param config 调试配置（取 type/request 两字段）
 * @returns 'attach' | 'launch'
 */
export function requestOfConfig(config: Pick<DapDebugConfig, 'type' | 'request'>): 'attach' | 'launch' {
  if (config.request === 'attach' || config.request === 'launch') return config.request
  return config.type === 'emmylua_attach' ? 'attach' : 'launch'
}

/**
 * 是否应发送 configurationDone（DAP 标准握手收尾：断点下发完 → configurationDone → 目标开跑）。
 * 仅当适配器在 initialize 响应声明 supportsConfigurationDoneRequest 时发送；
 * emmylua 适配器未声明该能力（实测响应体仅 5 个 supports* 字段）→ 不发，Lua 行为不变。
 * @author ddj 2026年09月21号
 * @param caps initialize 响应 body（capabilities）
 */
export function needsConfigurationDone(caps: Record<string, unknown> | null | undefined): boolean {
  return caps?.supportsConfigurationDoneRequest === true
}

/**
 * stopped 事件 body → 当前线程 id：多线程适配器（coreclr 等）取真实 threadId，
 * 缺省/非法回退 1（单线程适配器 emmylua 语义不变）。
 * @author ddj 2026年09月21号
 * @param body stopped 事件 body
 */
export function threadIdOfStopped(body: Record<string, unknown>): number {
  const id = body.threadId
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : 1
}

/**
 * setBreakpoints 响应 body → 断点回执（DAP 顺序与请求一致；缺行回退请求行）。
 * 适配器会把断点挪到最近可绑定行并给出 verified/message——必须消费而非造假回执。
 * @author ddj 2026年09月21号
 * @param body setBreakpoints 响应 body（breakpoints 数组）
 * @param items 本次请求的断点（回退基准）
 */
export function bpAcksOfResponse(body: unknown, items: DapBreakpointInput[]): DapBreakpointAck[] {
  const list = (body as { breakpoints?: unknown } | null)?.breakpoints
  if (!Array.isArray(list)) return items.map((it) => ({ line: it.line, verified: true }))
  return list.map((item, i) => {
    const b = (item ?? {}) as Record<string, unknown>
    const line = typeof b.line === 'number' && b.line >= 1 ? b.line : items[i]?.line ?? 0
    const ack: DapBreakpointAck = { line, verified: b.verified === true }
    if (typeof b.message === 'string' && b.message) ack.message = b.message
    return ack
  })
}

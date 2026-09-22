/**
 * dsh-vscode-mode host — SVN 能力：检测（CLI/Tortoise/工作副本根）、状态缓存与命令执行。
 * 底座 svn CLI：全部调用带 --non-interactive + stdin ignore + graceMs 超时防交互挂起；
 * 只需退出码的调用 stdio 用 inherit（受管环境管道 spawn EPERM，见 dsh-vscode-mode 技能），
 * 需要输出的调用先管道、spawn 级失败回退 inherit（输出降级为空）。
 * TortoiseProc 为长驻 GUI 进程：发射后不 await done（只挂 no-op catch 防未处理 rejection）。
 * 作者 ddj 2026年09月16号
 */
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Ctx, Session } from './store.js'
import { cwdOf, sessionOf } from './registry.js'
import type { SvnAction, SvnChangeEntry, SvnConflictArtifact, SvnFeature, SvnItemStatus, SvnLogEntry, SvnRemoteOutdatedEntry, SvnStatusPayload, SvnSumEntry } from './shared/svn.js'
import { SVN_CLI_DEFAULT, TORTOISE_EXE, contentGuardOf, tortoiseLaunchArgv } from './shared/svn.js'
import { attrOf, numAttrOf, scanXmlTags, textOf, unescapeXml } from './svnXml.js'
import { TEXT_OUTPUT_CAP, batchResultOf, tailOfText, updateResultOf } from './svnText.js'
import { LOG_CAP, LOG_DEFAULT_LIMIT, SVN_LOG_SHOW_ALL_CAP, parseLogXml, parseSvnInfoRevision } from './svnLog.js'
export { batchResultOf, commitResultOf, updateResultOf } from './svnText.js'
export { mapRepoPath, parseLogXml } from './svnLog.js'

/** 状态载荷 TTL（毫秒）：右键/命令只读缓存，过期后台重算。 */
export const STATUS_TTL_MS = 60_000
/** svn CLI 探测 TTL（毫秒）：PATH 很少变，长缓存避免频繁 spawn。 */
export const CLI_TTL_MS = 5 * 60_000
/** CLI 探测超时。 */
const CLI_GRACE_MS = 6_000
/** svn update 超时（大工作副本留足预算）。 */
const UPDATE_GRACE_MS = 180_000
/** TortoiseProc 发射超时预算（不 await done，仅约束服务侧资源）。 */
const TORTOISE_GRACE_MS = 600_000
/** 前台置顶助手超时预算（轮询 ≤8s + PowerShell 启动余量）。 */
const HELPER_GRACE_MS = 20_000
/** 输出载荷上限（1MB，对齐 runSvn stdio 限额；文本解析上限见 svnText.TEXT_OUTPUT_CAP）。 */
const OUTPUT_CAP = TEXT_OUTPUT_CAP
/**
 * 日志拉取的 stdout 上限：默认窗口 LOG_CAP=500 条、Show All 上限 SVN_LOG_SHOW_ALL_CAP=5000 条。
 *
 * 实测（2026-09-18，IslandSplash_BugFix `Assets`，svn 1.14.5）：`-l 500` → 2.52MB / 2.0s，
 * `-l 5000` → 18.86MB / 30.1s（约 3.8~5KB/条，含中文路径与提交信息）。故取 64MB 留约 3× 余量，
 * `-g`（merged）单条更大也吃这份余量。
 * 实测教训（勿复踩）：默认 1MB 上限时收集器保留**尾部**，Assets 全量 100 条（1.19MB）
 * 恰好把最新的 52 条挤出（用户报「显示的数据不对」）。
 * @author ddj 2026年09月17号 / 2026年09月18号
 */
const LOG_OUTPUT_CAP = 64 * 1024 * 1024
/** 变更条目上限（防超大工作副本撑爆载荷）。 */
export const CHANGES_CAP = 4000
/** 批量动作路径数上限（revert/add 单次操作目标数）。 */
export const BATCH_PATHS_CAP = 64
/** `svn status --xml` 超时（大工作副本留足预算）。 */
const STATUS_GRACE_MS = 120_000
/** 其他只读子命令（cat/info）超时。 */
const READ_GRACE_MS = 30_000
/** revert/add 超时。 */
const MUTATE_GRACE_MS = 120_000
/** 变更 TTL（毫秒）：与状态同源，避免频繁全量 status。 */
export const CHANGES_TTL_MS = 5_000
/** 文本读取上限（对齐 rpc.ts READ_CAP：>8MB 拒绝整文件读取/差异）。 */
const READ_CAP = 8 * 1024 * 1024
/**
 * W2-1 补丁文本输出上限（16MB）。实测教训复用（PROGRESS §六.1）：DSH stdout 收集器
 * 超限**保留尾部**——补丁被截断时头部 `Index:` 会丢失，host 以「不以 Index: 开头」
 * 标记 truncated，客户端明示「不完整」而非让用户拿半份补丁去用。
 */
const PATCH_OUTPUT_CAP = 16 * 1024 * 1024
/** W2-2 目录对比 summarize 输出上限（8MB；大目录长区间的变更条目 XML）。 */
const SUM_OUTPUT_CAP = 8 * 1024 * 1024
/**
 * W2-3 远端检查超时（15s）。M3 实测：无凭据/离线时 `status -u` 会长时间挂起
 * （受限沙箱内 120s 无输出），远端检查必须短超时 + 失败降级，绝不阻塞面板。
 */
const REMOTE_GRACE_MS = 15_000
/** W2-2 summarize 服务器往返预算（大目录长区间可能较慢）。 */
const SUM_GRACE_MS = 60_000
/** W2-5 fileSizes 单次查询路径上限（配对候选是少数条目，防滥用）。 */
export const FILE_SIZES_CAP = 200

/** 文件存在性探测（可注入替身）。 */
export type ExistsFn = (path: string) => Promise<boolean>

/** 工作副本根向上查找（≤10 层，命中含 .svn 的最近祖先）。 */
const SVN_ROOT_MAX_DEPTH = 10

/** 默认存在性探测（node fs；异常一律按不存在）。 */
const defaultExists: ExistsFn = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 从 cwd 向上查找 SVN 工作副本根（.svn 目录/文件均算，SvnHelper 同口径）。
 * `.svn` 判定与平台无关（Linux/macOS 亦为目录），无需平台参数。
 * @author ddj 2026年09月16号
 * @param cwd 起始绝对路径
 * @param exists 存在性探测（测试注入）
 * @returns 工作副本根绝对路径；未命中返回 null
 */
export async function findSvnRoot(
  cwd: string,
  exists: ExistsFn = defaultExists,
): Promise<string | null> {
  let dir = cwd
  for (let depth = 0; dir && depth < SVN_ROOT_MAX_DEPTH; depth += 1) {
    if (await exists(join(dir, '.svn'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * 解析 TortoiseProc.exe（候选序：设置目录 → bin 子目录 → 默认安装目录 → PATH 逐项）。
 * @author ddj 2026年09月16号
 * @param dirSetting 设置里的 TortoiseSVN 目录（空 = 默认）
 * @param exists 存在性探测（测试注入）
 * @param platform 目标平台（非 win32 恒 null）
 * @param pathEnv PATH 环境变量（测试注入）
 * @returns TortoiseProc.exe 绝对路径；不可用返回 null
 */
export async function findTortoiseProc(
  dirSetting: string,
  exists: ExistsFn = defaultExists,
  platform: NodeJS.Platform = process.platform,
  pathEnv: string | undefined = process.env?.PATH,
): Promise<string | null> {
  if (platform !== 'win32') return null
  const dir = dirSetting && dirSetting.trim() ? dirSetting.trim() : ''
  const candidates = [
    dir && join(dir, 'bin', TORTOISE_EXE),
    dir && join(dir, TORTOISE_EXE),
  ].filter((item): item is string => Boolean(item))
  for (const entry of (pathEnv ?? '').split(';')) {
    const trim = entry.trim()
    if (trim) candidates.push(join(trim, TORTOISE_EXE))
  }
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return null
}

/** 设置里 SVN 路径的最小读取面（setupOpenSettings 提供）。 */
export interface SvnSettingsLike {
  svn: () => { svnPath: string; tortoisePath: string }
}

/**
 * 本插件已自研的 SVN 能力（「自研替换时间线」的推进点）。
 *
 * 每完成一个阶段就把对应能力加进来：client 会据此隐藏被覆盖的 TortoiseProc 项，
 * 避免自研项与官方同名项并列、用户误点到官方弹窗。
 * 当前：差异（P2「与基线比较」）、还原（P2 `revert -R`）、日志（P3 日志弹窗）。
 * 待补：提交（P4 完成后加入 'commit'）；追溯无自研计划（P5 另议），故不含 'blame'。
 */
export const SVN_FEATURES: readonly SvnFeature[] = ['diff', 'revert', 'log']

// --region P2 工作副本状态解析

/** `svn status --xml` 的 `<wc-status item="...">` 合法取值（未知值一律按 modified 兜底）。 */
const KNOWN_ITEM_STATUS: ReadonlySet<string> = new Set([
  'normal', 'added', 'deleted', 'replaced', 'conflicted',
  'missing', 'unversioned', 'obstructed', 'ignored', 'modified',
  'external', 'incomplete',
])

/** 受版本控制判据：unversioned/ignored 之外均为版本化条目。 */
const UNVERSIONED_STATUS: ReadonlySet<string> = new Set(['unversioned', 'ignored'])

/**
 * 归一化 XML 中的条目路径为工作区相对路径（`/` 分隔、无前导 `./`）。
 * XML 路径相对「执行 status 时的 cwd」（实测 Windows 下用 `\`），故 host 必须以
 * 工作副本根为 cwd 执行，这里只做分隔符与形态归一；`''`/`.` 表示根自身。
 * @author ddj 2026年09月16号
 * @param raw XML path 属性原文（已反转义）
 * @returns 归一化路径；根自身返回 ''
 */
export function changePathOf(raw: string): string {
  const slashed = String(raw ?? '').replace(/\\/g, '/').trim()
  const stripped = slashed.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
  return stripped === '.' ? '' : stripped
}

/**
 * 解析 `svn status --xml` 输出为变更清单（纯函数，无第三方 XML 依赖）。
 *
 * 结构要点（实测 svn 1.14.5）：
 * - `<target path="..."><entry path="..."><wc-status item="..." props="..." revision="..."/></entry>...`
 * - 登记过 changelist 的条目被抽到 `<changelist name="...">` 块内（与 target 平级），
 *   故解析必须按块回填 changelist 名，不能只看 `<entry>`。
 * - 根自身条目（`path="."`）在属性被改时出现，`item="normal"` 不代表变更；路径为空的
 *   条目一律跳过，避免把根当成变更项展示。
 *
 * @author ddj 2026年09月16号
 * @param xml status --xml 的 stdout
 * @param cap 条目上限（超出标记 truncated）
 * @returns 变更清单与是否截断
 */
export function parseStatusXml(xml: string, cap: number = CHANGES_CAP): { entries: SvnChangeEntry[]; truncated: boolean } {
  const entries: SvnChangeEntry[] = []
  let truncated = false
  if (typeof xml !== 'string' || !xml) return { entries, truncated }
  let changelist = ''
  let pendingPath: string | null = null
  for (const hit of scanXmlTags(xml, ['changelist', 'entry', 'wc-status'])) {
    if (hit.name === 'changelist') {
      changelist = hit.closing ? '' : attrOf(hit.attrs, 'name')
      continue
    }
    if (hit.name === 'entry') {
      pendingPath = hit.closing ? null : attrOf(hit.attrs, 'path')
      continue
    }
    // 闭合标签 `</wc-status>` 只是结构收尾（无属性），不得当成新条目——旧实现会据此产出
    // 一条 `item` 缺失的兜底 'modified' 条目，同一路径出现两条（实测由本模块单测抓出）
    if (hit.closing) { pendingPath = null; continue }
    if (!pendingPath) continue
    const rawItem = attrOf(hit.attrs, 'item')
    const item = (rawItem || 'modified') as SvnItemStatus
    const status: SvnItemStatus = KNOWN_ITEM_STATUS.has(item) ? item : 'modified'
    const path = changePathOf(pendingPath)
    if (!path) { pendingPath = null; continue }
    if (entries.length >= cap) { truncated = true }
    else {
      const props = attrOf(hit.attrs, 'props')
      const revision = numAttrOf(hit.attrs, 'revision')
      entries.push({
        path,
        status,
        props: props === 'modified' || props === 'conflicted' ? props : 'none',
        versioned: !UNVERSIONED_STATUS.has(status),
        ...(changelist ? { changelist } : {}),
        ...(revision !== undefined && revision >= 0 ? { revision } : {}),
      })
    }
    // 自闭合形态（`<wc-status .../>`）到此结束；长形态由 `</entry>` 收尾
    if (hit.selfClosing) pendingPath = null
  }
  return { entries, truncated }
}

/**
 * 绝对路径 → 工作副本相对路径（W2-2/W2-3：M3/M5 实测 XML 中 path 为绝对路径）。
 * Windows 大小写不敏感文件系统：前缀匹配按小写比较，剥离后保留原大小写。
 * @author ddj 2026年09月20号
 * @param abs 绝对路径（`/` 或 `\` 分隔均可）
 * @param wcRoot 工作副本根绝对路径
 * @returns 相对路径（`/` 分隔）；不在根下返回 null
 */
export function relPathOfAbs(abs: string, wcRoot: string): string | null {
  const norm = (p: string) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  const a = norm(abs)
  const r = norm(wcRoot)
  if (!r || !a.toLowerCase().startsWith(r.toLowerCase() + '/')) return null
  return a.slice(r.length + 1)
}

/**
 * W2-1 补丁的 `-x` 扩展选项组合（纯函数）。
 * 冒烟实测修正（2026-09-20）：本机 svn 内部 diff 的上下文行数只认 `-U<N>`，
 * `--unified=N` 报 E200016 erroneous argument（07 计划 §1 当年只核对了 help 文案，未实测）。
 * @author ddj 2026年09月20号
 * @param opts 空白语义 / EOL 忽略 / 上下文行数
 * @returns 空格连接的单个 `-x` 值；无选项时空串
 */
export function patchExtOf(opts: { whitespace?: string; ignoreEol?: boolean; unified?: number }): string {
  const parts: string[] = []
  if (opts.whitespace === 'b') parts.push('-b')
  if (opts.whitespace === 'w') parts.push('-w')
  if (opts.ignoreEol === true) parts.push('--ignore-eol-style')
  const unified = Math.floor(Number(opts.unified))
  if (Number.isFinite(unified) && unified >= 0 && unified <= 100 && unified !== 3) parts.push('-U' + unified)
  return parts.join(' ')
}

/**
 * 解析 `svn diff --summarize --xml` 输出（W2-2；M5 实测形态，svn 1.14.5）：
 * `<diff><paths><path item="modified" kind="file" props="none">ABS:\\PATH</path>...`
 * - path 的**文本内容**是绝对路径（非属性）→ relPathOfAbs 归一为工作副本相对；
 * - 属性输出顺序不稳定（与 M1 log 同款教训），只按字段名取值、不做字符串快照；
 * - 区间无变更时 `<paths>` 为空 → entries 为空数组（非错误）。
 * @author ddj 2026年09月20号
 * @param xml summarize --xml 的 stdout
 * @param wcRoot 工作副本根（路径归一锚点）
 * @param cap 条目上限（超出标记 truncated）
 * @returns 变更条目与是否截断
 */
export function parseSummarizeXml(xml: string, wcRoot: string, cap: number = CHANGES_CAP): { entries: SvnSumEntry[]; truncated: boolean } {
  const entries: SvnSumEntry[] = []
  let truncated = false
  if (typeof xml !== 'string' || !xml) return { entries, truncated }
  const re = /<path\b([^>]*?)>([\s\S]*?)<\/path>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const abs = unescapeXml(match[2].trim())
    // 路径形态双兼容（冒烟实测 2026-09-20）：绝对路径目标 → svn 回显绝对路径；相对路径目标
    // （host 常态，cwd=wcRoot）→ svn 回显相对路径。先按绝对剥离前缀，失败按相对归一。
    const rel = relPathOfAbs(abs, wcRoot) ?? changePathOf(abs)
    if (!rel) continue
    if (entries.length >= cap) { truncated = true; break }
    entries.push({
      path: rel,
      item: attrOf(match[1], 'item') || 'none',
      kind: attrOf(match[1], 'kind') || 'none',
      props: attrOf(match[1], 'props') || 'none',
    })
  }
  return { entries, truncated }
}

/**
 * 解析 `svn status -u --xml` 输出（W2-3；M3 实测形态，svn 1.14.5）：
 * `<entry path="ABS"><wc-status ...>...</wc-status><repos-status item="modified" props="none"/></entry>` + `<against revision="N"/>`
 * - 落后锚点 = 存在 `<repos-status>` 且 `item !== 'none'`（实测落后文件为 modified）；
 *   远端无变化的条目**没有** repos-status 元素（省略，非 'none' 值）；
 * - 离线/无凭据时会长时间挂起（M3 实测 120s+），调用方必须用 REMOTE_GRACE_MS 短超时。
 * @author ddj 2026年09月20号
 * @param xml status -u --xml 的 stdout
 * @param wcRoot 工作副本根（路径归一锚点）
 * @param cap 条目上限（超出标记 truncated）
 * @returns 落后清单 + against 修订
 */
export function parseRemoteStatusXml(
  xml: string,
  wcRoot: string,
  cap: number = CHANGES_CAP,
): { outdated: SvnRemoteOutdatedEntry[]; againstRev: number | null; truncated: boolean } {
  const outdated: SvnRemoteOutdatedEntry[] = []
  let againstRev: number | null = null
  let truncated = false
  if (typeof xml !== 'string' || !xml) return { outdated, againstRev, truncated }
  // 开标签属性截取（M3 实测长形态：`<repos-status\n item="...">\n</repos-status>`，
  // 开标签 `>` 与闭标签之间可能有换行，故只截开标签而非要求紧邻闭标签）
  const against = /<against\b([^>]*?)\/?>/.exec(xml)
  if (against) {
    const rev = numAttrOf(against[1], 'revision')
    if (rev !== undefined) againstRev = rev
  }
  const re = /<entry\b([^>]*?)>([\s\S]*?)<\/entry>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    const repos = /<repos-status\b([^>]*?)\/?>/.exec(match[2])
    if (!repos) continue
    const item = attrOf(repos[1], 'item')
    if (!item || item === 'none') continue
    // 路径形态双兼容（同 parseSummarizeXml：绝对/相对取决于调用目标形态）
    const rawPath = attrOf(match[1], 'path')
    const rel = relPathOfAbs(rawPath, wcRoot) ?? changePathOf(rawPath)
    if (!rel) continue
    if (outdated.length >= cap) { truncated = true; break }
    outdated.push({ path: rel, item })
  }
  return { outdated, againstRev, truncated }
}

// --endregion

/** 一次 svn CLI 运行结果（输出可能因 stdio 回退而为空）。 */
interface SvnRunOutcome { code: number | null; stdout: string; stderr: string }

/** subprocess 产句柄最小结构面（done 载荷对齐 revert.ts 的 exitCode/code 双读）。 */
interface SpawnedHandle {
  done: Promise<{ exitCode?: number; code?: number } | undefined>
  collected?: {
    stdout?: { readFrom: (n: number) => { text: string } }
    stderr?: { readFrom: (n: number) => { text: string } }
  }
}

/** subprocess 服务 spawn 方法最小结构面。 */
type SpawnFn = (spec: Record<string, unknown>) => SpawnedHandle

/** 进程名（去路径去 .exe；前台助手用）。 */
export function processNameOf(exe: string): string {
  const base = exe.split(/[\\/]/).pop() ?? exe
  return base.replace(/\.exe$/i, '')
}

/**
 * 前台置顶助手 argv（纯函数）。
 * 背景：Windows 前台锁——后台进程（DSH host）启动的窗口默认抢不到前台（任务栏闪烁），
 * 前台进程的子进程才继承置顶权（SvnHelper 依赖 VSCode 在前台故无此问题）。
 * 方案：独立 PowerShell 助手轮询新进程主窗口，SwitchToThisWindow 强制切换
 * （任务栏同源 API，无前台权限也可切窗）；脚本内不含任何用户数据（按进程名发现），无注入面。
 * @author ddj 2026年09月16号
 * @param processName 目标进程名（不带 .exe）
 * @returns powershell 助手 argv
 */
export function foregroundHelperArgv(processName: string): string[] {
  const script = [
    '$cut = (Get-Date).AddSeconds(-2)',
    '$deadline = $cut.AddSeconds(8)',
    '$h = [IntPtr]::Zero',
    'while ((Get-Date) -lt $deadline) {',
    '  Start-Sleep -Milliseconds 150',
    '  $p = Get-Process -Name "' + processName + '" -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $cut -and $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1',
    '  if ($p) { $h = $p.MainWindowHandle; break }',
    '}',
    'if ($h -ne [IntPtr]::Zero) {',
    "  Add-Type -Namespace W -Name N -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void SwitchToThisWindow(IntPtr h, bool a);'",
    '  [W.N]::SwitchToThisWindow($h, $true)',
    '}',
  ].join('\n')
  return ['powershell', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script]
}

/** createSvnRpc 依赖（时钟/查找器/平台可注入便于单测）。 */
export interface SvnRpcDeps {
  ctx: Ctx
  settings: SvnSettingsLike
  now?: () => number
  /** 工作副本根查找（测试注入；缺省 findSvnRoot）。 */
  findRoot?: (cwd: string) => Promise<string | null>
  /** TortoiseProc 查找（测试注入；缺省 findTortoiseProc）。 */
  findTortoise?: (dir: string) => Promise<string | null>
  /** 目标平台（测试注入；缺省当前进程平台，前台助手仅 win32 发射）。 */
  platform?: NodeJS.Platform
}

/** host 会话/工作区前置（对齐 rpc.ts requireSession 的错误文案）。 */
async function requireSvnSession(
  ctx: Ctx,
  sessionId?: string,
): Promise<{ cwd: string } | { err: string }> {
  const session: Session | undefined = sessionOf(ctx, sessionId)
  if (!session) return { err: '会话不存在' }
  const cwd = cwdOf(session)
  if (!cwd) return { err: '会话无工作区' }
  return { cwd }
}

/** 工作区相对路径归一（'' 合法 = 工作区根；非法含越界/绝对路径返回 null）。 */
function safeRel(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return ''
  if (typeof raw !== 'string') return null
  const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (rel === '') return ''
  if (rel === '..' || rel.startsWith('../') || rel.includes('/../')) return null
  if (/^[A-Za-z]:/.test(rel) || rel.startsWith('/')) return null
  return rel
}

/**
 * 创建 svn.* RPC handlers（缓存随装配生命周期；lsp/ai 同模式并入 buildHandlers）。
 * @author ddj 2026年09月16号
 * @param deps ctx + 设置读取面 + 可注入时钟
 * @returns handlers（Partial<RpcHandlerMap> 形状）
 */
export function createSvnRpc(deps: SvnRpcDeps): { handlers: Record<string, unknown> } {
  const { ctx, settings } = deps
  const now = deps.now ?? (() => Date.now())
  const findRoot = deps.findRoot ?? ((cwd: string) => findSvnRoot(cwd))
  const findTortoise = deps.findTortoise ?? ((dir: string) => findTortoiseProc(dir))
  const statusCache = new Map<string, { at: number; payload: SvnStatusPayload }>()
  /** 变更清单缓存（键 = 工作副本根；TTL 短，仅合并同一轮 UI 的多处拉取）。 */
  const changesCache = new Map<string, { at: number; value: { entries: SvnChangeEntry[]; truncated: boolean } }>()
  /** 工作副本根 relative-url 缓存（日志路径映射用；探测失败也缓存空串避免反复 spawn）。 */
  const urlCache = new Map<string, { at: number; value: string }>()
  let cliProbe: { at: number; exe: string; ok: boolean } | null = null

  const subprocess = (): SpawnFn | null => {
    const sub = ctx.get('subprocess') as { spawn?: unknown } | null | undefined
    if (!sub || typeof sub.spawn !== 'function') return null
    return (sub.spawn as SpawnFn).bind(sub)
  }

  /** svn CLI 探测（inherit stdio 只取退出码；TTL 缓存按 exe 键）。 */
  const probeCli = async (exe: string): Promise<boolean> => {
    const at = now()
    if (cliProbe && cliProbe.exe === exe && at - cliProbe.at < CLI_TTL_MS) return cliProbe.ok
    let ok = false
    const spawn = subprocess()
    if (spawn) {
      try {
        const handle = spawn({
          argv: [exe, '--version', '--quiet'],
          // subprocess 服务要求 spec.cwd 必须为字符串（validateNoNullByte 对 cwd 做 .includes，
          // 缺省即抛 TypeError——已实测），无工作目录语义的探测统一落在系统临时目录。
          cwd: tmpdir(),
          stdio: { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
          graceMs: CLI_GRACE_MS,
        })
        const outcome = await handle.done
        ok = (outcome?.exitCode ?? outcome?.code) === 0
      } catch {
        ok = false
      }
    }
    cliProbe = { at, exe, ok }
    return ok
  }

  /** 合成状态（managed/svnCli/tortoise），带 TTL 缓存。 */
  const statusOf = async (cwd: string, force = false): Promise<SvnStatusPayload> => {
    const at = now()
    const hit = statusCache.get(cwd)
    if (!force && hit && at - hit.at < STATUS_TTL_MS) return hit.payload
    const configured = settings.svn()
    const cliExe = configured.svnPath.trim() || SVN_CLI_DEFAULT
    const wcRoot = await findRoot(cwd)
    const svnCli = await probeCli(cliExe)
    const tortoiseExe = await findTortoise(configured.tortoisePath)
    const payload: SvnStatusPayload = {
      managed: wcRoot !== null,
      wcRoot,
      svnCli,
      tortoise: tortoiseExe !== null,
      // 自研替换时间线：声明本插件已自研的能力，client 据此隐藏对应 Tortoise 过渡项
      // （差异/还原 = P2，日志 = P3；提交待 P4，追溯未自研，均不在此列）
      svnFeatures: SVN_FEATURES,
      svnPath: cliExe,
      tortoiseExe: tortoiseExe ?? '',
    }
    statusCache.set(cwd, { at, payload })
    return payload
  }

  /**
   * 运行 svn CLI（管道收集；spawn 级失败回退 inherit，输出降级为空）。
   * @author ddj 2026年08月26号 / 2026年09月17号
   * @param cwd 运行目录
   * @param argv 参数（不含可执行文件名；自动加 --non-interactive）
   * @param graceMs 进程宽限
   * @param stdoutCap stdout 收集上限（缺省 1MB；大载荷场景如日志拉取需显式放大）
   * @returns 退出码与输出
   */
  const runSvn = async (cwd: string, argv: string[], graceMs: number, stdoutCap: number = OUTPUT_CAP): Promise<SvnRunOutcome> => {
    const spawn = subprocess()
    if (!spawn) throw new Error('缺少 subprocess 服务')
    const fs = ctx.get('fs') as { resolve?: (p: string, o: object) => Promise<unknown>; processPath?: (t: unknown) => string } | null | undefined
    let realCwd = cwd
    if (fs?.resolve && fs?.processPath) realCwd = fs.processPath(await fs.resolve(cwd, {}))
    const exe = settings.svn().svnPath.trim() || SVN_CLI_DEFAULT
    const attempt = (mode: 'pipe' | 'inherit') => spawn({
      argv: [exe, '--non-interactive', ...argv],
      cwd: realCwd,
      stdio: mode === 'pipe'
        ? { stdout: { maxBytes: stdoutCap }, stderr: { maxBytes: OUTPUT_CAP }, stdin: 'ignore' }
        : { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
      graceMs,
    })
    try {
      const handle = attempt('pipe')
      const outcome = await handle.done
      const stdout = handle.collected?.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
      return { code: outcome?.exitCode ?? outcome?.code ?? null, stdout, stderr }
    } catch {
      // 受管环境管道 EPERM：回退 inherit（只拿退出码，输出为空）
      const handle = attempt('inherit')
      const outcome = await handle.done
      return { code: outcome?.exitCode ?? outcome?.code ?? null, stdout: '', stderr: '' }
    }
  }

  /** 发射 TortoiseProc（GUI 长驻：不 await done，no-op catch 防未处理 rejection）。 */
  const launchTortoise = (exe: string, action: SvnAction, absPath: string): void => {
    const spawn = subprocess()
    if (!spawn) throw new Error('缺少 subprocess 服务')
    const handle = spawn({
      argv: tortoiseLaunchArgv(exe, action, absPath),
      // spec.cwd 必须为字符串（subprocess 契约，缺省即抛 TypeError）；GUI 进程不依赖 cwd，落目标父目录
      cwd: dirname(absPath),
      stdio: { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
      graceMs: TORTOISE_GRACE_MS,
    })
    void handle.done.catch(() => {})
    // 前台置顶助手：后台进程启动的窗口抢不到前台（任务栏闪烁），SwitchToThisWindow 兜底；
    // best-effort——助手失败仅表现为窗口不上浮，不影响对话框本身
    if ((deps.platform ?? process.platform) !== 'win32') return
    try {
      const helper = spawn({
        argv: foregroundHelperArgv(processNameOf(exe)),
        cwd: tmpdir(),
        stdio: { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
        graceMs: HELPER_GRACE_MS,
      })
      void helper.done.catch(() => {})
    } catch {
      // 置顶失败不影响对话框启动
    }
  }

  /**
   * 读取并缓存工作副本变更（`svn status --xml --no-ignore`，以工作副本根为 cwd 执行）。
   *
   * 为什么固定以 wcRoot 为 cwd：XML 里的 path 是相对「执行时的 cwd」的（实测 Windows 用
   * `\`），固定根目录后路径即为「工作副本根相对」，与 client 的 scope/树路径口径一致；
   * 恒带 `--no-ignore` 取全集（默认不返回 ignored），显示开关交给客户端，避免为开关重跑。
   * @author ddj 2026年09月16号
   * @param wcRoot 工作副本根绝对路径
   * @param force 跳过 TTL 强制重查
   * @returns 变更清单与截断标记
   */
  const changesOf = async (wcRoot: string, force = false): Promise<{ entries: SvnChangeEntry[]; truncated: boolean }> => {
    const at = now()
    const hit = changesCache.get(wcRoot)
    if (!force && hit && at - hit.at < CHANGES_TTL_MS) return hit.value
    const outcome = await runSvn(wcRoot, ['status', '--xml', '--no-ignore'], STATUS_GRACE_MS)
    if (outcome.code !== 0) {
      throw new Error(tailOfText([outcome.stderr, outcome.stdout].filter(Boolean).join('\n')))
    }
    const value = parseStatusXml(outcome.stdout)
    changesCache.set(wcRoot, { at, value })
    return value
  }

  /**
   * 批量路径动作公共流程（revert/add 共用）：会话 → 路径白名单与上限 → 受管理校验 → 执行。
   * 路径一律以工作副本根为 cwd 传入（`--` 之后），避免以 cwd 为基准产生歧义。
   * @author ddj 2026年09月16号
   * @param verb 动作动词（摘要用）
   * @param verbArgs 子命令与选项（如 ['revert','-R']）
   * @param sessionId 会话 id
   * @param paths 工作区相对路径列表
   * @returns 动作结果或错误
   */
  const mutate = async (
    verb: string,
    verbArgs: string[],
    sessionId: string | undefined,
    paths: unknown,
  ): Promise<
    | { ok: false; error: string }
    | { ok: true; count: number; summary: string; output: string }
  > => {
    const sc = await requireSvnSession(ctx, sessionId)
    if ('err' in sc) return { ok: false as const, error: sc.err }
    if (!Array.isArray(paths) || !paths.length) return { ok: false as const, error: '未选择任何路径' }
    if (paths.length > BATCH_PATHS_CAP) {
      return { ok: false as const, error: '一次最多处理 ' + BATCH_PATHS_CAP + ' 个路径' }
    }
    const rels: string[] = []
    for (const item of paths) {
      const rel = safeRel(item)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      rels.push(rel)
    }
    const status = await statusOf(sc.cwd)
    if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
    if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
    try {
      const outcome = await runSvn(status.wcRoot, [...verbArgs, '--', ...rels], MUTATE_GRACE_MS)
      const result = batchResultOf(outcome.stdout, outcome.stderr, outcome.code, verb)
      // 变更清单已过期（revert/add 改工作副本状态）：主动作废缓存，下次拉取即为最新
      changesCache.delete(status.wcRoot)
      if (outcome.code !== 0) return { ok: false as const, error: verb + '失败：' + (result.output ? tailOfText(result.output) : '未知错误') }
      return { ok: true as const, count: result.count, summary: result.summary, output: result.output }
    } catch (error) {
      return { ok: false as const, error: verb + '失败：' + String(error) }
    }
  }

  /**
   * 读取并缓存工作副本根的 `relative-url`（`^/trunk`），供日志路径映射用。
   * 与状态探测同 TTL 量级：仓库切换（switch/relocate）是低频操作，缓存 60s 足够且省一次 spawn。
   * @author ddj 2026年09月16号
   * @param wcRoot 工作副本根
   * @returns relative-url（探测失败返回 ''）
   */
  const relativeUrlOf = async (wcRoot: string): Promise<string> => {
    const at = now()
    const hit = urlCache.get(wcRoot)
    if (hit && at - hit.at < STATUS_TTL_MS) return hit.value
    let value = ''
    try {
      const outcome = await runSvn(wcRoot, ['info', '--xml'], READ_GRACE_MS)
      if (outcome.code === 0) value = textOf(outcome.stdout, 'relative-url')
    } catch {
      value = ''
    }
    urlCache.set(wcRoot, { at, value })
    return value
  }

  /**
   * 拉取提交日志（`svn log --xml -v`）。
   * 必须显式 `-r HEAD:1`：实测默认范围是 `BASE:1`，工作副本落后时几乎拿不到日志。
   * @author ddj 2026年09月16号 / 2026年09月18号
   * @param wcRoot 工作副本根
   * @param target 目标相对路径（'' = 根）
   * @param limit 条数上限
   * @param opts stopOnCopy（P1-4）/ range（P1-6）/ showMerged（P1-5，argv `-g`）
   * @param cap 条数硬上限（P1-7 Show All 传 SVN_LOG_SHOW_ALL_CAP，默认 LOG_CAP）
   * @returns 日志条目与截断标记
   */
  const logOf = async (
    wcRoot: string,
    target: string,
    limit: number,
    opts: { stopOnCopy?: boolean; range?: { start: number; end: number } | null; showMerged?: boolean } = {},
    cap: number = LOG_CAP,
  ): Promise<{ entries: SvnLogEntry[]; truncated: boolean; limit: number }> => {
    const capped = Math.max(1, Math.min(cap, Math.floor(limit) || LOG_DEFAULT_LIMIT))
    const relativeUrl = await relativeUrlOf(wcRoot)
    // 选项必须全部在 `--` 之前（G3）；默认窗口 HEAD:1（G1），Show Range 用 -r START:END（P1-6）
    const revArg = opts.range ? String(opts.range.start) + ':' + String(opts.range.end) : 'HEAD:1'
    const argv = ['log', '-r', revArg, '-l', String(capped), '--xml', '-v']
    // P1-4 Stop on copy（§6 M2 已实测：仅截断条目集合，解析零改动）
    if (opts.stopOnCopy) argv.push('--stop-on-copy')
    // P1-5 Include merged revisions（§6 M1 已实测：嵌套 logentry + reverse-merge）
    if (opts.showMerged) argv.push('-g')
    if (target) argv.push('--', target)
    const outcome = await runSvn(wcRoot, argv, READ_GRACE_MS, LOG_OUTPUT_CAP)
    if (outcome.code !== 0) {
      throw new Error(tailOfText([outcome.stderr, outcome.stdout].filter(Boolean).join('\n')))
    }
    const parsed = parseLogXml(outcome.stdout, relativeUrl)
    // 请求数已达上限说明可能还有更多（用于「加载更多」按钮）；limit 回传供 client 记录 loadedLimit（P1-8）
    return { entries: parsed.entries, truncated: parsed.entries.length >= capped, limit: capped }
  }

  /**
   * 读取单文件某版本的左右两侧内容（`cat -r REV` vs `cat -r REV-1`）。
   *
   * 左侧在「该路径在该版本不存在」时（实测新增文件报 E195012）返回 null 而非报错：
   * 这正是「新增」的正常语义，UI 应把左侧渲染为空而不是弹错误。
   * @author ddj 2026年09月16号
   * @param wcRoot 工作副本根
   * @param rel 工作区相对路径
   * @param revision 目标版本
   * @returns 双侧内容
   */
  const diffRevSides = async (wcRoot: string, rel: string, revision: number): Promise<{ left: string | null; right: string | null; reason?: string; error?: string }> => {
    const rightOutcome = await runSvn(wcRoot, ['cat', '-r', String(revision), '--', rel], READ_GRACE_MS)
    if (rightOutcome.code !== 0) {
      return { left: null, right: null, reason: 'not-exist', error: tailOfText(rightOutcome.stderr || rightOutcome.stdout) }
    }
    const prev = revision - 1
    if (prev < 1) return { left: null, right: rightOutcome.stdout, reason: 'not-exist' }
    const leftOutcome = await runSvn(wcRoot, ['cat', '-r', String(prev), '--', rel], READ_GRACE_MS)
    if (leftOutcome.code !== 0) {
      // 该版本尚无此文件（新增/复制）：左侧为空即可，不是错误
      return { left: null, right: rightOutcome.stdout, reason: 'not-exist' }
    }
    return { left: leftOutcome.stdout, right: rightOutcome.stdout }
  }

  /**
   * 读取单文件两个指定版本的左右两侧内容（P1-2 比较两个修订；与 diffRevSides 同口径）。
   *
   * 任一侧 cat 失败返回 null + reason（新增/删除侧为正常业务分支），UI 渲染为空而非报错。
   * @author ddj 2026年09月17号
   * @param wcRoot 工作副本根
   * @param rel 工作区相对路径
   * @param revA 左侧版本（选中顺序在前）
   * @param revB 右侧版本（选中顺序在后）
   * @returns 双侧内容
   */
  const pairSides = async (wcRoot: string, rel: string, revA: number, revB: number): Promise<{ left: string | null; right: string | null; reason?: string; error?: string }> => {
    const sides: Array<{ rev: number; text: string | null; reason?: string; error?: string }> = []
    for (const rev of [revA, revB]) {
      const outcome = await runSvn(wcRoot, ['cat', '-r', String(rev), '--', rel], READ_GRACE_MS)
      if (outcome.code !== 0) {
        sides.push({ rev, text: null, reason: 'not-exist', error: tailOfText(outcome.stderr || outcome.stdout) })
      } else {
        sides.push({ rev, text: outcome.stdout })
      }
    }
    return {
      left: sides[0].text,
      right: sides[1].text,
      reason: sides[0].reason ?? sides[1].reason,
      error: sides[0].error ?? sides[1].error,
    }
  }

  /**
   * 扫描冲突副本文件（W2-4；svn 冲突时的标准后缀 `.mine`/`.working`/`.rN`，纯本地 fs 只读）。
   * @author ddj 2026年09月20号
   * @param wcRoot 工作副本根
   * @param rel 冲突文件的工作副本相对路径
   * @returns 副本清单（rev 升序 → working → mine；默认对比对 = 首个 .rN ↔ .mine）
   */
  const conflictArtifactsOf = async (wcRoot: string, rel: string): Promise<SvnConflictArtifact[]> => {
    const abs = join(wcRoot, rel)
    const base = basename(abs)
    const names = await readdir(dirname(abs))
    const rankOf = (kind: SvnConflictArtifact['kind']) => (kind === 'rev' ? 0 : kind === 'working' ? 1 : 2)
    const artifacts: SvnConflictArtifact[] = []
    for (const name of names) {
      let kind: SvnConflictArtifact['kind'] | null = null
      let rev: number | undefined
      if (name === base + '.mine') kind = 'mine'
      else if (name === base + '.working') kind = 'working'
      else if (name.startsWith(base + '.r') && /^\d+$/.test(name.slice(base.length + 2))) {
        kind = 'rev'
        rev = Number.parseInt(name.slice(base.length + 2), 10)
      }
      if (kind === null) continue
      const artifactPath = relPathOfAbs(join(dirname(abs), name), wcRoot)
      if (!artifactPath) continue
      artifacts.push({ path: artifactPath, name, kind, ...(rev !== undefined ? { rev } : {}) })
    }
    return artifacts.sort((a, b) => rankOf(a.kind) - rankOf(b.kind) || (a.rev ?? 0) - (b.rev ?? 0) || a.name.localeCompare(b.name))
  }

  /** W2-6：双侧内容护栏标记（干净时返回空对象，展开进载荷不添字段）。 */
  const guardSides = (a: string | null, b: string | null): { binary?: boolean; encodingHint?: boolean } => {
    const merged = { ...contentGuardOf(a ?? ''), ...contentGuardOf(b ?? '') }
    return merged.binary || merged.encodingHint ? merged : {}
  }

  const handlers = {
    'svn.status': async (args: { sessionId?: string; force?: boolean }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const payload = await statusOf(sc.cwd, args.force === true)
      return { ok: true as const, ...payload }
    },
    'svn.changes': async (args: { sessionId?: string; force?: boolean }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        const result = await changesOf(status.wcRoot, args.force === true)
        return { ok: true as const, wcRoot: status.wcRoot, ...result }
      } catch (error) {
        return { ok: false as const, error: '读取变更失败：' + String(error) }
      }
    },
    'svn.diffBase': async (args: { sessionId?: string; path?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      const fs = ctx.get('fs') as {
        resolve?: (p: string, o: object) => Promise<unknown>
        stat?: (t: unknown) => Promise<{ type?: string; size?: number } | null>
        readText?: (t: unknown) => Promise<string>
      } | null | undefined
      if (!fs?.resolve || !fs?.stat || !fs?.readText) return { ok: false as const, error: '缺少 fs' }
      try {
        const target = await fs.resolve(rel, { cwd: sc.cwd })
        const info = await fs.stat(target)
        if (!info || info.type !== 'file') return { ok: false as const, error: '文件不存在' }
        if ((info.size ?? 0) > READ_CAP) return { ok: false as const, error: '文件过大（>8MB），不支持基线差异' }
        const working = await fs.readText(target)
        // BASE 侧：以工作副本根为 cwd 执行（与 svn.changes 同源，保证相对路径语义一致）
        const outcome = await runSvn(status.wcRoot, ['cat', '-r', 'BASE', '--', rel], READ_GRACE_MS)
        if (outcome.code !== 0) {
          // added/未提交条目没有 pristine：非致命，按原因返回（客户端提示而非报错面板）
          const text = (outcome.stderr || outcome.stdout).trim()
          const reason = /pristine|E200009/i.test(text) ? 'no-pristine' : 'cat-failed'
          return { ok: true as const, base: null, working, reason, error: tailOfText(text), ...guardSides(null, working) }
        }
        return { ok: true as const, base: outcome.stdout, working, ...guardSides(outcome.stdout, working) }
      } catch (error) {
        return { ok: false as const, error: '读取基线失败：' + String(error) }
      }
    },
    'svn.revert': async (args: { sessionId?: string; paths?: string[] }) => {
      return mutate('还原', ['revert', '-R'], args.sessionId, args.paths)
    },
    'svn.add': async (args: { sessionId?: string; paths?: string[] }) => {
      return mutate('加入版本控制', ['add'], args.sessionId, args.paths)
    },
    'svn.log': async (args: { sessionId?: string; path?: string; limit?: number; stopOnCopy?: boolean; startRev?: number; endRev?: number; showMerged?: boolean }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null) return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        const result = await logOf(status.wcRoot, rel, args.limit ?? LOG_DEFAULT_LIMIT, {
          stopOnCopy: args.stopOnCopy === true,
          showMerged: args.showMerged === true,
          range: args.startRev && args.endRev
            ? { start: Math.floor(args.startRev), end: Math.floor(args.endRev) }
            : null,
        }, SVN_LOG_SHOW_ALL_CAP)
        return { ok: true as const, ...result, target: rel }
      } catch (error) {
        return { ok: false as const, error: '读取日志失败：' + String(error) }
      }
    },
    'svn.diffRev': async (args: { sessionId?: string; path?: string; revision?: number }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      const revision = Number(args.revision)
      if (!Number.isFinite(revision) || revision < 1) return { ok: false as const, error: '版本号不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        const result = await diffRevSides(status.wcRoot, rel, Math.floor(revision))
        return { ok: true as const, ...result, ...guardSides(result.left, result.right) }
      } catch (error) {
        return { ok: false as const, error: '读取版本差异失败：' + String(error) }
      }
    },
    'svn.diffPair': async (args: { sessionId?: string; path?: string; revA?: number; revB?: number }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      const revA = Number(args.revA)
      const revB = Number(args.revB)
      if (!Number.isFinite(revA) || revA < 1 || !Number.isFinite(revB) || revB < 1) {
        return { ok: false as const, error: '版本号不合法' }
      }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        const result = await pairSides(status.wcRoot, rel, Math.floor(revA), Math.floor(revB))
        return { ok: true as const, ...result, ...guardSides(result.left, result.right) }
      } catch (error) {
        return { ok: false as const, error: '读取版本差异失败：' + String(error) }
      }
    },
    'svn.diffWorking': async (args: { sessionId?: string; path?: string; revision?: number }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      const revision = Number(args.revision)
      if (!Number.isFinite(revision) || revision < 1) return { ok: false as const, error: '版本号不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      const fs = ctx.get('fs') as {
        resolve?: (p: string, o: object) => Promise<unknown>
        stat?: (t: unknown) => Promise<{ type?: string; size?: number } | null>
        readText?: (t: unknown) => Promise<string>
      } | null | undefined
      if (!fs?.resolve || !fs?.stat || !fs?.readText) return { ok: false as const, error: '缺少 fs' }
      try {
        const resolved = await fs.resolve(rel, { cwd: sc.cwd })
        const info = await fs.stat(resolved)
        if (!info || info.type !== 'file') return { ok: false as const, error: '文件不存在' }
        if ((info.size ?? 0) > READ_CAP) return { ok: false as const, error: '文件过大（>8MB），不支持与工作副本比较' }
        const working = await fs.readText(resolved)
        // 左侧 = 该版本内容；cat 失败按「该版本尚无此文件」处理（新增语义，非错误）
        const leftOutcome = await runSvn(status.wcRoot, ['cat', '-r', String(Math.floor(revision)), '--', rel], READ_GRACE_MS)
        if (leftOutcome.code !== 0) {
          const text = (leftOutcome.stderr || leftOutcome.stdout).trim()
          return { ok: true as const, left: null, right: working, reason: 'not-exist', error: tailOfText(text), ...guardSides(null, working) }
        }
        return { ok: true as const, left: leftOutcome.stdout, right: working, ...guardSides(leftOutcome.stdout, working) }
      } catch (error) {
        return { ok: false as const, error: '读取工作副本差异失败：' + String(error) }
      }
    },
    'svn.patchText': async (args: { sessionId?: string; path?: string; whitespace?: 'none' | 'b' | 'w'; ignoreEol?: boolean; unified?: number }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        // W2-1：`-x` 单值承载全部扩展选项（-b/-w/--ignore-eol-style/--unified=N，patchExtOf 组合）
        const ext = patchExtOf({ whitespace: args.whitespace, ignoreEol: args.ignoreEol === true, unified: args.unified })
        const argv = ['diff', ...(ext ? ['-x', ext] : []), '--', rel]
        const outcome = await runSvn(status.wcRoot, argv, READ_GRACE_MS, PATCH_OUTPUT_CAP)
        if (outcome.code !== 0) {
          return { ok: false as const, error: '生成补丁失败：' + tailOfText([outcome.stderr, outcome.stdout].filter(Boolean).join('\n')) }
        }
        const text = outcome.stdout
        // 截断判定（PROGRESS §六.1）：收集器超限保留尾部 → 头部丢失；补丁恒以 Index:/Property changes on: 开头
        const head = text.slice(0, 200)
        const truncated = !head.startsWith('Index:') && !head.startsWith('Property changes on:')
        // M4 实测：svn diff 对二进制只输出 "Cannot display" 通知（几百字节），如实标记给客户端
        return { ok: true as const, text, truncated, binary: text.includes('Cannot display:') }
      } catch (error) {
        return { ok: false as const, error: '生成补丁失败：' + String(error) }
      }
    },
    'svn.diffSum': async (args: { sessionId?: string; path?: string; revA?: number; revB?: number }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null) return { ok: false as const, error: '路径不合法' }
      const revA = Number(args.revA)
      const revB = Number(args.revB)
      if (!Number.isFinite(revA) || revA < 1 || !Number.isFinite(revB) || revB < 1) {
        return { ok: false as const, error: '版本号不合法' }
      }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        // W2-2：M5 实测 —— summarize 输出的 path 是绝对路径，parseSummarizeXml 内归一为相对
        const argv = ['diff', '--summarize', '--xml', '-r', String(Math.floor(revA)) + ':' + String(Math.floor(revB))]
        if (rel) argv.push('--', rel)
        const outcome = await runSvn(status.wcRoot, argv, SUM_GRACE_MS, SUM_OUTPUT_CAP)
        if (outcome.code !== 0) {
          return { ok: false as const, error: '目录对比失败：' + tailOfText([outcome.stderr, outcome.stdout].filter(Boolean).join('\n')) }
        }
        return { ok: true as const, ...parseSummarizeXml(outcome.stdout, status.wcRoot) }
      } catch (error) {
        return { ok: false as const, error: '目录对比失败：' + String(error) }
      }
    },
    'svn.remoteStatus': async (args: { sessionId?: string; path?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null) return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        // W2-3：M3 实测 —— 离线/无凭据会长时间挂起，REMOTE_GRACE_MS 短超时是硬约束
        const argv = ['status', '-u', '--xml']
        if (rel) argv.push('--', rel)
        const outcome = await runSvn(status.wcRoot, argv, REMOTE_GRACE_MS, SUM_OUTPUT_CAP)
        if (outcome.code !== 0) {
          return { ok: false as const, error: '远端检查失败：' + tailOfText([outcome.stderr, outcome.stdout].filter(Boolean).join('\n')) }
        }
        return { ok: true as const, ...parseRemoteStatusXml(outcome.stdout, status.wcRoot) }
      } catch (error) {
        return { ok: false as const, error: '远端检查失败：' + String(error) }
      }
    },
    'svn.conflictArtifacts': async (args: { sessionId?: string; path?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      try {
        // W2-4：纯本地 fs 只读扫描，不跑 svn、不触碰 resolve
        const artifacts = await conflictArtifactsOf(status.wcRoot, rel)
        return { ok: true as const, artifacts }
      } catch (error) {
        return { ok: false as const, error: '扫描冲突副本失败：' + String(error) }
      }
    },
    'svn.diffLocalPair': async (args: { sessionId?: string; left?: string; right?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      // W2-4：双侧均为本地文件（冲突副本对比）；safeRel 兜底防越界，与 diffBase 同一安全口径
      const left = safeRel(args.left)
      const right = safeRel(args.right)
      if (!left || !right) return { ok: false as const, error: '路径不合法（需工作副本内相对路径）' }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      const fs = ctx.get('fs') as {
        resolve?: (p: string, o: object) => Promise<unknown>
        stat?: (t: unknown) => Promise<{ type?: string; size?: number } | null>
        readText?: (t: unknown) => Promise<string>
      } | null | undefined
      if (!fs?.resolve || !fs?.stat || !fs?.readText) return { ok: false as const, error: '缺少 fs' }
      try {
        const sides: string[] = []
        for (const rel of [left, right]) {
          const resolved = await fs.resolve(rel, { cwd: sc.cwd })
          const info = await fs.stat(resolved)
          if (!info || info.type !== 'file') return { ok: false as const, error: '文件不存在：' + rel }
          if ((info.size ?? 0) > READ_CAP) return { ok: false as const, error: '文件过大（>8MB）：' + rel }
          sides.push(await fs.readText(resolved))
        }
        return { ok: true as const, left: sides[0], right: sides[1], ...guardSides(sides[0], sides[1]) }
      } catch (error) {
        return { ok: false as const, error: '读取冲突副本失败：' + String(error) }
      }
    },
    'svn.fileSizes': async (args: { sessionId?: string; paths?: string[] }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      // W2-5：配对候选是少数条目；上限护栏 + 单条失败按 null（未知）处理，不因个别路径失败整体报错
      const list = Array.isArray(args.paths) ? args.paths.slice(0, FILE_SIZES_CAP) : []
      if (!list.length) return { ok: true as const, sizes: [] }
      const fs = ctx.get('fs') as {
        resolve?: (p: string, o: object) => Promise<unknown>
        stat?: (t: unknown) => Promise<{ type?: string; size?: number } | null>
      } | null | undefined
      if (!fs?.resolve || !fs?.stat) return { ok: false as const, error: '缺少 fs' }
      const sizes: Array<{ path: string; size: number | null }> = []
      for (const raw of list) {
        const rel = safeRel(raw)
        if (rel === null || rel === '') { sizes.push({ path: String(raw ?? ''), size: null }); continue }
        try {
          const resolved = await fs.resolve(rel, { cwd: sc.cwd })
          const info = await fs.stat(resolved)
          sizes.push({ path: rel, size: info && info.type === 'file' ? (info.size ?? null) : null })
        } catch {
          sizes.push({ path: rel, size: null })
        }
      }
      return { ok: true as const, sizes }
    },
    'svn.wcRev': async (args: { sessionId?: string; path?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      // P1-9 口径：仅文件目标做版号加粗；根/目录返回 null，避免引入 crawl 成本（官方在独立线程做）
      const rel = safeRel(args.path)
      if (rel === null || rel === '') return { ok: true as const, revision: null }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      const outcome = await runSvn(status.wcRoot, ['info', '--xml', '--', rel], READ_GRACE_MS)
      if (outcome.code !== 0) return { ok: true as const, revision: null }
      return { ok: true as const, revision: parseSvnInfoRevision(outcome.stdout) }
    },
    'svn.cleanup': async (args: { sessionId?: string; removeUnversioned?: boolean; removeIgnored?: boolean }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const status = await statusOf(sc.cwd)
      if (!status.managed || !status.wcRoot) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      const argv = ['cleanup']
      // 破坏性选项由 client 强制 confirm 后才传入（默认清锁，不删文件）
      if (args.removeUnversioned === true) argv.push('--remove-unversioned')
      if (args.removeIgnored === true) argv.push('--remove-ignored')
      try {
        const outcome = await runSvn(status.wcRoot, argv, MUTATE_GRACE_MS)
        const result = batchResultOf(outcome.stdout, outcome.stderr, outcome.code, '清理')
        if (outcome.code !== 0) return { ok: false as const, error: '清理失败：' + tailOfText(result.output) }
        // 清理可能改动工作副本（删未版本控制文件）：作废变更缓存
        changesCache.delete(status.wcRoot)
        return { ok: true as const, ...result }
      } catch (error) {
        return { ok: false as const, error: '清理失败：' + String(error) }
      }
    },
    'svn.update': async (args: { sessionId?: string; path?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const rel = safeRel(args.path)
      if (rel === null) return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.svnCli) return { ok: false as const, error: 'svn 命令不可用（可在设置页配置 svn 路径）' }
      try {
        const outcome = await runSvn(sc.cwd, ['update', rel || '.'], UPDATE_GRACE_MS)
        const result = updateResultOf(outcome.stdout, outcome.stderr, outcome.code)
        if (outcome.code !== 0) return { ok: false as const, error: '更新失败：' + tailOfText(result.output) }
        return { ok: true as const, ...result }
      } catch (error) {
        return { ok: false as const, error: '更新失败：' + String(error) }
      }
    },
    'svn.tortoise': async (args: { sessionId?: string; action?: SvnAction; path?: string }) => {
      const sc = await requireSvnSession(ctx, args.sessionId)
      if ('err' in sc) return { ok: false as const, error: sc.err }
      const action = args.action
      if (action !== 'update' && action !== 'commit' && action !== 'log' && action !== 'diff' && action !== 'blame' && action !== 'revert') {
        return { ok: false as const, error: '未知动作: ' + String(action) }
      }
      const rel = safeRel(args.path)
      if (rel === null) return { ok: false as const, error: '路径不合法' }
      const status = await statusOf(sc.cwd)
      if (!status.managed) return { ok: false as const, error: '当前工作区不受 SVN 管理' }
      if (!status.tortoise) return { ok: false as const, error: 'TortoiseProc.exe 不可用（仅 Windows；可在设置页配置目录）' }
      const fs = ctx.get('fs') as { resolve?: (p: string, o: object) => Promise<unknown>; stat?: (t: unknown) => Promise<{ type?: string } | null>; processPath?: (t: unknown) => string } | null | undefined
      if (!fs?.resolve || !fs?.stat || !fs?.processPath) return { ok: false as const, error: '缺少 fs' }
      try {
        const target = await fs.resolve(rel || '.', { cwd: sc.cwd })
        const info = await fs.stat(target)
        if (!info) return { ok: false as const, error: '路径不存在' }
        const abs = fs.processPath(target)
        launchTortoise(status.tortoiseExe, action, abs)
        return { ok: true as const, launched: abs }
      } catch (error) {
        return { ok: false as const, error: '启动 TortoiseSVN 失败：' + String(error) }
      }
    },
  }
  return { handlers }
}

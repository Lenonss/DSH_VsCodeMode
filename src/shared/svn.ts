/**
 * dsh-vscode-mode shared — SVN 能力双面契约（类型/动作表/TortoiseProc argv/变更纯函数）。
 * 底座：svn CLI（跨平台）；TortoiseProc 对话框为 Windows 过渡增强（自研 UI 就绪后按能力标志隐藏）。
 * P2 增补：工作副本变更条目类型与显隐/徽标纯函数（`svn status --xml` 解析结果的消费口径）。
 * Purity rule: no node/react imports（对齐 rpc.ts/types.ts）。
 * 作者 ddj 2026年09月16号
 */

/** TortoiseSVN 过渡动作（P1 菜单/命令面；后续阶段由自研能力逐项替换）。 */
export type SvnAction = 'update' | 'commit' | 'log' | 'diff' | 'blame' | 'revert'

/** svn CLI 缺省可执行名（未配置 svnPath 时从 PATH 解析）。 */
export const SVN_CLI_DEFAULT = 'svn'

/** TortoiseSVN 缺省安装目录（Windows；对齐 SvnHelper 的 TortoiseSVN.path 默认值）。 */
export const TORTOISE_DIR_DEFAULT = 'C:\\Program Files\\TortoiseSVN'

/** TortoiseSVN 主程序名。 */
export const TORTOISE_EXE = 'TortoiseProc.exe'

/** SvnAction → TortoiseProc /command: 参数（全部同名，显式映射防拼写漂移）。 */
export function tortoiseCommandOf(action: SvnAction): string {
  const table: Record<SvnAction, string> = {
    update: 'update',
    commit: 'commit',
    log: 'log',
    diff: 'diff',
    blame: 'blame',
    revert: 'revert',
  }
  return table[action]
}

/**
 * TortoiseProc 启动 argv（纯函数）。
 * Windows CRT 引号规则：node 对含空格参数整体加引号，子进程 CommandLineToArgvW
 * 还原为单参数，TortoiseSVN 解析器取 `/path:` 后全串为路径——无 shell 注入面。
 * @author ddj 2026年09月16号
 * @param exe TortoiseProc.exe 绝对路径
 * @param action Tortoise 动作
 * @param absPath 目标绝对路径（文件/目录）
 * @returns argv 数组（无 shell 插值）
 */
export function tortoiseLaunchArgv(exe: string, action: SvnAction, absPath: string): string[] {
  return [exe, '/command:' + tortoiseCommandOf(action), '/path:' + absPath]
}

/** 自研 SVN 能力标志（用于「自研替换 Tortoise 项」的显隐推进）。 */
export type SvnFeature = 'diff' | 'revert' | 'log' | 'commit' | 'blame' | 'update'

/** SVN 能力状态（svn.status 载荷；client 显隐判定唯一数据源）。 */
export interface SvnStatusPayload {
  /** 工作区是否位于 SVN 工作副本内（cwd 向上找 .svn）。 */
  managed: boolean
  /** 工作副本根目录绝对路径（未受管理为 null）。 */
  wcRoot: string | null
  /** svn CLI 是否可用（`svn --version --quiet` 退出码 0）。 */
  svnCli: boolean
  /** TortoiseProc.exe 是否可用（仅 Windows 可能为 true）。 */
  tortoise: boolean
  /**
   * 已由**自研界面**提供等价能力的功能集合（能力标志）。
   *
   * 推进口径见 `plans/svn-integration/01-infra-visibility.md` 的「自研替换时间线」：
   * 自研能力上线后，对应 TortoiseProc 项自动隐藏（避免同名项并列、误点到官方弹窗）。
   * 缺省 `[]`（旧 payload/未探测时）→ 不隐藏任何 Tortoise 项，保持降级可用。
   */
  svnFeatures?: readonly SvnFeature[]
  /** 实际使用的 svn CLI（探测依据，诊断用）。 */
  svnPath: string
  /** 实际解析到的 TortoiseProc.exe（诊断用；不可用为空串）。 */
  tortoiseExe: string
}

/** update 结果行的动作（对齐 `svn help update` 的字母表）。 */
export type SvnUpdateAction = 'A' | 'U' | 'D' | 'G' | 'C' | 'E' | 'R'

/** 一条 update 条目（path 为 svn 输出的原始形态）。 */
export interface SvnUpdateEntry {
  /** 动作字母。 */
  action: SvnUpdateAction
  /** 目标路径（svn 原样输出）。 */
  path: string
  /** 中文说明（面板展示；未知字母回落为字母本身）。 */
  label: string
}

/** svn.update 结果（条目级 + 宽松解析；output 始终带原文兜底）。 */
export interface SvnUpdateResult {
  /** 一行摘要（状态栏展示）。 */
  summary: string
  /** 解析到的目标修订版号（解析失败缺省）。 */
  revision?: number
  /** 冲突文件清单（宽松解析，上限截断）。 */
  conflicts: string[]
  /** 条目级明细（update 无 --xml，由文本行解析；解析不出时为空数组）。 */
  entries: SvnUpdateEntry[]
  /** 原始输出（stdout+stderr 合并，诊断与兜底展示）。 */
  output: string
}

/** revert/add 等批量动作结果（计数 + 摘要 + 原文）。 */
export interface SvnActionResult {
  /** 处理条目数（宽松计数）。 */
  count: number
  /** 一行摘要（含失败原因兜底）。 */
  summary: string
  /** 原始输出。 */
  output: string
}

// --region P2 工作副本变更（svn status --xml 消费口径）

/**
 * 工作副本条目状态（svn status `item` 属性全集）。
 * 取值范围与 `svn help status` 的首列字母表一一对应；'normal'/'external' 仅在返回
 * 自身条目时出现（根条目、external 目录），不属于「变更」。
 */
export type SvnItemStatus =
  | 'normal' | 'added' | 'deleted' | 'replaced' | 'conflicted'
  | 'missing' | 'unversioned' | 'obstructed' | 'ignored' | 'modified'
  | 'external' | 'incomplete'

// --region P3 日志与更新结果

/** 日志条目里单个被改动的路径（对齐 `svn log -v` 的 `<path>` 节点）。 */
export interface SvnLogPath {
  /** 仓库绝对路径（`/trunk/sub/x.txt`；host 会额外提供映射后的工作区相对路径）。 */
  path: string
  /** 映射到工作区内的相对路径；仓库前缀之外（如分支/外部）为 null。 */
  relPath: string | null
  /** 动作字母：A 新增 / D 删除 / R 替换 / M 修改。 */
  action: 'A' | 'D' | 'R' | 'M'
  /** 条目类型（file / dir）。 */
  kind?: string
  /** 复制来源路径（`svn copy` 记录，仓库绝对路径）。 */
  copyFrom?: string
  /** 复制来源版本。 */
  copyFromRev?: number
  /** 属性改动（`prop-mods`）。 */
  propMods?: boolean
  /** 内容改动（`text-mods`）。 */
  textMods?: boolean
}

/** 一条提交日志（对齐 `svn log --xml -v` 的 `<logentry>`）。 */
export interface SvnLogEntry {
  /** 修订版号。 */
  revision: number
  /** 提交者（可能为空）。 */
  author: string
  /** 提交时间（ISO8601 原文）。 */
  date: string
  /** 提交信息（保留换行）。 */
  message: string
  /** 该版本的变更路径（`-v` 才有）。 */
  paths: SvnLogPath[]
  /**
   * 被合并进本版本的修订（P1-5，仅 `-g`/`--use-merge-history` 才有）。
   *
   * 实测（§6 M1，svn 1.14.5）：`-g` 时被合并的修订以**嵌套 `<logentry>`** 形式出现在父条目
   * `</msg>` 之后，同一父条目下可并列多个；嵌套条目的 `<paths>` 是**源分支路径**，
   * `mapRepoPath` 会判为仓库外（relPath=null）——UI 按「仓库外」展示，不得误映射。
   * 缺省 undefined = 未勾选 `-g` 或该修订无合并历史。
   */
  merged?: SvnLogEntry[]
  /**
   * 是否为反向合并（`reverse-merge="true"`；仅嵌套条目可能带，顶层从不带）。
   * 实测只采到 `reverse-merge="false"` 样本，故按「可能存在 true」处理。
   */
  reverseMerge?: boolean
}

/** 日志动作 → 中文说明。 */
export const SVN_LOG_ACTION_LABEL: Record<string, string> = {
  A: '新增',
  D: '删除',
  R: '替换',
  M: '修改',
}

/** 版本差异结果（左右两侧内容；左侧为 null 表示该版本尚无此文件）。 */
export interface SvnDiffRevResult {
  /** 左（revision-1）侧内容；新增文件/版本 1 时为 null。 */
  left: string | null
  /** 右（revision）侧内容。 */
  right: string | null
  /** left 缺失原因（'not-exist' = 该版本无此路径）。 */
  reason?: string
  /** 失败提示（诊断用）。 */
  error?: string
  /** W2-6 护栏：内容含 NUL 字节（二进制嫌疑），客户端不渲染编辑器。 */
  binary?: boolean
  /** W2-6 护栏：嗅探窗含 U+FFFD（可能非 UTF-8），客户端提示乱码风险。 */
  encodingHint?: boolean
}

// --endregion

/** 一条工作副本变更（path 相对工作副本根、`/` 分隔；host 已归一）。 */
export interface SvnChangeEntry {
  /** 工作区/工作副本相对路径（`/` 分隔，无前导 `./`）。 */
  path: string
  /** 条目状态。 */
  status: SvnItemStatus
  /** 属性（svn:*) 修改状态：'modified'/'conflicted' 时非空（展示用）。 */
  props?: 'none' | 'modified' | 'conflicted'
  /** 所属 changelist 名（未分组为空）。 */
  changelist?: string
  /** 是否受版本控制（unversioned/ignored 为 false）。 */
  versioned: boolean
  /** 工作副本修订版号（`-1` = 新增未提交，展示时忽略）。 */
  revision?: number
}

/** 条目状态 → 展示字母（对齐 `svn status` 首列，VSCode 扩展同口径）。 */
export const SVN_STATUS_LETTER: Record<SvnItemStatus, string> = {
  normal: ' ',
  added: 'A',
  deleted: 'D',
  replaced: 'R',
  conflicted: 'C',
  missing: '!',
  unversioned: '?',
  obstructed: '~',
  ignored: 'I',
  modified: 'M',
  external: 'X',
  incomplete: '!',
}

/** 条目状态 → 中文说明（徽标 tooltip / 面板行 tooltip）。 */
export const SVN_STATUS_LABEL: Record<SvnItemStatus, string> = {
  normal: '未修改',
  added: '已添加（待提交）',
  deleted: '已删除（待提交）',
  replaced: '已替换',
  conflicted: '冲突',
  missing: '缺失（已被外部删除）',
  unversioned: '未纳入版本控制',
  obstructed: '类型冲突（被同名的其他类型占用）',
  ignored: '已被忽略',
  modified: '已修改',
  external: '外部定义',
  incomplete: '不完整（需 cleanup）',
}

/**
 * 条目状态 → 颜色分级（对齐 TortoiseSVN「Check for Modifications」配色口径：
 * 本地修改=蓝、新增=紫、删除/缺失=暗红、冲突=亮红、未版本控制/忽略=中性）。
 */
export type SvnStatusTone = 'modified' | 'added' | 'deleted' | 'conflict' | 'plain'

/** 条目状态 → 颜色分级。 */
export const SVN_STATUS_TONE: Record<SvnItemStatus, SvnStatusTone> = {
  normal: 'plain',
  added: 'added',
  deleted: 'deleted',
  replaced: 'added',
  conflicted: 'conflict',
  missing: 'deleted',
  unversioned: 'plain',
  obstructed: 'conflict',
  ignored: 'plain',
  modified: 'modified',
  external: 'plain',
  incomplete: 'deleted',
}

/**
 * 是否属于「工作副本变更」（`normal`/`external` 不算；`ignored` 由开关决定是否收录）。
 * @author ddj 2026年09月16号
 * @param entry 变更条目
 * @returns 是否计入变更清单
 */
export function isSvnChange(entry: SvnChangeEntry): boolean {
  if (entry.status === 'normal' || entry.status === 'external') return false
  if (entry.status === 'ignored') return false
  return true
}

/** 面板「显示」开关（未版本控制/忽略项默认关掉忽略项、保留未版本控制）。 */
export interface SvnChangeFilter {
  /** 是否显示未纳入版本控制的条目（默认 true）。 */
  unversioned?: boolean
  /** 是否显示已被忽略的条目（默认 false）。 */
  ignored?: boolean
  /**
   * 名称过滤串（W1-2，纯前端）：`*`/`?` 通配或子串包含，忽略大小写；空/空白 = 不过滤。
   * 只影响列表展示；「全部加入/全部还原」等批量动作仍按未过滤集合计算（防误伤）。
   */
  name?: string
}

/**
 * 路径名称过滤匹配（W1-2）：`*` 任意串、`?` 单字符（忽略大小写）；
 * 无通配符时回落子串包含。非法正则元字符已转义，永不抛错。
 * @author ddj 2026年09月20号
 * @param path 条目路径（`/` 分隔）
 * @param pattern 过滤串（空/空白 = 不过滤）
 * @returns 是否命中
 */
export function changeNameMatch(path: string, pattern: string | undefined): boolean {
  const query = String(pattern ?? '').trim().toLowerCase()
  if (!query) return true
  const target = String(path ?? '').toLowerCase()
  if (!query.includes('*') && !query.includes('?')) return target.includes(query)
  const source = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
  return new RegExp('^' + source + '$').test(target)
}

/**
 * 按开关过滤变更清单（过滤规则唯一出口，面板/徽标共用，避免两处漂移）。
 * @author ddj 2026年09月16号
 * @param entries 变更清单（host 已按 `--no-ignore` 取全集）
 * @param filter 显示开关
 * @returns 过滤后的清单（保持原顺序）
 */
export function svnVisibleChanges(
  entries: readonly SvnChangeEntry[],
  filter: SvnChangeFilter = {},
): SvnChangeEntry[] {
  const showUnversioned = filter.unversioned !== false
  const showIgnored = filter.ignored === true
  return entries.filter((entry) => {
    if (!changeNameMatch(entry.path, filter.name)) return false
    if (entry.status === 'ignored') return showIgnored
    if (entry.status === 'unversioned') return showUnversioned
    return isSvnChange(entry)
  })
}

/**
 * 条目 → 文件树行尾徽标字母（无可展示徽标返回空串）。
 * 与 svnVisibleChanges 同口径：未版本控制/忽略项由开关决定，故此处直接按状态给出字母，
 * 由调用方决定是否已过滤。
 * @author ddj 2026年09月16号
 * @param entry 变更条目
 * @returns 单字母徽标；`normal`/`external` 返回空串
 */
export function svnBadgeOf(entry: SvnChangeEntry): string {
  if (entry.status === 'normal' || entry.status === 'external') return ''
  return SVN_STATUS_LETTER[entry.status]
}

/**
 * 条目 → 徽标/行 tooltip 文案（`M 已修改` 形式）。
 * @author ddj 2026年09月16号
 * @param entry 变更条目
 * @returns 展示文案；无徽标时返回空串
 */
export function svnBadgeTitle(entry: SvnChangeEntry): string {
  const letter = svnBadgeOf(entry)
  if (!letter) return ''
  return letter + ' ' + SVN_STATUS_LABEL[entry.status]
}

// --endregion

// --region P2 动作文案与判定

/** 与基线比较（`svn cat -r BASE` 差异视图）。 */
export const SVN_DIFF_BASE_LABEL = '与基线比较'
/** 加入版本控制（`svn add`）。 */
export const SVN_ADD_LABEL = '加入版本控制'
/** 还原（`svn revert -R`；CLI 全平台，区别于 TortoiseSVN 还原）。 */
export const SVN_REVERT_LABEL = 'SVN 还原'
/** 刷新变更（强制重查 `svn status --xml`）。 */
export const SVN_REFRESH_LABEL = '刷新变更'

/** 基线差异可打开的路径判据（需为可读文本文件；二进制/图片/PDF 不支持）。 */
const SVN_BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'pdf', 'zip', 'gz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'class', 'jar', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4',
])

/**
 * 是否可打开基线差异（受版本控制 + 非二进制扩展名）。
 * `added`/`unversioned` 无 BASE 内容，但 `added` 仍允许调用（host 会返回 no-pristine 原因）。
 * @author ddj 2026年09月16号
 * @param path 目标路径
 * @param status 该条目的状态（缺省表示「不在变更清单里」，按受版本控制的已修改处理）
 * @returns 是否可打开基线差异
 */
export function isSvnDiffable(path: string, status?: SvnItemStatus): boolean {
  if (status === 'unversioned' || status === 'ignored') return false
  const base = String(path ?? '').split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return true
  return !SVN_BINARY_EXT.has(base.slice(dot + 1).toLowerCase())
}

/** 菜单/页签共用的动作文案（避免 client 侧两处漂移）。 */
export const SVN_UPDATE_LABEL = 'SVN 更新'

/** Tortoise 菜单文案表（按动作）。 */
export const SVN_TORTOISE_LABELS: Record<SvnAction, string> = {
  update: 'TortoiseSVN 更新',
  commit: 'TortoiseSVN 提交',
  log: 'TortoiseSVN 日志',
  diff: 'TortoiseSVN 差异',
  blame: 'TortoiseSVN 追溯',
  revert: 'TortoiseSVN 还原',
}

// --region W2 差异管理补全（护栏/目录对比/远端检查/冲突/配对）

/** W2-6 内容护栏嗅探窗（字符数；NUL/U+FFFD 只看前 8K，全量扫描大文本得不偿失）。 */
export const GUARD_SNIFF_CHARS = 8 * 1024

/** W2-6 内容级护栏标记（host 嗅探 → client 提示）。 */
export interface SvnContentGuard {
  /** 嗅探窗含 NUL 字节（二进制嫌疑；M4 实测 svn cat 对二进制原样透传字节）。 */
  binary?: boolean
  /** 嗅探窗含 U+FFFD（UTF-8 解码失败替换符；可能非 UTF-8 编码）。 */
  encodingHint?: boolean
}

/**
 * 文本级内容护栏（W2-6，纯函数）：对喂给差异视图/补丁的文本做低成本嗅探。
 * 二进制锚点取 NUL 字节（比 svn:mime-type 更兜底——mime 缺省的「伪文本」二进制也拦得住）；
 * 编码提示取 U+FFFD（host fs.readText 按 UTF-8 解码，无效序列会变成替换符）。
 * @author ddj 2026年09月20号
 * @param text 待嗅探文本（null/undefined 按空处理）
 * @returns 护栏标记（干净内容返回空对象）
 */
export function contentGuardOf(text: string | null | undefined): SvnContentGuard {
  if (typeof text !== 'string' || !text) return {}
  const window = text.slice(0, GUARD_SNIFF_CHARS)
  if (window.includes('\u0000')) return { binary: true }
  if (window.includes('\uFFFD')) return { encodingHint: true }
  return {}
}

/** W2-5 一对「疑似改名」配对（missing `!` ↔ unversioned `?`）。 */
export interface SvnRenamePair {
  /** 原路径（missing 条目）。 */
  missingPath: string
  /** 新路径（unversioned 条目）。 */
  unversionedPath: string
}

/** 取路径 basename（`/`/`\` 通用；纯函数）。 */
function baseNameOf(path: string): string {
  return String(path ?? '').split(/[\\/]/).pop() ?? ''
}

/**
 * 疑似改名配对（W2-5，纯函数；M2 定论：status XML 无 copyfrom，只能客户端启发式）。
 * 配对条件从严：basename 相同 **且** 双侧 size 均已知且相等（size 缺失不配对，防误报）。
 * @author ddj 2026年09月20号
 * @param entries 变更清单
 * @param sizes 路径 → 字节大小（未知为 null/缺失）
 * @returns 配对数组（每个 missing 至多配一个，先到先得保持输入顺序）
 */
export function pairMissingWithUnversioned(
  entries: readonly SvnChangeEntry[],
  sizes: Record<string, number | null>,
): SvnRenamePair[] {
  const unversioned = entries.filter((entry) => entry.status === 'unversioned')
  const pairs: SvnRenamePair[] = []
  for (const missing of entries) {
    if (missing.status !== 'missing') continue
    const name = baseNameOf(missing.path)
    for (const candidate of unversioned) {
      if (baseNameOf(candidate.path) !== name) continue
      const a = sizes[missing.path]
      const b = sizes[candidate.path]
      if (typeof a !== 'number' || typeof b !== 'number' || a !== b) continue
      pairs.push({ missingPath: missing.path, unversionedPath: candidate.path })
      break
    }
  }
  return pairs
}

/** W2-2 目录对比单条（`svn diff --summarize --xml` 的 `<path>`；M5 实测形态）。 */
export interface SvnSumEntry {
  /** 工作副本相对路径（host 已从绝对路径归一）。 */
  path: string
  /** 变更动作（svn 词汇：added/deleted/replaced/modified/normal/none）。 */
  item: string
  /** 节点类型（file/dir；异常输出回 'none'）。 */
  kind: string
  /** 属性变更（none/modified）。 */
  props: string
}

/** W2-3 远端落后条目（`svn status -u --xml` 的 repos-status；M3 实测形态）。 */
export interface SvnRemoteOutdatedEntry {
  /** 工作副本相对路径。 */
  path: string
  /** 远端状态（实测落后文件为 modified；'none' = 远端无变化）。 */
  item: string
}

/** W2-2 summarize 动作 → 展示字母（对齐 svn status 首列字母；normal/none 不出徽标）。 */
export const SVN_SUM_LETTER: Record<string, string> = {
  added: 'A',
  deleted: 'D',
  replaced: 'R',
  modified: 'M',
  normal: ' ',
  none: ' ',
  'props-deleted': ' ',
  'props-modified': ' ',
}

/** W2-4 冲突副本文件（`.mine`/`.working`/`.rN`）。 */
export interface SvnConflictArtifact {
  /** 工作副本相对路径。 */
  path: string
  /** 文件名（含冲突后缀）。 */
  name: string
  /** 种类：mine = 我的（.mine）/ working = 基础工作版（.working）/ rev = 仓库版本（.rN）。 */
  kind: 'mine' | 'working' | 'rev'
  /** rev 种类时的修订号。 */
  rev?: number
}

// --endregion

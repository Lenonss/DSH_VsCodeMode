/**
 * dsh-vscode-mode client — 官方 shortcuts 服务桥接层。
 * 职责四件：① 运行时探测 ctx.shortcuts（可选服务，有界重试，不进 inject——旧版 DSH 无此服务
 * 时不阻断装配）；② safeRegister 逐命令注册（官方 register 对重复 id/保留默认/组合重叠抛错，
 * 冲突时去掉默认键位降级注册，绝不阻断插件加载）；③ 官方命令定义构建（commandCatalog → 官方
 * command，resolve 统一走插件注册表 run，可用性为假返回 pass 不吞键）；④ 旧 keybindings
 * 设置一次性迁移进官方存储。
 * 作者 ddj 2026年10月
 */
import { bindingToChord, chordToBinding, defaultKeybindings, normalizeKeybindings } from '../shared/keybindings.js'
import { applyKeyAria, matchEvent, parseChords } from './keybindings.js'
import type { OfficialBinding, ShortcutProfileKey } from '../shared/keybindings.js'
import { log } from './log.js'

const bridgeLog = log.child('shortcuts-official')

/** 迁移比对用的默认键位表副本（模块态，避免每次调用重建）。 */
const KEYBINDING_DEFAULTS_OF: Record<string, string> = defaultKeybindings()

//#region 官方服务鸭子类型（结构对齐 @deepseek-ai/dsh-client-shortcuts，不 import 官方包）

/** 快照存储（createSnapshotStore 形状）。 */
export interface SnapshotStoreLike<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

/** 官方目录行（catalog 快照项）。 */
export interface ShortcutCatalogRow {
  id: string
  label: string
  binding: OfficialBinding | null
  modified: boolean
  issue: string | null
  conflicts: string[]
  keys: string[]
  aria?: string
}

/** 官方配置快照。 */
export interface ShortcutConfigSnapshot {
  revision: string
  sequence: number
  status: 'loading' | 'ready' | 'unreadable'
  error: string | null
  usingDefaults: boolean
}

/** 官方派发上下文。 */
export interface ShortcutInvokeContext {
  region: string
  modal: string | null
  target?: unknown
  source?: string
}

/** 官方 resolve 结果。 */
export type ShortcutResolution =
  | { status: 'handled'; run: () => void }
  | { status: 'pass' }
  | { status: 'blocked'; reason?: string }

/** 官方可编辑命令定义（register 入参）。 */
export interface ShortcutCommandLike {
  id: string
  label: () => string
  aliases?: string[]
  defaults?: Partial<Record<ShortcutProfileKey, OfficialBinding>>
  regions: string[]
  modals: string[]
  resolve: (context: ShortcutInvokeContext) => ShortcutResolution
}

/** 官方偏好编辑操作。 */
export type ShortcutEditLike =
  | { type: 'set'; id: string; binding: OfficialBinding }
  | { type: 'reset'; id: string }
  | { type: 'reset-all' }

/** 官方 shortcuts 服务（ShortcutsService 结构子集，鸭子类型）。 */
export interface ShortcutsServiceLike {
  register(command: ShortcutCommandLike): () => void
  describeBinding(binding: OfficialBinding | null): { binding: OfficialBinding | null; keys: string[]; issue: string | null; conflicts: string[] }
  edit(edit: ShortcutEditLike, revision: string): Promise<{ status: string; issue?: string | null; conflicts?: string[] }>
  recording(active: boolean): Promise<void>
  catalog: SnapshotStoreLike<ShortcutCatalogRow[]>
  config: SnapshotStoreLike<ShortcutConfigSnapshot>
  fixedCatalog: SnapshotStoreLike<unknown[]>
  platform: string
  runtime: string
  /** ShortcutRegistry 实例（菜单路径 invoke；用于程序化打开官方弹窗）。 */
  registry?: { invoke(id: string, context: ShortcutInvokeContext): unknown }
}

//#endregion

/** 探测节奏（与插件其他可选服务探测一致：15 次 × 2s）。 */
export interface ProbeOptions {
  schedule: (fn: () => void, ms: number) => void
  attempts?: number
  intervalMs?: number
}

/** 结构探测：get('shortcuts') 命中且具备核心能力才算服务就绪（设置组件运行时自愈探测复用）。 */
export function detectShortcuts(ctx: { get: (name: string) => unknown }): ShortcutsServiceLike | null {
  try {
    const service = ctx.get('shortcuts') as ShortcutsServiceLike | undefined
    if (service && typeof service.register === 'function' && typeof service.edit === 'function' && service.catalog && service.config) return service
  } catch {
    /* 服务缺失/构造失败按未命中处理 */
  }
  return null
}

/**
 * 探测官方 shortcuts 服务：立即探测一次，未命中按节奏有界重试；命中或用尽均回调一次。
 * @author ddj 2026年10月
 * @param ctx 客户端上下文
 * @param options schedule/重试节奏 + onReady 回调
 * @returns 取消探测的注销函数
 */
export function awaitShortcutsService(ctx: { get: (name: string) => unknown }, options: ProbeOptions & { onReady: (service: ShortcutsServiceLike | null) => void }): () => void {
  const maxAttempts = options.attempts ?? 15
  const interval = options.intervalMs ?? 2000
  let attempts = 0
  let settled = false
  const tick = (): void => {
    if (settled) return
    const service = detectShortcuts(ctx)
    if (service !== null) {
      settled = true
      options.onReady(service)
      return
    }
    if (attempts >= maxAttempts) {
      settled = true
      options.onReady(null)
      return
    }
    attempts += 1
    options.schedule(tick, interval)
  }
  tick()
  return () => {
    settled = true
  }
}

/**
 * 逐命令安全注册：官方 register 抛错（重复 id/保留默认/组合重叠）时去掉默认键位重试一次，
 * 保证命令仍进官方目录（可被用户手动绑定），注册路径绝不抛错、绝不阻断装配。
 * @author ddj 2026年10月
 * @param service 官方服务
 * @param command 官方命令定义
 * @returns 注销函数（注册失败返回空操作）
 */
export function safeRegister(service: ShortcutsServiceLike, command: ShortcutCommandLike): () => void {
  try {
    return service.register(command)
  } catch (error) {
    if (!command.defaults || Object.keys(command.defaults).length === 0) {
      bridgeLog.warn('官方快捷键注册失败（' + command.id + '）：' + String(error))
      return () => {}
    }
    bridgeLog.warn('官方快捷键默认键位被拒（' + command.id + '），降级为未绑定：' + String(error))
    try {
      return service.register({ ...command, defaults: {} })
    } catch (retryError) {
      bridgeLog.warn('官方快捷键注册失败（' + command.id + '）：' + String(retryError))
      return () => {}
    }
  }
}

/** 插件指令注册表执行子集（commandRegistry 形状）。 */
export interface CommandRunner {
  isAvailable(id: string): boolean
  run(id: string): boolean
}

/**
 * 官方服务未就绪时复用旧版窗口键位语义；服务出现后注销，避免双执行。
 * @author ddj 2026年09月28号
 * @param defs 按目录序排列的插件命令
 * @param runner 指令注册表
 * @param chords 当前旧设置键位获取函数
 * @param target 键盘事件目标（缺省 window，测试可注入）
 * @returns 注销监听的函数
 */
export function installLegacyKeys(
  defs: ReadonlyArray<{ id: string }>, runner: CommandRunner, chords: () => Record<string, string>,
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null = typeof window === 'undefined' ? null : window,
): () => void {
  if (!target) return () => {}
  const cache = new Map<string, ReturnType<typeof parseChords>>()
  let disposed = false
  const onKey = (event: Event): void => {
    if (disposed) return
    const key = event as KeyboardEvent
    const current = chords()
    for (const def of defs) {
      const chord = current[def.id]
      if (!chord) continue
      let bindings = cache.get(chord)
      if (!bindings) {
        bindings = parseChords(chord)
        cache.set(chord, bindings)
      }
      if (!matchEvent(key, bindings) || !runner.isAvailable(def.id)) continue
      key.preventDefault()
      key.stopPropagation()
      runner.run(def.id)
      return
    }
  }
  target.addEventListener('keydown', onKey, { capture: true })
  return () => {
    if (disposed) return
    disposed = true
    target.removeEventListener('keydown', onKey, { capture: true })
  }
}

/**
 * 插件命令定义 → 官方命令定义：默认键位取 SHORTCUT_PROFILES（缺省 = 不绑定）；
 * resolve 可用性为假返回 pass（不吞键，与旧桥「不可用不执行也不吞键」语义一致），
 * 执行统一走注册表 run（自带可用性复核与异常捕获）。
 * @author ddj 2026年10月
 * @param def 插件命令定义
 * @param runner 插件指令注册表
 * @returns 官方命令定义
 */
export function officialCommandOf(def: { id: string; label: string }, runner: CommandRunner): ShortcutCommandLike {
  return {
    id: def.id,
    label: () => def.label,
    // 必须为数组：官方弹窗渲染排名列表时 `...row.aliases` 直接展开，undefined 会让弹窗崩溃
    aliases: [],
    defaults: undefined,
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => {
      if (!runner.isAvailable(def.id)) return { status: 'pass' }
      return {
        status: 'handled',
        run: () => {
          runner.run(def.id)
        },
      }
    },
  }
}

/**
 * 注册全部命令进官方服务（逐命令 safeRegister 隔离，defaults 由调用方按 id 注入 SHORTCUT_PROFILES）。
 * @author ddj 2026年10月
 * @param service 官方服务
 * @param defs 插件命令定义（id/label）
 * @param runner 插件指令注册表
 * @param profiles id → 官方 profile 默认键位
 * @returns 聚合注销函数
 */
export function registerOfficialShortcuts(
  service: ShortcutsServiceLike,
  defs: ReadonlyArray<{ id: string; label: string }>,
  runner: CommandRunner,
  profiles: Readonly<Record<string, Partial<Record<ShortcutProfileKey, OfficialBinding>>>>,
): () => void {
  const disposers: Array<() => void> = []
  for (const def of defs) {
    const command = officialCommandOf(def, runner)
    command.defaults = profiles[def.id] ?? {}
    disposers.push(safeRegister(service, command))
  }
  return () => {
    while (disposers.length) disposers.pop()?.()
  }
}

/**
 * 订阅官方目录 → 重建 edrv.* 弦表（chordOf 数据源）；目录变化即通知。
 * 只收录 issue 为空的行（conflict 行保留——用户显式改键后 tooltip 仍显示其选择，
 * 冲突状态由设置页徽标呈现）。
 * @author ddj 2026年10月
 * @param service 官方服务
 * @param onChange 弦表回调（每次全量替换）
 * @returns 注销函数
 */
export function bindCatalogChords(service: ShortcutsServiceLike, onChange: (chords: Readonly<Record<string, string>>) => void): () => void {
  const sync = (): void => {
    const chords: Record<string, string> = {}
    const aria: Record<string, string | undefined> = {}
    try {
      for (const row of service.catalog.getSnapshot()) {
        if (!row.id.startsWith('edrv.') || row.binding === null) continue
        if (row.issue !== null) continue
        const chord = row.keys.length ? row.keys.join(' ') : bindingToChord(row.binding)
        if (chord !== null) chords[row.id] = chord
        aria[row.id] = row.aria
      }
    } catch (error) {
      bridgeLog.warn('官方目录弦表重建失败：' + String(error))
    }
    applyKeyAria(aria)
    onChange(chords)
  }
  sync()
  return service.catalog.subscribe(sync)
}

/**
 * 唤起官方快捷键弹窗（VSCodeMode 通用页的跳转入口用；插件不再自建录键界面）。
 * 官方入口不可用（旧版 DSH / registry 缺失）或唤起失败时返回可读说明，
 * 供设置页原样展示：不抛错、不阻断设置渲染。
 * @author ddj 2026年09月28号
 * @param service 官方 shortcuts 服务（可为 null：运行时探测未就绪）
 * @returns 空串 = 已成功唤起；否则为给用户看的失败说明
 */
export function openOfficialShortcuts(service: ShortcutsServiceLike | null): string {
  const manual = '可按 Ctrl+/ 或到 DSH 设置 → 通用 → 快捷键 打开'
  if (!service || !service.registry || typeof service.registry.invoke !== 'function') {
    return '官方快捷键弹窗入口不可用（当前 DSH 版本或外壳未提供）：' + manual
  }
  try {
    service.registry.invoke('shortcuts.open', {
      region: 'page',
      modal: null,
      target: typeof document === 'undefined' ? null : document.activeElement,
    })
    return ''
  } catch (error) {
    bridgeLog.warn('打开官方快捷键弹窗失败：' + String(error))
    return '打开官方快捷键弹窗失败：' + String(error) + '；' + manual
  }
}

//#region 旧设置迁移

/** 旧设置 scope 最小形状（compat settingsBridge 绑定产物的最小面，结构与 SettingsScopeLike 兼容）。 */
export interface LegacySettingsScope {
  getSnapshot(): { status?: string; value?: { keybindings?: unknown } }
}

/** 迁移结果：done=true 表示无需/已完成迁移（含「无差异」），false 表示中止待重试。 */
export interface MigrationResult {
  imported: number
  skipped: number
  done: boolean
}

/**
 * 官方 edit 单次写入；stale 表示其他窗口已更新，不自动用新 revision 重放。
 * @author ddj 2026年09月28号
 * @param service 官方快捷键服务
 * @param edit 本次操作
 * @returns 是否保存成功
 */
async function editOnce(service: ShortcutsServiceLike, edit: ShortcutEditLike): Promise<boolean> {
  try {
    const result = await service.edit(edit, service.config.getSnapshot().revision)
    if (result.status === 'saved') return true
    bridgeLog.warn('官方快捷键写入未成功（' + edit.type + (edit.type === 'set' ? ' ' + edit.id : '') + '）：' + result.status)
  } catch (error) {
    bridgeLog.warn('官方快捷键写入异常（' + edit.type + '）：' + String(error))
  }
  return false
}

/**
 * 逐条恢复插件自定义键位；官方 reset-all 会清空所有产品命令的覆盖，不能使用。
 * @author ddj 2026年09月28号
 * @param service 官方快捷键服务
 * @returns 完成数量及首个失败命令（有失败时）
 */
export async function resetPluginKeys(service: ShortcutsServiceLike): Promise<{ reset: number; failed?: string }> {
  const ids = service.catalog.getSnapshot()
    .filter((row) => row.id.startsWith('edrv.') && row.modified)
    .map((row) => row.id)
  let reset = 0
  for (const id of ids) {
    if (!await editOnce(service, { type: 'reset', id })) return { reset, failed: id }
    reset += 1
  }
  return { reset }
}

const MIGRATION_KEY = 'dsh-vscode-mode.shortcuts-migrated.v1.'

/**
 * 当前快捷键运行平台的迁移标记键；不同 Web/Desktop 和操作系统分别处理。
 * @author ddj 2026年09月28号
 * @param service 官方快捷键服务
 * @returns 本机迁移标记键
 */
function migrationKey(service: ShortcutsServiceLike): string {
  return MIGRATION_KEY + service.runtime + '.' + service.platform
}

/**
 * 检查当前端是否已处理旧设置；存储不可用时继续按目录状态判定。
 * @author ddj 2026年09月28号
 * @param service 官方快捷键服务
 * @returns 是否已处理
 */
function hasMigrated(service: ShortcutsServiceLike): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(migrationKey(service)) === '1'
  } catch {
    return false
  }
}

/**
 * 标记当前端已处理；旧设置永不清空，供其他平台及人工恢复使用。
 * @author ddj 2026年09月28号
 * @param service 官方快捷键服务
 */
function markMigrated(service: ShortcutsServiceLike): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(migrationKey(service), '1')
  } catch {
    bridgeLog.warn('无法持久化旧快捷键迁移标记，本次配置仍保留')
  }
}

/**
 * 旧 keybindings 设置按当前 runtime/platform 一次性导入官方存储：
 * - 仅处理与 KEYBINDING_DEFAULTS 有差异的单候选键位；多候选、空键位、冲突或
 *   官方不可表示项不迁移，完整旧值仍保留（官方每条命令当前只允许一个绑定）；
 * - 官方已有自定义值时不覆盖，stale 冲突也不自动重放；
 * - 旧配置供其他平台及人工恢复使用，绝不清空；当前端成功处理后记录本地标记，
 *   防止重启后把已由用户重置的官方键位重新导入。
 * @author ddj 2026年10月
 * @param service 官方服务
 * @param scope 旧设置 scope（settings bridge 绑定产物）
 * @returns 迁移结果
 */
export async function migrateLegacyKeybindings(service: ShortcutsServiceLike, scope: LegacySettingsScope): Promise<MigrationResult> {
  const snapshot = scope.getSnapshot()
  if (snapshot.status !== 'ready') return { imported: 0, skipped: 0, done: false }
  if (service.config.getSnapshot().status !== 'ready') return { imported: 0, skipped: 0, done: false }
  if (hasMigrated(service)) return { imported: 0, skipped: 0, done: true }
  const stored = normalizeKeybindings(snapshot.value?.keybindings)
  const overrides = Object.entries(stored).filter(([id, chord]) => chord !== KEYBINDING_DEFAULTS_OF[id])
  if (overrides.length === 0) return { imported: 0, skipped: 0, done: true }
  let imported = 0
  let skipped = 0
  for (const [id, chord] of overrides) {
    if (!chord.trim() || chord.includes('|')) {
      skipped += 1
      bridgeLog.warn('迁移跳过（空键位或多候选，原值保留）：' + id)
      continue
    }
    const binding = chordToBinding(chord)
    if (binding === null) {
      skipped += 1
      bridgeLog.warn('迁移跳过（官方不可表示）：' + id + ' = ' + chord)
      continue
    }
    if (service.catalog.getSnapshot().some((row) => row.id === id && row.modified)) {
      skipped += 1
      bridgeLog.warn('迁移跳过（官方存储已有自定义值）：' + id)
      continue
    }
    let probe: { conflicts: string[]; issue: string | null }
    try {
      probe = service.describeBinding(binding)
    } catch (error) {
      bridgeLog.warn('迁移中止（describeBinding 异常）：' + String(error))
      return { imported, skipped, done: false }
    }
    if (probe.conflicts.length > 0 || probe.issue !== null) {
      skipped += 1
      bridgeLog.warn('迁移跳过（与官方键冲突/保留）：' + id + ' = ' + chord)
      continue
    }
    const saved = await editOnce(service, { type: 'set', id, binding })
    if (!saved) return { imported, skipped, done: false }
    imported += 1
  }
  markMigrated(service)
  bridgeLog.info('旧快捷键设置已处理（旧值保留）：导入 ' + imported + ' 条，跳过 ' + skipped + ' 条')
  return { imported, skipped, done: true }
}

//#endregion

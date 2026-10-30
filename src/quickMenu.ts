/**
 * dsh-vscode-mode host — 快捷菜单配置的读写（~/.dsh/dsh-vscode-mode/data/quick-menu.json）。
 *
 * 为什么单独成模块：菜单项是用户数据而不是界面镜像——不能落在 cache/（会被 sweep、
 * 且与 uiState 共享 512KB 预算），也不适合塞进 Config schema（嵌套 JSON 不参与校验）。
 * 写入约定：revision 乐观并发 + 同文件串行队列 + tmp 原子替换 + 单代 .bak 备份，
 * 解析失败时把原文件另存 .bad-<ts>.json 再回落默认文档，绝不让坏文件阻塞功能。
 * 作者 ddj 2026年10月30号
 */
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  defaultDoc,
  normalizeDoc,
  parseDoc,
  serializeDoc,
  QUICK_MENU_BYTES_CAP,
  QUICK_MENU_MAX_ITEMS,
} from './shared/quickMenu.js'
import type { QuickMenuDoc } from './shared/quickMenu.js'
import { quickMenuFile } from './paths.js'

/** 一次性读取结果。 */
export interface QuickMenuState {
  /** 合法文档（读到坏文件时为默认文档）。 */
  doc: QuickMenuDoc
  /** 读取告警（坏文件被备份并重置时给出）。 */
  warning?: string
  /** 文件最后修改时间毫秒（缺失为 0）。 */
  mtime: number
}

/** 写入结果（冲突时把磁盘上的最新文档带回，供客户端刷新）。 */
export type QuickMenuSaveResult =
  | { ok: true; doc: QuickMenuDoc }
  | { ok: false; error: string; doc?: QuickMenuDoc }

/** mtime 缓存（文件未变则复用解析结果，避免每次打开菜单都读盘）。 */
const stateCache = new Map<string, QuickMenuState>()

/** 同文件写队列尾（串行化并发写入；队列清空即移除条目，与 uiState 同套路）。 */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * 把写任务挂到该文件的队尾串行执行（前序失败不影响后续）。
 * @author ddj 2026年10月30号
 * @param file 目标文件绝对路径
 * @param run 实际写操作
 * @returns 本次写操作结果
 */
function chainWrite<T>(file: string, run: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.then(() => undefined, () => undefined)
  writeChains.set(file, tail)
  void tail.then(() => {
    if (writeChains.get(file) === tail) writeChains.delete(file)
  })
  return next
}

/**
 * 读取文件修改时间（缺失/不可读返回 0）。
 * @author ddj 2026年10月30号
 * @param file 文件路径
 * @returns mtime 毫秒
 */
async function mtimeOf(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 原子写文本（先写 .tmp 再改名，缺目录自动建；失败时尽量清掉临时文件）。
 * @author ddj 2026年10月30号
 * @param file 目标文件
 * @param text 文本
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = file + '.tmp'
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, file)
}

/**
 * 把坏文件另存为 .bad-<ts>.json（尽力而为，失败不影响主流程）。
 * @author ddj 2026年10月30号
 * @param file 源文件
 * @returns 备份路径（失败为 null）
 */
async function backupCorrupt(file: string): Promise<string | null> {
  const target = file + '.bad-' + Date.now() + '.json'
  try {
    await copyFile(file, target)
    return target
  } catch {
    return null
  }
}

/**
 * 把上一次内容写成单代备份（quick-menu.bak.json）。
 * @author ddj 2026年10月30号
 * @param file 源文件
 */
async function backupPrevious(file: string): Promise<void> {
  try {
    await copyFile(file, file.replace(/\.json$/, '') + '.bak.json')
  } catch {
    // 首次保存没有旧文件，忽略
  }
}

/**
 * 读盘并归一（绕过缓存；文件缺失按默认文档处理）。
 * @author ddj 2026年10月30号
 * @param file 文件路径
 * @returns 文档 + 告警 + mtime
 */
async function loadFile(file: string): Promise<QuickMenuState> {
  const mtime = await mtimeOf(file)
  if (mtime === 0) return { doc: defaultDoc(), mtime: 0 }
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { doc: defaultDoc(), warning: '快捷菜单配置读取失败（' + reason + '），已回落默认配置', mtime }
  }
  const parsed = parseDoc(text)
  if (!parsed.warning) return { doc: parsed.doc, mtime }
  // 坏文件：先备份原文件，再写回默认文档，避免每次打开都重复告警
  const backup = await backupCorrupt(file)
  const doc = parsed.doc
  try {
    await writeAtomic(file, serializeDoc(doc))
  } catch {
    // 只读环境/权限不足时保留告警即可，功能继续用内存默认文档
  }
  const hint = backup ? '已备份为 ' + backup : '备份失败'
  return { doc, warning: parsed.warning + '（' + hint + '）', mtime }
}

/**
 * 读取快捷菜单文档（mtime 未变时复用缓存）。
 * @author ddj 2026年10月30号
 * @param home DSH home（测试可注入）
 * @returns 文档 + 告警
 */
export async function readQuickMenu(home?: string): Promise<QuickMenuState> {
  const file = quickMenuFile(home)
  const mtime = await mtimeOf(file)
  const cached = stateCache.get(file)
  if (cached && cached.mtime === mtime) return cached
  const state = await loadFile(file)
  stateCache.set(file, state)
  return state
}

/**
 * 清空读取缓存（测试或外部改动后强制重读）。
 * @author ddj 2026年10月30号
 * @param home DSH home（缺省清全部）
 */
export function resetMenuCache(home?: string): void {
  if (home === undefined) stateCache.clear()
  else stateCache.delete(quickMenuFile(home))
}

/**
 * 校验待保存文档的硬性上限（超出即拒绝，避免静默截断用户数据）。
 * @author ddj 2026年10月30号
 * @param doc 待保存文档
 * @returns 错误文案（合法为 null）
 */
function checkLimits(doc: QuickMenuDoc): string | null {
  if (doc.items.length > QUICK_MENU_MAX_ITEMS) return '菜单项超过上限（' + QUICK_MENU_MAX_ITEMS + ' 项）'
  const bytes = Buffer.byteLength(serializeDoc(doc), 'utf8')
  if (bytes > QUICK_MENU_BYTES_CAP) return '配置超出容量上限（' + QUICK_MENU_BYTES_CAP + ' 字节）'
  return null
}

/**
 * 保存文档（revision 不匹配即判定为并发冲突，返回磁盘最新文档）。
 * @author ddj 2026年10月30号
 * @param doc 客户端提交的完整文档
 * @param baseRevision 客户端读到的 revision
 * @param home DSH home（测试可注入）
 * @returns 保存结果
 */
export async function saveQuickMenu(
  doc: QuickMenuDoc,
  baseRevision: number,
  home?: string,
): Promise<QuickMenuSaveResult> {
  const file = quickMenuFile(home)
  return chainWrite(file, async () => {
    const limit = checkLimits(doc)
    if (limit) return { ok: false as const, error: limit }
    const current = await loadFile(file)
    if (current.doc.revision !== baseRevision) {
      return { ok: false as const, error: '配置已被其他窗口修改，请重新加载后再保存', doc: current.doc }
    }
    const next = normalizeDoc(doc)
    // 悬浮按钮坐标只由 patchLauncher 维护：保存表单时沿用磁盘现值，
    // 否则「拖动/重置位置」与「保存设置」并发时会互相覆盖（曾实测重置后被旧坐标顶回）。
    next.launcher = current.doc.launcher
    next.revision = current.doc.revision + 1
    next.updatedAt = new Date().toISOString()
    try {
      await backupPrevious(file)
      await writeAtomic(file, serializeDoc(next))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false as const, error: '快捷菜单配置写入失败：' + reason }
    }
    const state: QuickMenuState = { doc: next, mtime: await mtimeOf(file) }
    stateCache.set(file, state)
    return { ok: true as const, doc: next }
  })
}

/**
 * 只更新悬浮按钮坐标（不推进 revision，避免拖拽把正在编辑的表单顶掉）。
 * @author ddj 2026年10月30号
 * @param launcher 坐标（null 表示回到输入框锚点）
 * @param home DSH home（测试可注入）
 * @returns 保存结果
 */
export async function patchLauncher(
  launcher: { x: number | null; y: number | null },
  home?: string,
): Promise<QuickMenuSaveResult> {
  const file = quickMenuFile(home)
  return chainWrite(file, async () => {
    const current = await loadFile(file)
    const next: QuickMenuDoc = {
      ...current.doc,
      launcher: { x: launcher.x, y: launcher.y },
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeAtomic(file, serializeDoc(next))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false as const, error: '保存悬浮按钮位置失败：' + reason }
    }
    const state: QuickMenuState = { doc: next, mtime: await mtimeOf(file) }
    stateCache.set(file, state)
    return { ok: true as const, doc: next }
  })
}

/** 导出/导入时的建议文件名（浏览器侧下载用，host 不参与）。 */
export const quickMenuBaseName = 'quick-menu.json'

/**
 * 当前 home 下的配置路径（诊断日志用）。
 * @author ddj 2026年10月30号
 * @param home DSH home
 * @returns 绝对路径
 */
export function quickMenuPath(home?: string): string {
  return quickMenuFile(home)
}

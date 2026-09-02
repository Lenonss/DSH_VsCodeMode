/**
 * dsh-vscode-mode shared — 快捷键命令目录与默认键位（双面契约）。
 * 纯数据模块：host（settings schema 默认值）与 client（执行匹配/设置页）共用。
 * 键位格式：修饰符 + 主键，`+` 连接，如 `Ctrl+Shift+F`；空串 = 未绑定；
 * `|` 连接多个候选（任一命中即触发），如 `Alt+ArrowLeft|Ctrl+Alt+-`。
 * 作者 ddj 2026年08月26号
 */

/** 命令 id → 默认键位（可为多候选）。命令目录以此为准，新增命令只需加一项。 */
export const KEYBINDING_DEFAULTS: Record<string, string> = {
  'edrv.save': 'Ctrl+S',
  'edrv.quickOpen': 'Ctrl+P',
  'edrv.toggleSidebar': 'Ctrl+B',
  'edrv.searchInFiles': 'Ctrl+Shift+F',
  'edrv.navigateBack': 'Alt+ArrowLeft|Ctrl+Alt+-',
  'edrv.navigateForward': 'Alt+ArrowRight|Ctrl+Shift+-',
}

/**
 * 返回默认键位的独立副本（调用方修改不污染目录）。
 * @author ddj 2026年08月26号
 * @returns 默认键位映射
 */
export function defaultKeybindings(): Record<string, string> {
  return { ...KEYBINDING_DEFAULTS }
}

/**
 * 规整外部键位数据：只保留已知命令 id 且为字符串的值，未知 id 丢弃。
 * 防止用户文档/旧版本写入的未知命令污染执行匹配。
 * @author ddj 2026年08月26号
 * @param raw 原始设置值
 * @returns 规整后的键位映射（缺省项不补默认值，由调用方按需合并）
 */
export function normalizeKeybindings(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [id, chord] of Object.entries(raw as Record<string, unknown>)) {
    if (id in KEYBINDING_DEFAULTS && typeof chord === 'string') out[id] = chord
  }
  return out
}

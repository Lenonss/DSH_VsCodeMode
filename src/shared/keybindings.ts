/**
 * dsh-vscode-mode shared — 快捷键命令目录与默认键位（双面契约）。
 * 纯数据模块：host（settings schema 默认值）与 client（执行匹配/设置页）共用。
 * 键位格式：修饰符 + 主键，`+` 连接，如 `Ctrl+Shift+F`；空串 = 未绑定；
 * `|` 连接多个候选（任一命中即触发），如 `Alt+ArrowLeft|Ctrl+Alt+-`。
 * 约束：本模块被 host 与 client 两半共用，**禁止 import client 侧模块**（React/浏览器 API）。
 * 与 client/ui/commandCatalog 的一致性由 tests/commands.test.ts 断言兜底。
 * 作者 ddj 2026年08月26号 / 2026年09月10号
 */

/** 命令 id → 默认键位（可为多候选）。命令目录以此为准，新增命令只需加一项。 */
export const KEYBINDING_DEFAULTS: Record<string, string> = {
  'edrv.save': 'Ctrl+S',
  'edrv.quickOpen': 'Ctrl+P',
  'edrv.toggleSidebar': 'Ctrl+B',
  'edrv.searchInFiles': 'Ctrl+Shift+F',
  'edrv.navigateBack': 'Alt+ArrowLeft|Ctrl+Alt+-',
  'edrv.navigateForward': 'Alt+ArrowRight|Ctrl+Shift+-',
  // 页签循环：主候选避开浏览器保留键（Ctrl+Tab / Ctrl+PgUp/PgDn 会被浏览器截获）
  'edrv.nextTab': 'Ctrl+Alt+ArrowRight|Ctrl+PageDown',
  'edrv.prevTab': 'Ctrl+Alt+ArrowLeft|Ctrl+PageUp',
  // 命令栏（Ctrl+Shift+P 主候选；F1 为 VS Code 同款第二候选）与编辑行导航
  'edrv.showCommands': 'Ctrl+Shift+P|F1',
  'edrv.nextEditorRow': 'Ctrl+Alt+ArrowDown',
  'edrv.prevEditorRow': 'Ctrl+Alt+ArrowUp',
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

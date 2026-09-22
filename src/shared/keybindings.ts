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
  // Markdown 预览切换：VS Code 同款 (Ctrl+K V 为分栏，此处取单键 Ctrl+Shift+V)。
  // 仅当活动文件是 .md 时才吞键，其余情况放行给浏览器/输入框（保留「粘贴为纯文本」语义）。
  'edrv.toggleMarkdownPreview': 'Ctrl+Shift+V',
  'edrv.navigateBack': 'Alt+ArrowLeft|Ctrl+Alt+-',
  'edrv.navigateForward': 'Alt+ArrowRight|Ctrl+Shift+-',
  // 页签循环：主候选避开浏览器保留键（Ctrl+Tab / Ctrl+PgUp/PgDn 会被浏览器截获）
  'edrv.nextTab': 'Ctrl+Alt+ArrowRight|Ctrl+PageDown',
  'edrv.prevTab': 'Ctrl+Alt+ArrowLeft|Ctrl+PageUp',
  // 转到行：插件只补键位与命令栏入口，widget 本体转发 Monaco 原生 editor.action.gotoLine（VS Code 同款 Ctrl+G）
  'edrv.goToLine': 'Ctrl+G',
  // 命令栏（Ctrl+Shift+P 主候选；F1 为 VS Code 同款第二候选）与编辑行导航
  'edrv.showCommands': 'Ctrl+Shift+P|F1',
  'edrv.nextEditorRow': 'Ctrl+Alt+ArrowDown',
  'edrv.prevEditorRow': 'Ctrl+Alt+ArrowUp',
  // 添加选中内容为引用：把当前选区追加进对话输入框（Ctrl+U，VS Code 同款）
  'edrv.addSelectionRef': 'Ctrl+U',
  // 关闭当前页签：VS Code 同款为 Ctrl+W，但浏览器会截获该键（脚本无法 preventDefault），
  // 故取参考图里的第二候选 Ctrl+F4（Chrome/Edge 默认无行为，可安全拦截）。
  'edrv.closeTab': 'Ctrl+F4',
  // 调试（VS Code 同款键位；F5 在有调试配置或暂停态才吞键，空闲时放行浏览器刷新）
  'edrv.debugToggleBreakpoint': 'F9',
  'edrv.debugStartContinue': 'F5',
  'edrv.debugStepOver': 'F10',
  'edrv.debugStepInto': 'F11',
  'edrv.debugStepOut': 'Shift+F11',
  'edrv.debugStop': 'Shift+F5',
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

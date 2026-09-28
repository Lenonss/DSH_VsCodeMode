/**
 * dsh-vscode-mode shared — 快捷键命令目录与默认键位（双面契约）。
 * 纯数据模块：host（settings schema 默认值）与 client（执行匹配/设置页）共用。
 * 键位格式：修饰符 + 主键，`+` 连接，如 `Ctrl+Shift+F`；空串 = 未绑定；
 * `|` 连接多个候选（任一命中即触发），如 `Alt+ArrowLeft|Ctrl+Alt+-`。
 * 约束：本模块被 host 与 client 两半共用，**禁止 import client 侧模块**（React/浏览器 API）。
 * 与 client/ui/commandCatalog 的一致性由 tests/commands.test.ts 断言兜底。
 * 官方机制（2026-10）：SHORTCUT_PROFILES 描述各命令在官方 ctx.shortcuts 的 profile 默认键位
 * （由 client 注册官方服务时使用）；chordToBinding/bindingToChord 负责插件弦与官方绑定互转。
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

//#region 官方 shortcuts 机制映射层（纯数据/纯函数，禁 import client 侧与官方包）

/** 官方 shortcuts 服务的修饰符标记（'primary' = 桌面端按平台展开为 Ctrl/Cmd，web 同语义）。 */
export type OfficialModifier = 'primary' | 'control' | 'alt' | 'shift' | 'meta'

/** 官方绑定形状（物理 code + 修饰符；与 @deepseek-ai/dsh-client-shortcuts 绑定契约同构，鸭子类型）。 */
export interface OfficialBinding {
  code: string
  modifiers: OfficialModifier[]
  secondCode?: string
}

/** 官方 profile 键（desktop|web × macos|windows|linux）。 */
export type ShortcutProfileKey =
  | 'desktop:macos' | 'desktop:windows' | 'desktop:linux'
  | 'web:macos' | 'web:windows' | 'web:linux'

/** 命令 id → 各 profile 官方默认键位（缺 profile = 该端不绑定）。 */
export type ShortcutProfiles = Partial<Record<ShortcutProfileKey, OfficialBinding>>

/** 显示主键 → 官方物理 code 对照（官方 code 白名单：Key[A-Z]|Digit[0-9]|F1-24|具名键）。 */
const DISPLAY_KEY_TO_CODE: Record<string, string> = {
  '-': 'Minus', '=': 'Equal', '[': 'BracketLeft', ']': 'BracketRight',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period',
  '/': 'Slash', '\\': 'Backslash', '`': 'Backquote',
  Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
  Escape: 'Escape', Space: 'Space',
  ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
}

/** 官方具名 code（非 Key/Digit/F 前缀且可回显的部分）。 */
const NAMED_CODES = ['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const

/** 官方 code → 显示主键（符号键反向对照）。 */
const CODE_TO_DISPLAY_KEY: Record<string, string> = {
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backslash: '\\', Backquote: '`',
}

/** 显示主键 → 官方 code（PageUp/PageDown/Home/End/Insert 等官方不支持 → null）。 */
function keyToCode(key: string): string | null {
  if (Object.hasOwn(DISPLAY_KEY_TO_CODE, key)) return DISPLAY_KEY_TO_CODE[key]
  if (key.length === 1 && key >= 'a' && key <= 'z') return 'Key' + key.toUpperCase()
  if (key.length === 1 && key >= 'A' && key <= 'Z') return 'Key' + key
  if (key.length === 1 && key >= '0' && key <= '9') return 'Digit' + key
  if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(key)) return key
  return null
}

/** 官方 code → 显示主键（不可回显 → null）。 */
function codeToKey(code: string): string | null {
  if (Object.hasOwn(CODE_TO_DISPLAY_KEY, code)) return CODE_TO_DISPLAY_KEY[code]
  if (/^Key[A-Z]$/u.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/u.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/u.test(code)) return code
  if ((NAMED_CODES as readonly string[]).includes(code)) return code
  return null
}

/** 插件弦的修饰符 token → 官方修饰符（Ctrl 与 Cmd 同为 primary，与 matchEvent 的互认语义一致）。 */
const CHORD_MODIFIER_TOKENS: Record<string, OfficialModifier> = {
  ctrl: 'primary', control: 'primary', cmd: 'primary', meta: 'primary',
  shift: 'shift', alt: 'alt',
}

/**
 * 插件键位弦（单候选）→ 官方绑定。
 * 不可表示的主键（PageUp/PageDown/Home/End/Insert 等）返回 null，调用方跳过。
 * @author ddj 2026年10月
 * @param chord 键位弦（如 `Ctrl+Alt+-` / `F9` / `Alt+ArrowLeft`）
 * @returns 官方绑定或 null
 */
export function chordToBinding(chord: string): OfficialBinding | null {
  const parts = String(chord ?? '').split('+').map((part) => part.trim()).filter(Boolean)
  if (!parts.length) return null
  const modifiers = new Set<OfficialModifier>()
  let key = ''
  for (const part of parts) {
    const modifier = CHORD_MODIFIER_TOKENS[part.toLowerCase()]
    if (modifier) {
      modifiers.add(modifier)
      continue
    }
    if (key) return null
    key = part
  }
  if (!key) return null
  if (key === ' ') key = 'Space'
  else if (key.length === 1 && key >= 'a' && key <= 'z') key = key.toUpperCase()
  const code = keyToCode(key)
  return code === null ? null : { code, modifiers: [...modifiers] }
}

/**
 * 官方绑定 → 可读键位弦，保留规范化后的 Control/Meta 物理区别。
 * 官方目录展示优先使用官方 keys；此函数仅作为缺少展示字段时的回落。
 * @author ddj 2026年09月28号
 * @param binding 官方绑定
 * @returns 插件弦（不可表示 → null）
 */
export function bindingToChord(binding: OfficialBinding): string | null {
  if (!binding || typeof binding !== 'object') return null
  const key = codeToKey(binding.code)
  if (key === null) return null
  let suffix = ''
  if (binding.secondCode !== undefined) {
    const secondKey = codeToKey(binding.secondCode)
    if (secondKey === null) return null
    suffix = '+' + secondKey
  }
  const parts: string[] = []
  if (binding.modifiers.includes('primary') || binding.modifiers.includes('control')) parts.push('Ctrl')
  if (binding.modifiers.includes('meta')) parts.push('Meta')
  if (binding.modifiers.includes('shift')) parts.push('Shift')
  if (binding.modifiers.includes('alt')) parts.push('Alt')
  return [...parts, key + suffix].join('+')
}

/** 官方绑定字面量构造（表格可读性辅助）。 */
function bind(code: string, modifiers: OfficialModifier[]): OfficialBinding {
  return { code, modifiers }
}

/**
 * 命令 id → 官方 profile 默认键位（与 KEYBINDING_DEFAULTS 一一对应；client 注册官方服务的数据源）。
 * 取值约束（对齐官方 bindingIssue/isWebBindingAllowed 校验，错报会在注册时抛错）：
 * - desktop:macos/windows：官方不做保留校验，用 VS Code 同款 chord；
 * - desktop:linux / web:linux：Arrow*、裸 F 键、全 Shift、Ctrl+V/C/X/Z/Y/Q/H/A、Meta 均为保留键 → 不声明；
 * - web:macos/windows：单修饰符组合不在白名单 → 用 primary+alt / primary+shift 变体（官方 ui-layout 同款）；
 * - Ctrl+PageDown/PageUp 候选废弃（官方 code 白名单无 PageUp/PageDown）；
 * - edrv.toggleSidebar 留空：Ctrl+B 与官方 sidebar.left.toggle（Mod+B）冲突，注册会抛错且冲突键互相阻断。
 * @author ddj 2026年10月
 */
export const SHORTCUT_PROFILES: Record<string, ShortcutProfiles> = {
  'edrv.toggleSidebar': {},
  'edrv.save': {
    'desktop:macos': bind('KeyS', ['primary']),
    'desktop:windows': bind('KeyS', ['primary']),
    'desktop:linux': bind('KeyS', ['primary']),
  },
  // 官方 workspace.files 已占用桌面 primary+P 和 Web primary+alt+P；插件 QuickOpen 使用非冲突组合。
  'edrv.quickOpen': {
    'desktop:macos': bind('KeyP', ['primary', 'alt']),
    'desktop:windows': bind('KeyP', ['primary', 'alt']),
    'desktop:linux': bind('KeyP', ['primary', 'alt']),
    'web:macos': bind('KeyP', ['primary', 'alt', 'shift']),
    'web:windows': bind('KeyP', ['primary', 'alt', 'shift']),
  },
  // 官方 session.fork 占用两种 Web primary+shift+F；加 Alt 避开联合目录冲突。
  'edrv.searchInFiles': {
    'desktop:macos': bind('KeyF', ['primary', 'shift']),
    'desktop:windows': bind('KeyF', ['primary', 'shift']),
    'desktop:linux': bind('KeyF', ['primary', 'shift']),
    'web:macos': bind('KeyF', ['primary', 'alt', 'shift']),
    'web:windows': bind('KeyF', ['primary', 'alt', 'shift']),
  },
  // Ctrl+Shift+V（primary+KeyV）在 linux 为保留键（官方 bindingIssue 不豁免 shift），desktop:linux 不声明
  'edrv.toggleMarkdownPreview': {
    'desktop:macos': bind('KeyV', ['primary', 'shift']),
    'desktop:windows': bind('KeyV', ['primary', 'shift']),
    'web:macos': bind('KeyV', ['primary', 'shift']),
    'web:windows': bind('KeyV', ['primary', 'shift']),
  },
  // 导航历史：主候选 Alt+Arrow 在 linux/web 为保留或白名单外；web 取第二候选（Ctrl+Alt+- / Ctrl+Shift+-）
  'edrv.navigateBack': {
    'desktop:macos': bind('ArrowLeft', ['alt']),
    'desktop:windows': bind('ArrowLeft', ['alt']),
    'web:macos': bind('Minus', ['primary', 'alt']),
    'web:windows': bind('Minus', ['primary', 'alt']),
  },
  'edrv.navigateForward': {
    'desktop:macos': bind('ArrowRight', ['alt']),
    'desktop:windows': bind('ArrowRight', ['alt']),
    'web:macos': bind('Minus', ['primary', 'shift']),
    'web:windows': bind('Minus', ['primary', 'shift']),
  },
  // 页签循环：Ctrl+PageDown/PageUp 候选官方不可表示，仅保留 Ctrl+Alt+Arrow 主候选
  'edrv.nextTab': {
    'desktop:macos': bind('ArrowRight', ['primary', 'alt']),
    'desktop:windows': bind('ArrowRight', ['primary', 'alt']),
    'web:macos': bind('ArrowRight', ['primary', 'alt']),
    'web:windows': bind('ArrowRight', ['primary', 'alt']),
  },
  'edrv.prevTab': {
    'desktop:macos': bind('ArrowLeft', ['primary', 'alt']),
    'desktop:windows': bind('ArrowLeft', ['primary', 'alt']),
    'web:macos': bind('ArrowLeft', ['primary', 'alt']),
    'web:windows': bind('ArrowLeft', ['primary', 'alt']),
  },
  'edrv.goToLine': {
    'desktop:macos': bind('KeyG', ['primary']),
    'desktop:windows': bind('KeyG', ['primary']),
    'desktop:linux': bind('KeyG', ['primary']),
  },
  'edrv.showCommands': {
    'desktop:macos': bind('KeyP', ['primary', 'shift']),
    'desktop:windows': bind('KeyP', ['primary', 'shift']),
    'desktop:linux': bind('KeyP', ['primary', 'shift']),
    'web:macos': bind('KeyP', ['primary', 'shift']),
    'web:windows': bind('KeyP', ['primary', 'shift']),
  },
  'edrv.nextEditorRow': {
    'desktop:macos': bind('ArrowDown', ['primary', 'alt']),
    'desktop:windows': bind('ArrowDown', ['primary', 'alt']),
    'web:macos': bind('ArrowDown', ['primary', 'alt']),
    'web:windows': bind('ArrowDown', ['primary', 'alt']),
  },
  'edrv.prevEditorRow': {
    'desktop:macos': bind('ArrowUp', ['primary', 'alt']),
    'desktop:windows': bind('ArrowUp', ['primary', 'alt']),
    'web:macos': bind('ArrowUp', ['primary', 'alt']),
    'web:windows': bind('ArrowUp', ['primary', 'alt']),
  },
  'edrv.addSelectionRef': {
    'desktop:macos': bind('KeyU', ['primary']),
    'desktop:windows': bind('KeyU', ['primary']),
    'desktop:linux': bind('KeyU', ['primary']),
  },
  'edrv.closeTab': {
    'desktop:macos': bind('F4', ['primary']),
    'desktop:windows': bind('F4', ['primary']),
    'desktop:linux': bind('F4', ['primary']),
  },
  // 调试 F 键：linux 判 modifier-required（裸 F/全 Shift），仅 desktop:macos/windows
  'edrv.debugToggleBreakpoint': {
    'desktop:macos': bind('F9', []),
    'desktop:windows': bind('F9', []),
  },
  'edrv.debugStartContinue': {
    'desktop:macos': bind('F5', []),
    'desktop:windows': bind('F5', []),
  },
  'edrv.debugStepOver': {
    'desktop:macos': bind('F10', []),
    'desktop:windows': bind('F10', []),
  },
  'edrv.debugStepInto': {
    'desktop:macos': bind('F11', []),
    'desktop:windows': bind('F11', []),
  },
  'edrv.debugStepOut': {
    'desktop:macos': bind('F11', ['shift']),
    'desktop:windows': bind('F11', ['shift']),
  },
  'edrv.debugStop': {
    'desktop:macos': bind('F5', ['shift']),
    'desktop:windows': bind('F5', ['shift']),
  },
}

//#endregion

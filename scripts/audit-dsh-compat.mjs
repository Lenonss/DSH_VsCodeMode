#!/usr/bin/env node
/**
 * dsh-vscode-mode DSH 兼容性审计脚本（版本适配机制例行检查用）。
 * 用法：node scripts/audit-dsh-compat.mjs <dshA根目录> [dshB根目录]
 * 根目录需直接包含 dsh-settings 等 @deepseek-ai 包目录（如 node_modules/@deepseek-ai
 * 或 DSH 备份 _backup/@deepseek-ai-0.1.2-alpha.2）。只给一个目录时输出该目录的报告，
 * 两个目录时输出差异表 + 已知影响性差异断言。
 * 作者 ddj 2026-09-02
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = process.argv.slice(2)
if (roots.length === 0 || roots.length > 2) {
  console.error('用法：node scripts/audit-dsh-compat.mjs <dshA根目录> [dshB根目录]')
  process.exit(2)
}

/** 读取包版本；缺失返回 null。 */
function versionOf(root, pkg) {
  const file = join(root, pkg, 'package.json')
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')).version ?? null
  } catch {
    return null
  }
}

/** 从 lib/index.js 提取 export { ... } 行内容（含 export function 名）。 */
function exportsOf(root, pkg) {
  const file = join(root, pkg, 'lib', 'index.js')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const found = new Set()
  for (const line of text.split('\n')) {
    const named = /export\s*\{([^}]+)\}/.exec(line)
    if (named) for (const item of named[1].split(',')) found.add(item.trim().split(/\s+as\s+/)[0])
    const fn = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (fn) found.add(fn[1])
    const cls = /export\s+class\s+([A-Za-z_$][\w$]*)/.exec(line)
    if (cls) found.add(cls[1])
  }
  return [...found].sort()
}

/** 服务名 → 提供者包名映射（super(ctx, "name") 扫描）。 */
function servicesOf(root) {
  const result = {}
  if (!existsSync(root)) return result
  const dirs = readdirRecursive(root).filter((p) => p.endsWith('.js'))
  for (const file of dirs) {
    const pkg = file.split(/[\\/]/)[0]
    const text = readFileSync(join(root, file), 'utf8')
    const re = /super\(ctx,\s*"([a-zA-Z]+)"\)/g
    for (const match of text.matchAll(re)) result[match[1]] = result[match[1]] ? result[match[1]] + ',' + pkg : pkg
  }
  return result
}

function readdirRecursive(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSafe(dir)) {
      const full = join(dir, name)
      if (statIsDir(full)) walk(full)
      else out.push(full)
    }
  }
  walk(root)
  return out.map((p) => p.slice(root.length + 1))
}

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

function statIsDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

/** 本插件消费的官方 UI 原语成员（dsh-client-ui-primitives 虚拟模块导出）。 */
const PRIMITIVE_MEMBERS = [
  'FileTypeIcon',
  'classifyFileType',
  'IconFolderClose16',
  'IconFolderOpen16',
  'IconFolderOpenOutline16',
  'IconRefreshOutline16',
  'IconSearchOutline16',
  'IconListPenOutline16',
  'IconCodeOutline16',
]

/**
 * 官方 UI 原语虚拟模块的导出面探测（该模块无独立包目录，导出表在 web 前端产物里）。
 * 判定为启发式：产物中不存在 "<成员>:" 形式的导出键即视为缺失。
 * @param root DSH 根目录（含 dsh-web-frontend）
 * @returns 缺失成员名数组；前端产物缺失时返回 null（无法判定）
 */
function primitivesMissing(root) {
  const dir = join(root, 'dsh-web-frontend', 'dist', 'assets')
  const files = readdirSafe(dir).filter((name) => name.endsWith('.js'))
  if (files.length === 0) return null
  const text = files.map((name) => {
    try { return readFileSync(join(dir, name), 'utf8') } catch { return '' }
  }).join('\n')
  return PRIMITIVE_MEMBERS.filter((name) => !new RegExp('\\b' + name + '\\s*:').test(text))
}

const report = (root) => {
  const settingsExports = exportsOf(root, 'dsh-settings')
  return {
    version: versionOf(root, 'dsh-settings'),
    hasRuntime: versionOf(root, 'dsh-client-runtime') !== null,
    hasUiSlots: versionOf(root, 'dsh-client-ui-slots') !== null,
    hasRenderer: versionOf(root, 'dsh-client-ui-renderer') !== null,
    hasApiproxy: versionOf(root, 'dsh-host-apiproxy') !== null,
    installSettingsSection: settingsExports.includes('installSettingsSection'),
    settingsNamespace: settingsExports.includes('settingsNamespace'),
    deepEqualJson: settingsExports.includes('deepEqualJson'),
    redactSecrets: settingsExports.includes('redactSecrets'),
    settingsProvider: settingsExports.includes('SettingsProvider'),
    primitivesMissing: primitivesMissing(root),
    services: servicesOf(root),
  }
}

if (roots.length === 1) {
  const r = report(roots[0])
  console.log(JSON.stringify(r, null, 2))
  process.exit(0)
}

const [a, b] = [report(roots[0]), report(roots[1])]
const diffRow = (label, key) => {
  const x = a[key]
  const y = b[key]
  console.log(String(x === y ? '=' : '≠') + '  ' + label.padEnd(26) + ' A=' + String(x ?? '-') + '  B=' + String(y ?? '-'))
}
console.log('== 关键包与导出面对比（A=' + roots[0] + ' → ' + (a.version ?? '?') + '，B=' + roots[1] + ' → ' + (b.version ?? '?') + '）==')
for (const key of ['installSettingsSection', 'settingsNamespace', 'deepEqualJson', 'redactSecrets', 'settingsProvider']) diffRow('dsh-settings 导出 ' + key, key)
for (const key of ['hasRuntime', 'hasUiSlots', 'hasRenderer', 'hasApiproxy']) diffRow('包存在 ' + key, key)
const svcNames = [...new Set([...Object.keys(a.services), ...Object.keys(b.services)])].sort()
const svcDiff = svcNames.filter((name) => a.services[name] !== b.services[name])
if (svcDiff.length === 0) {
  console.log('=  服务面（super(ctx,...) 提供者）两侧一致：' + svcNames.length + ' 个服务名')
} else {
  for (const name of svcDiff) {
    const x = a.services[name] ?? '(无提供者)'
    const y = b.services[name] ?? '(无提供者)'
    console.log('≠  服务提供者 ' + name.padEnd(18) + ' A=' + x + '  B=' + y)
  }
}

// 已知影响性差异断言：rc 线有 legacy 导出 / alpha 线移除并保留 SettingsProvider
const warnings = []
if (a.installSettingsSection && !b.installSettingsSection) console.log('\n[已知] installSettingsSection 仅 A 侧（rc 线）导出 → 0.1.2-alpha 线已移除（settings 服务 installSection 替代），适配器应走 service 策略')
else warnings.push('installSettingsSection 两侧状态与预期不符')
if (!b.hasRuntime && a.hasRuntime) console.log('[已知] dsh-client-runtime 仅 A 侧存在 → 0.1.2-alpha 线 slots 服务由 dsh-client-ui-renderer 提供（B.hasRenderer=' + b.hasRenderer + '）')
else if (!(a.hasRuntime && b.hasRenderer)) warnings.push('client runtime/renderer 结构异常')

// UI 原语导出面（文件树/活动栏图标依赖：FileTypeIcon + classifyFileType + Icon* 图标集）
if (a.primitivesMissing === null || b.primitivesMissing === null) {
  console.log('?  UI 原语导出面：前端产物缺失，无法判定（A=' + String(a.primitivesMissing) + '，B=' + String(b.primitivesMissing) + '）')
} else if (a.primitivesMissing.length === 0 && b.primitivesMissing.length === 0) {
  console.log('=  UI 原语导出面：本插件消费的 ' + PRIMITIVE_MEMBERS.length + ' 个成员两侧齐备')
} else {
  warnings.push('UI 原语成员缺失 A=' + JSON.stringify(a.primitivesMissing) + ' B=' + JSON.stringify(b.primitivesMissing))
}

if (warnings.length) { console.error('\n[告警] 矩阵预期偏差：\n' + warnings.join('\n')); process.exit(1) }
console.log('\n审计通过：差异符合已实测适配矩阵（rc.2 ↔ 0.1.2-alpha.2）。')

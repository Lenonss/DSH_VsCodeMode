#!/usr/bin/env node
/**
 * dsh-vscode-mode DSH 兼容性审计脚本（版本适配机制例行检查用）。
 * 用法：node scripts/audit-dsh-compat.mjs <dshA根目录> [dshB根目录]
 *      node scripts/audit-dsh-compat.mjs --dump-config-schema <dsh根目录> [profile]
 *      node scripts/audit-dsh-compat.mjs --help
 * 根目录需直接包含 dsh-settings 等 @deepseek-ai 包目录（如 node_modules/@deepseek-ai
 * 或 DSH 备份 _backup/@deepseek-ai-0.1.2-alpha.2）。只给一个目录时输出该目录的报告，
 * 两个目录时输出差异表 + 已知影响性差异断言。
 * --dump-config-schema 子命令（DSH 0.1.7+）：调 DSH CLI 导出组合配置 JSON Schema
 * 并最小校验本插件 cordis.patch.yml 结构；拿不到 schema（旧版 DSH / CLI 缺失 /
 * dump 失败）时打印提示并跳过（exit 0），绝不影响双树比对主流程。
 * 作者 ddj 2026-09-02；2026-09-22 增 --help 与 --dump-config-schema 子命令
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** 命令行用法（--help 与参数错误共用；保持单行原文风格）。 */
const USAGE = [
  '用法：node scripts/audit-dsh-compat.mjs <dshA根目录> [dshB根目录]',
  '      node scripts/audit-dsh-compat.mjs --dump-config-schema <dsh根目录> [profile]',
  '      node scripts/audit-dsh-compat.mjs --help',
].join('\n')

const argv = process.argv.slice(2)
if (argv[0] === '--help' || argv[0] === '-h') {
  console.log(USAGE)
  process.exit(0)
}
if (argv[0] === '--dump-config-schema') {
  process.exit(runSchemaCheck(argv.slice(1)))
}

const roots = argv
if (roots.length === 0 || roots.length > 2) {
  console.error(USAGE)
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

/** 本插件消费的官方 UI 原语成员 → 候选导出名（首名=≤0.1.6 旧名，其余=0.1.7+ 改名）。 */
const PRIMITIVE_MEMBERS = [
  ['FileTypeIcon'],
  ['classifyFileType'],
  ['IconFolderClose16', 'IconFolderCloseRegular'],
  ['IconFolderOpen16', 'IconFolderOpenRegular'],
  ['IconFolderOpenOutline16', 'IconFolderOpenOutlineRegular'],
  ['IconRefreshOutline16', 'IconRefreshOutlineRegular'],
  ['IconSearchOutline16', 'IconSearchOutlineRegular'],
  ['IconListPenOutline16', 'IconListPenOutlineRegular'],
  ['IconCodeOutline16', 'IconCodeOutlineRegular'],
  ['IconBranchOutline16', 'IconBranchOutlineRegular'],
]

/**
 * 官方 UI 原语导出面探测：候选名任一存在即通过（0.1.7 图标改名 Icon<Name>16 →
 * Icon<Name>Regular/Medium）。双文本源合并——① web 前端产物（≤0.1.6 虚拟模块导出表，
 * `dsh-web-frontend/dist/assets`）+ ② primitives 包自身（0.1.7 图标集随包分发，
 * `dsh-client-ui-primitives/lib` 的 js 与 d.ts）。判定为词边界启发式。
 * @param root DSH 根目录（含 @deepseek-ai 包目录）
 * @returns 缺失成员旧名数组（报告用）；两源皆空返回 null（无法判定）
 */
function primitivesMissing(root) {
  const dir = join(root, 'dsh-web-frontend', 'dist', 'assets')
  const files = readdirSafe(dir).filter((name) => name.endsWith('.js'))
  const bundle = files.map((name) => {
    try { return readFileSync(join(dir, name), 'utf8') } catch { return '' }
  }).join('\n')
  const pkgDir = join(root, 'dsh-client-ui-primitives', 'lib')
  const pkgFiles = existsSync(pkgDir) ? readdirRecursive(pkgDir).filter((p) => p.endsWith('.js') || p.endsWith('.d.ts')) : []
  const pkg = pkgFiles.map((p) => {
    try { return readFileSync(join(pkgDir, p), 'utf8') } catch { return '' }
  }).join('\n')
  const text = bundle + '\n' + pkg
  if (!text.trim()) return null
  return PRIMITIVE_MEMBERS
    .filter((names) => !names.some((name) => new RegExp('\\b' + name + '\\b').test(text)))
    .map(([oldName]) => oldName)
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

// 已知影响性差异断言（两代兼容：rc↔alpha 对 与 0.1.6↔0.1.7 对 均应通过）
const warnings = []
// installSettingsSection：rc 线有、0.1.2+ 皆无 → 仅「B 有 A 无」属矩阵外异常
if (b.installSettingsSection && !a.installSettingsSection) {
  warnings.push('installSettingsSection 出现在 B 侧（0.1.2-alpha 起应已移除）')
} else if (a.installSettingsSection && !b.installSettingsSection) {
  console.log('\n[已知] installSettingsSection 仅 A 侧（rc 线）导出 → 0.1.2-alpha 起移除（service 策略），0.1.7 再移除 installSection（forms 策略）')
} else {
  console.log('\n[已知] installSettingsSection 两侧皆无（0.1.2+ 结构；service/forms 按能力探测）')
}
// client 模块装载面：每侧至少有 dsh-client-runtime（≤rc）或 dsh-client-ui-renderer（0.1.2+）之一
if (!a.hasRuntime && !a.hasRenderer) warnings.push('client 装载面异常：A 侧既无 dsh-client-runtime 也无 dsh-client-ui-renderer')
else if (!b.hasRuntime && !b.hasRenderer) warnings.push('client 装载面异常：B 侧既无 dsh-client-runtime 也无 dsh-client-ui-renderer')
else console.log('[已知] client 装载面：A=' + (a.hasRuntime ? 'runtime' : 'renderer') + ' B=' + (b.hasRuntime ? 'runtime' : 'renderer'))

// UI 原语导出面（文件树/活动栏图标依赖：旧名或 0.1.7 新名任一存在即通过）
if (a.primitivesMissing === null || b.primitivesMissing === null) {
  console.log('?  UI 原语导出面：产物缺失，无法判定（A=' + String(a.primitivesMissing) + '，B=' + String(b.primitivesMissing) + '）')
} else if (a.primitivesMissing.length === 0 && b.primitivesMissing.length === 0) {
  console.log('=  UI 原语导出面：本插件消费的 ' + PRIMITIVE_MEMBERS.length + ' 个成员两侧齐备（含 0.1.7 改名候选）')
} else {
  warnings.push('UI 原语成员缺失 A=' + JSON.stringify(a.primitivesMissing) + ' B=' + JSON.stringify(b.primitivesMissing))
}

if (warnings.length) { console.error('\n[告警] 矩阵预期偏差：\n' + warnings.join('\n')); process.exit(1) }
console.log('\n审计通过：差异符合已实测适配矩阵（A=' + (a.version ?? '?') + ' ↔ B=' + (b.version ?? '?') + '）。')

// --region --dump-config-schema 子命令（DSH 0.1.7：导出组合配置 JSON Schema）

/**
 * 调 DSH CLI 导出组合配置 JSON Schema（0.1.7+ 的 --dump-config-schema）。
 * 仅当 CLI 源码内实见该 flag 字样才 spawn，杜绝旧版 DSH 把 flag 当参数误启 profile。
 * @author ddj 2026年09月22号
 * @param root 含 @deepseek-ai 包目录的 DSH 根
 * @param profile 目标 profile 名（缺省 web）
 * @returns 成功 `{ok:true, schema}`；不可用 `{ok:false, reason}`
 */
function dumpSchema(root, profile) {
  const bin = join(root, 'dsh', 'lib', 'bin.js')
  if (!existsSync(bin)) return { ok: false, reason: '未找到 DSH CLI：' + bin }
  if (!readFileSync(bin, 'utf8').includes('dump-config-schema')) {
    return { ok: false, reason: '当前 DSH CLI 不支持 --dump-config-schema（需 0.1.7+）：' + bin }
  }
  const run = spawnSync(process.execPath, [bin, '--profile', profile, '--dump-config-schema'], { encoding: 'utf8', timeout: 60000 })
  if (run.error) return { ok: false, reason: String(run.error) }
  const text = (run.stdout || '').trim()
  if (run.status !== 0 || !text) {
    const first = (run.stderr || '').trim().split('\n')[0] || ''
    return { ok: false, reason: 'CLI 退出码 ' + run.status + (first ? '：' + first : '') }
  }
  try {
    return { ok: true, schema: JSON.parse(text) }
  } catch (error) {
    return { ok: false, reason: 'stdout 非 JSON：' + String(error) }
  }
}

/**
 * 本插件 cordis.patch.yml 的最小结构校验（行级扫描，不引 YAML 依赖）：
 * 顶层序列项键白名单（insert + cordis-plugin-loader EntryOptions 的
 * id/name/config/group/disabled/inject）+ 本插件 loader 行必须在场。
 * @author ddj 2026年09月22号
 * @returns 问题描述数组（空数组 = 通过）
 */
function patchIssues() {
  const patchKeys = new Set(['insert', 'id', 'name', 'config', 'disabled', 'group', 'inject'])
  const raw = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const issues = []
  let items = 0
  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const top = /^-\s*([A-Za-z][\w-]*)\s*:/.exec(line)
    if (top) {
      items += 1
      if (!patchKeys.has(top[1])) issues.push('第' + (i + 1) + '行未知顶层键：' + top[1])
      continue
    }
    if (/^\s/.test(line)) continue
    issues.push('第' + (i + 1) + '行不是合法序列项：' + line.trim())
  }
  if (items === 0) issues.push('未找到任何顶层 patch 序列项')
  if (!/id:\s*['"]?dsh-vscode-mode['"]?\s*$/.test(raw)) issues.push('未见 id: dsh-vscode-mode loader 行')
  return issues
}

/**
 * --dump-config-schema 子命令：拿得到 schema 就校验本插件 cordis.patch.yml 结构；
 * 拿不到（旧版 DSH / CLI 缺失 / dump 失败）打印提示并跳过，绝不让主流程挂掉。
 * @author ddj 2026年09月22号
 * @param args `['<dsh根目录>', profile?]`
 * @returns 进程退出码：0 = 成功或已跳过，1 = 结构校验失败，2 = 用法错误
 */
function runSchemaCheck(args) {
  const [root, profile = 'web'] = args
  if (!root) {
    console.error('用法：node scripts/audit-dsh-compat.mjs --dump-config-schema <dsh根目录> [profile]')
    return 2
  }
  const dumped = dumpSchema(root, profile)
  if (!dumped.ok) {
    console.log('[跳过] 拿不到 config schema：' + dumped.reason)
    return 0
  }
  const issues = patchIssues()
  const ext = dumped.schema['x-cordis']
  if (!dumped.schema.$defs || !dumped.schema.$defs.patchList) issues.push('schema 缺少 $defs.patchList（非 0.1.7 dump 结构）')
  if (!ext) issues.push('schema 缺少 x-cordis 扩展')
  if (ext && ext.complete === false) console.log('[提示] schema 自报 incomplete（x-cordis.complete=false），诊断见 CLI stderr')
  if (!JSON.stringify(dumped.schema).includes('dsh-vscode-mode')) console.log('[提示] 组合结果未见 dsh-vscode-mode 条目（该 profile 可能未装本插件）')
  if (issues.length > 0) {
    console.error('[告警] cordis.patch.yml 结构校验未通过：\n' + issues.map((s) => ' - ' + s).join('\n'))
    return 1
  }
  console.log('cordis.patch.yml 结构校验通过（schema 就绪：$defs.patchList / x-cordis 齐备）。')
  return 0
}
// --endregion

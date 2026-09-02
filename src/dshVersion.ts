/**
 * dsh-vscode-mode host — DSH 核心版本探测与区间匹配（版本适配机制的地基）。
 * 约定：以运行时可解析的 @deepseek-ai/dsh-settings 包版本代表 DSH 核心版本——
 * 核心包发布锁步同版（rc.2 / alpha.2 全树同版实证），且该包是插件动态依赖面、
 * exports 已放行 ./package.json。解析失败按候选降级（dsh-web-app / dsh-base / dsh），
 * 全部失败返回空串（报告显示"未探测"，功能按能力探测运行）。
 * 纯函数（parse / compare / inRange / familyLabel）可在 node 环境单测。
 * 作者 ddj 2026-09-02
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 归一化版本：主/次/补丁 + 预发布标识数组（0.1.2-alpha.2 → pre=['alpha','2']）。 */
export interface DshVersion {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析版本串；非法返回 null（不抛错）。 */
export function parseDshVersion(input: string): DshVersion | null {
  const match = VERSION_RE.exec(input.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** 预发布标识比较：纯数字按值；数字段 < 字母段；字母按字典序（semver 规则）。 */
function comparePreId(a: string, b: string): number {
  const numericA = /^\d+$/.test(a)
  const numericB = /^\d+$/.test(b)
  if (numericA && numericB) return Number(a) - Number(b)
  if (numericA !== numericB) return numericA ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** 比较两个已解析版本：a<b → -1；相等 → 0；a>b → 1。 */
export function compareDshVersions(a: DshVersion, b: DshVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const samePre = a.pre.length === b.pre.length && a.pre.every((part, index) => part === b.pre[index])
  if (samePre) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i++) {
    const left = a.pre[i]
    const right = b.pre[i]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const cmp = comparePreId(left, right)
    if (cmp !== 0) return cmp
  }
  return 0
}

/** 版本区间（含端点）：from/to 为空表示该侧不设界。 */
export interface DshRange {
  from?: string
  to?: string
}

/** 版本是否落在区间内（入参解析失败一律不命中）。 */
export function inDshRange(version: DshVersion | null | undefined, range: DshRange): boolean {
  if (!version) return false
  if (range.from) {
    const lower = parseDshVersion(range.from)
    if (!lower || compareDshVersions(version, lower) < 0) return false
  }
  if (range.to) {
    const upper = parseDshVersion(range.to)
    if (!upper || compareDshVersions(version, upper) > 0) return false
  }
  return true
}

/** 版本线标签：报告与文档展示版本归属；不可解析返回 '未知'。 */
export function familyLabel(input: string): string {
  const version = parseDshVersion(input)
  if (!version) return '未知'
  if (inDshRange(version, { from: '0.1.2-alpha.1' })) return '0.1.2-alpha 及更新（设置 API=settings.installSection）'
  return '0.1.0/0.1.1 rc 线（设置 API=installSettingsSection）'
}

/** 探测候选：按与插件运行环境相关性排序，逐个尝试解析 package.json。 */
const VERSION_CANDIDATES = [
  '@deepseek-ai/dsh-settings/package.json',
  '@deepseek-ai/dsh-web-app/package.json',
  '@deepseek-ai/dsh-base/package.json',
  '@deepseek-ai/dsh/package.json',
]

let detectedVersion: string | undefined

/** 探测运行中 DSH 核心版本（模块级缓存；失败空串，不抛错）。 */
export function detectDshVersion(): string {
  if (detectedVersion !== undefined) return detectedVersion
  detectedVersion = ''
  const require = createRequire(import.meta.url)
  for (const specifier of VERSION_CANDIDATES) {
    try {
      const file = require.resolve(specifier)
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }
      if (typeof pkg.version === 'string' && parseDshVersion(pkg.version) !== null) {
        detectedVersion = pkg.version
        break
      }
    } catch {
      /* exports 未放行或包缺失：尝试下一个候选 */
    }
  }
  return detectedVersion
}

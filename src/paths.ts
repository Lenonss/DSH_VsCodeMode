/**
 * dsh-vscode-mode host — 路径常量与动态路径统一出口（PathConst）。
 * 所有 host 侧文件路径/缓存键/路由前缀从这里取，避免散落内联：
 * - 静态：插件缓存根（~/.dsh/dsh-vscode-mode/cache，下分 workspace/ 工作区级与
 *   user/ 用户级）、日志根、工作区侧车名、路由前缀、静态资源目录（import.meta.url 派生）
 * - 动态：每工作区树缓存文件（workspace/<id>/tree.v<schema>.json）、home 解析
 *   （DSH_HOME → ~/.dsh）
 * - 清理：缓存 sweep（分级：工作区级按版本/TTL/空目录、用户级按版本/保留期、根级残留）
 * 纯函数可单测；raw fs 写入与引擎自身插件（settings-file 用 node:fs + DSH_HOME）一致。
 * 作者 ddj 2026-09-01
 */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir, rm, stat } from 'node:fs/promises'
import { RPC_PATH } from './shared/rpc.js'

// --region 常量
/** 插件 id（也是 .dsh 下插件工作区目录名）。 */
export const PLUGIN_ID = 'dsh-vscode-mode'
/** DSH 工作区目录名（默认 home 下）。 */
export const DSH_DIR_NAME = '.dsh'
/** home 覆盖环境变量（与引擎 resolveDshHome 一致）。 */
export const DSH_HOME_ENV = 'DSH_HOME'
/** 树缓存 schema 版本（文件名携带；版本递增即触发旧版清理）。 */
export const TREE_CACHE_SCHEMA = 1
/** UI 状态镜像 schema 版本（文件名携带；版本递增即触发旧版清理）。 */
export const UI_STATE_SCHEMA = 1
/** LSP provider 发现缓存 schema 版本（格式变更即递增，旧文件自动失效）。 */
export const LSP_SPEC_CACHE_SCHEMA = 4
/** 树缓存保留期：超期文件视为废弃（工作区搬迁/废弃残留）。 */
export const TREE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** 插件缓存目录总预算：超限按 mtime 从旧到新删文件，防任意增长撑爆磁盘（最后兜底）。 */
export const CACHE_TOTAL_CAP = 200 * 1024 * 1024

/** 工作区根侧车：审查记录（用户数据，随项目走，不迁移）。 */
export const SIDECAR = '.dsh-edit-review.json'
/** 工作区根侧车：归档（用户数据）。 */
export const SIDECAR_ARCHIVE = '.dsh-edit-review-archive.json'
/** 旧 debug 日志文件名（工作区，迁移后由插件清理）。 */
export const DEBUG_LOG = '.dsh-edit-review-debug.log'
/** 旧树缓存 sidecar 名（工作区，迁移后由插件清理；缓存可重建，删除无损）。 */
export const LEGACY_TREE_SIDECARS = ['.dsh-edit-review-tree.json', '.dsh-vscode-mode-tree.json']

/** RPC 精确路由（shared 定义，这里统一出口）。 */
export { RPC_PATH }
/** 路由前缀（兼容性检查用）。 */
export const ROUTE_PREFIX = '/edrv'
/** Monaco 静态资源前缀。 */
export const VENDOR_PREFIX = '/edrv/vendor'
// --endregion

/** 稳定短哈希（cwd → 缓存文件名段；sha1 截断，跨运行稳定）。 */
export function hashOf(text: string): string {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16)
}

// --region DSH 会话定位编码
/**
 * 可读安全路径段编码：非安全码位 → ~XXXX 大写十六进制（`~` 本身也转义）。
 * 与 DSH 引擎 dsh-session-persistence-jsonl 的 encodeSegment 逐字节一致，
 * 用于从 cwd/id 反推 `~/.dsh/sessions` 下的会话目录，纯函数可单测。
 * @author ddj 2026年09月02号
 * @param raw 原始路径段（非空）
 * @returns 路径安全段（`.`/`..` 特判为 ~002E / ~002E~002E）
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * DSH 工作区目录键：cwd → `--<可读键>--`。分隔符（/ \ :）折叠为单个 `-`，
 * 其余非安全码位转 ~XXXX，`--` 包裹、251 截断。与引擎 projectKey 一致。
 * @author ddj 2026年09月02号
 * @param cwd 会话工作区绝对路径（非空）
 * @returns `~/.dsh/sessions` 下的工作区目录名
 */
export function sessionWorkspaceKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** DSH 会话目录段：id → 路径安全段（与引擎 encodeSegment 一致）。 */
export function sessionIdSegment(id: string): string {
  return encodeSegment(id)
}

/** DSH 会话根目录（~/.dsh/sessions；引擎 dsh-base 默认 root）。 */
export function sessionsRoot(home = dshHome()): string {
  return join(home, 'sessions')
}
// --endregion

/**
 * 解析 DSH home：空白环境值视为未设置，展开 ~ 并解析绝对路径。
 * @public
 * @author ddj 2026年09月28号
 * @param env 环境映射（缺省 process.env；测试可注入）
 * @returns 归一化的 DSH home 绝对路径
 */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const value = env[DSH_HOME_ENV]
  const path = value && value.trim() ? value : join(homedir(), DSH_DIR_NAME)
  if (path === '~') return resolve(homedir())
  if (path.startsWith('~/') || path.startsWith('~\\')) return resolve(join(homedir(), path.slice(2)))
  return resolve(path)
}

/** 插件缓存根（~/.dsh/dsh-vscode-mode/cache，下分 workspace/ 与 user/ 两级）。 */
export function pluginCacheRoot(home = dshHome()): string {
  return join(home, PLUGIN_ID, 'cache')
}

/** 工作区级缓存目录：按工作区 id（cwd hash）隔离，换工作区即失效。 */
export function workspaceCacheDir(workspaceId: string, home = dshHome()): string {
  return join(pluginCacheRoot(home), 'workspace', workspaceId)
}

/** 用户级缓存目录（跨工作区共享；当前无实例，预留供全局偏好类缓存使用）。 */
export function userCacheDir(home = dshHome()): string {
  return join(pluginCacheRoot(home), 'user')
}

/** LSP provider 发现结果缓存文件（用户级：user/lsp-specs.v<schema>.json，跨会话/跨重启共享）。 */
export function lspSpecCacheFile(home = dshHome(), schema = LSP_SPEC_CACHE_SCHEMA): string {
  return join(userCacheDir(home), 'lsp-specs.v' + schema + '.json')
}

/** 插件日志根（~/.dsh/dsh-vscode-mode/logs，用户级）。 */
export function pluginLogRoot(home = dshHome()): string {
  return join(home, PLUGIN_ID, 'logs')
}

/** 每工作区树缓存文件（工作区级：workspace/<id>/tree.v<schema>.json，文件名含版本便于 sweep）。 */
export function treeCacheFile(cwd: string, home = dshHome(), schema = TREE_CACHE_SCHEMA): string {
  return join(workspaceCacheDir(hashOf(cwd), home), 'tree.v' + schema + '.json')
}

/**
 * 每工作区 UI 状态镜像文件（工作区级：workspace/<id>/ui.v<schema>.json）。
 * 存编辑器页签/侧栏/预览态等界面状态的 localStorage 原值副本，供换 origin 后回填。
 * @author ddj 2026年09月28号
 * @param cwd 工作区绝对路径
 * @param home DSH home（测试可注入）
 * @param schema schema 版本（缺省 UI_STATE_SCHEMA）
 * @returns UI 状态镜像文件绝对路径
 */
export function uiStateFile(cwd: string, home = dshHome(), schema = UI_STATE_SCHEMA): string {
  return join(workspaceCacheDir(hashOf(cwd), home), 'ui.v' + schema + '.json')
}

/**
 * 用户级 UI 状态镜像文件（跨工作区共享：user/ui-globals.v<schema>.json）。
 * 存与工作区无关的全局键（侧栏提示已忽略、工作区折叠态等）。
 * @author ddj 2026年09月28号
 * @param home DSH home（测试可注入）
 * @param schema schema 版本（缺省 UI_STATE_SCHEMA）
 * @returns 全局 UI 状态镜像文件绝对路径
 */
export function uiGlobalsFile(home = dshHome(), schema = UI_STATE_SCHEMA): string {
  return join(userCacheDir(home), 'ui-globals.v' + schema + '.json')
}

/** 每工作区 debug 日志文件（用户级日志根下，按 cwd hash 隔离）。 */
export function debugLogFile(cwd: string, home = dshHome()): string {
  return join(pluginLogRoot(home), 'debug.' + hashOf(cwd) + '.log')
}

/** 插件包 assets 目录（import.meta.url 派生；config.imageDir 可覆盖，见 imageDirOf）。 */
export function assetsDirOf(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', 'assets')
}

/** Monaco AMD 静态目录（随包发布）。 */
export function vendorDirOf(moduleUrl: string): string {
  return join(assetsDirOf(moduleUrl), 'vendor')
}

/**
 * 插件自带技能组根目录（包根 skills/，与 assets/ 同级；随包发布）。
 * 布局：<根>/<技能名>/SKILL.md（目录式）或 <根>/<技能名>.md（扁平式）。
 * @author ddj 2026年09月11号
 * @param moduleUrl 模块 URL（缺省 import.meta.url；测试注入）
 * @returns 技能组根目录绝对路径
 */
export function skillsDirOf(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', 'skills')
}

/** 图标目录：config.imageDir 覆盖优先，否则插件包 assets/。 */
export function imageDirOf(config: unknown, moduleUrl: string): string {
  const cfg = config as { imageDir?: unknown } | undefined
  if (cfg && typeof cfg.imageDir === 'string' && cfg.imageDir) return cfg.imageDir.replace(/\\/g, '/')
  return assetsDirOf(moduleUrl)
}

// --region 缓存清理
/** 树缓存文件名 → schema 版本（不匹配返回 null）。 */
export function treeSchemaOf(filename: string): number | null {
  const m = /^tree\.v(\d+)\./.exec(filename)
  return m ? Number(m[1]) : null
}

/**
 * 已知缓存文件种类 → 当前 schema 版本（sweep 判旧依据）。
 * 新增缓存文件必须登记在此，否则被当作未知残留清理。
 */
const CACHE_SCHEMAS: Record<string, number> = {
  tree: TREE_CACHE_SCHEMA,
  'lsp-specs': LSP_SPEC_CACHE_SCHEMA,
  ui: UI_STATE_SCHEMA,
  'ui-globals': UI_STATE_SCHEMA,
}

/** 缓存文件名 → 种类与 schema 版本（`<kind>.v<schema>.json`；未登记种类/命名不合规 → null）。 */
function parseCacheName(filename: string): { kind: string; schema: number } | null {
  const m = /^([a-z-]+)\.v(\d+)\.json$/.exec(filename)
  if (!m) return null
  const kind = m[1]
  if (CACHE_SCHEMAS[kind] === undefined) return null
  return { kind, schema: Number(m[2]) }
}

/**
 * 该缓存文件名是否为已登记种类的当前 schema 版本（sweep 判旧/判残留依据）。
 * @author ddj 2026年09月28号
 * @param filename 缓存文件名（不含目录）
 * @returns 已登记种类且版本为当前版本
 */
export function isCurrentCacheFile(filename: string): boolean {
  const parsed = parseCacheName(filename)
  return parsed !== null && parsed.schema === CACHE_SCHEMAS[parsed.kind]
}

/** 按「schema 版本 + 保留期」清扫某目录内文件（目录级，返回相对路径清单）。 */
async function sweepDirFiles(dir: string, removed: string[], now: number, dropAll: boolean): Promise<void> {
  const names = await readdir(dir).catch(() => [])
  for (const name of names) {
    const full = join(dir, name)
    let drop = dropAll
    if (!drop) {
      if (!isCurrentCacheFile(name)) drop = true // 未知残留 / 旧版本
      else {
        try {
          const info = await stat(full)
          if (now - info.mtimeMs > TREE_RETENTION_MS) drop = true
        } catch (error) { drop = true }
      }
    }
    if (!drop) continue
    try {
      await rm(full, { force: true })
      removed.push(name)
    } catch (error) { /* 删除失败静默 */ }
  }
}

/** 清扫工作区级缓存：逐工作区目录按版本/TTL 清文件，空目录删除。 */
async function sweepWorkspaceTier(dir: string, removed: string[], now: number): Promise<void> {
  const ids = await readdir(dir).catch(() => [])
  for (const id of ids) {
    const wsDir = join(dir, id)
    await sweepDirFiles(wsDir, removed, now, false)
    const rest = await readdir(wsDir).catch(() => [])
    if (!rest.length) await rm(wsDir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 总预算兜底：递归收集全部缓存文件，按 mtime 从旧到新删，直到总大小 ≤ 预算。 */
async function sweepByTotalCap(root: string, removed: string[], cap: number): Promise<void> {
  const files: { path: string; mtime: number; size: number }[] = []
  const walk = async (dir: string): Promise<void> => {
    const names = await readdir(dir).catch(() => [])
    for (const name of names) {
      const full = join(dir, name)
      try {
        const info = await stat(full)
        if (info.isDirectory()) await walk(full)
        else files.push({ path: full, mtime: info.mtimeMs, size: info.size })
      } catch (error) { /* 忽略不可读项 */ }
    }
  }
  await walk(root)
  let total = files.reduce((sum, f) => sum + f.size, 0)
  files.sort((a, b) => a.mtime - b.mtime)
  for (const f of files) {
    if (total <= cap) break
    try {
      await rm(f.path, { force: true })
      total -= f.size
      removed.push(f.path.slice(root.length + 1))
    } catch (error) { /* 删除失败静默 */ }
  }
}

/**
 * 清理插件缓存根（分级 + 总预算兜底）：
 * - 根级残留文件（旧扁平格式/未知）→ 删
 * - workspace/ 工作区级 → 按「schema 版本 + 保留期」清文件，空目录删除
 * - user/ 用户级 → 按「schema 版本 + 保留期」清文件
 * - 总大小超预算 → 按最旧先删（最后防线，防任意增长撑爆磁盘）
 * best-effort 静默。
 * @author ddj 2026年09月01号
 * @param home DSH home（测试可注入）
 * @param cap 总预算字节数（缺省 CACHE_TOTAL_CAP；测试可注入小预算）
 * @returns 删除的文件相对路径清单
 */
export async function sweepTreeCache(home = dshHome(), cap = CACHE_TOTAL_CAP): Promise<string[]> {
  const dir = pluginCacheRoot(home)
  const names = await readdir(dir).catch(() => [])
  if (!names.length) return []
  const removed: string[] = []
  const now = Date.now()
  await Promise.all(names.map(async (name) => {
    const full = join(dir, name)
    try {
      const info = await stat(full)
      if (info.isDirectory()) {
        if (name === 'workspace') await sweepWorkspaceTier(full, removed, now)
        else if (name === 'user') await sweepDirFiles(full, removed, now, false)
        else {
          await rm(full, { recursive: true, force: true })
          removed.push(name)
        }
      } else {
        await rm(full, { force: true })
        removed.push(name) // 根级残留（迁移前扁平格式/未知文件）
      }
    } catch (error) { /* stat 失败忽略 */ }
  }))
  await sweepByTotalCap(dir, removed, cap)
  return removed
}
// --endregion

/**
 * dsh-vscode-mode host — 自我更新：registry 最新版本检查与官方 pluginManager「先删后装」编排。
 * 职责：compareVersion 语义化版本比较（纯函数可单测）、latestVersionOf 经 subprocess 运行
 *       `pnpm view <pkg> version --json`（与 installBundle 同一套 pnpm/registry 配置）、
 *       startSelfUpdate 把 removeBundle→installBundle 编排放进宿主级 setTimeout（先回 RPC 响应，
 *       定时器回调不受本插件卸载影响，规避「删除自身后 install 不再执行」的自愈陷阱）。
 * 注意：不 import @deepseek-ai/dsh-plugin-manager（鸭子类型引用 ctx.get('pluginManager')），
 *       老宿主缺失该服务时返回明确错误引导官方插件管理页。
 * 作者 ddj 2026-10-16
 */
import { PLUGIN_NAME, pluginVersionOf } from './compat.js'
import { childEnv } from './childEnv.js'
import { findProfileDir } from './devForm.js'
import type { Ctx } from './store.js'

/** 官方 dsh profile-boot 提供的包管理器启动参数（与 devForm.ts ProfileContext 对齐）。 */
interface PackageManagerSpec {
  command: string
  args?: string[]
  env?: NodeJS.ProcessEnv
}

/** subprocess.spawn 句柄的最小形状（对齐 devForm.ts runPnpmInstall 的用法）。 */
interface SpawnHandle {
  done: Promise<{ exitCode: number | null }>
}

/** pluginManager 服务的最小鸭子类型（仅本流程用到的方法）。 */
interface PluginManagerLike {
  removeBundle(name: string): Promise<unknown>
  installBundle(spec: string, options?: unknown): Promise<unknown>
}

/** 检查更新结果（RPC vscode.updateCheck 响应载荷）。 */
export type UpdateCheckResult =
  | { ok: true; current: string; latest: string; hasUpdate: boolean }
  | { ok: false; current: string; error: string }

/** 防并发重入标志：一旦启动编排，本次进程内不再接受第二次更新请求。 */
let updating = false

/**
 * 语义化版本比较：核心段按 `.` 数值比较、段数不足补 0；预发布版（-beta 等）低于同号正式版，
 * 构建元数据（+）与预发布粒度不参与排序。
 * @private
 * @author ddj 2026年10月16号
 * @param a 左版本号
 * @param b 右版本号
 * @returns a>b 为 1，a<b 为 -1，相等为 0
 */
export function compareVersion(a: string, b: string): number {
  const parse = (text: string): { nums: number[]; pre: boolean } => {
    const value = String(text ?? '').trim().replace(/^[^\d]*/, '')
    const cut = value.search(/[-+]/)
    const core = cut >= 0 ? value.slice(0, cut) : value
    const nums = core.split('.').map((part) => {
      const num = Number.parseInt(part, 10)
      return Number.isFinite(num) ? num : 0
    })
    return { nums, pre: cut >= 0 && value[cut] === '-' }
  }

  const left = parse(a)
  const right = parse(b)
  const total = Math.max(left.nums.length, right.nums.length)
  for (let index = 0; index < total; index += 1) {
    const diff = (left.nums[index] ?? 0) - (right.nums[index] ?? 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  if (left.pre !== right.pre) return left.pre ? -1 : 1
  return 0
}

/**
 * 用 profileContext.packageManager（缺省 pnpm）查询 npm registry 上本包最新版本。
 * @private
 * @author ddj 2026年10月16号
 * @param ctx DSH host 上下文
 * @returns registry 最新版本号
 * @throws pnpm 不存在、退出非零或输出不可解析
 */
async function latestVersionOf(ctx: Ctx): Promise<string> {
  const dir = findProfileDir(ctx)
  if (!dir) throw new Error('无法定位当前 profile，无法查询最新版本')
  const runner = (ctx.get('profileContext') as { packageManager?: PackageManagerSpec } | undefined)?.packageManager
  const text = await new Promise<string>((resolvePromise, rejectPromise) => {
    let spawned = false
    try {
      const handle = ctx.get('subprocess').spawn({
        argv: [runner?.command ?? 'pnpm', ...runner?.args ?? [], 'view', PLUGIN_NAME, 'version', '--json'],
        cwd: dir,
        env: childEnv(runner?.env),
        stdio: { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
        graceMs: 20000,
      }) as SpawnHandle
      spawned = true
      readSpawnText(handle, resolvePromise, rejectPromise)
    } catch (error) {
      if (!spawned) rejectPromise(error instanceof Error ? error : new Error(String(error)))
    }
  })
  return parseVersionJson(text)
}

/**
 * 读取 spawn 句柄的 stdout 文本并等待退出（非零退出或空输出抛错）。
 * @private
 * @author ddj 2026年10月16号
 * @param handle subprocess.spawn 返回句柄
 * @param resolvePromise 成功回传 stdout 全文
 * @param rejectPromise 失败回传错误
 */
function readSpawnText(
  handle: SpawnHandle & { collected?: { stdout?: { readFrom(offset: number): { text: string; lossy?: boolean } } } },
  resolvePromise: (text: string) => void,
  rejectPromise: (error: Error) => void,
): void {
  void handle.done.then((outcome) => {
    const text = handle.collected?.stdout?.readFrom(0)?.text ?? ''
    if (outcome?.exitCode !== 0 || !text.trim()) {
      rejectPromise(new Error('pnpm view 失败（exit ' + String(outcome?.exitCode) + '）：' + text.slice(0, 200)))
      return
    }
    resolvePromise(text)
  }, rejectPromise)
}

/**
 * 解析 `pnpm view --json` 输出：JSON 字符串（"1.2.3"）或直接版本字面量均接受。
 * @private
 * @author ddj 2026年10月16号
 * @param text stdout 全文
 * @returns 版本号
 * @throws 输出不含可识别版本
 */
function parseVersionJson(text: string): string {
  const trimmed = text.trim()
  try {
    const value = JSON.parse(trimmed) as unknown
    if (typeof value === 'string' && value.trim()) return value.trim()
  } catch { /* 落到字面量兜底 */ }
  if (/^\d+(\.\d+){0,3}([-+].*)?$/.test(trimmed)) return trimmed
  throw new Error('无法解析 pnpm view 输出：' + trimmed.slice(0, 120))
}

/**
 * 检查 registry 是否有比当前安装版本更新的版本。
 * @public
 * @author ddj 2026年10月16号
 * @param ctx DSH host 上下文
 * @returns 当前版本 / 最新版本 / 是否有更新
 */
export async function checkUpdate(ctx: Ctx): Promise<UpdateCheckResult> {
  const current = pluginVersionOf()
  try {
    const latest = await latestVersionOf(ctx)
    return { ok: true, current, latest, hasUpdate: latest !== '' && compareVersion(latest, current) > 0 }
  } catch (error) {
    return { ok: false, current, error: String(error) }
  }
}

/**
 * 启动「先删后装」自我更新编排：校验通过后把编排放进宿主级 setTimeout（延迟 1s 让 RPC 响应
 * 先送达客户端），立即返回 started；定时器回调不受本插件卸载影响。install 失败时
 * pluginManager 会恢复 profile 的 package.json/pnpm-lock.yaml，插件保持未安装状态，
 * 由用户在官方插件管理页重装恢复。
 * @public
 * @author ddj 2026年10月16号
 * @param ctx DSH host 上下文
 * @returns started 是否已启动编排；失败时 ok=false
 * @throws 无（失败走返回值 error）
 */
export async function startSelfUpdate(ctx: Ctx): Promise<{ ok: true; started: true } | { ok: false; error: string }> {
  if (updating) return { ok: false, error: '更新流程已在进行中，请重启 DSH 后观察结果' }
  const manager = ctx.get('pluginManager') as PluginManagerLike | undefined
  if (!manager || typeof manager.removeBundle !== 'function' || typeof manager.installBundle !== 'function') {
    return { ok: false, error: '当前宿主无 pluginManager 服务，请在官方插件管理页卸载后重新安装以升级' }
  }
  updating = true
  // 延迟启动：RPC 响应先送达客户端、UI 有机会展示「更新已开始」，再动 profile
  setTimeout(() => {
    manager.removeBundle(PLUGIN_NAME)
      .then(() => manager.installBundle(PLUGIN_NAME))
      .catch(() => { /* 编排已脱离本插件生命周期：失败状态由 pluginManager 恢复，无上报通道 */ })
  }, 1000)
  return { ok: true, started: true }
}

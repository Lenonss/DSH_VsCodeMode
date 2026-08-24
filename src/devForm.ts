/**
 * dsh-vscode-mode host — 开发形态管理（安装形态切换）。
 * 开发形态 = profile 中以 link: 依赖 + junction 指向工作区的安装（用于插件开发）；
 * 关闭 = 改回版本依赖 + 删 junction + pnpm install 装配正式版。
 * 切换后需重启 DSH 生效（运行中的代码仍是旧形态）。
 * 与 compat.ts 存在模块环（devForm 用 pluginVersionOf、compat 用 readDevForm），
 * 双方仅在函数体内交叉使用，模块求值期无依赖，ESM 安全。
 * 作者 ddj 2026-08-24
 */
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { PLUGIN_NAME, pluginVersionOf } from './compat.js'
import type { DevFormInfo } from './shared/compat.js'
import type { Ctx } from './store.js'

/** 扫描 $DSH_HOME/profiles 找到依赖本插件的 profile 目录（无 env 依赖，多 profile 安全）。 */
export function findProfileDir(): string | undefined {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  try {
    for (const name of readdirSync(join(home, 'profiles'))) {
      const pkgFile = join(home, 'profiles', name, 'package.json')
      if (!existsSync(pkgFile)) continue
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, unknown> } | undefined
        if (pkg?.dependencies?.[PLUGIN_NAME]) return dirname(pkgFile)
      } catch {
        /* 坏 manifest 跳过该 profile */
      }
    }
  } catch {
    /* profiles 目录不存在时放弃 */
  }
  return undefined
}

/**
 * 读取当前开发形态（manifest link: 判定）。
 * @author ddj 2026年08月24号
 * @returns 开发形态状态
 */
export function readDevForm(): DevFormInfo {
  const profileDir = findProfileDir()
  if (!profileDir) return { enabled: false }
  try {
    const text = readFileSync(join(profileDir, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
    const pkg = JSON.parse(text) as { dependencies?: Record<string, unknown> } | undefined
    const spec = pkg?.dependencies?.[PLUGIN_NAME]
    if (typeof spec === 'string' && spec.startsWith('link:')) {
      return { enabled: true, path: spec.slice('link:'.length) }
    }
  } catch {
    /* manifest 不可读视为非开发形态 */
  }
  return { enabled: false }
}

/**
 * 规划切换后的 manifest 文本（纯函数，可单测；非法 JSON 抛错）。
 * @author ddj 2026年08月24号
 * @param text 原 manifest 文本
 * @param enabled 目标形态（true=link:，false=版本）
 * @param path 工作区路径（开启时必填）
 * @param version 版本号（关闭时使用，写入 ^<version>）
 * @returns 新 manifest 文本（无 BOM，2 空格缩进）
 */
export function planManifest(text: string, enabled: boolean, path: string, version: string): string {
  const data = JSON.parse(text.replace(/^\uFEFF/, '')) as { dependencies?: Record<string, unknown> }
  if (!data.dependencies || typeof data.dependencies !== 'object') {
    throw new Error('profile package.json 缺少 dependencies 字段')
  }
  data.dependencies[PLUGIN_NAME] = enabled ? 'link:' + path.replace(/\\/g, '/') : '^' + version
  return JSON.stringify(data, null, 2) + '\n'
}

/** 建立或移除 node_modules 下的开发 junction（目标不存在时开启失败）。 */
function applyJunction(profileDir: string, enabled: boolean, target: string): void {
  const linkDir = join(profileDir, 'node_modules', PLUGIN_NAME)
  if (existsSync(linkDir)) rmSync(linkDir, { recursive: true, force: true })
  if (!enabled) return
  if (!existsSync(target)) throw new Error('工作区路径不存在：' + target)
  symlinkSync(target, linkDir, 'junction')
}

/**
 * 切换开发形态：改 manifest → 建/删 junction → pnpm install（subprocess）。
 * @author ddj 2026年08月24号
 * @param ctx DSH host 上下文（subprocess 服务）
 * @param enabled 目标形态
 * @param path 工作区绝对路径（开启时必填）
 * @returns 切换结果（restart=true 表示需重启 DSH 生效）
 */
export async function setDevForm(ctx: Ctx, enabled: boolean, path?: string): Promise<{ ok: boolean; error?: string; restart: boolean }> {
  const profileDir = findProfileDir()
  if (!profileDir) return { ok: false, error: '未找到依赖本插件的 profile（检查 DSH_HOME/profiles）', restart: false }
  const current = readDevForm()
  const target = (path ?? current.path ?? '').replace(/\\/g, '/')
  if (enabled && !target) return { ok: false, error: '开启开发形态需要提供工作区路径（path 参数）', restart: false }
  if (enabled === current.enabled && (!enabled || target === current.path)) {
    return { ok: true, restart: false }
  }
  try {
    const pkgFile = join(profileDir, 'package.json')
    const version = pluginVersionOf()
    if (!version) return { ok: false, error: '读取插件版本失败，无法写入版本依赖', restart: false }
    const next = planManifest(readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, ''), enabled, target, version)
    writeFileSync(pkgFile, next, 'utf8')
    applyJunction(profileDir, enabled, target)
    const installError = await runPnpmInstall(ctx, profileDir)
    return { ok: !installError, error: installError, restart: true }
  } catch (error) {
    return { ok: false, error: String(error), restart: false }
  }
}

/** 在 profile 目录执行 pnpm install（subprocess 契约：spawn({argv,cwd,stdio,graceMs})）。 */
async function runPnpmInstall(ctx: Ctx, profileDir: string): Promise<string | undefined> {
  const sub = ctx.get('subprocess')
  if (!sub || typeof sub.spawn !== 'function') return 'manifest/junction 已更新，但缺少 subprocess：请手动在 profile 目录运行 pnpm install'
  const handle = sub.spawn({
    argv: ['pnpm', 'install'],
    cwd: profileDir,
    stdio: { stdout: { maxBytes: 1 << 16 }, stderr: { maxBytes: 1 << 16 }, stdin: 'ignore' },
    graceMs: 120000,
  })
  const outcome = await handle.done
  const code = outcome?.exitCode ?? outcome?.code
  if (code !== 0) {
    const stderr = handle.collected?.stderr?.readFrom(0).text ?? ''
    return 'pnpm install 失败（exit ' + code + '）：' + stderr.slice(0, 500)
  }
  return undefined
}

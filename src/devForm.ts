/** 当前运行 profile 的开发形态切换；失败恢复 manifest、lockfile 与原安装入口。 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { PLUGIN_NAME, pluginVersionOf } from './compat.js'
import { dshHome } from './paths.js'
import { childEnv } from './childEnv.js'
import type { DevFormInfo } from './shared/compat.js'
import type { Ctx } from './store.js'

/** 官方 dsh profile-boot 提供的当前运行事实；不从 inventory 猜测。 */
interface ProfileContext {
  dir: string
  packageManager?: { command: string; args?: string[]; env?: NodeJS.ProcessEnv }
}
type SwitchResult = { ok: boolean; error?: string; restart: boolean }
interface ProfileBackup {
  dir: string
  link: string
  savedLink: string
  hadLink: boolean
  files: { path: string; text: Buffer | undefined }[]
}
const switching = new Set<string>()

// --region 运行上下文
/**
 * 获取官方 profileContext 服务；服务存在但无有效目录时拒绝猜测。
 * @private
 * @author ddj 2026年09月28号
 * @param ctx 可选运行上下文
 * @returns 官方服务对象或缺失
 * @throws 服务对象目录无效
 */
function profileOf(ctx?: Ctx): ProfileContext | undefined {
  const profile = ctx?.get?.('profileContext')
  if (profile === undefined || profile === null) return undefined
  if (typeof profile.dir !== 'string' || !isAbsolute(profile.dir)) throw new Error('当前 profileContext.dir 无效')
  return profile as ProfileContext
}

/**
 * 检查 manifest 是否明确依赖本插件；坏 manifest 不作候选。
 * @private
 * @author ddj 2026年09月28号
 * @param dir profile 目录
 * @returns 是否包含插件依赖
 */
function ownsPlugin(dir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    return typeof pkg?.dependencies?.[PLUGIN_NAME] === 'string'
  } catch { return false }
}

/**
 * 优先使用真实运行 profile；旧宿主仅允许唯一候选回退，多候选拒绝。
 * @public
 * @author ddj 2026年09月28号
 * @param ctx DSH host 上下文（可选，旧宿主兼容）
 * @returns 当前 profile 目录；无有效或唯一候选时 undefined
 */
export function findProfileDir(ctx?: Ctx): string | undefined {
  try {
    const profile = profileOf(ctx)
    if (profile) return ownsPlugin(profile.dir) ? profile.dir : undefined
    const homePath = ctx?.get?.('dshHomePath')
    const root = join(typeof homePath === 'function' ? homePath() : dshHome(), 'profiles')
    const candidates = readdirSync(root).map((name) => join(root, name)).filter(ownsPlugin)
    return candidates.length === 1 ? candidates[0] : undefined
  } catch { return undefined }
}

/**
 * 读取选中 profile 的 link 依赖状态。
 * @private
 * @author ddj 2026年09月28号
 * @param dir 已选定目录
 * @returns 开发形态；无法读取时未开启
 */
function readProfileForm(dir: string): DevFormInfo {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    const spec = pkg?.dependencies?.[PLUGIN_NAME]
    if (typeof spec === 'string' && spec.startsWith('link:')) return { enabled: true, path: spec.slice(5) }
  } catch { /* 只读探测失败 */ }
  return { enabled: false }
}

/**
 * 读取当前运行 profile 的开发形态。
 * @public
 * @author ddj 2026年09月28号
 * @param ctx DSH host 上下文
 * @returns 开发形态状态
 */
export function readDevForm(ctx?: Ctx): DevFormInfo {
  const dir = findProfileDir(ctx)
  return dir ? readProfileForm(dir) : { enabled: false }
}
// --endregion

/**
 * 规划切换后的 manifest，保留其它字段。
 * @public
 * @author ddj 2026年09月28号
 * @param text 原 manifest 文本
 * @param enabled true 为开发链接
 * @param path 开发目录
 * @param version 正式版本号
 * @returns 新 manifest 文本
 * @throws JSON 或 dependencies 无效
 */
export function planManifest(text: string, enabled: boolean, path: string, version: string): string {
  const data = JSON.parse(text.replace(/^\uFEFF/, '')) as { dependencies?: Record<string, unknown> }
  if (!data.dependencies || typeof data.dependencies !== 'object' || Array.isArray(data.dependencies)) {
    throw new Error('profile package.json 缺少 dependencies 字段')
  }
  data.dependencies[PLUGIN_NAME] = enabled ? 'link:' + path.replace(/\\/g, '/') : '^' + version
  return JSON.stringify(data, null, 2) + '\n'
}

// --region 切换事务
/**
 * 检查开发目录属于本插件且不位于会被替换的 node_modules 内。
 * @private
 * @author ddj 2026年09月28号
 * @param dir profile 目录
 * @param target 用户目标路径
 * @returns 真实绝对目录
 * @throws 目录、包身份或位置不安全
 */
function checkTarget(dir: string, target: string): string {
  if (!target || !isAbsolute(target)) throw new Error('开启开发形态需要提供工作区绝对路径')
  const full = realpathSync(target)
  if (!statSync(full).isDirectory()) throw new Error('工作区路径不是目录：' + target)
  const pkg = JSON.parse(readFileSync(join(full, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
  if (pkg?.name !== PLUGIN_NAME) throw new Error('工作区 package.json.name 必须是 ' + PLUGIN_NAME)
  const modules = join(dir, 'node_modules')
  const moduleRoot = existsSync(modules) ? realpathSync(modules) : resolve(realpathSync(dir), 'node_modules')
  const inside = relative(moduleRoot, full)
  if (!inside || (!inside.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(inside))) {
    throw new Error('开发源码不能位于当前 profile 的 node_modules 内')
  }
  return full
}

/**
 * 删除安装入口；链接仅 unlink，绝不递归其源码目标。
 * @private
 * @author ddj 2026年09月28号
 * @param path 安装入口或备份入口
 * @throws 删除失败
 */
function removeEntry(path: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) return
  if (info.isSymbolicLink()) unlinkSync(path)
  else rmSync(path, { recursive: true, force: true })
}

/**
 * 在首次写入前保存 manifest/lockfile 原字节，并移动原安装入口保留链接身份。
 * @private
 * @author ddj 2026年09月28号
 * @param dir profile 目录
 * @returns 可回滚的备份
 * @throws 备份失败；尚未修改 manifest
 */
function backupProfile(dir: string): ProfileBackup {
  const files = ['package.json', 'pnpm-lock.yaml'].map((name) => {
    const path = join(dir, name)
    return { path, text: existsSync(path) ? readFileSync(path) : undefined }
  })
  const backupDir = mkdtempSync(join(dir, '.vscode-mode-backup-'))
  const link = join(dir, 'node_modules', PLUGIN_NAME)
  const savedLink = join(backupDir, 'module')
  const hadLink = !!lstatSync(link, { throwIfNoEntry: false })
  try {
    for (const file of files) {
      if (file.text !== undefined) writeFileSync(join(backupDir, relative(dir, file.path)), file.text)
    }
    if (hadLink) renameSync(link, savedLink)
    return { dir: backupDir, link, savedLink, hadLink, files }
  } catch (error) {
    rmSync(backupDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * 恢复原安装入口和配置文件；恢复失败时保留备份供恢复。
 * @private
 * @author ddj 2026年09月28号
 * @param saved 原状态备份
 * @throws 回滚失败，错误包含备份位置
 */
function restoreProfile(saved: ProfileBackup): void {
  const failures: string[] = []
  try {
    removeEntry(saved.link)
    if (saved.hadLink) renameSync(saved.savedLink, saved.link)
  } catch (error) { failures.push(String(error)) }
  for (const file of saved.files) {
    try {
      if (file.text === undefined) rmSync(file.path, { force: true })
      else writeFileSync(file.path, file.text)
    } catch (error) { failures.push(String(error)) }
  }
  if (failures.length) throw new Error('回滚失败，备份保留于 ' + saved.dir + '：' + failures.join('; '))
  rmSync(saved.dir, { recursive: true, force: true })
}

/**
 * 执行已预检的切换；安装失败时恢复原入口及 manifest/lockfile。
 * @private
 * @author ddj 2026年09月28号
 * @param ctx host 上下文
 * @param dir 已确定的 profile
 * @param enabled 目标形态
 * @param target 已预检目标
 * @returns 事务结果；成功需重启
 */
async function switchProfile(ctx: Ctx, dir: string, enabled: boolean, target: string): Promise<SwitchResult> {
  const version = pluginVersionOf()
  if (!version) throw new Error('读取插件版本失败，无法写入版本依赖')
  const next = planManifest(readFileSync(join(dir, 'package.json'), 'utf8'), enabled, target, version)
  const saved = backupProfile(dir)
  try {
    writeFileSync(join(dir, 'package.json'), next, 'utf8')
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    if (enabled) symlinkSync(target, saved.link, 'junction')
    await runPnpmInstall(ctx, dir)
  } catch (error) {
    restoreProfile(saved)
    throw error
  }
  try {
    removeEntry(saved.savedLink)
    rmSync(saved.dir, { recursive: true, force: true })
  } catch (error) {
    return { ok: true, error: '切换成功，旧安装备份清理失败：' + saved.dir + '：' + String(error), restart: true }
  }
  return { ok: true, restart: true }
}

/**
 * 预检运行 profile、目标与安装服务，再串行执行可回滚切换。
 * @public
 * @author ddj 2026年09月28号
 * @param ctx DSH host 上下文
 * @param enabled 目标形态
 * @param path 开发工作区绝对路径
 * @returns 结果与是否需重启；失败不提交切换
 */
export async function setDevForm(ctx: Ctx, enabled: boolean, path?: string): Promise<SwitchResult> {
  const dir = findProfileDir(ctx)
  if (!dir) return { ok: false, error: '无法唯一定位当前 profile；请检查 profileContext 或 DSH_HOME/profiles', restart: false }
  const key = process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir)
  if (switching.has(key)) return { ok: false, error: '该 profile 正在切换开发形态', restart: false }
  switching.add(key)
  try {
    const current = readProfileForm(dir)
    const raw = path ?? current.path ?? ''
    const target = enabled ? checkTarget(dir, raw) : ''
    if (enabled === current.enabled && (!enabled || resolve(dir, current.path ?? '') === target)) return { ok: true, restart: false }
    if (typeof ctx?.get?.('subprocess')?.spawn !== 'function') throw new Error('缺少 subprocess 服务，未修改 profile')
    return await switchProfile(ctx, dir, enabled, target)
  } catch (error) {
    return { ok: false, error: String(error), restart: false }
  } finally { switching.delete(key) }
}

/**
 * 使用官方 profileContext.packageManager 运行 Desktop 内置 pnpm；旧宿主使用 PATH。
 * @private
 * @author ddj 2026年09月28号
 * @param ctx host 上下文
 * @param profileDir profile 工作目录
 * @throws 启动失败或非零退出；只需退出码，stdio 使用 inherit
 */
async function runPnpmInstall(ctx: Ctx, profileDir: string): Promise<void> {
  const runner = profileOf(ctx)?.packageManager
  const handle = ctx.get('subprocess').spawn({
    argv: [runner?.command ?? 'pnpm', ...runner?.args ?? [], 'install'],
    cwd: profileDir,
    env: childEnv(runner?.env),
    stdio: { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
    graceMs: 120000,
  })
  const outcome = await handle.done
  if (outcome?.exitCode !== 0) throw new Error('pnpm install 失败（exit ' + String(outcome?.exitCode) + '）')
}
// --endregion

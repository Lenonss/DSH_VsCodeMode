/**
 * dsh-vscode-mode host — 作者页自动打包（调技能自带 `pack.mjs`）。
 *
 * 模型只写 `plans/<slug>/plan.html` 时，计划签打开前在这里跑一次官方打包脚本：
 * 输出到系统临时文件，读回后删除，绝不删改作者页与 `assets/`（与技能里 `plan.mjs`
 * 的一键流程不同——那条会清理中间产物，不能拿来处理用户文件）。
 *
 * 只读工作区：页面必须落在会话工作区内、扩展名是 `.html/.htm`、确实是文件；
 * 打包脚本本身还有自己的 `--root` 围栏与密钥过滤。
 * @author ddj 2026年11月25号
 */
import { execFile } from 'node:child_process'
import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { childEnv } from './childEnv.js'
import { skillsDirOf } from './paths.js'

//region 常量

/** 打包子进程超时（毫秒）。 */
export const PLAN_PACK_TIMEOUT_MS = 20_000

/** 打包输出上限（读回内存的字节数）。 */
export const PLAN_PACK_MAX_BYTES = 16 * 1024 * 1024

/** 结果缓存条数（按 path + mtime + size）。 */
const CACHE_MAX = 8

//endregion

//region 结构面

/** 打包执行结果。 */
interface PackRun {
  stdout: string
  stderr: string
}

//endregion

//region 缓存

/** 已打包结果：key = 绝对路径 + mtime + size。 */
const cache = new Map<string, string>()

//endregion

//region 执行

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文本
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error ?? '未知错误')
}

/**
 * 跑一次打包脚本（child_process.execFile 的 Promise 包装，保留 stdout/stderr）。
 * @author ddj 2026年11月25号
 * @param args 参数列表
 * @param cwd 工作区
 * @returns stdout / stderr
 */
function runPack(args: string[], cwd: string): Promise<PackRun> {
  return new Promise((resolvePromise, reject) => {
    execFile(process.execPath, args, {
      cwd,
      timeout: PLAN_PACK_TIMEOUT_MS,
      windowsHide: true,
      env: childEnv(),
      maxBuffer: PLAN_PACK_MAX_BYTES,
    }, (error, stdout, stderr) => {
      const out = String(stdout ?? '')
      const err = String(stderr ?? '')
      if (error) {
        reject(Object.assign(error, { packStdout: out, packStderr: err }))
        return
      }
      resolvePromise({ stdout: out, stderr: err })
    })
  })
}

/**
 * 把作者页打包成单文件 HTML（结果进内存，不落工作区）。
 * @author ddj 2026年11月25号
 * @param cwd 会话工作区绝对路径
 * @param pagePath 页面路径（绝对或相对工作区）
 * @returns 打包后的 HTML 文本
 * @throws 路径越界、文件不存在、打包失败时抛出可读错误
 */
export async function packPlanPage(cwd: string, pagePath: string): Promise<string> {
  const workspace = resolve(String(cwd ?? ''))
  const raw = String(pagePath ?? '').trim()
  if (!raw) throw new Error('缺少页面路径')

  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(workspace, raw)
  const inside = relative(workspace, absolute)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('计划页必须位于会话工作区内：' + raw)
  }
  if (!/\.html?$/i.test(absolute)) throw new Error('只打包 .html / .htm 页面：' + raw)

  const info = await stat(absolute).catch(() => null)
  if (!info || !info.isFile()) throw new Error('计划页文件不存在：' + raw)

  const key = absolute + '|' + String(info.mtimeMs) + '|' + String(info.size)
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const packScript = join(skillsDirOf(import.meta.url), 'dsh-vscodemode-html-plan', 'runtime', 'pack.mjs')
  const output = join(tmpdir(), 'dsh-htmlplan-' + String(process.pid) + '-' + String(Date.now())
    + '-' + Math.random().toString(36).slice(2, 8) + '.packed.html')

  try {
    await runPack([packScript, absolute, '-o', output, '--root', workspace, '--quiet'], workspace)
    const html = await readFile(output, 'utf8')
    cache.set(key, html)
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return html
  } catch (error) {
    const stdout = String((error as { packStdout?: unknown } | null)?.packStdout ?? '')
    const stderr = String((error as { packStderr?: unknown } | null)?.packStderr ?? '')
    const detail = (stdout.trim() || stderr.trim()).slice(-400)
    throw new Error('打包计划页失败：' + (detail || messageOf(error)))
  } finally {
    await rm(output, { force: true }).catch(() => {})
  }
}

/**
 * 清空打包结果缓存（测试与工作区切换用）。
 * @author ddj 2026年11月25号
 * @returns 无
 */
export function clearPlanPagePackCache(): void {
  cache.clear()
}

//endregion

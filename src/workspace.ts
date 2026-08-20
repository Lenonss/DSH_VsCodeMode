/**
 * dsh-vscode-mode host — 工作区文件清单扫描与缓存（快速打开/搜索用）。
 * 迁移自原 src/index.ts 的 listWorkspaceFiles，语义不改。
 * 作者 ddj 2026-08-20
 */
import type { Ctx, Session } from './store.js'
import { policyOf } from './store.js'

/** 文件清单缓存 TTL 与扫描上限（避免大工作区反复全量扫描）。 */
const FILE_INDEX_TTL = 60_000
const SCAN_CAP = 6000
/** cwd → { at, files }（随会话销毁清理）。 */
const fileIndex = new Map<string, { at: number; files: string[] }>()

/**
 * 扫描工作区文件清单（快速打开/搜索用）：subprocess（Windows powershell / POSIX find），
 * 排除常见重目录，容量上限 SCAN_CAP；结果缓存（TTL FILE_INDEX_TTL）。失败返回 null。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文
 * @param session 会话（取工作区根）
 * @param cwd 工作区目录
 * @returns 绝对路径清单；不可用（无 subprocess/fs）或扫描失败返回 null
 */
export async function listWorkspaceFiles(ctx: Ctx, session: Session, cwd: string): Promise<string[] | null> {
  const cached = fileIndex.get(cwd)
  if (cached && Date.now() - cached.at < FILE_INDEX_TTL) return cached.files
  const sub = ctx.get('subprocess')
  const fs = ctx.get('fs')
  if (!sub || !fs) return null
  const policy = policyOf(ctx, session)
  let root: string
  try {
    const rootTarget = await fs.resolve(policy?.workspaceRoot ?? '.', {})
    root = fs.processPath(rootTarget)
  } catch (error) {
    root = cwd
  }
  const lines: string[] = []
  const run = async (argv: string[]): Promise<void> => {
    const handle = sub.spawn({
      argv,
      stdio: { stdout: { maxBytes: 8 << 20 }, stderr: { maxBytes: 1 << 16 }, stdin: 'ignore' },
      graceMs: 20000,
    })
    const outcome = await handle.done
    const code = outcome?.exitCode ?? outcome?.code
    if (code !== 0) throw new Error('scan exit ' + code)
    const text = handle.collected?.stdout?.readFrom(0).text ?? ''
    for (const ln of text.split(/\r?\n/)) {
      const s = ln.trim()
      if (s) lines.push(s)
    }
  }
  try {
    if (process.platform === 'win32') {
      const cmd = 'Get-ChildItem -LiteralPath "' + String(root).replace(/"/g, '""') + '" -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch \'(node_modules|\\.git|\\.tmp|\\.cache|dist|build|vendor|coverage|__pycache__)\' } | Select-Object -First ' + SCAN_CAP + ' | ForEach-Object { $_.FullName }'
      await run(['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd])
    } else {
      const cmd = 'find ' + JSON.stringify(root) + ' -type f -not -path \'*/node_modules/*\' -not -path \'*/.git/*\' -not -path \'*/.tmp/*\' -not -path \'*/.cache/*\' -not -path \'*/dist/*\' -not -path \'*/build/*\' -not -path \'*/vendor/*\' -not -path \'*/coverage/*\' 2>/dev/null | head -n ' + SCAN_CAP
      await run(['/bin/sh', '-c', cmd])
    }
  } catch (error) {
    console.error('edrv scan failed', error)
    return null
  }
  const files = lines.slice(0, SCAN_CAP)
  if (files.length) fileIndex.set(cwd, { at: Date.now(), files })
  return files
}

/** 会话销毁时清理文件索引缓存。 */
export function dropFileIndex(cwd: string): void {
  fileIndex.delete(cwd)
}

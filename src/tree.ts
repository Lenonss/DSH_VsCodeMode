/**
 * dsh-vscode-mode host — 目录树纯函数（edrv.listDir 的数据整形与守卫）。
 * 不触 fs/node，仅结构类型，可单测；RPC handler 只做装配，判定都收在这里。
 * 作者 ddj 2026-08-26
 */
import type { TreeEntry } from './shared/rpc.js'

/** fs.listDir 返回项的结构最小视图（不引 dsh-fs，保持纯函数零依赖）。 */
export interface DirChildLike {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/** 目录在文件前、名称按小写字母序的比较器（对齐 VSCode 资源管理器习惯）。 */
function entryOrder(a: { name: string; type: string }, b: { name: string; type: string }): number {
  const aDir = a.type === 'directory' ? 0 : 1
  const bDir = b.type === 'directory' ? 0 : 1
  if (aDir !== bDir) return aDir - bDir
  const la = a.name.toLocaleLowerCase('en-US')
  const lb = b.name.toLocaleLowerCase('en-US')
  return la < lb ? -1 : la > lb ? 1 : 0
}

/**
 * 归一化目录相对路径：去空白、反斜杠→斜杠、去首尾斜杠、`.`→''。
 * 任一路径段为 `..` 返回 null（拒绝越界）。
 * @author ddj 2026年08月26号
 * @param path 原始相对路径（'' 表示根目录）
 * @returns 归一化相对路径（'' = 根），非法返回 null
 */
export function normalizeRel(path: string | undefined | null): string | null {
  const rel = String(path ?? '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!rel) return ''
  const segs = rel.split('/').filter((seg) => seg !== '.')
  if (!segs.length) return ''
  for (const seg of segs) {
    if (seg === '..') return null
  }
  return segs.join('/')
}

/**
 * fs.listDir 结果 → TreeEntry 数组：相对路径拼接 + 目录优先排序。
 * @author ddj 2026年08月26号
 * @param rel 父目录相对路径（'' = 根）
 * @param children 目录子项
 * @returns 排序后的树条目
 */
export function toTreeEntries(rel: string, children: DirChildLike[]): TreeEntry[] {
  const out: TreeEntry[] = []
  for (const child of children) {
    if (!child || typeof child.name !== 'string' || !child.name) continue
    out.push({
      name: child.name,
      path: rel ? rel + '/' + child.name : child.name,
      type: child.type === 'directory' ? 'directory' : child.type === 'file' ? 'file' : 'other',
      size: typeof child.size === 'number' ? child.size : undefined,
    })
  }
  return out.sort(entryOrder)
}

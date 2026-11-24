/**
 * dsh-vscode-mode client — SVN 提交/更新窗口行图标的目录判定（纯函数，可单测）。
 *
 * 为什么需要它：`svn status --xml` 的 `<wc-status>` 与 `svn update` 的文本行都不带 kind
 * （实测 status XML 只有 item/props/revision 三个属性），客户端只能自己判。先白拿一层证据：
 * 递归输出里某条目若是另一条目的上级目录，它必然是目录；剩下的（空目录、只改了属性的目录、
 * 未版本控制的目录、已删除的目录）才去问 host 查盘，够不着的按文件图标回落。
 * @author ddj 2026年11月23号
 */
import type { SvnPathKind } from '../../shared/svn.js'
import { PATH_KINDS_CAP, svnChunksOf } from '../../shared/svn.js'

/** 单次窗口判型请求的总量上限（3 批）：超出的路径按文件图标回落，不无限追加请求。 */
export const KIND_QUERY_MAX = PATH_KINDS_CAP * 3

/**
 * 从清单本身推断目录：某路径是另一条目的上级目录时，它一定是目录。
 *
 * 复杂度与总层级深度成正比（不是两两比较），4000 条清单也只是一次线性扫。
 * @author ddj 2026年11月23号
 * @param paths 清单内全部路径（`/` 分隔，工作副本相对）
 * @returns 可确定为目录的路径集合
 */
export function dirsFromChildren(paths: readonly string[]): Set<string> {
  const all = new Set(paths)
  const dirs = new Set<string>()
  for (const path of paths) {
    let at = path.lastIndexOf('/')
    while (at > 0) {
      const parent = path.slice(0, at)
      if (all.has(parent)) dirs.add(parent)
      at = parent.lastIndexOf('/')
    }
  }
  return dirs
}

/**
 * 判定不出、需要问 host 的路径（去重、去空、保持原顺序）。
 * @author ddj 2026年11月23号
 * @param paths 清单内全部路径
 * @param dirs 已由子项关系确定的目录集合
 * @returns 待查路径列表
 */
export function kindCandidatesOf(paths: readonly string[], dirs: ReadonlySet<string>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const path of paths) {
    if (!path || dirs.has(path) || seen.has(path)) continue
    seen.add(path)
    out.push(path)
  }
  return out
}

/**
 * 待查路径按 host 单次上限分块（含总量上限，超出部分不问）。
 * @author ddj 2026年11月23号
 * @param candidates 待查路径（见 kindCandidatesOf）
 * @param max 总量上限
 * @returns 分块列表；空数组 = 不需要请求
 */
export function kindQueryChunksOf(candidates: readonly string[], max = KIND_QUERY_MAX): string[][] {
  if (!candidates.length) return []
  const capped = candidates.length > max ? candidates.slice(0, Math.max(0, max)) : candidates
  return svnChunksOf(capped, PATH_KINDS_CAP)
}

/**
 * 多块响应合并成一张表（后到的覆盖先到的：同一路径取值一致，覆盖无害）。
 * @author ddj 2026年11月23号
 * @param tables 各块返回的路径 → 类型表
 * @returns 合并后的表
 */
export function mergeKindsOf(...tables: ReadonlyArray<Readonly<Record<string, SvnPathKind>>>): Record<string, SvnPathKind> {
  const merged: Record<string, SvnPathKind> = {}
  for (const table of tables) {
    for (const [path, kind] of Object.entries(table)) merged[path] = kind
  }
  return merged
}

/**
 * 最终判定：子项关系说它是目录，或 host 说它是目录，都算目录。
 *
 * `missing`（磁盘上没有）不算目录：已删除的条目画文件图标，不误导成「这个目录还在」。
 * @author ddj 2026年11月23号
 * @param path 条目路径
 * @param dirs 子项关系确定的目录集合
 * @param kinds host 返回的类型表
 * @returns 是否按目录图标显示
 */
export function isDirOf(
  path: string,
  dirs: ReadonlySet<string>,
  kinds: Readonly<Record<string, SvnPathKind | undefined>>,
): boolean {
  return dirs.has(path) || kinds[path] === 'dir'
}

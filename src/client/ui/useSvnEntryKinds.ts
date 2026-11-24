/**
 * dsh-vscode-mode client — SVN 行图标的目录判定钩子（提交窗口 / 更新窗口 / 侧栏面板共用）。
 *
 * 判定顺序：先用子项关系白拿（某条目是另一条目的上级目录 → 必是目录），
 * 剩下的路径按 host 单次上限分块查盘；请求失败或尚未返回时表为空，行按文件图标回落。
 * 三处窗口共用同一个钩子，避免判定口径与请求节奏各写一份后漂移。
 * @author ddj 2026年11月23号
 */
import React from 'react'
import type { SvnPathKind } from '../../shared/svn.js'
import { svnPathKinds } from '../svnStatus.js'
import { dirsFromChildren, kindCandidatesOf, kindQueryChunksOf, mergeKindsOf } from './svnIcons.js'

/** 一轮判定结果：已确定的目录集合 + host 类型表。 */
export interface SvnEntryKinds {
  /** 子项关系确定的目录集合。 */
  dirs: ReadonlySet<string>
  /** host 返回的类型表（未出现的路径按文件处理）。 */
  kinds: Readonly<Record<string, SvnPathKind>>
}

/** 调用方约束。 */
export interface SvnEntryKindsOptions {
  /** 只允许查这些路径（更新窗口只查工作区内的 relPath，工作区外的行不 stat）。 */
  only?: ReadonlySet<string> | null
  /** 请求合并窗（毫秒）：流式出行期间只保留最后一次；默认 0 = 立即请求。 */
  debounceMs?: number
}

/**
 * 计算行图标用的目录判定结果。
 *
 * `paths` 需要调用方自己 memo（面板与窗口都已有派生集合），否则每帧重算子项关系。
 * @author ddj 2026年11月23号
 * @param paths 本轮要显示的条目路径（`/` 分隔）
 * @param sessionId 会话 id
 * @param options 可查路径白名单与合并窗
 * @returns 目录集合与类型表
 */
export function useSvnEntryKinds(
  paths: readonly string[],
  sessionId?: string,
  options: SvnEntryKindsOptions = {},
): SvnEntryKinds {
  const [kinds, setKinds] = React.useState<Record<string, SvnPathKind>>({})
  const dirs = React.useMemo(() => dirsFromChildren(paths), [paths])

  const only = options.only ?? null
  const candidates = React.useMemo(() => {
    const list = kindCandidatesOf(paths, dirs)
    return only ? list.filter((path) => only.has(path)) : list
  }, [paths, dirs, only])
  const signature = candidates.join('\n')
  const delay = options.debounceMs ?? 0

  React.useEffect(() => {
    const chunks = kindQueryChunksOf(candidates)
    if (!chunks.length) { setKinds({}); return () => {} }

    let alive = true
    /**
     * 逐块并发请求后合并（node 端每块内部再并发 16 条）。
     * @author ddj 2026年11月23号
     */
    const run = () => {
      void Promise.all(chunks.map((chunk) => svnPathKinds(sessionId, chunk))).then((tables) => {
        if (alive) setKinds(mergeKindsOf(...tables))
      })
    }
    if (!delay) { run(); return () => { alive = false } }

    const timer = setTimeout(run, delay)
    return () => { alive = false; clearTimeout(timer) }
  }, [signature, sessionId, delay])

  return { dirs, kinds }
}

/**
 * dsh-vscode-mode client — 已打开文件的外部改动轮询。
 *
 * 背景：RPC 只有客户端拉取通道（无服务端推送），编辑区因此无法感知外部写盘。
 * 本 hook 以轻量接口补上感知：每 POLL_MS 一次把「全部已打开页签路径」批量交给
 * host edrv.versions（单请求多条 stat），逐条与本地基线比对后按 watchDecision 的
 * 判定表把动作回调给 EditorView 执行（IO 与 UI 都在那里）。
 *
 * 为何「版本变了还要读内容」：host 版本令牌含 ctime，同字节重写（格式化工具/同步盘/
 * 编辑器保存策略）也会让它变化，只看版本会把无实质变化的文件反复重载（打断光标与
 * 滚动）。故版本变化时读一次磁盘内容与缓冲比对，相同则只推进基线；读取结果按版本
 * 记入 readVersions，同一版本只读一次（陈旧缓冲长期不处理也不会反复拉大文件）。
 *
 * 取舍：不使用 fs.watch（句柄/网络盘/长路径兼容性差），纯 stat+按需读轮询跨平台稳定
 * 且可单测；1.5s 周期对「外部改文件 → 编辑区可见」足够及时，标签页隐藏时整轮跳过。
 *
 * 上报规则（避免每轮都弹提示）：
 * - 首次观测某路径（无标记）：报 conflict/deleted，并落标记；
 * - 已有标记且仍异常：不再重复回调（提示已在屏上），版本恢复一致时自动清标记；
 * - 站点不可达（老 host 无此方法/离线）：整轮静默放弃，不清标记、不放大重试。
 *
 * 作者 ddj 2026-09-15
 */
import * as React from 'react'
import { rpc } from '../rpc.js'
import type { FileVersionItem } from '../../shared/rpc.js'
import {
  baselineOf,
  clearReadVersion,
  clearSync,
  markReadVersion,
  markSync,
  readSync,
  readVersionOf,
  recordBaseline,
  syncDecision,
  versionOf,
} from '../watchDecision.js'

/** 轮询周期：外部改动可见延迟上限（标签页隐藏时跳过整轮）。 */
export const POLL_MS = 1500

/** 同步判定结果（hook 只说「发生了什么」，怎么处理由调用方决定）。 */
export interface DiskChange {
  path: string
  kind: 'modified' | 'conflict' | 'deleted'
}

/** 读盘结果（供内容比对）。 */
export interface DiskContent {
  /** 磁盘内容是否与调用方缓冲内容相同。 */
  equal: boolean
}

/** 一轮判定的上下文（ref 与回调打包，避免 evaluate 参数过长；导出供测试构造）。 */
export interface PollContext {
  sessionId: string
  scope: string
  dirtyRef: React.MutableRefObject<Record<string, boolean>>
  onReadDisk?: (path: string) => Promise<DiskContent | null>
  onChange: (change: DiskChange) => void
}

/** hook 选项（ref 传入最新值，避免把轮询循环写进 React 依赖数组）。 */
export interface FileWatchOptions {
  /** 会话 id（缺失时不轮询）。 */
  sessionId?: string | null
  /** 工作区作用域键（基线/台账按它隔离）。 */
  scope: string
  /** 当前全部页签路径（读 ref 取最新值）。 */
  tabsRef: React.MutableRefObject<string[]>
  /** 脏标记表（path → 是否待保存）。 */
  dirtyRef: React.MutableRefObject<Record<string, boolean>>
  /**
   * 版本变化时读磁盘内容（与调用方缓冲内容比对用）；
   * 未实现/失败返回 null → 干净缓冲按「需要重载」处理，脏缓冲按冲突处理。
   */
  onReadDisk?: (path: string) => Promise<DiskContent | null>
  /** 同步动作回调（EditorView 负责重载、提示、刷新差异标记）。 */
  onDiskChange: (change: DiskChange) => void
}

/**
 * 装配外部改动轮询（挂载即开始，卸载/换会话即停）。
 * @author ddj 2026年09月15号
 * @param options 会话/作用域/ref 与回调
 */
export function useFileWatch(options: FileWatchOptions): void {
  const { sessionId, scope, tabsRef, dirtyRef, onReadDisk, onDiskChange } = options
  const cbRef = React.useRef(onDiskChange)
  cbRef.current = onDiskChange
  const readRef = React.useRef(onReadDisk)
  readRef.current = onReadDisk
  /** 在途守卫：上一轮未返回（host 卡住）时跳过本轮，避免请求堆积。 */
  const busyRef = React.useRef(false)

  React.useEffect(() => {
    if (!sessionId) return
    const context: PollContext = {
      sessionId,
      scope,
      dirtyRef,
      onReadDisk: (path) => (readRef.current ? readRef.current(path) : Promise.resolve(null)),
      onChange: (change) => cbRef.current(change),
    }
    /**
     * 一轮观测：批量取版本 → 逐条判定 → 回调。
     * @author ddj 2026年09月15号
     */
    const poll = async (): Promise<void> => {
      if (busyRef.current) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const paths = (tabsRef.current ?? []).filter((p) => typeof p === 'string' && p)
      if (!paths.length) return
      busyRef.current = true
      try {
        const res = await rpc('edrv.versions', { sessionId, paths })
        if (!res || !res.ok || !Array.isArray(res.items)) return
        for (const item of res.items) {
          if (!item || !item.path) continue
          await evaluate(item, context)
        }
      } catch (error) {
        // 老 host 无此方法 / 离线：静默停摆这一轮，不清任何标记
      } finally {
        busyRef.current = false
      }
    }
    const timer = window.setInterval(() => { void poll() }, POLL_MS)
    void poll()
    return () => window.clearInterval(timer)
  }, [sessionId, scope])
}

/**
 * 单条判定：按 watchDecision 的判定表决定动作，必要时清/落台账标记。
 * 版本变化时先读磁盘内容（同版本只读一次）再定分支：内容相同只推进基线，
 * 内容不同且缓冲脏才升级为冲突提示。
 *
 * 导出原因：这是「观测 → 动作派发」的关键落点（三条分支各自的副作用不轻），
 * 用假 fetch + 假 context 可直接驱动它做端到端断言，无需渲染 React 树。
 * 仅供测试与同模块内 poll 调用，不属于对外 API。
 * @author ddj 2026年09月15号
 * @param item host 版本条目
 * @param context 轮询上下文（作用域/脏标记/读盘/回调）
 */
export async function evaluate(item: FileVersionItem, context: PollContext): Promise<void> {
  const path = item.path
  const scope = context.scope
  const baseline = baselineOf(scope, path)
  const version = versionOf(item)
  const missing = item.type === 'missing'
  const dirty = context.dirtyRef.current?.[path] === true
  // 无基线但拿到版本：补记基线（首次观测不报变化，避免开页即弹提示）
  if (!baseline) {
    recordBaseline(scope, path, version)
    return
  }
  const versionChanged = version !== baseline
  if (!versionChanged && !missing) {
    clearSync(scope, path) // 版本恢复一致：清掉历史标记（含误报自愈）
    return
  }
  // 版本变了但内容一致（同字节重写：格式化工具/同步盘/编辑器保存策略）：
  // 只推进基线，绝不通知调用方重载——那会白刷一次并打断光标与滚动。
  const mode = await inspect(path, version, context)
  if (mode.known && mode.equal) {
    recordBaseline(scope, path, version)
    markReadVersion(scope, path, version, true)
    clearSync(scope, path)
    return
  }
  const action = syncDecision({ hasBaseline: true, versionChanged, missing, clean: !dirty, contentEqual: mode.equal })
  if (action === 'sync-silent') {
    clearSync(scope, path)
    if (mode.known) {
      recordBaseline(scope, path, version) // 内容不同：先推进基线，随后由调用方重载
      markReadVersion(scope, path, version, false)
    } else {
      clearReadVersion(scope, path) // 读失败：交重载重新读盘（并重试比对）
    }
    context.onChange({ path, kind: 'modified' })
    return
  }
  if (action === 'none') return
  const kind = action === 'deleted' ? 'deleted' : 'conflict'
  const flagged = readSync(scope, path)
  if (flagged && flagged.kind === kind) return
  markSync(scope, path, kind)
  context.onChange({ path, kind })
}

/**
 * 读盘并与调用方缓冲比对（脏缓冲也需要：内容相同就不该报冲突）。
 * 同版本只读一次：已读过该版本的路径直接回放当时的比对结果（不重复拉取大文件）。
 * @author ddj 2026年09月15号
 * @param path 文件路径
 * @param version 当前磁盘版本（可为 null）
 * @param context 轮询上下文
 * @returns { known: 是否拿到磁盘内容, equal: 内容是否与缓冲一致 }
 */
async function inspect(
  path: string,
  version: string | null,
  context: PollContext,
): Promise<{ known: boolean; equal: boolean }> {
  if (!version) return { known: false, equal: false }
  const cached = readVersionOf(context.scope, path, version)
  if (cached) return { known: true, equal: cached.equal }
  const disk = await context.onReadDisk?.(path).catch(() => null)
  if (!disk) return { known: false, equal: false }
  markReadVersion(context.scope, path, version, disk.equal)
  return { known: true, equal: disk.equal }
}

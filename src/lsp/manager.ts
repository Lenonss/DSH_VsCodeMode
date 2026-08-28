/**
 * dsh-vscode-mode host — LSP 服务器管理器。
 * 实例注册表（key=root|languageId，refcount 共享），崩溃退避重启，session/disposed 清理。
 * 作者 ddj 2026-08-27
 */
import { createLspServer, type LspServer } from './server.js'
import type { LspProviderSpec } from './providers.js'
import type { LspServerStatus } from '../shared/lsp.js'

interface Entry {
  key: string
  server: LspServer
  refs: number
  failures: number
  restartTimer: ReturnType<typeof setTimeout> | null
}

const BACKOFF_MS = [1000, 5000, 30000]
const MAX_FAILURES = 3

export interface LspManager {
  /** 获取（或惰性创建）某工作区+语言的服务器；refs+1。 */
  acquire(root: string, languageId: string, resolveSpec: (languageId: string) => LspProviderSpec): LspServer
  /** 释放引用；refs 归零时停止服务器。 */
  release(root: string, languageId: string): void
  /** 释放工作区下全部语言（session/disposed 用）。 */
  releaseRoot(root: string): void
  /** 状态快照。 */
  statusAll(): LspServerStatus[]
  /** 查询已注册的工作区+语言服务器，不增加引用计数。 */
  peek(root: string, languageId: string): LspServer | undefined
  /** 停止并清空全部（卸载/退出）。 */
  disposeAll(): Promise<void>
  /** 监听状态变化（用于 UI）。 */
  onStatusChange: ((status: LspServerStatus) => void) | null
}

/**
 * 创建 LSP 管理器。
 * @author ddj 2026年08月27号
 * @param logger 诊断日志
 * @returns 管理器
 */
export function createLspManager(logger?: (line: string) => void): LspManager {
  const entries = new Map<string, Entry>()
  const keyOf = (root: string, languageId: string): string => root + '|' + languageId

  const log = (line: string): void => logger?.('[lsp-manager] ' + line)

  /** 同步摘除注册表项并后台回收（refs 归零/工作区清理用；statusAll 立即可见归零）。 */
  const dropEntry = (entry: Entry): void => {
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer)
      entry.restartTimer = null
    }
    entries.delete(entry.key)
    void entry.server.dispose().catch(() => {})
  }

  const scheduleRestart = (entry: Entry): void => {
    if (entry.restartTimer) return
    if (entry.failures >= MAX_FAILURES) {
      log('unavailable after ' + entry.failures + ' failures: ' + entry.key)
      return
    }
    const delay = BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length - 1)]
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null
      if (!entries.has(entry.key)) return
      void (async () => {
        const ok = await entry.server.start()
        if (!ok) entry.failures++
        else entry.failures = 0
        if (!ok && entries.has(entry.key)) scheduleRestart(entry)
      })()
    }, delay)
  }

  const manager: LspManager = {
    acquire(root: string, languageId: string, resolveSpec: (languageId: string) => LspProviderSpec): LspServer {
      const key = keyOf(root, languageId)
      let entry = entries.get(key)
      if (!entry) {
        const spec = resolveSpec(languageId)
        const server = createLspServer(spec, root, languageId, log)
        server.onStateChange = (status) => manager.onStatusChange?.(status)
        entry = { key, server, refs: 0, failures: 0, restartTimer: null }
        entries.set(key, entry)
        // 惰性启动：若 spec ready 才启动，否则保持 idle（供 status 展示 reason）
        if (spec.ready) {
          void server.start().then((ok) => {
            if (!ok && entries.has(key)) entry!.failures++
          })
        }
      }
      entry.refs++
      return entry.server
    },

    release(root: string, languageId: string): void {
      const entry = entries.get(keyOf(root, languageId))
      if (!entry) return
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.refs === 0) dropEntry(entry)
    },

    releaseRoot(root: string): void {
      for (const entry of [...entries.values()]) {
        if (entry.server.root === root) dropEntry(entry)
      }
    },

    statusAll(): LspServerStatus[] {
      return [...entries.values()].map((entry) => entry.server.status())
    },

    peek(root: string, languageId: string): LspServer | undefined {
      return entries.get(keyOf(root, languageId))?.server
    },

    async disposeAll(): Promise<void> {
      const list = [...entries.values()]
      entries.clear()
      for (const entry of list) {
        if (entry.restartTimer) clearTimeout(entry.restartTimer)
        await entry.server.dispose()
      }
    },

    onStatusChange: null,
  }
  return manager
}

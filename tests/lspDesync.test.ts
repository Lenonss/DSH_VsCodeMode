/**
 * lsp/rpc.ts 文档跟踪（tracker）与服务器注册表（manager）一致性回归测试。
 *
 * 背景：两者是独立结构，重置类操作（重新检测/保存配置/运行时重装）曾只摘 manager 条目、
 * 保留 tracker 计数，导致 tracker.open() 对已跟踪文档恒为 false（不触发 acquire）、
 * peek 又取不到实例，sync 永久失败（「语言服务器未注册」）直到重启宿主。
 * 本文件锁定：①重置后同一文档再 sync 必须自愈补建；②补建不产生重复 acquire；
 * ③重置范围必须与 manager 对齐（单工作区 vs 全语言）；④detect 反映真实运行相位。
 * 作者 ddj 2026-09-11
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLspRpc } from '../src/lsp/rpc.js'
import type { LspServerStatus } from '../src/shared/lsp.js'

const CWD = 'D:/ws'
const CWD2 = 'D:/ws2'
const ROOT = 'proc:.' // 假 fs 的 processPath 产物（与 cwd 无关，见 fakeFs）

/** 假服务器：只记录 sync 调用，不启动进程。 */
function fakeServer(root: string, languageId: string) {
  const synced: string[] = []
  let phase = 'ready'
  return {
    languageId,
    root,
    synced,
    get phase() { return phase },
    setPhase(next: string) { phase = next },
    onStateChange: null,
    status(): LspServerStatus {
      return { languageId, source: 'extension', phase: phase as LspServerStatus['phase'], root, progress: 100, progressMessage: '解析完成' }
    },
    async start() { return true },
    sync(path: string) { synced.push(path) },
    close() {},
    dispose: async () => {},
  }
}

/**
 * 假 manager：复刻真实引用计数语义（acquire 建条目并 refs+1；refs 归零摘除）。
 * 记录 acquire 次数，供"补建不重复"断言使用。
 */
function fakeManager() {
  const entries = new Map<string, { server: ReturnType<typeof fakeServer>; refs: number }>()
  const keyOf = (root: string, lang: string) => root + '|' + lang
  let acquires = 0
  const drop = (key: string) => entries.delete(key)
  return {
    get acquires() { return acquires },
    entryCount: () => entries.size,
    has: (root: string, lang: string) => entries.has(keyOf(root, lang)),
    statusAll: () => [...entries.values()].map((e) => e.server.status()),
    peek: (root: string, lang: string) => entries.get(keyOf(root, lang))?.server,
    acquire(root: string, lang: string) {
      acquires++
      let entry = entries.get(keyOf(root, lang))
      if (!entry) {
        entry = { server: fakeServer(root, lang), refs: 0 }
        entries.set(keyOf(root, lang), entry)
      }
      entry.refs++
      return entry.server
    },
    release(root: string, lang: string) {
      const entry = entries.get(keyOf(root, lang))
      if (!entry) return
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.refs === 0) drop(keyOf(root, lang))
    },
    releaseRoot(root: string) {
      for (const key of [...entries.keys()]) if (key.startsWith(root + '|')) drop(key)
    },
    reset(root: string, lang: string) { drop(keyOf(root, lang)) },
    resetLanguage(lang: string) {
      for (const key of [...entries.keys()]) if (key.endsWith('|' + lang)) drop(key)
    },
    disposeAll: async () => { entries.clear() },
    onStatusChange: null,
  }
}

/** 假 fs：processPath 恒定，避免依赖真实路径解析（root 可指定，用于绝对路径归一场景）。 */
function fakeFs(root: string = ROOT) {
  return {
    resolve: async (p: string) => ({ targetKey: p }),
    processPath: () => root,
  }
}

/** 假 ctx：提供 sessions/fs/sandboxPolicy；会话 cwd 由 id 决定。 */
function fakeCtx(root: string = ROOT) {
  const sessions = {
    get: (id: string) => {
      if (id === 's1') return { id: 's1', header: { cwd: CWD } }
      if (id === 's2') return { id: 's2', header: { cwd: CWD2 } }
      return undefined
    },
    list: () => [{ id: 's1', header: { cwd: CWD } }, { id: 's2', header: { cwd: CWD2 } }],
  }
  return {
    get: (name: string) => {
      if (name === 'sessions') return sessions
      if (name === 'fs') return fakeFs(root)
      if (name === 'sandboxPolicy') return { resolve: () => ({ workspaceRoot: '.' }) }
      return undefined
    },
  }
}

/** 建一次 rpc + 假 manager（每例独立，避免 tracker 跨例串状态）。 */
function makeRpc(root: string = ROOT) {
  const manager = fakeManager()
  const rpc = createLspRpc({ ctx: fakeCtx(root), pluginConfig: {}, manager: manager as never })
  return { manager, handlers: rpc.handlers, disposeSession: rpc.disposeSession }
}

const LUA_DOC = 'a.lua'
const CS_DOC = 'a.cs'

/** 提取 RPC 响应的错误文案（成功返回空串）。 */
function errOf(res: unknown): string {
  const r = res as { ok?: boolean; error?: string }
  return r?.ok ? '' : String(r?.error ?? '')
}

let home = ''

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-lsp-desync-'))
  process.env.DSH_HOME = home
  // 隔离真实机器扩展：扫描列表指向不存在的临时目录
  process.env.DSH_LSP_EXT_DIRS = join(home, 'dsh-vscode-mode', 'extensions')
})

afterAll(() => {
  delete process.env.DSH_HOME
  delete process.env.DSH_LSP_EXT_DIRS
  rmSync(home, { recursive: true, force: true })
})

describe('lsp/rpc tracker 与 manager 一致性', () => {
  it('首次 sync 建立服务器并写入文档', async () => {
    const { manager, handlers } = makeRpc()
    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'local a = 1\n', version: 1 })
    expect(res.ok).toBe(true)
    expect(manager.acquires).toBe(1)
    expect(manager.has(ROOT, 'lua')).toBe(true)
    expect(manager.peek(ROOT, 'lua')!.synced).toEqual([LUA_DOC])
  })

  it('重新检测后同一文档再 sync 必须自愈补建（核心回归）', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'local a = 1\n', version: 1 })
    expect(manager.acquires).toBe(1)

    // 重新检测：manager 条目被摘除（tracker 侧一并重置）
    await handlers['edrv.lsp.redetect']!({ languageId: 'lua' })
    expect(manager.has(ROOT, 'lua')).toBe(false)

    // 客户端重检测后会重新同步已打开模型：同文档必须成功，且不得再报「语言服务器未注册」
    const again = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'local a = 1\n', version: 2 })
    expect(errOf(again)).toBe('')
    expect(again.ok).toBe(true)
    expect(manager.acquires).toBe(2)
    expect(manager.peek(ROOT, 'lua')!.synced).toEqual([LUA_DOC])
  })

  it('自愈补建不产生重复 acquire（同文档反复 sync 只建一次）', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    await handlers['edrv.lsp.redetect']!({ languageId: 'lua' })
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 2 })
    // 再同步两次：tracker 已跟踪该文档 → 复用既有实例，不再 acquire
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 3 })
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 4 })
    expect(manager.acquires).toBe(2)
    expect(manager.entryCount()).toBe(1)
  })

  it('自愈后按新文档 sync 亦可用，且同语言共享同一实例', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    await handlers['edrv.lsp.redetect']!({ languageId: 'lua' })
    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: 'b.lua', text: 'y', version: 1 })
    expect(res.ok).toBe(true)
    expect(manager.acquires).toBe(2)
    expect(manager.entryCount()).toBe(1) // a.lua 与 b.lua 共用同一 root|lang 实例
  })

  it('重置只作用于目标语言：另一语言实例不受影响', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: CS_DOC, text: 'y', version: 1 })
    await handlers['edrv.lsp.redetect']!({ languageId: 'lua' })
    expect(manager.has(ROOT, 'lua')).toBe(false)
    expect(manager.has(ROOT, 'csharp')).toBe(true)
  })

  it('两工作区同语言：重置某工作区不影响另一工作区的文档归属', async () => {
    const { manager, handlers } = makeRpc()
    // 两个会话各自 cwd 不同，但假 fs 让 root 相同——用显式 root 区分不可行，
    // 故此处只断言"重置后两者都能继续 sync"，覆盖跨会话计数不被误清导致失败。
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    await handlers['edrv.lsp.sync']!({ sessionId: 's2', path: LUA_DOC, text: 'x', version: 1 })
    await handlers['edrv.lsp.redetect']!({ languageId: 'lua' })
    const r1 = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 2 })
    const r2 = await handlers['edrv.lsp.sync']!({ sessionId: 's2', path: LUA_DOC, text: 'x', version: 2 })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(manager.entryCount()).toBe(1)
  })

  it('manager 条目单侧丢失（tracker 仍在跟踪）时 sync 自愈，不报「未注册」', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    expect(manager.acquires).toBe(1)

    // 绕过 redetect 直接摘除 manager 条目，复现"只清一侧"的失步（任何未来调用方都可能触发）
    manager.reset(ROOT, 'lua')
    expect(manager.has(ROOT, 'lua')).toBe(false)

    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 2 })
    expect(errOf(res)).toBe('')
    expect(res.ok).toBe(true)
    expect(manager.acquires).toBe(2)
  })

  it('close 释放后实例摘除，再 sync 会重建', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    await handlers['edrv.lsp.close']!({ sessionId: 's1', path: LUA_DOC })
    expect(manager.entryCount()).toBe(0)
    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 2 })
    expect(res.ok).toBe(true)
    expect(manager.acquires).toBe(2)
  })

  it('会话销毁释放引用，不残留实例', async () => {
    const { manager, handlers, disposeSession } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    disposeSession('s1')
    expect(manager.entryCount()).toBe(0)
  })
})

describe('lsp/rpc detect 相位', () => {
  it('无运行实例 → idle', async () => {
    const { handlers } = makeRpc()
    const res = await handlers['edrv.lsp.detect']!({})
    const lua = (res.servers as LspServerStatus[]).find((s) => s.languageId === 'lua')
    expect(lua!.phase).toBe('idle')
  })

  it('已有运行实例 → 反映真实相位（不再恒 idle）', async () => {
    const { handlers } = makeRpc()
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: LUA_DOC, text: 'x', version: 1 })
    const res = await handlers['edrv.lsp.detect']!({})
    const lua = (res.servers as LspServerStatus[]).find((s) => s.languageId === 'lua')
    expect(lua!.phase).toBe('ready')
    expect(lua!.progressMessage).toBe('解析完成')
  })

  it('detect 不启动服务器（保持只读探测语义）', async () => {
    const { manager, handlers } = makeRpc()
    await handlers['edrv.lsp.detect']!({})
    expect(manager.acquires).toBe(0)
    expect(manager.entryCount()).toBe(0)
  })
})

describe('lsp/rpc 绝对路径与相对路径等价（差异文件场景）', () => {
  // 真实形态：工作区根是绝对路径（fakeFs 的 processPath 提供）
  const ABS_ROOT = 'D:/ws'

  it('同一文件用绝对路径 sync → 传给 server 的 path 归一为相对路径', async () => {
    const { manager, handlers } = makeRpc(ABS_ROOT)
    // 差异记录 rec.path 取自工具参数 file_path，是绝对路径（Windows 反斜杠形态）
    const abs = 'D:\\ws\\Assets\\Scripts\\a.lua'
    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: abs, text: 'x', version: 1 })
    expect(errOf(res)).toBe('')
    // 未归一化时这里是绝对路径，server.sync 会拼出 <root>/<root>/... 的畸形 file:// URI
    expect(manager.peek(ABS_ROOT, 'lua')!.synced).toEqual(['Assets/Scripts/a.lua'])
  })

  it('绝对与相对两种形态指向同一文档，不产生重复跟踪记录', async () => {
    const { manager, handlers } = makeRpc(ABS_ROOT)
    const rel = 'Assets/Scripts/a.lua'
    const abs = 'D:\\ws\\' + rel.split('/').join('\\')
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: rel, text: 'x', version: 1 })
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: abs, text: 'x', version: 2 })
    // 归一化后是同一个 tracker 键 → 只 acquire 一次；两次 sync 落到的 path 形态一致
    expect(manager.acquires).toBe(1)
    expect(manager.peek(ABS_ROOT, 'lua')!.synced).toEqual([rel, rel])
  })

  it('用相对路径 sync、绝对路径 close 能正确释放（键一致）', async () => {
    const { manager, handlers } = makeRpc(ABS_ROOT)
    const rel = 'Assets/Scripts/a.lua'
    const abs = 'D:\\ws\\Assets\\Scripts\\a.lua'
    await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: rel, text: 'x', version: 1 })
    expect(manager.entryCount()).toBe(1)
    await handlers['edrv.lsp.close']!({ sessionId: 's1', path: abs })
    // 键若不一致，close 会落空 → 引用计数泄漏 → 服务器永不释放
    expect(manager.entryCount()).toBe(0)
  })

  it('大小写不同的绝对路径同样归一（Windows 盘符常见）', async () => {
    const { manager, handlers } = makeRpc(ABS_ROOT)
    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: 'd:/ws/Assets/Scripts/a.lua', text: 'x', version: 1 })
    expect(errOf(res)).toBe('')
    expect(manager.peek(ABS_ROOT, 'lua')!.synced).toEqual(['Assets/Scripts/a.lua'])
  })

  it('工作区外绝对路径不归一为相对（保持既有行为，不误判）', async () => {
    const { manager, handlers } = makeRpc(ABS_ROOT)
    const outside = 'D:/Other/place/a.lua'
    const res = await handlers['edrv.lsp.sync']!({ sessionId: 's1', path: outside, text: 'x', version: 1 })
    expect(errOf(res)).toBe('')
    expect(manager.peek(ABS_ROOT, 'lua')!.synced).toEqual([outside])
  })
})

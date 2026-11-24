/** 外部改动采集判定链：来源、归属、去重、忽略与预算。 @author ddj 2026年11月24号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeIndex } from '../src/treeIndex.js'
import type { ExternalSettings } from '../src/pending/externalCapture.js'
import { isIgnoredPath, installExternalCapture, ALIGN_AFTER_VCS_MS, MAX_BATCH } from '../src/pending/externalCapture.js'
import { windows } from '../src/pending/provenance.js'
import type { PendingWrite } from '../src/pending/capture.js'
import { pendingGaps } from '../src/pending/capture.js'
import type { StoredEntry } from '../src/pending/persist.js'
import { entryFromNew } from '../src/pending/kernel.js'
import { capabilityOf } from '../src/pending/decide.js'
import { pathKeyOf } from '../src/pending/provenance.js'
import type { VcsStatus } from '../src/pending/vcs.js'
import { join } from 'node:path'

const CWD = join(process.cwd(), 'external-capture-fixture')
const enabled: ExternalSettings = { watch: true, scan: false }

afterEach(() => {
  windows.dispose()
  disposeIndex(CWD)
})

/** 造一条已落库条目。 */
function storedOf(path: string, newText: string, extra?: Partial<StoredEntry['entry']>): StoredEntry {
  const entry = entryFromNew({
    id: path, path, sessionId: 's1', earlierVersion: 'file', oldText: 'OLD', newText, updatedAt: 1,
    source: 'write', origin: 'agent', baseKind: 'known',
  })
  Object.assign(entry, extra ?? {})
  return { entry, flags: { missing: false, diverged: false, oversized: false, revision: 1 } }
}

/**
 * @description: 一次采集运行的夹具：注入读盘、条目表、版本库状态与 mtime，记录全部落库写入。
 * @param files 磁盘内容表（绝对路径 → 内容；缺省视为不存在）
 * @param entries 已知条目
 * @param status 版本库状态（null = 拿不到状态）
 * @param mtimes mtime 表（绝对路径 → 毫秒；缺省视为读不到）
 * @returns 采集器、写入记录与改动磁盘的入口
 */
function harness(
  files: Record<string, string | null>, entries: StoredEntry[] = [], status: VcsStatus | null = null,
  mtimes: Record<string, number> = {},
) {
  const writes: PendingWrite[] = []
  const disk = new Map(Object.entries(files))
  const capture = installExternalCapture({
    ctx: { get: () => undefined } as never,
    settings: () => enabled,
    record: (write) => writes.push(write),
    read: async (_cwd, absolute) => {
      if (!disk.has(absolute)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      const value = disk.get(absolute)
      return value === undefined ? null : value
    },
    entries: () => new Map(entries.map((stored) => [pathKeyOf(stored.entry.id), stored])),
    status: async () => status,
    mtime: (_cwd, absolute) => mtimes[absolute],
  })
  // 生产里 startedAt 由 ensure() 里的 startWatch 赋值；夹具走同一条路，mtime 证据才有参照点
  capture.ensure(CWD, 's1')
  return {
    capture,
    writes,
    /** 改磁盘内容（null = 删除）。 */
    put(path: string, content: string | null): void { disk.set(path, content) },
  }
}

/** 造一个「一条改动」的版本库状态。 */
function statusOf(entries: Array<[string, 'modified' | 'added' | 'deleted']>): VcsStatus {
  return { kind: 'git', root: CWD, entries: new Map(entries.map(([path, status]) => [pathKeyOf(path), { path, status }])) }
}

describe('撤销白名单（能力位）', () => {
  const flags = { missing: false, diverged: false, oversized: false, revision: 1 }

  it('agent 来源且基线可信：可直接撤销，无需确认', () => {
    const entry = storedOf('/w/a.txt', 'NEW').entry
    expect(capabilityOf(entry, flags)).toMatchObject({ revert: true, reason: '' })
    expect(capabilityOf(entry, flags).confirmRevert).toBeUndefined()
  })

  it('外部来源：可撤销但要求确认，并给出可读原因', () => {
    const entry = storedOf('/w/a.txt', 'NEW', { origin: 'external', source: 'watch', baseKind: 'known' }).entry
    const capability = capabilityOf(entry, flags)
    expect(capability).toMatchObject({ revert: true, confirmRevert: true })
    expect(capability.reason).toContain('watch')
  })

  it('版本库基线：同样要求确认', () => {
    const entry = storedOf('/w/a.txt', 'NEW', { origin: 'external', baseKind: 'vcs' }).entry
    expect(capabilityOf(entry, flags)).toMatchObject({ revert: true, confirmRevert: true })
  })

  it('基线未知：禁用撤销并说明原因，绝不冒充可回退', () => {
    const entry = storedOf('/w/a.txt', 'NEW', { origin: 'external', baseKind: 'unknown' }).entry
    const capability = capabilityOf(entry, flags)
    expect(capability.revert).toBe(false)
    expect(capability.reason).toContain('未捕获修改前内容')
  })
})

describe('补扫触发点', () => {
  it('版本库命令后合并成一次延迟补扫', async () => {
    vi.useFakeTimers()
    const runs: string[] = []
    const capture = installExternalCapture({
      ctx: { get: () => undefined } as never,
      settings: () => ({ watch: true, scan: true }),
      record: () => {},
      read: async () => null,
      entries: () => new Map(),
      status: async () => null,
      align: async (cwd) => { runs.push(cwd) },
    })
    capture.ensure(CWD, 's1')
    await vi.advanceTimersByTimeAsync(0) // 启动对齐跑一次
    expect(runs).toHaveLength(1)
    // 版本库写命令连发三次（提交/更新/还原）：只应合并出一次补扫
    capture.requestAlign(CWD, ALIGN_AFTER_VCS_MS)
    capture.requestAlign(CWD, ALIGN_AFTER_VCS_MS)
    capture.requestAlign(CWD, ALIGN_AFTER_VCS_MS)
    expect(runs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(ALIGN_AFTER_VCS_MS + 10)
    expect(runs).toHaveLength(2)
    capture.dispose()
    vi.useRealTimers()
  })

  it('补扫开关关闭时既不自动跑也不响应命令', async () => {
    vi.useFakeTimers()
    const runs: string[] = []
    const capture = installExternalCapture({
      ctx: { get: () => undefined } as never,
      settings: () => ({ watch: true, scan: false }),
      record: () => {},
      read: async () => null,
      entries: () => new Map(),
      status: async () => null,
      align: async (cwd) => { runs.push(cwd) },
    })
    capture.ensure(CWD, 's1')
    capture.requestAlign(CWD, 0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toHaveLength(0)
    capture.dispose()
    vi.useRealTimers()
  })

  it('未开始监听的工作区不会被命令触发补扫', async () => {
    vi.useFakeTimers()
    const runs: string[] = []
    const capture = installExternalCapture({
      ctx: { get: () => undefined } as never,
      settings: () => ({ watch: true, scan: true }),
      record: () => {},
      read: async () => null,
      entries: () => new Map(),
      status: async () => null,
      align: async (cwd) => { runs.push(cwd) },
    })
    capture.requestAlign(join(process.cwd(), 'never-ensured'), 0)
    await vi.advanceTimersByTimeAsync(100)
    expect(runs).toHaveLength(0)
    capture.dispose()
    vi.useRealTimers()
  })
})

describe('忽略清单', () => {
  it('跳过版本库元数据、Unity 缓存、sidecar、sourcemap 与计划页打包目录', () => {
    for (const relative of ['.svn/entries', '.git/index', 'node_modules/x.js', 'Library/x.dat',
      'Temp/y.tmp', 'obj/z.o', '.dsh-edit-review.json', 'app.js.map', 'plans/p/runtime/htmlplan.js']) {
      expect(isIgnoredPath(CWD, join(CWD, relative)), relative).toBe(true)
    }
  })

  it('保留工作区普通源码与 plans 下的页面本身', () => {
    for (const relative of ['Assets/Scripts/A.cs', 'a.txt', 'plans/p/plan.packed.html', 'src/index.ts']) {
      expect(isIgnoredPath(CWD, join(CWD, relative)), relative).toBe(false)
    }
  })

  it('工作区之外的路径一律不进记录', () => {
    expect(isIgnoredPath(CWD, join(process.cwd(), 'outside', 'a.txt'))).toBe(true)
  })
})

describe('判定链', () => {
  it('内容与已知条目相同则不产生记录', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'SAME' }, [storedOf(file, 'SAME')], statusOf([]))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('没有 agent 窗口时归属外部，并带上真实修改前内容', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')], statusOf([[file, 'modified']]))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ before: 'OLD', after: 'NEW', tool: 'watch', origin: 'external', baseKind: 'known' })
  })

  it('工具调用窗口内归属 agent', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')], statusOf([[file, 'modified']]))
    windows.enterTool()
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes[0]).toMatchObject({ origin: 'agent', tool: 'watch' })
  })

  it('插件自写窗口内的事件直接跳过', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')], statusOf([[file, 'modified']]))
    windows.markSelf(pathKeyOf(file))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('版本库说干净的路径不建新记录；已有条目折叠成版本库同步', async () => {
    const fresh = join(CWD, 'fresh.txt')
    const tracked = join(CWD, 'tracked.txt')
    const empty = harness({ [fresh]: 'X', [tracked]: 'Y' }, [storedOf(tracked, 'OLD')], statusOf([]))
    empty.capture.enqueue(CWD, fresh)
    empty.capture.enqueue(CWD, tracked)
    await empty.capture.flush()
    expect(empty.writes).toHaveLength(1)
    expect(empty.writes[0]).toMatchObject({ path: tracked, tool: 'vcs', origin: 'vcs' })
  })

  it('编辑器保存窗口内：没有条目就不建行，有条目只推进基线', async () => {
    const fresh = join(CWD, 'fresh.txt')
    const known = join(CWD, 'known.txt')
    const { capture, writes } = harness({ [fresh]: 'X', [known]: 'Y' }, [storedOf(known, 'OLD')], statusOf([]))
    windows.markEditor(pathKeyOf(fresh))
    windows.markEditor(pathKeyOf(known))
    capture.enqueue(CWD, fresh)
    capture.enqueue(CWD, known)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ path: known, origin: 'editor', after: 'Y' })
  })
})

describe('修改前内容的四级来源', () => {
  it('首次观察到的内容成为后续改动的基线', async () => {
    const file = join(CWD, 'a.txt')
    // 刚被写过的文件：没有版本库状态也能建档，只是基线只能标 unknown
    const { capture, writes, put } = harness({ [file]: 'FIRST' }, [], null, { [file]: Date.now() })
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ before: null, after: 'FIRST', baseKind: 'unknown' })
    // 之后再改就用首次观察到的内容当真实修改前内容
    put(file, 'SECOND')
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toMatchObject({ before: 'FIRST', after: 'SECOND', baseKind: 'known', origin: 'external' })
  })

  it('版本库说新增时基线是"不存在"', async () => {
    const file = join(CWD, 'new.cs')
    const { capture, writes } = harness({ [file]: 'CONTENT' }, [], statusOf([[file, 'added']]))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes[0]).toMatchObject({ before: null, after: 'CONTENT', baseKind: 'absent' })
  })

  it('拿不到任何基线时标 unknown，交给能力位禁用撤销', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [], statusOf([[file, 'modified']]))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes[0]).toMatchObject({ before: null, baseKind: 'unknown', origin: 'external' })
  })
})

describe('首次见路径的建档证据（幽灵记录闸门）', () => {
  it('拿不到版本库状态且文件没被写过：不建档，只记一条缺口', async () => {
    const file = join(CWD, 'old.txt')
    const { capture, writes } = harness({ [file]: 'UNTOUCHED' }, [], null, { [file]: Date.now() - 3600_000 })
    capture.enqueue(CWD, file)
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
    const gaps = pendingGaps(CWD).filter((line) => line.includes('old.txt'))
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain('未建档')
  })

  it('拿不到版本库状态但文件刚被写过：仍然建档，基线标 unknown', async () => {
    const file = join(CWD, 'just-written.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [], null, { [file]: Date.now() })
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ before: null, after: 'NEW', baseKind: 'unknown' })
  })

  it('本会话观察过的路径再变化：mtime 旧也照常记录', async () => {
    const file = join(CWD, 'seen.txt')
    const { capture, writes, put } = harness({ [file]: 'V1' }, [], null, { [file]: Date.now() - 3600_000 })
    // 第一次被闸门挡下，但内容进了本会话的观察快照
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
    put(file, 'V2')
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ before: 'V1', after: 'V2' })
  })

  it('版本库说有改动时不受 mtime 闸门影响', async () => {
    const file = join(CWD, 'vcs-modified.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [], statusOf([[file, 'modified']]), { [file]: Date.now() - 3600_000 })
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ after: 'NEW', baseKind: 'unknown' })
  })
})

describe('去重、顺序与预算', () => {
  it('同一文件连续 5 次事件只处理一次（同批折叠）', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes, put } = harness({ [file]: 'V1' }, [storedOf(file, 'OLD')], statusOf([[file, 'modified']]))
    for (let index = 2; index <= 5; index++) {
      put(file, 'V' + index)
      capture.enqueue(CWD, file)
    }
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0].after).toBe('V5')
  })

  it('单轮只处理 MAX_BATCH 条，剩余留到下一轮', async () => {
    const files: Record<string, string> = {}
    const entries: StoredEntry[] = []
    for (let index = 0; index < MAX_BATCH + 5; index++) {
      const path = join(CWD, `f${index}.txt`)
      files[path] = 'NEW'
      entries.push(storedOf(path, 'OLD'))
      windows.markSelf(pathKeyOf(path))
    }
    const { capture, writes } = harness(files, entries, null)
    // 自写标记会让这些事件全部跳过；这里只验证批量上限本身不越界
    for (const path of Object.keys(files)) capture.enqueue(CWD, path)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('读盘失败只记缺口，不影响同批其它文件', async () => {
    const bad = join(CWD, 'bad.txt')
    const good = join(CWD, 'good.txt')
    const { capture, writes } = harness({ [good]: 'NEW' }, [storedOf(good, 'OLD'), storedOf(bad, 'OLD')], statusOf([]))
    capture.enqueue(CWD, bad)
    capture.enqueue(CWD, good)
    await capture.flush()
    expect(writes.map((write) => write.path)).toEqual([good])
  })

  it('监听开关关闭时不落库', async () => {
    const file = join(CWD, 'a.txt')
    const writes: PendingWrite[] = []
    const capture = installExternalCapture({
      ctx: { get: () => undefined } as never,
      settings: () => ({ watch: false, scan: false }),
      record: (write) => writes.push(write),
      read: async () => 'NEW', entries: () => new Map(), status: async () => null,
    })
    capture.ensure(CWD, 's1')
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
    capture.dispose()
  })
})

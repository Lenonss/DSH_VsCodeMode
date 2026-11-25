/** 差异窗口跟随器：只跟随开窗路径、只折内容、校准与预算。 @author ddj 2026年11月25号 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { disposeIndex } from '../src/treeIndex.js'
import type { ExternalSettings } from '../src/pending/externalCapture.js'
import { isIgnoredPath, installExternalCapture, MAX_BATCH, SYNC_INTERVAL_MS } from '../src/pending/externalCapture.js'
import { windows } from '../src/pending/provenance.js'
import type { PendingWrite } from '../src/pending/capture.js'
import type { StoredEntry } from '../src/pending/persist.js'
import { entryFromNew } from '../src/pending/kernel.js'
import { capabilityOf } from '../src/pending/decide.js'
import { pathKeyOf } from '../src/pending/provenance.js'
import { join } from 'node:path'

const CWD = join(process.cwd(), 'external-capture-fixture')

afterEach(() => {
  windows.dispose()
  disposeIndex(CWD)
  vi.useRealTimers()
})

/** 造一条已落库条目。 */
function storedOf(path: string, newText: string, extra?: Partial<StoredEntry['entry']>): StoredEntry {
  const entry = entryFromNew({
    id: path, path, sessionId: 's1', earlierVersion: 'file', oldText: 'OLD', newText, updatedAt: 1,
    source: 'write', origin: 'agent', baseKind: 'known', tracking: 'open', openedAt: 1,
  })
  Object.assign(entry, extra ?? {})
  return { entry, flags: { missing: false, diverged: false, oversized: false, revision: 1 } }
}

/**
 * @description: 一次采集运行的夹具：注入读盘、条目表与折叠入口，记录全部折入。
 * @param files 磁盘内容表（绝对路径 → 内容；null 表示文件不存在）
 * @param entries 已知条目（缺省没有条目 = 所有路径都未开窗）
 * @param settings 跟随开关
 * @param readOverride 覆盖读盘（模拟读失败）
 * @returns 跟随器、折入记录与改动磁盘的入口
 */
function harness(
  files: Record<string, string | null>, entries: StoredEntry[] = [],
  settings: ExternalSettings = { watch: true, scan: false },
  readOverride?: (absolute: string) => Promise<string | null>,
) {
  const writes: PendingWrite[] = []
  const disk = new Map(Object.entries(files))
  const capture = installExternalCapture({
    ctx: { get: () => undefined } as never,
    settings: () => settings,
    fold: (write) => { writes.push(write); return true },
    read: async (_cwd, absolute) => {
      if (readOverride) return readOverride(absolute)
      if (!disk.has(absolute)) return null
      return disk.get(absolute) ?? null
    },
    entries: () => entries,
  })
  capture.ensure(CWD, 's1')
  return {
    capture,
    writes,
    /** 改磁盘内容（null = 删除）。 */
    put(path: string, content: string | null): void { disk.set(path, content) },
  }
}

describe('撤销白名单（能力位）', () => {
  const flags = { missing: false, diverged: false, oversized: false, revision: 1 }

  it('agent 来源且基线可信：可直接撤销，无需确认', () => {
    const entry = storedOf('/w/a.txt', 'NEW').entry
    expect(capabilityOf(entry, flags)).toMatchObject({ revert: true, reason: '' })
    expect(capabilityOf(entry, flags).confirmRevert).toBeUndefined()
  })

  it('窗口内的编辑器保存：可撤销但要求确认，并给出可读原因', () => {
    const entry = storedOf('/w/a.txt', 'NEW', { origin: 'editor', source: 'watch', baseKind: 'known' }).entry
    const capability = capabilityOf(entry, flags)
    expect(capability).toMatchObject({ revert: true, confirmRevert: true })
    expect(capability.reason).toContain('编辑器')
  })

  it('基线未知：禁用撤销并说明原因，绝不冒充可回退', () => {
    const entry = storedOf('/w/a.txt', 'NEW', { origin: 'external', baseKind: 'unknown' }).entry
    const capability = capabilityOf(entry, flags)
    expect(capability.revert).toBe(false)
    expect(capability.reason).toContain('未捕获修改前内容')
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

describe('只跟随开窗路径', () => {
  it('没有窗口的路径：Unity 重写也不产生任何记录', async () => {
    const file = join(CWD, 'index.json')
    const { capture, writes } = harness({ [file]: 'UNITY CONTENT' }, [])
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('开窗中的路径：改动折进同一条，基线取窗口里的旧内容', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')])
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ path: file, before: 'OLD', after: 'NEW', tool: 'watch', origin: 'external' })
  })

  it('已关窗的路径：之后再改也不产生记录', async () => {
    const file = join(CWD, 'closed.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD', { tracking: 'closed' })])
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('内容与条目一致时不落库', async () => {
    const file = join(CWD, 'same.txt')
    const { capture, writes } = harness({ [file]: 'SAME' }, [storedOf(file, 'SAME')])
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('编辑器保存窗口内折入并标成编辑器来源', async () => {
    const file = join(CWD, 'editor.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')])
    windows.markEditor(pathKeyOf(file))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ origin: 'editor', after: 'NEW' })
  })

  it('插件自写窗口内的事件直接跳过', async () => {
    const file = join(CWD, 'self.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')])
    windows.markSelf(pathKeyOf(file))
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })

  it('文件被删：折成"内容为空 + 缺失"', async () => {
    const file = join(CWD, 'gone.txt')
    const { capture, writes } = harness({ [file]: null }, [storedOf(file, 'OLD')])
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ before: 'OLD', after: null })
  })
})

describe('去重、顺序与预算', () => {
  it('同一文件连续 5 次事件只折一次（同批折叠，取最新内容）', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes, put } = harness({ [file]: 'V1' }, [storedOf(file, 'OLD')])
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
    }
    const { capture, writes } = harness(files, entries)
    for (const path of Object.keys(files)) capture.enqueue(CWD, path)
    await capture.flush()
    expect(writes).toHaveLength(MAX_BATCH)
    await capture.flush()
    expect(writes).toHaveLength(MAX_BATCH + 5)
  })

  it('读盘失败只记缺口，不影响同批其它文件', async () => {
    const bad = join(CWD, 'bad.txt')
    const good = join(CWD, 'good.txt')
    const { capture, writes } = harness({ [good]: 'NEW' }, [storedOf(good, 'OLD'), storedOf(bad, 'OLD')], { watch: true, scan: false },
      async (absolute) => {
        if (absolute === bad) throw new Error('EACCES')
        return 'NEW'
      })
    capture.enqueue(CWD, bad)
    capture.enqueue(CWD, good)
    await capture.flush()
    expect(writes.map((write) => write.path)).toEqual([good])
  })

  it('监听开关关闭时不落库', async () => {
    const file = join(CWD, 'a.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')], { watch: false, scan: false })
    capture.enqueue(CWD, file)
    await capture.flush()
    expect(writes).toHaveLength(0)
  })
})

describe('校准', () => {
  it('启动校准把窗口内漏掉的事件从磁盘补进来（不依赖 watch）', async () => {
    vi.useFakeTimers()
    const file = join(CWD, 'missed.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')], { watch: false, scan: true })
    await vi.advanceTimersByTimeAsync(0)
    await capture.flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ path: file, after: 'NEW' })
    capture.dispose()
  })

  it('扫描开关关闭时不会自动校准（手动按钮仍可用）', async () => {
    vi.useFakeTimers()
    const file = join(CWD, 'ignored.txt')
    const { capture, writes } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')], { watch: true, scan: false })
    await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS + 10)
    await capture.flush()
    expect(writes).toHaveLength(0)
    capture.dispose()
  })

  it('手动校准不受扫描开关限制，且只对齐开窗文件', async () => {
    const open = join(CWD, 'open.txt')
    const closed = join(CWD, 'closed.txt')
    const { capture, writes } = harness(
      { [open]: 'NEW', [closed]: 'NEW' },
      [storedOf(open, 'OLD'), storedOf(closed, 'OLD', { tracking: 'closed' })],
      { watch: true, scan: false },
    )
    const outcome = await capture.sync(CWD)
    expect(writes.map((write) => write.path)).toEqual([open])
    expect(outcome).toMatchObject({ checked: 1, folded: 1 })
    capture.dispose()
  })

  it('校准返回检查与折入条数', async () => {
    const file = join(CWD, 'report.txt')
    const { capture } = harness({ [file]: 'NEW' }, [storedOf(file, 'OLD')])
    const outcome = await capture.sync(CWD)
    expect(outcome).toMatchObject({ checked: 1, folded: 1 })
    expect(outcome.gaps).toEqual([])
    capture.dispose()
  })
})

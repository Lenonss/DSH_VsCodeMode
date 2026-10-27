import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCollector } from '../src/officialCapture.js'
import type { CaptureDeps } from '../src/officialCapture.js'
import type { OfficialDiff, OfficialSummary, ReviewSnapshot } from '../src/shared/review.js'
const collectors: ReturnType<typeof createCollector>[] = []
const summary: OfficialSummary = { turn: 1, cwd: '/work', files: [{ path: 'a', display: 'a', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 }
const diff: OfficialDiff = { kind: 'text', path: 'a', display: 'a', before: false, after: true, coarse: false,
  hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ['+hello'] }] }
/** @private @author ddj 2026年10月26号 @param overrides Source failure injection. @returns Isolated collector and persisted facts. */
function fixture(overrides: Partial<CaptureDeps> = {}) {
  const facts: ReviewSnapshot[] = []
  const deps: CaptureDeps = { source: () => ({ summary: () => structuredClone(summary), diff: async () => structuredClone(diff) }),
    prepare: async () => {}, identity: async (cwd, path) => cwd + '/' + path,
    persist: vi.fn((_cwd, snapshot) => { facts.push(snapshot); return true }), state: vi.fn(), report: vi.fn(), timeoutMs: 1000, retryMs: 1,
    ...overrides }
  const collector = createCollector(deps); collectors.push(collector)
  return { collector, facts, deps }
}
/** @private @author ddj 2026年10月26号 @param collector Active fixture. @param seq Source event seq. */
function enqueue(collector: ReturnType<typeof createCollector>, seq = 10): void {
  collector.enqueue({ id: 'source', header: { cwd: '/work' } }, { type: 'workspace/changes', seq, data: { turn: 1 } })
}
afterEach(async () => { await Promise.all(collectors.splice(0).map((collector) => collector.dispose())) })
describe('deferred official capture', () => {
  it('never reads source synchronously inside append observer; retries first undefined', async () => {
    const read = vi.fn().mockReturnValueOnce(undefined).mockReturnValue(structuredClone(summary))
    const { collector, facts } = fixture({ source: () => ({ summary: read, diff: async () => diff }) })
    enqueue(collector); expect(read).not.toHaveBeenCalled()
    await collector.flush()
    expect(read).toHaveBeenCalledTimes(2); expect(facts[0].files[0].diff).toEqual(diff)
  })
  it('deduplicates live/backfill race and serializes same-turn versions', async () => {
    const order: string[] = []
    const { collector, facts } = fixture({ source: () => ({ summary: () => summary, diff: async (_session, seq) => {
      order.push('start' + seq)
      await new Promise((resolve) => setTimeout(resolve, 2))
      order.push('end' + seq); return diff
    } }) })
    enqueue(collector, 10); enqueue(collector, 10); enqueue(collector, 11)
    await collector.flush()
    expect(order).toEqual(['start10', 'end10', 'start11', 'end11'])
    expect(facts.map((item) => item.seq)).toEqual([10, 11])
  })
  it('ignores inherited fork prefix but accepts own boundary event', async () => {
    const { collector, facts } = fixture()
    const session = { id: 'child', inheritedEventCount: 10 }
    collector.enqueue(session, { type: 'workspace/changes', seq: 9, data: { turn: 1 } })
    collector.enqueue(session, { type: 'workspace/changes', seq: 10, data: { turn: 1 } })
    await collector.flush()
    expect(facts).toHaveLength(1); expect(facts[0].sessionId).toBe('child')
  })
  it('missing service and expired summary produce explicit durable gaps', async () => {
    const { collector, deps, facts } = fixture({ source: () => undefined })
    enqueue(collector); await collector.flush()
    expect(facts).toEqual([])
    expect(deps.state).toHaveBeenLastCalledWith('/work', expect.objectContaining({ seq: 10, error: expect.stringContaining('服务不可用') }), 'gap')
    const expired = fixture({ source: () => ({ summary: () => undefined, diff: async () => diff }) })
    enqueue(expired.collector); await expired.collector.flush()
    expect(expired.deps.report).toHaveBeenCalledWith(expect.stringContaining('summary 已失效'))
  })
  it('half capture is never published; deadlines do not create fictitious snapshots', async () => {
    const multiple = structuredClone(summary); multiple.files.push({ ...multiple.files[0], path: 'b', display: 'b' }); multiple.total = 2
    const { collector, deps, facts } = fixture({ source: () => ({ summary: () => multiple,
      diff: async (_session, _seq, index) => index === 0 ? diff : undefined }) })
    enqueue(collector); await collector.flush()
    expect(facts).toEqual([]); expect(deps.state).toHaveBeenLastCalledWith('/work', expect.objectContaining({ error: expect.stringContaining('差异缺失') }), 'gap')
  })
  it('late async source abort cannot publish after unload', async () => {
    let resolve!: (value: OfficialDiff) => void
    const { collector, facts } = fixture({ timeoutMs: 30, source: () => ({ summary: () => summary, diff: () => new Promise((done) => { resolve = done }) }) })
    enqueue(collector); await collector.dispose()
    resolve(diff); await Promise.resolve()
    expect(facts).toEqual([])
  })
  it('empty official snapshot is a valid event and metadata is detached from later mutations', async () => {
    const empty = { ...summary, files: [], total: 0 }
    const { collector, facts } = fixture({ source: () => ({ summary: () => empty, diff: async () => diff }) })
    enqueue(collector); await collector.flush(); empty.total = 99
    expect(facts[0].files).toEqual([]); expect(facts[0].summary.total).toBe(0)
  })
})

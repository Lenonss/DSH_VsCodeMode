/** Coordinator regressions without DOM/React dependency. @author ddj 2026年10月10号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyViewRows, ExplorerViewClient } from '../src/client/sidebar/panels/explorerView.js'
import type { SvnViewPayload, SvnViewRequest, SvnViewMark } from '../src/shared/svnExplorer.js'
const owners: ExplorerViewClient[] = []
/** @private @author ddj 2026年10月10号 @param args Requested rows. @returns Complete compact response. */
function output(args: SvnViewRequest): { ok: true } & SvnViewPayload {
  return { ok: true, scopeId: 'host', prefix: '.', revision: 1, generation: 1, observedGeneration: 1, confirmedAt: Date.now(),
    complete: true, refreshing: false, scanMs: 10, error: '', mismatch: false,
    rows: args.rows.map((r) => ({ path: r.path, kind: 'clean', count: 0, stale: false })) }
}
/** @private @author ddj 2026年10月10号 @returns Mounted coordinator, observable callbacks. */
async function fixture() {
  const fetch = vi.fn().mockImplementation(async (args: SvnViewRequest) => output(args)), publish = vi.fn(), drop = vi.fn()
  const client = new ExplorerViewClient('one', fetch, publish, drop); owners.push(client)
  client.setRows([{ path: 'dir/a', isDir: false }, { path: 'dir', isDir: true }, { path: 'other/b', isDir: false }])
  await vi.advanceTimersByTimeAsync(0)
  return { client, fetch, publish, drop }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000) })
afterEach(() => { for (const client of owners.splice(0)) client.dispose(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers() })
describe('explorer compact client coordination', () => {
  it('reuses unchanged map/mark objects and marks affected rows only', async () => {
    const { client, fetch, publish } = await fixture()
    const view = publish.mock.calls.at(-1)![0], stable = view.marks.get('other/b')
    expect(applyViewRows(view.marks, [...view.marks.values()])).toBe(view.marks)
    client.notify({ scope: 'one', paths: ['dir/a'], kind: 'text', eventId: 'a' })
    const stale = publish.mock.calls.at(-1)![0]
    expect(stale.marks.get('dir').stale).toBe(true)
    expect(stale.marks.get('other/b')).toBe(stable)
    await vi.advanceTimersByTimeAsync(299); expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1); expect(fetch.mock.calls[1][0]).toMatchObject({ reason: 'paths', paths: ['dir/a'] })
  })
  it('deduplicates events, ignores another scope, text retains remote, structure drops it', async () => {
    const { client, fetch, drop } = await fixture()
    client.notify({ scope: 'two', paths: ['dir/a'], kind: 'structure' })
    client.notify({ scope: 'one', paths: ['dir/a'], kind: 'text', eventId: 'same' })
    client.notify({ scope: 'one', paths: ['dir/a'], kind: 'text', eventId: 'same' })
    await vi.advanceTimersByTimeAsync(300)
    expect(fetch).toHaveBeenCalledTimes(2); expect(drop).not.toHaveBeenCalled()
    client.notify({ paths: ['dir/b'], kind: 'structure' }); expect(drop).toHaveBeenCalledTimes(1)
  })
  it('100 notifications in one second have a hard maxwait and one merged request', async () => {
    const { client, fetch } = await fixture()
    for (let i = 0; i < 100; i++) { client.notify({ paths: ['dir/a'], kind: 'text', eventId: String(i) }); await vi.advanceTimersByTimeAsync(10) }
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][0].paths).toEqual(['dir/a'])
  })
  it('notice during a fetch cannot restore stale green; receives one follow-up batch', async () => {
    const { client, fetch, publish } = await fixture()
    let resolve!: (v: any) => void
    fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    client.setRows([{ path: 'dir/a', isDir: false }]); await vi.advanceTimersByTimeAsync(0)
    client.notify({ paths: ['dir/a'], kind: 'text' }); client.notify({ paths: ['dir/b'], kind: 'text' })
    resolve(output(fetch.mock.calls[1][0])); await vi.advanceTimersByTimeAsync(0)
    expect(publish.mock.calls.at(-1)![0].marks.get('dir/a').stale).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(fetch).toHaveBeenCalledTimes(3); expect(fetch.mock.calls[2][0].paths).toEqual(['dir/a', 'dir/b'])
  })
  it('retries mixed-generation pages using same event id and commits one consistent map', async () => {
    const { client, fetch, publish } = await fixture()
    const rows = Array.from({ length: 1001 }, (_, i) => ({ path: 'd/' + i, isDir: false }))
    fetch.mockImplementationOnce(async (args: SvnViewRequest) => output(args))
      .mockImplementationOnce(async (args: SvnViewRequest) => ({ ...output(args), mismatch: true, rows: [] }))
    client.setRows(rows); await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(new Set(fetch.mock.calls.slice(1).map((c) => c[0].eventId)).size).toBe(1)
    expect(fetch.mock.calls[2][0]).toMatchObject({ revision: 1, generation: 1 })
    expect(publish.mock.calls.at(-1)![0].marks.size).toBe(1001)
  })
  it('hidden page stops polls/calibration; repeated focus coalesces and no automatic repository calls', async () => {
    const { client, fetch } = await fixture()
    client.visibility(false); await vi.advanceTimersByTimeAsync(40000)
    expect(fetch).toHaveBeenCalledTimes(1)
    client.visibility(true); client.visibility(true); await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls[1][0].reason).toBe('calibrate')
    await vi.advanceTimersByTimeAsync(30001); expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('disposal aborts UI fetch and suppresses late result without touching shared host', async () => {
    const { client, fetch, publish } = await fixture()
    let resolve!: (v: any) => void
    fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    client.setRows([]); await vi.advanceTimersByTimeAsync(0)
    const count = publish.mock.calls.length
    client.dispose(); expect(fetch.mock.calls[1][1].aborted).toBe(true)
    resolve(output(fetch.mock.calls[1][0])); await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenCalledTimes(count)
  })
  it('unknown/traversal notices safely request full, errors retain stale anomalies', async () => {
    const { client, fetch, publish } = await fixture()
    client.notify({ paths: ['../x'], kind: 'unknown' }); await vi.advanceTimersByTimeAsync(300)
    expect(fetch.mock.calls[1][0]).toMatchObject({ reason: 'full', paths: [] })
    fetch.mockResolvedValueOnce({ ok: false, error: 'offline' })
    client.refresh(); await vi.advanceTimersByTimeAsync(300)
    expect(publish.mock.calls.at(-1)![0]).toMatchObject({ complete: false, error: 'Error: offline' })
  })
})

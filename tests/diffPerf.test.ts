import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import type { Hunk, RecordView } from '../src/shared/types.js'
import { applyLocations, locateHunks } from '../src/shared/diff.js'
import { diffRegions } from '../src/client/state/regions.js'

/** @author ddj 2026年09月29号 @description 固定文件和 hunk 规模，记录定位、展示与反向替换耗时。 */
describe('diff operation performance sample', () => {
  it('measures a 1 MiB file and 200 snapshot hunks without a brittle timing assertion', () => {
    const part = 'x'.repeat(5000)
    const hunks: Hunk[] = Array.from({ length: 200 }, (_, idx) => ({
      oldText: 'old', newText: `MARK-${idx.toString().padStart(3, '0')}`,
    }))
    let content = ''
    for (const hunk of hunks) {
      content += part
      hunk.afterStart = content.length
      content += hunk.newText
      hunk.afterEnd = content.length
    }
    const record: RecordView = {
      callId: 'bench', toolName: 'edit', path: '/bench.ts', beforeLen: content.length,
      create: false, callHunk: null, hunks,
      decisions: { call: 'pending', perHunk: hunks.map(() => 'pending') },
      note: null, superseded: false, at: '2026-09-29T00:00:00.000Z',
    }
    const start = performance.now()
    const locations = locateHunks(content, hunks)
    const located = performance.now()
    const regions = diffRegions([record], content)
    const rendered = performance.now()
    const applied = applyLocations(content, locations, true)
    const finished = performance.now()
    expect(locations.every((location) => location.matched)).toBe(true)
    expect(regions).toHaveLength(hunks.length)
    expect(applied.stale).toEqual([])
    expect(applied.content.length).toBe(content.length - hunks.reduce((sum, hunk) => sum + hunk.newText.length - 3, 0))
    console.log(`diffPerf bytes=${content.length} hunks=${hunks.length} locate=${(located - start).toFixed(1)}ms regions=${(rendered - located).toFixed(1)}ms apply=${(finished - rendered).toFixed(1)}ms`)
  })
})

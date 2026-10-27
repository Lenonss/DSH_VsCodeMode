import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installEvidence } from '../src/reviewCapture.js'
import { closeArchiveDbs, migrateActive } from '../src/archiveDb.js'
import { reviewDb, reviewDetail, reviewPage, saveSnapshot } from '../src/reviewDb.js'
import type { ReviewSnapshot } from '../src/shared/review.js'
vi.mock('../src/store.js', () => ({ resolveTarget: vi.fn(async (_ctx, _session, path) => path) }))
let home: string, original: string | undefined
const cwd = '/capture-evidence'
beforeAll(async () => { original = process.env.DSH_HOME; home = mkdtempSync(join(tmpdir(), 'review-capture-')); process.env.DSH_HOME = home; await migrateActive(cwd, null, async () => null) })
afterAll(() => { closeArchiveDbs(); if (original === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original; rmSync(home, { recursive: true, force: true }) })
/** @private @author ddj 2026年10月27号 @param turn Isolated source. @returns Actual collector adapter with public filesystem mock and isolated durable facts. */
function fixture(turn: number) {
  const hooks = new Map<string, (...args: any[]) => any>(), path = cwd + '/file' + turn, disk = { text: 'head\nold\ntail' }
  const fs = { processPath: (target: string) => target, readBytes: async () => Buffer.from(disk.text) }
  const ctx = { on: (name: string, callback: (...args: any[]) => any) => hooks.set(name, callback), get: () => fs }
  const recorder = installEvidence(ctx)
  const session = { id: 'capture' + turn }
  const exec = { name: 'edit', agent: { session }, arguments: { file_path: path } }
  const snapshot: ReviewSnapshot = { sourceKind: 'official', sessionId: session.id, turn, seq: turn, capturedAt: '',
    summary: { cwd, turn, total: 1, added: 1, deleted: 1, files: [{ path, display: path, added: 1, deleted: 1 }] },
    files: [{ identity: path, diff: { kind: 'text', before: true, after: true, coarse: false, path, display: path,
      hunks: [{ oldStart: 1, newStart: 1, oldLines: 3, newLines: 3, lines: [' head', '-old', '+new', ' tail'] }] } }] }
  const publish = () => { hooks.get('session/event')!(session, { type: 'workspace/changes', seq: turn }); saveSnapshot(cwd, snapshot); recorder.persist(cwd, snapshot); return reviewPage(cwd).items.find((item) => item.turn === turn)! }
  return { hooks, disk, recorder, session, exec, publish }
}
describe('independent tool byte chain to official evidence', () => {
  it('captures around tool execution, freezes at official event and persists validated bytes', async () => {
    const f = fixture(1)
    const result = await f.hooks.get('tools/execute')!(f.exec, async () => { f.disk.text = 'head\nnew\ntail'; return { ok: true } })
    expect(result).toEqual({ ok: true })
    const item = f.publish()
    expect(reviewDetail(cwd, item.id)?.capability.undo).toBe(true)
    f.recorder.dispose()
  })
  it('fails closed on a discontinuous intermediate file instead of claiming tool coverage', async () => {
    const f = fixture(2)
    await f.hooks.get('tools/execute')!(f.exec, async () => { f.disk.text = 'head\ntmp\ntail' })
    f.disk.text = 'external\n'
    await f.hooks.get('tools/execute')!(f.exec, async () => { f.disk.text = 'head\nnew\ntail' })
    const item = f.publish()
    expect(reviewDetail(cwd, item.id)?.capability.undo).toBe(false)
    expect(reviewDb(cwd).prepare('SELECT 1 FROM review_evidence WHERE file_id=?').get(item.id)).toBeUndefined()
    f.recorder.dispose()
  })
  it('capture failure does not prevent the original tool and cannot enable undo', async () => {
    const f = fixture(3), next = vi.fn(async () => 'original')
    await expect(f.hooks.get('tools/execute')!({ ...f.exec, name: 'other' }, next)).resolves.toBe('original')
    expect(next).toHaveBeenCalledTimes(1)
    const item = f.publish()
    expect(reviewDetail(cwd, item.id)?.capability.undo).toBe(false)
    f.recorder.dispose()
  })
})

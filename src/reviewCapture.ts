/** Independent byte evidence; official diff remains the only display authority. @author ddj 2026年10月27号 */
import { rawReviewFile, evidenceBlocks } from './reviewEvidence.js'
import type { RawReviewFile } from './reviewEvidence.js'
import type { ReviewSnapshot } from './shared/review.js'
import { reviewDb } from './reviewDb.js'
import { resolveTarget } from './store.js'
import type { Ctx } from './store.js'
import { log } from './log.js'

interface ByteChain { before: RawReviewFile; after: RawReviewFile; busy: boolean; invalid: boolean }
interface EvidenceCapture {
  persist(cwd: string, snapshot: ReviewSnapshot): void
  dispose(): void
}

/** @public @author ddj 2026年10月27号 @param ctx Host lifecycle owner. @returns Scoped byte recorder; failures disable undo evidence only, never tool execution. */
export function installEvidence(ctx: Ctx): EvidenceCapture {
  const chains = new Map<string, Map<string, ByteChain>>()
  const staged = new Map<string, Map<string, ByteChain>>()
  let stopped = false
  ctx.on('tools/execute', aroundTool)
  ctx.on('session/event', onEvent)
  ctx.on('session/disposed', onDisposed)

  /** @private @author ddj 2026年10月27号 @param session Disposed owner. Drops optional in-memory evidence, never persisted official facts. */
  function onDisposed(session: { id: string }): void { chains.delete(session.id) }

  /** @private @author ddj 2026年10月27号 @returns Current bounded capture footprint, excluding transient filesystem reads. */
  function footprint(): number {
    let bytes = 0
    for (const group of [chains, staged]) {
      for (const files of group.values()) {
        for (const chain of files.values()) bytes += chain.before.bytes.length + chain.after.bytes.length
      }
    }
    return bytes
  }

  /** @private @author ddj 2026年10月27号 @param exec Allowed tool dispatch. @param next Original dispatch. @returns Original result unchanged, regardless of capture failure. */
  async function aroundTool(exec: any, next: () => Promise<any>): Promise<any> {
    const session = exec.agent?.session
    const path = exec.arguments?.file_path
    if (stopped || !session?.id || !['edit', 'write'].includes(exec.name) || typeof path !== 'string') return next()
    let fs: any
    let chain: ByteChain | undefined
    let target: any
    try {
      if ((chains.size >= 16 && !chains.has(session.id)) || footprint() >= 32 * 1024 * 1024) return next()
      fs = ctx.get('fs')
      target = await resolveTarget(ctx, session, path)
      const identity = fs.processPath(target)
      const before = await readRaw(fs, target, exec.signal)
      let files = chains.get(session.id)
      if (!files) { files = new Map(); chains.set(session.id, files) }
      if (files.size >= 64 && !files.has(identity)) return next()
      chain = files.get(identity)
      if (!chain) { chain = { before, after: before, busy: false, invalid: false }; files.set(identity, chain) }
      if (chain.busy || chain.after.hash !== before.hash) chain.invalid = true
      chain.busy = true
    } catch { /* No trustworthy read means no undo evidence, not a failed user tool. */ }
    try { return await next() }
    finally {
      if (chain) {
        try { chain.after = await readRaw(fs, target, exec.signal) } catch { chain.invalid = true }
        chain.busy = false
      }
    }
  }

  /** @private @author ddj 2026年10月27号 @param session Source session. @param event Published official turn. Freezes the chain before the next turn can mutate it. */
  function onEvent(session: any, event: any): void {
    if (stopped || event.type !== 'workspace/changes') return
    const files = chains.get(session.id)
    chains.delete(session.id)
    if (!files || staged.size >= 128) return
    staged.set(JSON.stringify([session.id, event.seq]), structuredClone(files))
  }

  /** @public @author ddj 2026年10月27号 @param cwd Official workspace. @param snapshot Committed official facts. Persists only independently validated, exact-correspondence byte chains. */
  function persist(cwd: string, snapshot: ReviewSnapshot): void {
    const key = JSON.stringify([snapshot.sessionId, snapshot.seq])
    const files = staged.get(key)
    staged.delete(key)
    if (!files || stopped) return
    const db = reviewDb(cwd)
    for (const file of snapshot.files) {
      const chain = files.get(file.identity)
      if (!chain || chain.invalid || chain.busy) continue
      try {
        const evidence = { before: chain.before, after: chain.after }
        evidenceBlocks(file.diff, evidence)
        db.prepare(`INSERT OR IGNORE INTO review_evidence(file_id,payload)
          SELECT id,? FROM review_files WHERE session_id=? AND turn=? AND seq=? AND identity=?`)
          .run(JSON.stringify(evidence), snapshot.sessionId, snapshot.turn, snapshot.seq, file.identity)
      } catch (error) { log.warn('官方回滚证据不可用：' + String(error)) }
    }
  }

  /** @public @author ddj 2026年10月27号 Release bounded in-memory images after capture has drained. */
  function dispose(): void { stopped = true; chains.clear(); staged.clear() }
  return { persist, dispose }
}

/** @private @author ddj 2026年10月27号 @param fs Public filesystem. @param target Backend identity. @returns Raw bounded file or confirmed missing. @throws Any non-missing read error. */
async function readRaw(fs: any, target: any, signal?: AbortSignal): Promise<RawReviewFile> {
  try { return rawReviewFile(await fs.readBytes(target, signal, 1024 * 1024)) }
  catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND') return rawReviewFile(null)
    throw error
  }
}

/** Independent byte evidence; official diff remains the only display authority. @author ddj 2026年10月27号 */
import { rawReviewFile, evidenceBlocks } from './reviewEvidence.js'
import type { RawReviewFile } from './reviewEvidence.js'
import type { ReviewSnapshot } from './shared/review.js'
import { reviewDb } from './reviewDb.js'
import { cwdOfSession } from './store.js'
import { toolTargets } from './toolTargets.js'
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
  const disposed = new Set<string>()
  ctx.on('tools/execute', aroundTool)
  ctx.on('session/event', onEvent)
  ctx.on('session/disposed', onDisposed)

  /** @private @author ddj 2026年10月27号 @param session Disposed owner. Drops optional in-memory evidence, never persisted official facts. */
  function onDisposed(session: { id: string }): void {
    disposed.add(session.id)
    chains.delete(session.id)
    for (const key of staged.keys()) {
      if ((JSON.parse(key) as unknown[])[0] === session.id) staged.delete(key)
    }
  }

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
    if (stopped || !session?.id) return next()
    const captures: Array<{ fs: any; target: any; chain: ByteChain }> = []
    try {
      const cwd = cwdOfSession(ctx, session)
      const fs = ctx.get('fs')
      const paths = await toolTargets(exec)
      for (const path of paths) {
        try {
          const capture = await prepareRaw(fs, session.id, cwd ?? undefined, path, exec.signal)
          if (capture) captures.push(capture)
        } catch { /* A failed target never prevents independent targets. */ }
      }
    } catch { /* Optional parser absence must not fail the original tool. */ }
    try { return await next() }
    finally {
      for (const capture of captures) {
        try {
          const after = await readRaw(capture.fs, capture.target, exec.signal)
          if (!stopped && !disposed.has(session.id)) {
            capture.chain.after = after
            if (footprint() > 32 * 1024 * 1024) {
              capture.chain.invalid = true
              capture.chain.before = rawReviewFile(null); capture.chain.after = rawReviewFile(null)
            }
          }
        } catch { capture.chain.invalid = true }
        capture.chain.busy = false
      }
    }
  }

  /** @private @author ddj 2026年11月04号 @param sessionId Frozen owner. @param cwd Frozen workspace. @param path Patch target. @param signal Tool cancellation. @returns Reserved raw capture or no evidence. */
  async function prepareRaw(fs: any, sessionId: string, cwd: string | undefined, path: string, signal?: AbortSignal) {
    if (stopped || disposed.has(sessionId) || !cwd || (chains.size >= 16 && !chains.has(sessionId)) || footprint() >= 32 * 1024 * 1024) return null
    const target = await fs.resolve(path, { cwd })
    if (stopped || disposed.has(sessionId)) return null
    const identity = fs.processPath(target)
    let files = chains.get(sessionId)
    if (!files) { files = new Map(); chains.set(sessionId, files) }
    if (files.size >= 64 && !files.has(identity)) return null
    let chain = files.get(identity)
    if (chain?.busy) { chain.invalid = true; return null }
    const empty = rawReviewFile(null)
    if (!chain) {
      chain = { before: empty, after: empty, busy: true, invalid: false }
      files.set(identity, chain)
      try { chain.before = await readRaw(fs, target, signal); chain.after = chain.before }
      catch (error) { chain.invalid = true; chain.busy = false; throw error }
    } else {
      chain.busy = true
      try {
        const before = await readRaw(fs, target, signal)
        if (chain.after.hash !== before.hash) chain.invalid = true
      } catch (error) { chain.invalid = true; chain.busy = false; throw error }
    }
    if (stopped || disposed.has(sessionId) || footprint() > 32 * 1024 * 1024) {
      chain.invalid = true; chain.busy = false; files.delete(identity); return null
    }
    return { fs, target, chain }
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

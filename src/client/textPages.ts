import { TEXT_PAGE_BYTES, TEXT_VIEW_BYTES, TEXT_VIEW_LINES } from '../shared/textPages.js'
import type { TextPageArgs, TextPageResult } from '../shared/textPages.js'

export interface TextPagerState {
  text: string
  loading: boolean
  eof: boolean
  capped: boolean
  error: string | null
  offset: number
  size: number
  lines: number
  partialLine: boolean
}
export type TextPageLoader = (args: TextPageArgs) => Promise<TextPageResult>

/**
 * Own one preview identity and one in-flight request; no polling or automatic continuation.
 * @public @author ddj 2026年10月22号
 * @param load Authorized RPC loader. @param changed Snapshot observer.
 * @returns Pager lifecycle and explicit load controls.
 */
export function createTextPager(load: TextPageLoader, changed: (state: TextPagerState) => void) {
  let generation = 0
  let disposed = false
  let target: TextPageArgs | null = null
  let cursor: string | undefined
  let version: string | undefined
  let inFlight = false
  let retainedBytes = 0
  let state = emptyState()

  /** @private @author ddj 2026年10月22号 @returns Publish immutable snapshot. */
  function publish(): void { changed({ ...state }) }

  /** @public @author ddj 2026年10月22号 @param args New file/session identity. @returns Reset state; old responses are ignored. */
  function reset(args: TextPageArgs): void {
    generation++
    target = { sessionId: args.sessionId, path: args.path }
    cursor = undefined
    version = undefined
    retainedBytes = 0
    state = emptyState()
    state.loading = inFlight
    if (!disposed) publish()
  }

  /** @public @author ddj 2026年10月22号 @returns Explicitly load one page, or no-op when busy/finished. */
  async function loadNext(): Promise<void> {
    if (disposed || !target || inFlight || state.eof || state.capped) return
    state.error = null
    const requestGeneration = generation
    const request = { ...target, cursor }
    inFlight = true
    state.loading = true
    publish()

    try {
      const page = await load(request)
      if (disposed || requestGeneration !== generation) return
      if (!page.ok) { state.error = page.error; return }
      if (!validPage(page, state.offset, version)) { state.error = 'Invalid or stale text page'; return }
      appendPage(page)
    } catch (error) {
      if (!disposed && requestGeneration === generation) state.error = String(error)
    } finally {
      inFlight = false
      if (!disposed) { state.loading = false; publish() }
    }
  }

  /** @private @author ddj 2026年10月22号 @param page Verified page. @returns Append only within byte/line limits. */
  function appendPage(page: Extract<TextPageResult, { ok: true }>): void {
    let text = page.text
    const encoded = new TextEncoder().encode(text)
    const remaining = TEXT_VIEW_BYTES - retainedBytes
    if (encoded.length > remaining) {
      // A UTF-8 suffix may straddle the cap; never retain a replacement character.
      let end = remaining
      while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--
      text = new TextDecoder('utf-8', { fatal: true }).decode(encoded.subarray(0, end))
      state.capped = true
    }
    let lines = state.lines
    for (let index = 0; index < text.length; index++) {
      if (text[index] !== '\n' && (text[index] !== '\r' || text[index + 1] === '\n')) continue
      if (lines >= TEXT_VIEW_LINES) {
        const end = text[index] === '\n' && text[index - 1] === '\r' ? index - 1 : index
        text = text.slice(0, end); state.capped = true; break
      }
      lines++
    }
    retainedBytes += new TextEncoder().encode(text).length
    state.text += text
    state.lines = lines
    state.offset = page.offset
    state.size = page.size
    state.eof = page.eof
    state.partialLine = page.partialLine || state.capped
    state.capped ||= page.offset >= TEXT_VIEW_BYTES || retainedBytes >= TEXT_VIEW_BYTES || lines >= TEXT_VIEW_LINES
    version = page.version
    cursor = page.nextCursor ?? undefined
  }

  /** @public @author ddj 2026年10月22号 @returns Invalidate identity while retaining the transport lock. */
  function invalidate(): void { generation++; target = null; state = emptyState() }

  /** @public @author ddj 2026年10月22号 @returns Invalidate pending responses and release preview content. */
  function dispose(): void { disposed = true; invalidate() }

  return { reset, loadNext, invalidate, dispose, getState: () => ({ ...state }) }
}

/** @private @author ddj 2026年10月22号 @returns Empty bounded preview state. */
function emptyState(): TextPagerState {
  return { text: '', loading: false, eof: false, capped: false, error: null, offset: 0, size: 0, lines: 1, partialLine: false }
}

/**
 * Validate the RPC envelope before retaining any content.
 * @private @author ddj 2026年10月22号
 * @param page Server page. @param offset Previous byte position. @param version Bound version.
 * @returns Whether bounds and continuation invariants hold.
 */
function validPage(page: Extract<TextPageResult, { ok: true }>, offset: number, version?: string): boolean {
  return typeof page.text === 'string' && typeof page.version === 'string'
    && (version === undefined || version === page.version)
    && Number.isSafeInteger(page.offset) && Number.isSafeInteger(page.size)
    && page.size >= 0 && page.offset >= offset && page.offset <= page.size
    && (page.offset > offset || page.eof) && page.offset - offset <= TEXT_PAGE_BYTES
    && new TextEncoder().encode(page.text).length <= TEXT_PAGE_BYTES + 1
    && page.encoding === 'utf-8' && typeof page.partialLine === 'boolean'
    && typeof page.eof === 'boolean' && (page.eof ? page.nextCursor === null : typeof page.nextCursor === 'string' && page.nextCursor.length > 0)
    && (page.eof === (page.offset === page.size))
}

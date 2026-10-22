import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { TEXT_PAGE_BYTES } from './shared/textPages.js'
import type { TextPageArgs, TextPageResult } from './shared/textPages.js'

/** Only an authorized Host adapter may supply this capability; never use raw fs as fallback. */
export interface TextPageSource {
  /** Authorized workspace + canonical target identity; re-authorize every request before supplying this source. */
  identity: string
  stat(): Promise<{ version: string; size: number; type: string } | undefined>
  readRange(offset: number, length: number): Promise<Uint8Array>
}

interface PageCursor {
  identity: string
  sessionId: string
  path: string
  version: string
  offset: number
  pendingCR: boolean
}

/**
 * Create a Host-owned pager with process-local authenticated cursors.
 * @public @author ddj 2026年10月22号
 * @returns A bounded reader requiring an independently authorized range capability.
 */
export function createTextPages() {
  const secret = randomBytes(32)

  /** @private @author ddj 2026年10月22号 @param payload Authenticated state. @returns Signed cursor. */
  function signCursor(payload: PageCursor): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    return body + '.' + createHmac('sha256', secret).update(body).digest('base64url')
  }

  /** @private @author ddj 2026年10月22号 @param token Untrusted cursor. @returns Verified state or null. */
  function parseCursor(token: string): PageCursor | null {
    if (typeof token !== 'string' || token.length > 8192) return null
    const parts = token.split('.')
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!)) return null
    const signature = Buffer.from(parts[1]!, 'base64url')
    const expected = createHmac('sha256', secret).update(parts[0]!).digest()
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null

    try {
      const payload = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as PageCursor
      if (typeof payload.identity !== 'string' || typeof payload.version !== 'string'
        || typeof payload.sessionId !== 'string' || typeof payload.path !== 'string'
        || typeof payload.pendingCR !== 'boolean' || !Number.isSafeInteger(payload.offset)
        || payload.offset <= 0) return null
      return payload
    } catch { return null }
  }

  /**
   * Read at most 256 KiB, validating freshness before and after IO.
   * @public @author ddj 2026年10月22号
   * @param source Authorized range capability; absent means unsupported.
   * @param args Request identity and optional signed cursor.
   * @returns Strict UTF-8 text or an explicit fail-closed result; never partial success on mutation.
   */
  async function readTextPage(source: TextPageSource | undefined, args: TextPageArgs): Promise<TextPageResult> {
    if (!source) return failure('unsupported', 'Host does not expose authorized range reads')
    const cursor = args.cursor === undefined ? undefined : parseCursor(args.cursor)
    if (cursor === null || (cursor && (cursor.identity !== source.identity
      || cursor.sessionId !== (args.sessionId ?? '') || cursor.path !== args.path))) {
      return failure('invalid-cursor', 'Cursor does not belong to this file and session')
    }

    try {
      const before = await source.stat()
      if (!before || before.type !== 'file' || typeof before.version !== 'string'
        || !Number.isSafeInteger(before.size) || before.size < 0) {
        return failure('unsupported', 'Regular file size and opaque version are required')
      }
      if (cursor && (cursor.version !== before.version || cursor.offset >= before.size)) {
        return failure('stale', 'File changed; restart text preview')
      }
      const offset = cursor?.offset ?? 0
      const length = Math.min(TEXT_PAGE_BYTES, before.size - offset)
      const bytes = await source.readRange(offset, length)
      const after = await source.stat()
      if (!after || after.version !== before.version || after.size !== before.size || after.type !== 'file') {
        return failure('stale', 'File changed during text read')
      }
      if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
        return failure('read-failed', 'Range reader returned an incomplete or oversized page')
      }
      return decodePage(bytes, before, offset, cursor?.pendingCR ?? false, args, source.identity, signCursor)
    } catch (error) {
      return failure('read-failed', String(error))
    }
  }

  return readTextPage
}

/** @private @author ddj 2026年10月22号 @param reason Failure discriminator. @param error User-visible error. @returns Failure result. */
function failure(reason: Extract<TextPageResult, { ok: false }>['reason'], error: string): TextPageResult {
  return { ok: false, reason, error }
}

/**
 * Keep an incomplete final UTF-8 sequence for a bounded re-read on the next page.
 * @private @author ddj 2026年10月22号
 * @param bytes Raw page. @returns Complete prefix length; invalid sequences remain for fatal decoding.
 */
function utf8Prefix(bytes: Uint8Array): number {
  let start = bytes.length - 1
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--
  if (start < 0) return bytes.length
  const lead = bytes[start]!
  let width = 1
  if (lead >= 0xc2 && lead <= 0xdf) width = 2
  else if (lead >= 0xe0 && lead <= 0xef) width = 3
  else if (lead >= 0xf0 && lead <= 0xf4) width = 4
  return bytes.length - start < width ? start : bytes.length
}

/**
 * Decode one page preserving original line endings without buffering a long line.
 * @private @author ddj 2026年10月22号
 * @param bytes Raw page. @param info File snapshot. @param offset Current offset.
 * @param pendingCR Previous trailing CR. @param args Request identity. @param identity Authorized target identity.
 * @param signCursor Host cursor signer. @returns Page or strict decoding failure.
 */
function decodePage(
  bytes: Uint8Array, info: { size: number; version: string }, offset: number, pendingCR: boolean,
  args: TextPageArgs, identity: string, signCursor: (cursor: PageCursor) => string,
): TextPageResult {
  const finalRange = offset + bytes.length === info.size
  const consumed = finalRange ? bytes.length : utf8Prefix(bytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, consumed))
  } catch { return failure('not-text', 'File is not valid UTF-8') }
  if (text.includes('\0')) return failure('not-text', 'Binary text preview is unsupported')
  if (offset === 0 && text.startsWith('\uFEFF')) text = text.slice(1)
  if (pendingCR) text = '\r' + text

  const nextOffset = offset + consumed
  const eof = nextOffset === info.size
  const trailingCR = !eof && text.endsWith('\r')
  if (trailingCR) text = text.slice(0, -1)
  const nextCursor = eof ? null : signCursor({ identity, sessionId: args.sessionId ?? '', path: args.path,
    version: info.version, offset: nextOffset, pendingCR: trailingCR })
  return { ok: true, text, version: info.version, offset: nextOffset, size: info.size, eof, nextCursor,
    encoding: 'utf-8', partialLine: !eof && !/[\r\n]$/.test(text) }
}

/** Bounded SVN XML framing; retain statuses, never the entire verbose document. @author ddj 2026年10月09号 */
import { StringDecoder } from 'node:string_decoder'
import type { Readable } from 'node:stream'
import { attrOf } from './svnXml.js'
import type { SvnChangeEntry } from './shared/svn.js'

export interface StatusPipe {
  stdout?: Readable | null
  done: Promise<{ exitCode?: number | null; code?: number | null }>
  terminate?: () => unknown
  collected?: { stderr?: { readFrom: (offset: number) => { text: string } } }
}

/** @public @author ddj 2026年10月09号 @param handle Managed pipe process. @param parse Status semantics. @param cap Entry bound. @param timeout Deadline. @returns EOF-validated statuses. @throws CLI, timeout or framing failure; never retries with inherit. */
export async function readStatusPipe(handle: StatusPipe, parse: StatusParser, cap: number, timeout: number, signal?: AbortSignal) {
  const reader = new SvnStatusReader(parse, cap)
  /** @private @author ddj 2026年10月09号 Consume raw chunks through stream EOF, not just direct process exit. */
  async function consume(): Promise<void> {
    if (!handle.stdout) throw new Error('SVN 状态管道不可用，未确认正常状态')
    for await (const chunk of handle.stdout) reader.push(chunk)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('读取 SVN 图标状态超时')), timeout)
    timer.unref?.()
  })
  let abort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new Error('SVN 状态扫描已取消'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  try {
    const [outcome] = await Promise.race([Promise.all([handle.done, consume()]), expired, cancelled])
    if ((outcome.exitCode ?? outcome.code) !== 0) throw new Error(handle.collected?.stderr?.readFrom(0).text || 'SVN 状态命令失败')
    return reader.finish()
  } catch (error) {
    // Keep managed teardown observable but do not mask the original failure.
    try { await handle.terminate?.() } catch { /* Preserve CLI/stream failure. */ }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

type StatusParser = (xml: string, cap: number) => { entries: SvnChangeEntry[]; truncated: boolean }
const TAG_CAP = 64 * 1024
const STREAM_CAP = 512 * 1024 * 1024

/** @public @author ddj 2026年10月09号 Validates framing through EOF, including entries beyond the retained cap. */
export class SvnStatusReader {
  private readonly decoder = new StringDecoder('utf8')
  private buffer = ''
  private bytes = 0
  private readonly stack: string[] = []
  private opened = false
  private closed = false
  private entry = ''
  private changelist = ''
  private readonly entries: SvnChangeEntry[] = []
  private truncated = false

  /** @public @author ddj 2026年10月09号 @param parse Existing status semantics. @param cap Retained entry bound. */
  constructor(private readonly parse: StatusParser, private readonly cap: number) {}

  /** @public @author ddj 2026年10月09号 @param chunk Raw pipe chunk. @throws Byte/tag limits or invalid framing. */
  push(chunk: Buffer | string): void {
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes > STREAM_CAP) throw new Error('SVN 状态流超过 512 MiB 安全上限')
    this.feed(typeof chunk === 'string' ? chunk : this.decoder.write(chunk))
  }

  /** @private @author ddj 2026年10月09号 @param text Decoded chunk. Process each complete tag once; partial tags stay bounded. */
  private feed(text: string): void {
    this.buffer += text
    let cursor = 0
    while (cursor < this.buffer.length) {
      const start = this.buffer.indexOf('<', cursor)
      const end = start < 0 ? -1 : this.buffer.indexOf('>', start)
      const tail = start < 0 ? this.buffer.length : start
      if (!this.stack.length && this.buffer.slice(cursor, tail).trim()) this.invalid()
      if (end < 0) { cursor = tail; break }
      if (end - start > TAG_CAP) this.invalid()
      this.tag(this.buffer.slice(start, end + 1))
      cursor = end + 1
    }
    this.buffer = this.buffer.slice(cursor)
    if (this.buffer.length > TAG_CAP) this.invalid()
  }

  /** @private @author ddj 2026年10月09号 @param token Complete XML tag. Validate nesting and capture only entry/wc-status attributes. */
  private tag(token: string): void {
    if (token.startsWith('<?xml ') && !this.opened && !this.stack.length) return
    const match = /^<(\/?)([\w-]+)\b([^>]*?)(\/?)>$/.exec(token)
    if (!match || this.closed) this.invalid()
    const [, closing, name, attrs, self] = match!
    if (closing) {
      if (this.stack.pop() !== name) this.invalid()
      if (name === 'entry') this.saveEntry()
      if (name === 'changelist') this.changelist = ''
      if (name === 'status') this.closed = true
      return
    }
    if (!this.stack.length) {
      if (name !== 'status' || this.opened || self) this.invalid()
      this.opened = true
    }
    if (name === 'changelist') this.changelist = attrOf(attrs, 'name')
    if (name === 'entry') this.entry = token.replace(/\/>$/, '>')
    if (name === 'wc-status' && this.entry) this.entry += '<wc-status' + attrs + '/>'
    if (!self) this.stack.push(name)
    else if (name === 'entry') this.saveEntry()
  }

  /** @private @author ddj 2026年10月09号 Preserve existing property/tree-conflict/path semantics and bounded statuses. */
  private saveEntry(): void {
    const result = this.parse(this.entry + '</entry>', 1)
    this.entry = ''
    for (const entry of result.entries) {
      if (this.entries.length >= this.cap) { this.truncated = true; continue }
      this.entries.push(this.changelist ? { ...entry, changelist: this.changelist } : entry)
    }
  }

  /** @private @author ddj 2026年10月09号 @throws Invalid/missing/truncated XML; never produces a clean snapshot. */
  private invalid(): never { throw new Error('SVN 状态输出为空或不完整，未确认正常状态') }

  /** @public @author ddj 2026年10月09号 @returns Confirmed snapshot only after complete stream EOF. @throws Invalid framing. */
  finish(): { entries: SvnChangeEntry[]; truncated: boolean } {
    this.feed(this.decoder.end())
    if (!this.opened || !this.closed || this.stack.length || this.buffer.trim()) this.invalid()
    return { entries: this.entries, truncated: this.truncated }
  }
}

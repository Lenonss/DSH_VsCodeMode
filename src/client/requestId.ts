/** @public @author ddj 2026年10月23号
 * Generate an unpredictable UUID, including on insecure LAN HTTP origins.
 * @returns UUID v4, or undefined when secure randomness is unavailable.
 */
export function createRequestId(): string | undefined {
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  } catch { /* Fall through to the cryptographic API available on HTTP origins. */ }

  try {
    const bytes = new Uint8Array(16)
    globalThis.crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  } catch {
    return undefined
  }
}

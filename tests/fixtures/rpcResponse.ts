/**
 * RPC response doubles for fetch stubs.
 *
 * The client RPC wrapper validates the authenticated route's real envelope:
 * HTTP status, JSON media type, and a boolean `ok` field. Stubs that only
 * expose `json()` no longer represent the host contract, so share one shape.
 * @author ddj 2026年09月28号
 */

/** Minimal fetch Response surface consumed by the client RPC wrapper. */
export interface RpcResponseDouble {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

/**
 * Build a successful JSON response double carrying a business payload.
 * @author ddj 2026年09月28号
 * @param body Business result the client should decode.
 * @returns Response-like object for a fetch stub.
 */
export function rpcResponse(body: unknown): RpcResponseDouble {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
  }
}

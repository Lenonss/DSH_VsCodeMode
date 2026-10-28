/** Bounded credential-safe MCP failure diagnostics. @author ddj 2026年10月28号 */
import type { MpcConfig } from './shared/mcp.js'

/**
 * Format an initialization failure without serializing the MCP configuration.
 * @public @author ddj 2026年10月28号
 * @param error Original failure and optional cause chain.
 * @param config Effective configuration, used only to remove known secret values.
 * @returns Bounded single-line diagnostic; URLs and explicit credentials are removed.
 */
export function mcpErrorText(error: unknown, config: MpcConfig): string {
  const messages: string[] = []
  const seen = new Set<unknown>()
  let cause = error
  while (cause !== undefined && !seen.has(cause) && messages.length < 4) {
    seen.add(cause)
    if (cause instanceof Error) {
      const code = (cause as Error & { code?: unknown }).code
      messages.push(cause.name + ': ' + cause.message + (typeof code === 'string' ? ' [' + code + ']' : ''))
      cause = cause.cause
    } else {
      messages.push(typeof cause === 'string' ? cause : 'Unknown MCP failure')
      break
    }
  }

  let text = messages.join(' <- ')
  const secrets = [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})]
  // Arguments may contain credentials; never reproduce their non-option values in an error.
  for (const argument of config.args ?? []) {
    if (!argument.startsWith('-')) secrets.push(argument)
  }
  secrets.sort((left, right) => right.length - left.length)
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[REDACTED]')
  }

  text = text.replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\b(authorization|api[-_]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\x00-\x1f\x7f]+/g, ' ')
  return text.slice(0, 2048)
}

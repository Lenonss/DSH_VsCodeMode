import { resolve } from 'node:path'

/**
 * Resolve the settings document only when the request names its exact configured path.
 * @author ddj 2026年10月02号
 * @param configuredPath Path exposed by the active settings provider
 * @param requestedPath Path requested by the editor RPC
 * @param platform Host platform for case-sensitive path comparison
 * @returns The configured absolute path when authorized; otherwise null
 */
export function settingsDocPath(
  configuredPath: unknown,
  requestedPath: string,
  platform = process.platform,
): string | null {
  if (typeof configuredPath !== 'string' || !configuredPath.trim() || !requestedPath) return null
  try {
    const configured = resolve(configuredPath)
    const requested = resolve(requestedPath)
    const fold = (value: string): string => platform === 'win32' ? value.toLowerCase() : value
    return fold(configured) === fold(requested) ? configured : null
  } catch {
    return null
  }
}

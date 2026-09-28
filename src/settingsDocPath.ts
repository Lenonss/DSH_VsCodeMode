import { posix, win32 } from 'node:path'

/**
 * Resolve the settings document only when the request names its exact configured path.
 *
 * Both sides are resolved with the path rules of `platform` (win32 → `C:`-style paths and
 * case-insensitive comparison; otherwise POSIX rules and case-sensitive comparison), so the
 * function keeps its meaning when the host platform is passed explicitly instead of implied.
 * @author ddj 2026年10月02号
 * @param configuredPath Path exposed by the active settings provider
 * @param requestedPath Path requested by the editor RPC
 * @param platform Platform whose path rules resolve both sides and drive case comparison
 * @returns The configured absolute path when authorized; otherwise null
 */
export function settingsDocPath(
  configuredPath: unknown,
  requestedPath: string,
  platform = process.platform,
): string | null {
  if (typeof configuredPath !== 'string' || !configuredPath.trim() || !requestedPath) return null
  try {
    const api = platform === 'win32' ? win32 : posix
    const configured = api.resolve(configuredPath)
    const requested = api.resolve(requestedPath)
    const fold = (value: string): string => platform === 'win32' ? value.toLowerCase() : value
    return fold(configured) === fold(requested) ? configured : null
  } catch {
    return null
  }
}

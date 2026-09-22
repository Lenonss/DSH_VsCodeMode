/**
 * dsh-vscode-mode host — DAP source 路径归一化与候选排序。
 * 适配器可能上报绝对路径、工作区相对路径、file:// URI 或 Lua chunkname；
 * 这里统一转换，避免调用栈只显示 rawFile 但无法跳转。
 * 作者 ddj 2026年09月29号
 */

/** 统一路径分隔符并去掉 chunkname 的 @ 前缀。 */
export function normalizeSourcePath(value: unknown): string {
  let text = String(value ?? '').trim()
  if (!text) return ''
  if (/^file:\/\//i.test(text)) text = fileUriPath(text)
  return text.replace(/^@/, '').replace(/\\/g, '/')
}

/** 将 file:// URI 转成本地路径（兼容 Windows 盘符与 UNC）。 */
function fileUriPath(value: string): string {
  try {
    const url = new URL(value)
    let path = decodeURIComponent(url.pathname)
    if (url.hostname && url.hostname !== 'localhost') path = '//' + url.hostname + path
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1)
    return path
  } catch {
    return value.replace(/^file:\/\//i, '')
  }
}

/** 取路径 basename（大小写保持原样）。 */
export function sourceBaseOf(value: unknown): string {
  const path = normalizeSourcePath(value)
  return path.split('/').pop() ?? ''
}

/** 规范化路径键（大小写不敏感，供候选缓存使用）。 */
export function sourceKeyOf(value: unknown): string {
  return normalizeSourcePath(value).toLowerCase()
}

/**
 * 把 source 路径转换为工作区相对路径；工作区外路径保留规范化绝对路径，
 * 不再返回空串，调用方仍可交给现有 tabPathOf/absoluteOf 继续处理。
 */
export function sourcePathOf(value: unknown, workspacePath: string): string {
  const source = normalizeSourcePath(value)
  if (!source) return ''
  const root = normalizeSourcePath(workspacePath).replace(/\/+$/, '')
  if (root && source.toLowerCase().startsWith((root + '/').toLowerCase())) {
    return source.slice(root.length + 1)
  }
  return source
}

/**
 * 对 findFile 候选按 chunkname 相关度排序：完整路径后缀 > 路径片段 > basename/stem，
 * 同分时保持确定性字典序，避免同名 Lua 文件随机取第一项。
 */
export function rankSourceCandidates(chunk: string, files: string[], workspacePath: string): string[] {
  const needle = normalizeSourcePath(chunk).toLowerCase()
  const needleParts = needle.split('/').filter(Boolean)
  const needleBase = sourceBaseOf(needle).toLowerCase()
  const needleStem = needleBase.replace(/\.[^.]+$/, '')
  return [...files].sort((a, b) => scoreSource(b, needle, needleParts, needleBase, needleStem, workspacePath) - scoreSource(a, needle, needleParts, needleBase, needleStem, workspacePath) || a.localeCompare(b))
}

/** 计算单个候选相关度。 */
function scoreSource(file: string, needle: string, parts: string[], base: string, stem: string, workspacePath: string): number {
  const rel = sourcePathOf(file, workspacePath).toLowerCase()
  const fileBase = sourceBaseOf(rel).toLowerCase()
  const fileStem = fileBase.replace(/\.[^.]+$/, '')
  let score = 0
  if (needle && (rel === needle || rel.endsWith('/' + needle) || needle.endsWith('/' + rel))) score += 100000
  if (base && fileBase === base) score += 10000
  if (stem && fileStem === stem) score += 5000
  const relParts = rel.split('/').filter(Boolean)
  let suffix = 0
  for (let i = 1; i <= Math.min(parts.length, relParts.length); i++) {
    if (parts[parts.length - i] !== relParts[relParts.length - i]) break
    suffix += 1
  }
  return score + suffix * 100
}

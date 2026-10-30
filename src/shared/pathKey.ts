/**
 * 路径比较口径：Host 与客户端共用同一套「远端 / 盘符 / 相对路径」判定，只在平台折叠上分工。
 * @author ddj 2026年10月30号
 */

/** 远端仓库身份：`scheme://...` 区分大小写，绝不能折叠。 */
const REMOTE = /^[a-z]+:\/\//i
/** 盘符绝对路径：大小写不敏感与宿主平台无关，两边都必须折叠。 */
const DRIVE = /^[a-z]:\//i

/**
 * @author ddj 2026年10月30号
 * @description: 统一分隔符为 `/`，其余字符原样保留。
 * @param path 原始路径
 * @returns 反斜杠已归一化的路径
 */
export function unifiedPath(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * @author ddj 2026年10月30号
 * @description: 是否为远端仓库身份。
 * @param path 原始路径
 * @returns 远端身份返回 true
 */
export function isRemotePath(path: string): boolean {
  return REMOTE.test(unifiedPath(path))
}

/**
 * @author ddj 2026年10月30号
 * @description: 是否为盘符绝对路径。
 * @param path 原始路径
 * @returns Windows 盘符路径返回 true
 */
export function isDrivePath(path: string): boolean {
  return DRIVE.test(unifiedPath(path))
}

/**
 * @author ddj 2026年10月30号
 * @description: 生成路径比较键。盘符路径恒折叠大小写；其余路径是否折叠由调用方按运行平台决定
 * （Host 在 Windows 上折叠，客户端不在宿主进程里，取 false）。
 * @param path 原始路径
 * @param foldCase 非盘符路径是否折叠大小写
 * @returns 比较键
 */
export function pathKeyFor(path: string, foldCase: boolean): string {
  const unified = unifiedPath(path)
  if (REMOTE.test(unified)) return unified
  if (DRIVE.test(unified)) return unified.toLowerCase()
  return foldCase ? unified.toLowerCase() : unified
}

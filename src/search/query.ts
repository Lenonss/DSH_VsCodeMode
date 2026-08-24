/**
 * dsh-vscode-mode host — 搜索 query 与路径规范化。
 * 查询只按字面连续片段比较，不解释为正则或 shell 语句。
 * 作者 ddj 2026年08月24号
 */
import { isAbsolute, resolve } from 'node:path'
import type { PreparedQuery } from './types.js'

/**
 * 规范化用户搜索文本。
 * @author ddj 2026年08月24号
 * @param raw 原始搜索文本
 * @returns 用于比较和缓存的 query
 */
export function prepareQuery(raw: unknown): PreparedQuery {
  const value = String(raw ?? '').trim()
  return { raw: value, text: value.replaceAll('\\', '/').toLocaleLowerCase('en-US') }
}

/**
 * 归一化路径分隔符并移除无意义前缀。
 * @author ddj 2026年08月24号
 * @param value 原始路径
 * @returns 比较用路径
 */
export function pathText(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '')
}

/**
 * 生成不区分大小写的路径 key。
 * @author ddj 2026年08月24号
 * @param value 原始路径
 * @returns 去重 key
 */
export function pathKey(value: string): string {
  return pathText(value).toLocaleLowerCase('en-US')
}

/**
 * 将相对文件路径映射到 provider 根目录。
 * @author ddj 2026年08月24号
 * @param value 文件路径
 * @param root 工作区根目录
 * @returns 可供 edrv.read 使用的路径
 */
export function displayPath(value: string, root: string): string {
  const normalized = pathText(value)
  if (isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) return normalized
  return resolve(root, normalized)
}

/**
 * 判断路径是否包含连续 query。
 * @author ddj 2026年08月24号
 * @param value 文件路径
 * @param query 已规范化 query
 * @returns 是否命中
 */
export function pathMatch(value: string, query: PreparedQuery): boolean {
  return pathText(value).toLocaleLowerCase('en-US').includes(query.text)
}

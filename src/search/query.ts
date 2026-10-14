/**
 * dsh-vscode-mode host — 搜索 query 与路径规范化。
 * 文件名支持有序子序列；带目录的查询保持连续片段，不解释为正则或 shell 语句。
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
 * @public
 * @author ddj 2026年10月14号
 * @description 按顺序匹配不连续字符；每个位置最多消费一次。
 * @param value 已归一化候选文本
 * @param text 已归一化查询文本
 * @returns 是否完整匹配所有查询字符
 */
export function subsequence(value: string, text: string): boolean {
  let offset = 0
  for (const char of text) {
    const index = value.indexOf(char, offset)
    if (index < 0) return false
    offset = index + char.length
  }
  return true
}

/**
 * @public
 * @author ddj 2026年10月14号
 * @description 连续匹配相对路径，或对无目录查询模糊匹配文件名。
 * @param value 文件路径（调用方移除工作区根前缀）
 * @param query 已规范化 query
 * @returns 是否命中；空查询不命中
 */
export function pathMatch(value: string, query: PreparedQuery): boolean {
  if (!query.text) return false
  const path = pathText(value).toLocaleLowerCase('en-US')
  if (path.includes(query.text)) return true
  if (query.text.includes('/')) return false
  const basename = path.slice(path.lastIndexOf('/') + 1)
  return subsequence(basename, query.text)
}

/**
 * dsh-vscode-mode host — UI 状态镜像存储（界面状态的跨重启记忆）。
 * 背景：Web GUI 的 origin（含端口）可能每次启动变化，而 localStorage 按 origin 分区，
 * 于是页签/侧栏/预览态等状态随重启一并丢失。这里把客户端 `edrv.*` 键的字符串原值
 * 按工作区镜像到 host 文件（workspace/<hash>/ui.v<schema>.json；全局键走 user/），
 * 启动时原样回填本地缺失的键。
 * 值不解析、不校验业务格式（客户端自会解析并丢弃损坏值），只保证键值对可靠落盘：
 * - 原子写：先写临时文件再 rename，避免半截文件
 * - 串行化：同一文件的写操作链式排队，避免并发丢更新
 * - 容量上限：序列化超过 UI_STATE_BYTES_CAP 即拒写（客户端保留 localStorage，不丢数据）
 * 纯函数（parse/serialize/merge）与文件读写均参数注入，可单测。
 * 作者 ddj 2026-09-28
 */
import { Buffer } from 'node:buffer'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// --region 常量与类型
/** UI 状态镜像文档版本（与文件名 schema 解耦：文件名管失效，字段管结构）。 */
export const UI_STATE_VERSION = 1
/** UI 状态镜像容量上限：序列化后超出即拒写（客户端回退纯 localStorage）。 */
export const UI_STATE_BYTES_CAP = 512 * 1024

/** UI 状态镜像文档。 */
export interface UiStateDoc {
  /** 文档版本（不匹配即视为损坏）。 */
  version: number
  /** 最后写入时间（ISO 字符串，仅供排查）。 */
  updatedAt: string
  /** 界面状态键值表（localStorage 键 → 字符串原值）。 */
  keys: Record<string, string>
}

/** 增量补丁：值 null/undefined 表示删除该键（localStorage 值恒为字符串，语义无歧义）。 */
export type UiStatePatch = Record<string, string | null | undefined>
// --endregion

// --region 纯函数
/**
 * 合并增量补丁到键值表（不改入参）。
 * @author ddj 2026年09月28号
 * @param base 已有键值表
 * @param patch 增量补丁（null/undefined 值删除该键；空键跳过）
 * @returns 合并后的新键值表
 */
export function mergeUiStateKeys(base: Record<string, string>, patch: UiStatePatch): Record<string, string> {
  const merged: Record<string, string> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (!key) continue
    if (value === null || value === undefined) delete merged[key]
    else merged[key] = String(value)
  }
  return merged
}

/**
 * 解析镜像文件文本；损坏/版本不符 → null（调用方视为空）。
 * @author ddj 2026年09月28号
 * @param text 文件文本（可为空）
 * @returns 解析后的文档；不可用时 null
 */
export function parseUiState(text: string | null | undefined): UiStateDoc | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const doc = raw as { version?: unknown; updatedAt?: unknown; keys?: unknown }
  if (doc.version !== UI_STATE_VERSION) return null
  if (!doc.keys || typeof doc.keys !== 'object') return null
  const keys: Record<string, string> = {}
  for (const [key, value] of Object.entries(doc.keys as Record<string, unknown>)) {
    if (!key || typeof value !== 'string') continue
    keys[key] = value
  }
  return {
    version: UI_STATE_VERSION,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : '',
    keys,
  }
}

/**
 * 序列化为镜像文件文本。
 * @author ddj 2026年09月28号
 * @param keys 键值表
 * @param updatedAt 更新时间（缺省当前时间）
 * @returns 文件文本
 */
export function serializeUiState(keys: Record<string, string>, updatedAt = new Date().toISOString()): string {
  const doc: UiStateDoc = { version: UI_STATE_VERSION, updatedAt, keys }
  return JSON.stringify(doc)
}
// --endregion

// --region 文件读写
/** 同文件写队列尾（串行化并发写入；队列清空即移除条目）。 */
const writeChains = new Map<string, Promise<unknown>>()

/**
 * 把写任务挂到该文件的队尾串行执行（前序失败不影响后续）。
 * @author ddj 2026年09月28号
 * @param file 目标文件绝对路径
 * @param run 实际写操作
 * @returns 本次写操作结果
 */
function chainWrite<T>(file: string, run: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.then(() => undefined, () => undefined)
  writeChains.set(file, tail)
  void tail.then(() => {
    if (writeChains.get(file) === tail) writeChains.delete(file)
  })
  return next
}

/**
 * 读取镜像文件的键值表（文件缺失/损坏/不可读 → 空表，静默）。
 * @author ddj 2026年09月28号
 * @param file 镜像文件绝对路径
 * @returns 键值表（localStorage 键 → 字符串原值）
 */
export async function readUiState(file: string): Promise<Record<string, string>> {
  try {
    const doc = parseUiState(await readFile(file, 'utf8'))
    return doc ? doc.keys : {}
  } catch (error) {
    return {}
  }
}

/**
 * 合并写入镜像文件（读旧 → 合并补丁 → 容量校验 → 原子替换），同文件写操作串行。
 * @author ddj 2026年09月28号
 * @param file 镜像文件绝对路径
 * @param patch 增量补丁（null/undefined 值删除该键）
 * @returns ok；超限或写入失败时 ok:false + 中文错误文案
 */
export async function writeUiState(
  file: string,
  patch: UiStatePatch,
): Promise<{ ok: true } | { ok: false; error: string }> {
  return chainWrite(file, async () => {
    try {
      const merged = mergeUiStateKeys(await readUiState(file), patch)
      const json = serializeUiState(merged)
      if (Buffer.byteLength(json, 'utf8') > UI_STATE_BYTES_CAP) {
        return { ok: false as const, error: '界面状态镜像超出容量上限（' + UI_STATE_BYTES_CAP + ' 字节）' }
      }
      await mkdir(dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await writeFile(tmp, json, 'utf8')
      await rename(tmp, file)
      return { ok: true as const }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false as const, error: '界面状态写入失败: ' + reason }
    }
  })
}
// --endregion

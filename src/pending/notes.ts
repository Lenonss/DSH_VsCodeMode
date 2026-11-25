/**
 * 只读编辑说明：AI 给某个文件留一句「为什么改」，只供面板展示。
 * 不参与真假判定、不改写工具参数、不落库；插件卸载或换工作区即清空。
 * @author ddj 2026年11月25号
 */
import { pathKeyOf } from './provenance.js'

/** 单条说明上限（字符）。 */
export const NOTE_MAX = 500
/** 每个工作区最多记住多少条，超出按写入序逐出最旧。 */
export const NOTE_SPACE_MAX = 200

/** 一个工作区的说明表。 */
interface NoteSpace {
  /** 插入顺序，逐出时用。 */
  order: string[]
  /** 条目身份 → 说明。 */
  byPath: Map<string, string>
}

/** 进程内说明表：随插件装配创建，卸载清空。 */
const spaces = new Map<string, NoteSpace>()

/**
 * @private
 * @author ddj 2026年11月25号
 * @description: 取（或建）一个工作区的说明表。
 * @param cwd 工作区
 * @returns 说明表
 */
function spaceOf(cwd: string): NoteSpace {
  const key = pathKeyOf(cwd)
  const existing = spaces.get(key)
  if (existing) return existing
  const created: NoteSpace = { order: [], byPath: new Map() }
  spaces.set(key, created)
  return created
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 记录一条只读说明；同一文件后写的覆盖先写的，超出上限逐出最旧。
 * @param cwd 工作区
 * @param identity 条目身份（文件绝对路径）
 * @param note 说明文本
 * @returns 无
 */
export function declareNote(cwd: string, identity: string, note: string): void {
  if (!cwd || !identity || !note) return
  const space = spaceOf(cwd)
  const key = pathKeyOf(identity)
  if (!space.byPath.has(key)) space.order.push(key)
  space.byPath.set(key, note.slice(0, NOTE_MAX))
  while (space.order.length > NOTE_SPACE_MAX) {
    const oldest = space.order.shift()
    if (oldest !== undefined) space.byPath.delete(oldest)
  }
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 读某个文件的只读说明；没有时返回 undefined。
 * @param cwd 工作区
 * @param identity 条目身份（文件绝对路径）
 * @returns 说明或 undefined
 */
export function noteOf(cwd: string, identity: string): string | undefined {
  return spaces.get(pathKeyOf(cwd))?.byPath.get(pathKeyOf(identity))
}

/**
 * @public
 * @author ddj 2026年11月25号
 * @description: 清空说明；不传工作区时清全部（插件卸载）。
 * @param cwd 工作区
 * @returns 无
 */
export function clearNotes(cwd?: string): void {
  if (cwd === undefined) spaces.clear()
  else spaces.delete(pathKeyOf(cwd))
}

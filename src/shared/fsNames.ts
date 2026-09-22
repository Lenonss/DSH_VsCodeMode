/**
 * dsh-vscode-mode shared — 文件操作名称/路径校验（纯函数，可单测）。
 * 新建/重命名输入护栏（客户端弹窗校验与 host 端二次校验共用一份）：
 * 空名、绝对路径、盘符、'.'/'..' 路径段、空路径段、控制字符、超长一律拒绝；
 * 新建允许 a/b.c 嵌套段（对齐 VS Code「新建文件…」输入语义），重命名仅允许单个名称段。
 * 作者 ddj 2026年09月22号
 */

/** 单个名称段最大长度（防误贴超长串直接打到文件系统）。 */
export const NAME_MAX = 255

/**
 * 路径归一：去首尾空白 + 反斜杠转 '/'（Windows 输入等价处理）。
 * @author ddj 2026年09月22号
 * @param raw 原始输入
 * @returns 归一后的字符串
 */
function normPath(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\\/g, '/')
}

/**
 * 单个名称段的通用违规检查（两套校验共用）。
 * @author ddj 2026年09月22号
 * @param seg 名称段
 * @returns 错误文案；null = 通过
 */
function checkSegment(seg: string): string | null {
  if (!seg) return '名称包含空路径段'
  if (seg === '.' || seg === '..') return '名称不能包含 . 或 .. 路径段'
  if (seg.length > NAME_MAX) return '名称过长（单段超过 ' + NAME_MAX + ' 字符）'
  if (/[\0-\x1f]/.test(seg)) return '名称包含非法控制字符'
  return null
}

/**
 * 校验新建文件/文件夹的相对路径（允许 a/b.c 嵌套段）。
 * @author ddj 2026年09月22号
 * @param raw 用户输入的名称或相对路径
 * @returns 错误文案；null = 校验通过
 */
export function checkNewName(raw: unknown): string | null {
  const text = normPath(raw)
  if (!text) return '名称不能为空'
  if (text.startsWith('/')) return '名称不能是绝对路径'
  if (/^[a-zA-Z]:/.test(text)) return '名称不能带盘符'
  for (const seg of text.split('/')) {
    const bad = checkSegment(seg)
    if (bad) return bad
  }
  return null
}

/**
 * 校验重命名的新名称（仅单个名称段，不接受路径）。
 * @author ddj 2026年09月22号
 * @param raw 用户输入的新名称
 * @returns 错误文案；null = 校验通过
 */
export function checkRenameName(raw: unknown): string | null {
  const text = normPath(raw)
  if (!text) return '名称不能为空'
  if (text.includes('/')) return '新名称不能包含路径分隔符'
  return checkSegment(text)
}

/**
 * 拼接工作区相对路径（dir 为空 = 根；name 新建时可含多段）。
 * @author ddj 2026年09月22号
 * @param dir 目标目录（工作区相对）
 * @param name 名称
 * @returns 拼接后的相对路径
 */
export function joinRelPath(dir: string, name: string): string {
  const base = normPath(dir).replace(/\/+$/, '')
  const add = normPath(name).replace(/^\/+/, '')
  return base ? base + '/' + add : add
}

/**
 * 取相对路径的父目录（顶层条目返回空串 = 根）。
 * @author ddj 2026年09月22号
 * @param path 工作区相对路径
 * @returns 父目录相对路径
 */
export function parentRelOf(path: string): string {
  const parts = normPath(path).split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

/**
 * 取相对路径的名称段（末段）。
 * @author ddj 2026年09月22号
 * @param path 工作区相对路径
 * @returns 末段名称
 */
export function baseNameOf(path: string): string {
  const parts = normPath(path).split('/').filter(Boolean)
  return parts.pop() ?? ''
}

/**
 * other 是否为 base 本身或其内部路径（复制/移动「不能以自身或其子目录为目标」护栏）。
 * @author ddj 2026年09月22号
 * @param base 基准相对路径（源）
 * @param other 待判定相对路径（目标目录）
 * @returns 是否为自身或子路径
 */
export function isSubPath(base: string, other: string): boolean {
  const b = normPath(base).replace(/\/+$/, '')
  const o = normPath(other).replace(/\/+$/, '')
  if (!b) return false
  return o === b || o.startsWith(b + '/')
}

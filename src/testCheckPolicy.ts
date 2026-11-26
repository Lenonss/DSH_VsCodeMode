/**
 * dsh-vscode-mode host — 测试验收模式的项目级规则文件（`.dsh/test-check/policy.md`）。
 *
 * 模式内建规则写死在 `testCheckGuidance.ts`，改它要重构建插件；项目自己的验收要求
 * （必须跑的用例、证据长什么样、哪些条目不许口头过）应该由用户直接改文件，所以放在
 * `<项目根>/.dsh/test-check/policy.md`，每次请求拼进规则段，改完下一次请求就生效。
 *
 * 读盘是同步的（规则段文本回调是同步的），按 mtime 缓存，文件不存在就是空串。
 * @author ddj 2026年11月25号
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_TEST_POLICY, POLICY_MAX_BYTES } from './shared/testCheckPolicyDefault.js'
import { TEST_CHECK_BASE_DIR } from './shared/testCheck.js'

//region 常量

/** 项目级规则文件名。 */
export const POLICY_FILE = 'policy.md'

//endregion

//region 读取

/** mtime 缓存：绝对路径 → 上次读到的内容。 */
const cache = new Map<string, { mtimeMs: number; text: string }>()

/**
 * 规则文件的绝对路径（`<项目根>/.dsh/test-check/policy.md`）。
 * @author ddj 2026年11月25号
 * @param root 项目根
 * @returns 绝对路径
 */
export function policyPathOf(root: string): string {
  return join(root, TEST_CHECK_BASE_DIR, POLICY_FILE)
}

/**
 * 读项目级规则文件；不存在、读失败或空文件都返回空串（模式仍按内建规则跑）。
 *
 * 截断口径按字节上线，截断后附一行说明，避免用户以为规则被静默忽略。
 * @author ddj 2026年11月25号
 * @param root 项目根（空串表示拿不到工作区）
 * @returns 规则正文（已去 BOM）
 */
export function policyOverlayOf(root: string): string {
  if (!root) return ''
  const path = policyPathOf(root)
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(path)
  } catch {
    return ''
  }
  if (!info.isFile()) return ''

  const cached = cache.get(path)
  if (cached && cached.mtimeMs === info.mtimeMs) return cached.text

  let raw: string
  try {
    raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
  const text = raw.trim().length === 0
    ? ''
    : (raw.length > POLICY_MAX_BYTES
        ? raw.slice(0, POLICY_MAX_BYTES) + '\n\n（policy.md 超过 8 KB，以上已截断；把规则写短一点）'
        : raw)
  cache.set(path, { mtimeMs: info.mtimeMs, text })
  return text
}

/**
 * 清空规则缓存（插件卸载与测试隔离用）。
 * @author ddj 2026年11月25号
 */
export function resetPolicyCache(): void {
  cache.clear()
}

//endregion

//region 生效文本

/** 生效的规范正文与来源。 */
export interface PolicyText {
  /** 生效正文（已截断，超长时末尾带说明）。 */
  text: string
  /** true = 用的是默认规则（文件不存在或空白）。 */
  isDefault: boolean
}

/**
 * 当前生效的项目测试规范：文件非空白就用文件，否则用默认规则。
 *
 * 与 `policyOverlayOf` 的分工：那个函数只负责「读文件」，回答「用户写过什么」；
 * 这个函数回答「规则段最终该给模型看什么」，默认规则也只在这里兜底。
 * @author ddj 2026年11月26号
 * @param root 项目根（空串表示拿不到工作区）
 * @returns 正文与来源
 */
export function policyTextOf(root: string): PolicyText {
  const text = policyOverlayOf(root)
  if (text.trim()) return { text, isDefault: false }
  return { text: DEFAULT_TEST_POLICY, isDefault: true }
}

/**
 * 写项目测试规范：空白文本删除文件（回到默认），否则按 UTF-8 + LF 落盘。
 *
 * 写的是 `<项目根>/.dsh/test-check/policy.md` 这一个固定路径，调用方传不了别的路径；
 * 写完立即清缓存，保证同一条消息里读到的就是新规则。
 * @author ddj 2026年11月26号
 * @param root 项目根（空串表示没有工作区）
 * @param text 规则正文
 * @returns 写后生效的正文与来源
 * @throws 工作区为空或写盘失败（文案可直接展示）
 */
export async function writePolicyText(root: string, text: string): Promise<PolicyText> {
  if (!root) throw new Error('保存项目测试规范需要所属会话的工作区')

  const path = policyPathOf(root)
  const body = String(text ?? '').replace(/\r\n/g, '\n')

  // 空白 = 回到默认：删文件而不是写一个空文件，否则「有没有自定义规则」会变得看不出来
  if (body.trim() === '') {
    await rm(path, { force: true })
    resetPolicyCache()
    return policyTextOf(root)
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
  resetPolicyCache()
  return policyTextOf(root)
}

//endregion

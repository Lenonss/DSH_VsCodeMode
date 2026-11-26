/**
 * dsh-vscode-mode host — `/test-check` 的 RPC：读视图、手动上报、导出快照。
 *
 * 三个方法都按会话作用域解析工作区（同 `reviewHandlers` 的写法）：页面轮询用 get，
 * 页签工具栏的「手动上报」用 report，导出按钮用 snapshot。真正的读写都在
 * `testCheckStore.ts` 里，这里只做参数校验与错误归一。
 * @author ddj 2026年11月25号
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { skillsDirOf } from './paths.js'
import { resolveScope } from './registry.js'
import {
  exportSnapshot,
  listSheets,
  projectRootOf,
  readView,
  removeSheet,
  slashPath,
  writeEvent,
} from './testCheckStore.js'
import { policyPathOf, policyTextOf, writePolicyText } from './testCheckPolicy.js'
import { normalizeStatus } from './shared/testCheck.js'
import type { RpcHandlerMap, TestCheckPolicyPayload } from './shared/rpc.js'
import type { Ctx } from './store.js'

//region 工具

/** 随包技能名（`skills/` 下的目录名，frontmatter 里的 name 必须与它一致）。 */
const SKILL_NAME = 'dsh-vscodemode-test-check'

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月25号
 * @param error 捕获值
 * @returns 可读文案
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

/**
 * 读当前生效的项目测试规范（文件或默认规则）。
 * @author ddj 2026年11月26号
 * @param cwd 会话工作区
 * @returns 路径、正文与来源
 */
function policyOf(cwd: string): TestCheckPolicyPayload {
  const root = projectRootOf(cwd)
  const policy = policyTextOf(root)
  return { path: slashPath(policyPathOf(root)), text: policy.text, isDefault: policy.isDefault }
}

/**
 * 随包技能正文文件绝对路径（`<包根>/skills/<名>/SKILL.md`）。
 * @author ddj 2026年11月26号
 * @returns 绝对路径
 */
function skillFileOf(): string {
  return join(skillsDirOf(import.meta.url), SKILL_NAME, 'SKILL.md')
}

//endregion

//region handler 表

/**
 * 构造测试验收模式的三个 handler（由 `buildHandlers` 并入总表）。
 * @author ddj 2026年11月25号
 * @param ctx 宿主上下文
 * @returns 三个方法的 handler
 */
export function checkHandlers(ctx: Ctx): Partial<RpcHandlerMap> {
  return {
    /** 读派生视图：页签与 chip 轮询它，1 秒一次也够轻。 */
    'edrv.testCheck.get': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        return { ok: true, view: await readView({ cwd: sc.cwd, id: args.id, force: args.force === true }) }
      } catch (error) {
        return { ok: false, error: '读取验收单失败：' + messageOf(error) }
      }
    },
    /** 手动上报一条结果（页签工具栏用）：与 AI 的上报工具走同一条写盘链路。 */
    'edrv.testCheck.report': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const status = normalizeStatus(args.status)
      if (!status) return { ok: false, error: 'status 只能是 pass / fail / blocked / skip' }
      const item = typeof args.item === 'string' ? args.item.trim() : ''
      if (!item) return { ok: false, error: 'item 必填：写验收单里的测试点 id' }
      const summary = typeof args.summary === 'string' ? args.summary.trim() : ''
      if (!summary) return { ok: false, error: 'summary 必填：它就是这次验证的证据' }
      try {
        const written = await writeEvent({
          cwd: sc.cwd,
          id: typeof args.id === 'string' && args.id.trim() ? args.id.trim() : 'check',
          item,
          status,
          evidence: { kind: 'manual', summary },
        })
        return { ok: true, view: written.view, filed: written.file }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },
    /** 导出交付快照：`docs/acceptance-<id>.html`（单文件、无脚本）。 */
    'edrv.testCheck.snapshot': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const result = await exportSnapshot({
          cwd: sc.cwd,
          id: typeof args.id === 'string' && args.id.trim() ? args.id.trim() : 'check',
        })
        return { ok: true, path: result.path, view: result.view }
      } catch (error) {
        return { ok: false, error: '导出快照失败：' + messageOf(error) }
      }
    },
    /** 读项目测试规范：有文件给文件内容，没有给默认规则。 */
    'edrv.testCheck.policy.get': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        return { ok: true, ...policyOf(sc.cwd) }
      } catch (error) {
        return { ok: false, error: '读取项目测试规范失败：' + messageOf(error) }
      }
    },
    /** 保存项目测试规范：空白文本＝删文件回默认（不写空文件）。 */
    'edrv.testCheck.policy.save': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      if (typeof args.text !== 'string') {
        return { ok: false, error: 'text 必填：要保存的规则正文（空文本表示恢复默认）' }
      }
      try {
        const root = projectRootOf(sc.cwd)
        const policy = await writePolicyText(root, args.text)
        return { ok: true, path: slashPath(policyPathOf(root)), text: policy.text, isDefault: policy.isDefault }
      } catch (error) {
        return { ok: false, error: '保存项目测试规范失败：' + messageOf(error) }
      }
    },
    /** 重置项目测试规范：删文件回默认。 */
    'edrv.testCheck.policy.reset': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const root = projectRootOf(sc.cwd)
        const policy = await writePolicyText(root, '')
        return { ok: true, path: slashPath(policyPathOf(root)), text: policy.text, isDefault: policy.isDefault }
      } catch (error) {
        return { ok: false, error: '重置项目测试规范失败：' + messageOf(error) }
      }
    },
    /** 读随包技能全文（只读展示；文件缺失给可读原因，面板不白屏）。 */
    'edrv.testCheck.skill': async () => {
      const file = skillFileOf()
      try {
        const content = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
        return { ok: true, name: SKILL_NAME, path: slashPath(file), content }
      } catch (error) {
        return { ok: false, error: '技能文件读取失败：' + slashPath(file) + '（' + messageOf(error) + '）' }
      }
    },
    /** 列出项目内全部验收单：计数与验收单页签同源，附快照是否存在。 */
    'edrv.testCheck.sheets': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      try {
        const listed = await listSheets({ cwd: sc.cwd, force: args.force === true })
        return { ok: true, root: listed.root, sheets: listed.sheets }
      } catch (error) {
        return { ok: false, error: '读取验收单列表失败：' + messageOf(error) }
      }
    },
    /** 移除一张验收单目录与它的快照（破坏性；路径由 id 现算，不收外部路径）。 */
    'edrv.testCheck.remove': async (args) => {
      const sc = await resolveScope(ctx, args.sessionId)
      if ('err' in sc) return { ok: false, error: sc.err }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (!id) return { ok: false, error: 'id 必填：要移除的验收单 id' }
      try {
        const result = await removeSheet({ cwd: sc.cwd, id })
        return { ok: true, removed: result.removed }
      } catch (error) {
        return { ok: false, error: '移除验收单失败：' + messageOf(error) }
      }
    },
  }
}

//endregion

/**
 * dsh-vscode-mode client — 暂停态 Lua DAP hover。
 * provider 只在 DAP paused 时工作，按当前 selectedFrameId 求值，并把「表达式值 + 类型 + 可折叠
 * 变量树」渲染成**单个 HTML 块**（`[data-edrv-dap]`）；Alt 切换 LSP 信息由 hover 层做行级显隐
 * （见 hoverTree.ts），因此这里不按 Alt 改变内容，避免依赖 Monaco 的 hover 重算路径。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
import { dapStore } from './store.js'
import { pathOfModel } from '../monaco/lsp/lspClient.js'
import { BLOCK_ATTR, EQ_ATTR, EXPR_ATTR, HEAD_ATTR, TYPE_ATTR, VAL_ATTR, createTreeState, escapeHtml, initialHtml } from './hoverTree.js'

const GLOBAL_KEY = '__edrvDapHoverProvider__'

/** Monaco hover 依赖的最小模型接口。 */
interface HoverModel {
  getWordAtPosition: (position: HoverPosition) => { word?: string; startColumn: number; endColumn: number } | null
  getLineContent?: (line: number) => string
  getLanguageId?: () => string
}

/** 光标位置（1-based）。 */
interface HoverPosition {
  lineNumber: number
  column: number
}

/**
 * 树状态键：表达式 + 模型路径 + 光标范围（同一次 hover 内复用展开状态与缓存）。
 * @author ddj 2026年09月21号
 * @param target 光标处表达式与范围
 * @param path 模型工作区路径
 * @returns 状态键
 */
function treeKeyOf(target: { expression: string; lineNumber: number; startColumn: number; endColumn: number }, path: string): string {
  return target.expression + '@' + path + ':' + target.lineNumber + ':' + target.startColumn + '-' + target.endColumn
}

/** Lua 保留字集合（保留字不是可求值表达式，避免 adapter 返回 syntax err 噪声）。 */
const LUA_KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto',
  'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
])

/** 可求值路径表达式：标识符链，成员用 . 或 : 连接（注释里的中文文本等一律不匹配）。 */
const EVAL_EXPR = /^[A-Za-z_][A-Za-z0-9_]*(?:[.:][A-Za-z_][A-Za-z0-9_]*)*$/

/**
 * 是否可交给调试器求值：标识符链且非保留字。
 * @author ddj 2026年09月21号
 * @param text 候选表达式
 * @returns 是否可求值
 */
function isEvalExpr(text: string): boolean {
  return EVAL_EXPR.test(text) && !LUA_KEYWORDS.has(text)
}

/**
 * 从光标处提取 Lua 标识符/成员表达式（如 this.model、self:GetName）。
 * 光标在链首段时只取该段（悬停 this 求 this，而不是 this.canUpdate）；
 * 光标在成员段时取整条链（悬停 canUpdate 求 this.canUpdate）。
 * @author ddj 2026年09月29号 / 2026年09月21号
 * @param model Monaco 文本模型
 * @param position 光标位置
 */
export function expressionAt(model: HoverModel, position: HoverPosition): { expression: string; lineNumber: number; startColumn: number; endColumn: number } | null {
  const word = model.getWordAtPosition(position)
  if (!word) return null
  const line = model.getLineContent?.(position.lineNumber) ?? word.word ?? ''
  const start = Math.max(0, word.startColumn - 1)
  const end = Math.max(start, word.endColumn - 1)
  const isPart = (char: string): boolean => /[A-Za-z0-9_.:]/.test(char)
  let left = start
  while (left > 0 && isPart(line[left - 1])) left -= 1
  // 光标词即链首段：只返回该段（向右扩展会把 this 吃成 this.canUpdate）
  if (left === start) {
    const head = line.slice(start, end).trim()
    return head ? { expression: head, lineNumber: position.lineNumber, startColumn: start + 1, endColumn: end + 1 } : null
  }
  let right = end
  while (right < line.length && isPart(line[right])) right += 1
  const expression = line.slice(left, right).trim()
  return expression ? { expression, lineNumber: position.lineNumber, startColumn: left + 1, endColumn: right + 1 } : null
}

/**
 * 组装调试块 HTML（头行 + 类型 + 变量树；全部动态文本转义后拼进 supportHtml 片段）。
 * ⚠️ 钩子一律用 data-*：markdown 渲染会剥掉 class（见 hoverTree.ts 常量区注释）。
 * @author ddj 2026年09月21号
 * @param expression 光标处表达式
 * @param value 求值结果
 * @param type 值类型（可空）
 * @param treeHtml 变量树片段（可空）
 * @returns 单块 HTML
 */
export function blockHtml(expression: string, value: string, type: string, treeHtml: string): string {
  const head = '<div ' + HEAD_ATTR + '="1">'
    + '<span ' + EXPR_ATTR + '="1">' + escapeHtml(expression) + '</span>'
    + '<span ' + EQ_ATTR + '="1"> = </span>'
    + '<code ' + VAL_ATTR + '="1">' + escapeHtml(value) + '</code>'
    + '</div>'
  const typeLine = type ? '<div ' + TYPE_ATTR + '="1">type: <code>' + escapeHtml(type) + '</code></div>' : ''
  return '<div ' + BLOCK_ATTR + '="1">' + head + typeLine + treeHtml + '</div>'
}

/**
 * 暂停态求值并组装 hover 内容（单个 HTML 块）。
 * @author ddj 2026年09月21号
 * @param monaco Monaco 命名空间
 * @param model 文本模型
 * @param position 光标位置
 * @param token Monaco 取消令牌
 * @returns hover 结果；非暂停、取不到表达式/路径、被取消时为 null
 */
async function dapHoverAt(monaco: any, model: HoverModel, position: HoverPosition, token: any): Promise<{ contents: Array<{ value: string; supportHtml?: boolean }>; range: unknown } | null> {
  const snapshot = dapStore.getSnapshot()
  if (snapshot.phase !== 'paused' || token?.isCancellationRequested) return null
  const target = expressionAt(model, position)
  if (!target || !isEvalExpr(target.expression)) return null
  const path = pathOfModel(model)
  if (!path) return null
  const result = await dapStore.evaluate(target.expression, snapshot.selectedFrameId)
  if (/^syntax err/i.test(result.result)) return null
  if (token?.isCancellationRequested) return null
  let treeHtml = ''
  if (result.ref > 0) {
    const children = await dapStore.variables(result.ref)
    if (token?.isCancellationRequested) return null
    // 可展开树：首层随 hover 取回，点「▸」才懒加载下一层（绑定见 hoverTree.ts）
    treeHtml = initialHtml(createTreeState(treeKeyOf(target, path), children))
  }
  return {
    contents: [{ value: blockHtml(target.expression, result.result, result.type ?? '', treeHtml), supportHtml: true }],
    // 必须 new：Monaco 的 Range 是 ES class（createMonacoBaseAPI 导出类本体），
    // 无 new 调用抛 TypeError，被 getHover 的逐 provider try/catch 吞掉 →
    // 表现为「暂停态只有 LSP 浮窗、没有调试值行」。
    range: new monaco.Range(target.lineNumber, target.startColumn, target.lineNumber, target.endColumn),
  }
}

/**
 * 注册暂停态 DAP hover provider（幂等，跨插件重载会先清理旧 provider）。
 * @author ddj 2026年09月29号
 * @param monaco Monaco 命名空间
 */
export function registerDapHover(monaco: any): void {
  if (!monaco?.languages?.registerHoverProvider) return
  const host = typeof window === 'undefined' ? null : window as any
  host?.[GLOBAL_KEY]?.dispose?.()
  const disposable = monaco.languages.registerHoverProvider(['lua'], {
    provideHover: async (model: HoverModel, position: HoverPosition, token: any) => {
      try {
        return await dapHoverAt(monaco, model, position, token)
      } catch {
        return null // 异常不外抛：Monaco 会把整个 provider 的结果丢弃
      }
    },
  })
  if (host) host[GLOBAL_KEY] = { dispose: () => disposable?.dispose?.() }
}

/** 注销 DAP hover provider。 */
export function disposeDapHover(): void {
  const host = typeof window === 'undefined' ? null : window as any
  host?.[GLOBAL_KEY]?.dispose?.()
  if (host) delete host[GLOBAL_KEY]
}

/**
 * dsh-vscode-mode client — HTML 计划页的纯逻辑（标记解析、路径归位、打包检测、状态推导、审批答案）。
 *
 * 页面格式来自上游 html-plan（MIT）；本模块不碰 DOM/React，便于 node 单测。
 * 约定：exit_plan_mode 的 plan 正文里写一行「HTML 计划页：<path>」，
 * 插件据此把计划页签切成 HTML 模式；缺行或文件不可读时回落 Markdown 计划预览。
 * @author ddj 2026年11月21号
 */

/** plan 投影的最小结构面。 */
export interface PlanProjectionLike {
  active?: unknown
  pending?: unknown
}

/** 计划页签的状态模式。 */
export type PlanUiMode = 'unknown' | 'off' | 'planning' | 'reviewing' | 'approved' | 'revising' | 'exited'

/** 计划页签状态（徽标文案 + 原始布尔）。 */
export interface PlanUiState {
  mode: PlanUiMode
  label: string
  active: boolean
  pending: boolean
}

/** 待审批的 plan-review 问题（从 userQuestions 投影快照解析）。 */
export interface PendingReview {
  callId: string
  questionId: string
  approveLabel: string
  keepLabel: string | null
}

/** 插件桥接脚本标记（重复注入的幂等判据）。 */
const BRIDGE_MARK = 'data-edrv-htmlplan-bridge'

/** 计划页标记行：HTML 计划页：<path>（中英文冒号都接受）。 */
const PAGE_LINE = /^[ \t]*HTML[ \t]*计划页[ \t]*[:：][ \t]*(.+?)[ \t]*$/im

/** 相对未打包页面的运行时引用（存在即说明还没 pack）；只看 link/script 标签，`.doc-code src=` 这种引用不算。 */
const RUNTIME_REF = /<(?:link|script)\b[^>]*?\s(?:href|src)\s*=\s*["']([^"']*htmlplan\.(?:css|js))[^>]*>/gi

/** 桥接脚本：拦截 iframe 内剪贴板写入并转发给父级；失败不影响页面。 */
const BRIDGE_SCRIPT = [
  '<script ' + BRIDGE_MARK + '>',
  '(() => {',
  '  try {',
  '    const send = (text) => {',
  '      try { parent.postMessage({ source: "edrv-htmlplan", type: "copy", text: String(text ?? "") }, "*") } catch (error) { /* 父级不可达 */ }',
  '    }',
  '    const clipboard = navigator.clipboard',
  '    const original = clipboard && clipboard.writeText',
  '    if (clipboard && typeof original === "function") {',
  '      clipboard.writeText = function writeText(text) { send(text); return original.apply(this, arguments) }',
  '    }',
  '    const exec = document.execCommand && document.execCommand.bind(document)',
  '    if (exec) {',
  '      document.execCommand = function execCommand(command) {',
  '        try { if (String(command).toLowerCase() === "copy" && window.getSelection) send(window.getSelection().toString()) } catch (error) { /* 忽略 */ }',
  '        return exec.apply(document, arguments)',
  '      }',
  '    }',
  '    document.addEventListener("click", (event) => {',
  '      const node = event.target && event.target.nodeType === 3 ? event.target.parentElement : event.target',
  '      const button = node && node.closest ? node.closest("button") : null',
  '      const label = button ? String(button.textContent || "").trim() : ""',
  '      if (!/copy response|复制答复/i.test(label)) return',
  '      const texts = Array.from(document.querySelectorAll("pre, textarea, [data-htmlplan-response]")).map((el) => String(el.value ?? el.textContent ?? ""))',
  '      texts.sort((left, right) => right.length - left.length)',
  '      if (texts[0]) send(texts[0])',
  '    }, true)',
  '    let reviewPending = false',
  '    const hookSheet = () => {',
  '      const sheets = document.querySelectorAll(".nw-sheet")',
  '      for (const sheet of sheets) {',
  '        if (sheet.dataset.edrvReply) continue',
  '        const title = sheet.querySelector("header h3")',
  '        if (!title || !/your response|你的回复/i.test(title.textContent || "")) continue',
  '        const pre = sheet.querySelector("pre")',
  '        const footer = sheet.querySelector("footer")',
  '        if (!pre || !footer) continue',
  '        sheet.dataset.edrvReply = "1"',
  '        const reply = document.createElement("button")',
  '        reply.type = "button"',
  '        reply.className = "nw-btn primary"',
  '        reply.textContent = reviewPending ? "回复并执行" : "回复"',
  '        reply.title = "直接把这份答复发送给 DSH agent"',
  '        reply.addEventListener("click", (event) => {',
  '          event.preventDefault()',
  '          reply.disabled = true',
  '          reply.textContent = "发送中…"',
  '          try { parent.postMessage({ source: "edrv-htmlplan", type: "respond", text: String(pre.textContent || "") }, "*") } catch (error) { /* 父级不可达 */ }',
  '        }, true)',
  '        const copy = Array.from(footer.querySelectorAll("button")).find((btn) => /copy response|复制答复/i.test(btn.textContent || ""))',
  '        footer.insertBefore(reply, copy || footer.firstChild)',
  '        const hint = sheet.querySelector("p.hint")',
  '        if (hint) hint.textContent = reviewPending ? "点「回复并执行」= 把答复和批准一起交给 agent（同一步读到）；要改计划请先点页签「继续规划」。" : "点「回复」直接发送给 agent；也可以复制后手动粘贴。"',
  '      }',
  '    }',
  '    try { new MutationObserver(() => { try { hookSheet() } catch (error) { /* 忽略 */ } }).observe(document.body || document.documentElement, { childList: true, subtree: true }) } catch (error) { /* 无 MutationObserver */ }',
  '    try { hookSheet() } catch (error) { /* 忽略 */ }',
  '    window.addEventListener("message", (event) => {',
  '      const data = event.data',
  '      if (!data || data.source !== "edrv-plan-host") return',
  '      if (data.type === "state") {',
  '        reviewPending = data.reviewPending === true',
  '        for (const sheet of document.querySelectorAll(".nw-sheet")) {',
  '          const reply = Array.from(sheet.querySelectorAll("footer button")).find((btn) => /回复|发送中|已发送|发送失败/.test(btn.textContent || ""))',
  '          if (reply && !reply.disabled) reply.textContent = reviewPending ? "回复并执行" : "回复"',
  '          const hint = sheet.querySelector("p.hint")',
  '          if (hint && !/发送失败/.test(hint.textContent || "")) hint.textContent = reviewPending ? "点「回复并执行」= 把答复和批准一起交给 agent（同一步读到）；要改计划请先点页签「继续规划」。" : "点「回复」直接发送给 agent；也可以复制后手动粘贴。"',
  '        }',
  '        return',
  '      }',
  '      if (data.type !== "respond-result") return',
  '      for (const sheet of document.querySelectorAll(".nw-sheet")) {',
  '        const reply = Array.from(sheet.querySelectorAll("footer button")).find((btn) => /回复|发送中|已发送|发送失败/.test(btn.textContent || ""))',
  '        if (!reply) continue',
  '        if (data.ok === true) {',
  '          reply.textContent = "已发送"',
  '          setTimeout(() => { try { sheet.querySelector("header button")?.click() } catch (error) { /* 忽略 */ } }, 500)',
  '        } else {',
  '          reply.disabled = false',
  '          reply.textContent = "回复"',
  '          const hint = sheet.querySelector("p.hint")',
  '          if (hint) hint.textContent = "发送失败：" + String(data.message || "未知原因") + "。可复制后手动粘贴。"',
  '        }',
  '      }',
  '    })',
  '    try { parent.postMessage({ source: "edrv-htmlplan", type: "ready" }, "*") } catch (error) { /* 忽略 */ }',
  '  } catch (error) { /* 桥接失败不影响页面 */ }',
  '})();',
  '</script>',
].join('\n')

/**
 * 从计划正文里取 HTML 计划页路径（去掉包裹的反引号/引号）。
 * @author ddj 2026年11月21号
 * @param markdown 计划正文
 * @returns 相对或绝对路径，未声明时 null
 */
export function planPagePathOf(markdown: unknown): string | null {
  const text = typeof markdown === 'string' ? markdown : ''
  const match = PAGE_LINE.exec(text)
  if (!match) return null
  const raw = match[1].trim().replace(/^["'\`]+|["'\`]+$/g, '').trim()
  return raw ? raw.replace(/\\/g, '/') : null
}

/**
 * 把计划页路径归位到工作区绝对路径（相对路径按 cwd 拼接）。
 * @author ddj 2026年11月21号
 * @param cwd 工作区目录
 * @param pagePath 计划声明里的路径
 * @returns 归一化路径（/ 分隔）；空输入返回空串
 */
export function resolvePlanPagePath(cwd: unknown, pagePath: string): string {
  const raw = String(pagePath ?? '').trim()
  if (!raw) return ''
  const normalized = raw.replace(/\\/g, '/')
  if (/^(?:[a-zA-Z]:\/|\/)/.test(normalized)) return normalized
  const base = String(cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  return base ? base + '/' + normalized.replace(/^\.\//, '') : normalized
}

/**
 * 检测仍未内联的运行时引用（未执行 pack 的页面）。
 * @author ddj 2026年11月21号
 * @param html 页面文本
 * @returns 引用串（去重，最多 8 条）
 */
export function unresolvedRuntimeRefs(html: unknown): string[] {
  const text = typeof html === 'string' ? html : ''
  const seen = new Set<string>()
  for (const match of text.matchAll(RUNTIME_REF)) {
    const ref = String(match[1] ?? '').trim()
    if (ref) seen.add(ref)
    if (seen.size >= 8) break
  }
  return [...seen]
}

/**
 * 组装 iframe 的 srcdoc：注入剪贴板桥接脚本（已注入则原样返回）。
 * @author ddj 2026年11月21号
 * @param html 打包后的页面文本
 * @returns 可安全交给 sandbox iframe 的 srcdoc
 */
export function buildPlanSrcDoc(html: unknown): string {
  const text = typeof html === 'string' ? html : ''
  if (!text.trim()) return ''
  if (text.includes(BRIDGE_MARK)) return text
  if (/<\/body\s*>/i.test(text)) return text.replace(/<\/body\s*>/i, BRIDGE_SCRIPT + '\n</body>')
  return text + '\n' + BRIDGE_SCRIPT
}

/**
 * 读取计划页的失败是否属于「文件还没生成」（而不是路径非法/权限等其它原因）。
 * @author ddj 2026年11月23号
 * @param result edrv.read 的返回
 * @returns true 表示页面文件不存在
 */
export function isMissingPage(result: unknown): boolean {
  if (result === null || typeof result !== 'object') return false
  const row = result as { ok?: unknown; code?: unknown; error?: unknown }
  if (row.ok === true) return false
  if (row.code === 'file-missing') return true
  return /文件不存在|no such file|ENOENT/i.test(typeof row.error === 'string' ? row.error : '')
}

/** 打包页里的附件统计。 */
export interface PlanAttachmentInfo {
  /** `<doc-file>` 总数。 */
  total: number
  /** src 仍是本地路径（没被 pack 内联）的数量。 */
  pending: number
}

/**
 * 统计打包页里的附件：`data:` / `http(s):` 之外都算没内联。
 * 打包后的页面内附件必须是 data URI——iframe 用 srcdoc 渲染，相对路径打不开。
 * @author ddj 2026年11月24号
 * @param html 页面文本
 * @returns 总数与未内联数
 */
export function planAttachInfoOf(html: unknown): PlanAttachmentInfo {
  const text = typeof html === 'string' ? html : ''
  let total = 0
  let pending = 0
  for (const match of text.matchAll(/<doc-file\b([^>]*)>/gi)) {
    total += 1
    const found = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(match[1] ?? '')
    const src = found ? found[1] : ''
    if (src && !/^(?:data:|https?:|#)/i.test(src)) pending += 1
  }
  return { total, pending }
}

/**
 * 从计划正文声明的页面路径里取 slug（plans/<slug>/… 的第二段）。
 * @author ddj 2026年11月23号
 * @param declared 声明的路径（可能为空或不是 plans/ 结构）
 * @returns slug；取不到时用 html-plan
 */
export function planSlugOf(declared: unknown): string {
  const parts = String(declared ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  const at = parts.indexOf('plans')
  const raw = at >= 0 && parts.length > at + 1 ? parts[at + 1] : ''
  return /^[a-z0-9][a-z0-9-]*$/i.test(raw) ? raw : 'html-plan'
}

//region 页面来源决策（HTML 计划模式）

/** 计划页读取结果的三态（读不到 / 不存在 / 读到）。 */
export type PlanPageRead = 'ok' | 'missing' | 'error'

/** 计划签打开页面时要执行的动作。 */
export type PlanPageAction = 'show' | 'pack' | 'auto' | 'error'

/** 页面动作决策入参。 */
export interface PlanPageDecisionInput {
  /** 计划正文声明的页面路径（可能为空）。 */
  declared: string
  /** 是否在 HTML 计划模式里提交（允许插件兜底页）。 */
  htmlPlanMode: boolean
  /** 声明路径的读取结果。 */
  read: PlanPageRead
  /** 读到的页面是否还引用未内联的运行时（需要重新打包）。 */
  needsPack: boolean
  /** 备用路径（`.packed.html` ↔ `.html`）是否存在。 */
  alternateExists: boolean
}

/** 页面动作决策结果。 */
export interface PlanPageDecision {
  /** 动作。 */
  action: PlanPageAction
  /** pack 动作的目标路径（绝对或相对，由调用方归位）。 */
  target?: string
}

/**
 * 决定计划签怎样拿到一页 HTML。
 *
 * 顺序：作者页可直接显示 → 作者页需要打包 → 备用路径打包 → HTML 计划模式下用正文渲染 → 报错。
 * `htmlPlanMode` 为真时，声明页缺失/读不到也允许兜底渲染，保证模式内不出现「只剩报错」。
 * @author ddj 2026年11月25号
 * @param input 决策入参
 * @returns 动作与打包目标
 */
export function planPageDecisionOf(input: PlanPageDecisionInput): PlanPageDecision {
  const declared = String(input.declared ?? '').trim()
  if (declared && input.read === 'ok') {
    return input.needsPack ? { action: 'pack', target: declared } : { action: 'show' }
  }
  const alternate = declared ? planPageAltPath(declared) : null
  if (alternate && input.alternateExists) return { action: 'pack', target: alternate }
  if (input.htmlPlanMode) return { action: 'auto' }
  return { action: 'error' }
}

/**
 * 推导作者页的备用路径：`plan.packed.html` ↔ `plan.html`。
 * 没有这两种后缀时返回 null（不做无意义重试）。
 * @author ddj 2026年11月25号
 * @param path 声明路径
 * @returns 备用路径；推导不出时 null
 */
export function planPageAltPath(path: unknown): string | null {
  const value = String(path ?? '').trim().replace(/\\/g, '/')
  if (!value) return null
  if (/\.packed\.html?$/i.test(value)) return value.replace(/\.packed\.html?$/i, '.html')
  if (/\.html?$/i.test(value)) return value.replace(/\.html?$/i, '.packed.html')
  return null
}

//endregion

/**
 * 检测页面里是否真有计划结构（`doc-plan` / `doc-claim` 元素）。
 *
 * 只看标记，不看脚本与样式：运行时脚本里本来就写着 `doc-plan` 这些标签名，
 * 不剥掉就会把「自造样式的文档页」误判成合规计划页。打包后的页面标记还在，不受影响。
 * @author ddj 2026年11月26号
 * @param html 页面文本（作者页或打包页）
 * @returns 是否带计划结构
 */
export function hasPlanStructure(html: unknown): boolean {
  const text = typeof html === 'string' ? html : ''
  if (!text.trim()) return false
  const markup = text
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
  return /<doc-plan\b|<doc-claim\b/i.test(markup)
}

/**
 * 检测页面是否引用了 htmlplan 运行时（未打包页看 link/script，打包页看内联标记）。
 *
 * 打包脚本本来就要求页面链接 `htmlplan.css` / `htmlplan.js`（或内联带 `data-htmlplan`
 * 的 style/script），所以「读得到但没引用运行时」的作者页必然没打包，样式是空的。
 * @author ddj 2026年11月26号
 * @param html 页面文本
 * @returns 是否引用运行时
 */
export function hasPlanRuntime(html: unknown): boolean {
  const text = typeof html === 'string' ? html : ''
  return /htmlplan\.(?:css|js)/i.test(text) || /<style\b[^>]*data-htmlplan/i.test(text)
}

/**
 * 让 agent 重写作者页的修复指令（计划页签「生成 HTML 计划页」按钮发给 agent）。
 * 插件会自动打包，所以不再要求模型跑 plan.mjs（那条命令会删中间文件，不能用于用户文件）。
 * @author ddj 2026年11月23号
 * @author ddj 2026年11月25号（改为「只写页、插件打包」，去掉运行 plan.mjs 的要求）
 * @param declared 计划正文声明的页面路径（可为空）
 * @returns 发给 agent 的用户消息
 */
export function planRepairInstruction(declared: unknown): string {
  const slug = planSlugOf(declared)
  return [
    '请按 dsh-vscodemode-html-plan 技能生成 HTML 计划页，然后重新提交计划：',
    '1. 计划模式里允许写 plans/ 下的计划交付物：直接在计划模式里写页面，不要让我退出计划模式。',
    `2. 只写 plans/${slug}/plan.html 即可：计划签打开时插件会自动打包，不要运行 plan.mjs 或任何 node 命令。`,
    `3. 页面若引用附件（<doc-file src="assets/…">），确认文件在 plans/${slug}/assets/；插件打包时会把它们内联。`,
    '   附件目录不会被插件删除；文件缺失时让我重新附一次，不要凭空造图。',
    `4. 页面写好后调用 exit_plan_mode：正文第一行「# 计划：<标题>」，并单独一行「HTML 计划页：plans/${slug}/plan.html」。`,
    '不要只写路径不生成文件；页面确实生成失败就说清原因，并交付纯 Markdown 计划（插件会用正文兜底渲染）。',
  ].join('\n')
}

/**
 * 由 plan 投影 + 待审批状态 + 本地动作结果推导页签状态文案。
 * @author ddj 2026年11月21号
 * @param projection plan 投影快照（未知形状按不可用处理）
 * @param reviewPending 是否存在 pending 的 plan-review 问题
 * @param acted 本地刚完成的动作（approved / revising）
 * @returns 页签状态
 */
export function derivePlanUiState(
  projection: unknown,
  reviewPending: boolean,
  acted?: 'approved' | 'revising' | 'exited' | null,
): PlanUiState {
  if (projection === null || typeof projection !== 'object') {
    return { mode: 'unknown', label: '计划状态不可用', active: false, pending: false }
  }
  const row = projection as PlanProjectionLike
  const active = row.active === true
  const pending = row.pending === true
  if (pending) return { mode: 'planning', label: '计划状态切换中', active, pending }
  if (acted === 'approved') {
    return { mode: 'approved', label: active ? '已批准 · 等待退出计划模式' : '已批准 · 已退出计划模式', active, pending }
  }
  if (acted === 'exited' && !active) return { mode: 'exited', label: '已退出计划模式', active, pending }
  if (acted === 'revising' && active) return { mode: 'revising', label: '继续规划中', active, pending }
  if (active && reviewPending) return { mode: 'reviewing', label: '待审批', active, pending }
  if (active) return { mode: 'planning', label: '计划中', active, pending }
  return { mode: 'off', label: '计划模式未开启', active, pending }
}

/**
 * HTML 计划模式的状态推导（独立模式不走官方 plan 投影）。
 *
 * 投影缺失时按「提交即活跃」乐观处理：计划能走到计划签，说明提交时模式是活跃的；
 * 批准/退出动作后按本地动作收口，避免按钮一直可点。
 * @author ddj 2026年11月25号
 * @param mode html-plan 投影快照（{ active } 或 undefined）
 * @param reviewPending 是否有待审批的 plan-review
 * @param acted 本地刚完成动作
 * @returns 计划页签状态
 */
export function deriveHtmlPlanUiState(
  mode: unknown,
  reviewPending: boolean,
  acted?: 'approved' | 'revising' | 'exited' | null,
): PlanUiState {
  const row = mode !== null && typeof mode === 'object' ? mode as { active?: unknown } : undefined
  const active = row ? row.active === true : acted !== 'approved' && acted !== 'exited'
  const pending = false
  if (acted === 'approved') {
    return { mode: 'approved', label: active ? '已批准 · 等待退出 HTML 计划模式' : '已批准 · 已退出 HTML 计划模式', active, pending }
  }
  if (acted === 'exited' && !active) return { mode: 'exited', label: '已退出 HTML 计划模式', active, pending }
  if (acted === 'revising' && active) return { mode: 'revising', label: '继续规划中', active, pending }
  if (active && reviewPending) return { mode: 'reviewing', label: '待审批', active, pending }
  if (active) return { mode: 'planning', label: 'HTML 计划模式中', active, pending }
  return { mode: 'off', label: 'HTML 计划模式未开启', active, pending }
}

/**
 * 选项标签归一：字符串或 { label } 数组。
 * @author ddj 2026年11月21号
 * @param options 选项列表
 * @returns 非空标签
 */
function labelsOf(options: unknown): string[] {
  if (!Array.isArray(options)) return []
  const out: string[] = []
  for (const option of options) {
    if (typeof option === 'string') out.push(option.trim())
    else if (option !== null && typeof option === 'object') {
      const label = (option as { label?: unknown }).label
      if (typeof label === 'string' && label.trim()) out.push(label.trim())
    }
  }
  return out
}

/** 按正则挑标签（大小写不敏感）。 */
function pickLabel(labels: string[], pattern: RegExp): string | null {
  for (const label of labels) if (pattern.test(label)) return label
  return null
}

/**
 * 从一个 question 里提取 plan-review 的标签（批准 / 继续规划）。
 * 官方内存请求带 intent 对象（approve 才是准）；投影会丢 intent，只剩选项标签。
 * @author ddj 2026年11月21号
 * @param raw question 形状
 * @returns 标签集合；不是 plan-review 或没有批准标签时 null
 */
export function reviewLabelsOf(raw: unknown): { questionId: string; approveLabel: string; keepLabel: string | null } | null {
  if (raw === null || typeof raw !== 'object') return null
  const question = raw as Record<string, unknown>
  const intent = question.intent !== null && typeof question.intent === 'object'
    ? question.intent as Record<string, unknown>
    : undefined
  const labels = labelsOf(question.options)
  const fromIntent = typeof intent?.approve === 'string' && intent.approve.trim() ? intent.approve.trim() : null
  const questionId = typeof question.id === 'string' && question.id ? question.id : ''
  const declaredReview = intent?.kind === 'plan-review' || questionId === 'plan-review'
  const approveLabel = fromIntent ?? pickLabel(labels, /^(?:approve|approve plan|同意执行|同意)$/i) ?? pickLabel(labels, /approve|同意/i)
  if (approveLabel === null) return null
  if (!declaredReview && !labels.includes(approveLabel)) return null
  const keepLabel = pickLabel(labels.filter(label => label !== approveLabel), /keep planning|继续规划|要求修改/i)
  return { questionId: questionId || 'plan-review', approveLabel, keepLabel }
}

/** 从一行待审批记录里取 questions 数组。 */
function questionsOf(row: Record<string, unknown>): unknown[] {
  const pending = row.pending !== null && typeof row.pending === 'object' ? row.pending as Record<string, unknown> : undefined
  const request = row.request !== null && typeof row.request === 'object' ? row.request as Record<string, unknown> : undefined
  const candidates = [pending?.questions, row.questions, request?.questions]
  for (const value of candidates) if (Array.isArray(value)) return value
  return []
}

/** 取该记录的调用 id（官方问答按 callId 结算）。 */
function callIdOf(row: Record<string, unknown>): string | null {
  const pending = row.pending !== null && typeof row.pending === 'object' ? row.pending as Record<string, unknown> : undefined
  const key = row.key !== null && typeof row.key === 'object' ? row.key as Record<string, unknown> : undefined
  const wait = pending?.wait !== null && typeof pending?.wait === 'object' ? pending.wait as Record<string, unknown> : undefined
  const values = [row.callId, pending?.callId, wait?.callId, (row.wait as Record<string, unknown> | undefined)?.callId, key?.callId, row.id]
  for (const value of values) if (typeof value === 'string' && value) return value
  return null
}

/**
 * 在 userQuestions 投影快照里找待审批的 plan-review 问题。
 * 形状容错：数组或 { items } 包裹；questions 可能在 row/questions/pending 三层。
 * @author ddj 2026年11月21号
 * @param snapshot 投影快照
 * @returns 待审批描述，或 null
 */
export function findPendingReview(snapshot: unknown): PendingReview | null {
  const rows: unknown[] = Array.isArray(snapshot)
    ? snapshot
    : (snapshot !== null && typeof snapshot === 'object' && Array.isArray((snapshot as { items?: unknown }).items)
        ? (snapshot as { items: unknown[] }).items
        : [])
  for (const entry of rows) {
    if (entry === null || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    const callId = callIdOf(row)
    if (!callId) continue
    for (const raw of questionsOf(row)) {
      const labels = reviewLabelsOf(raw)
      if (!labels) continue
      return { callId, questionId: labels.questionId, approveLabel: labels.approveLabel, keepLabel: labels.keepLabel }
    }
  }
  return null
}

/**
 * 构造官方 ask_user_question 答案（批准 = 选批准标签；否则选继续规划标签）。
 * @author ddj 2026年11月21号
 * @param review 待审批描述
 * @param approve 是否批准
 * @returns 答案批次；不批准且没有问题级备选时 null
 */
export function reviewAnswerOf(
  review: PendingReview | null,
  approve: boolean,
): { answers: Array<{ id: string; selected: string[]; custom: string }> } | null {
  if (!review) return null
  const label = approve ? review.approveLabel : review.keepLabel
  if (!label) return null
  return { answers: [{ id: review.questionId, selected: [label], custom: '' }] }
}

/**
 * dsh-vscode-mode host — `ui_builder_intake` 工具：生成空白 UI 材料页。
 *
 * 工具只做三件事：解析项目根、按项目 config 生成页面、把路径交回模型/客户端。
 * 页面打开由客户端监听工具结果完成（官方 HTML 预览），工具本身不碰 UI 权限。
 * @author ddj 2026年11月26号
 */
import { loadHostModule } from './hostImport.js'
import { log } from './log.js'
import type { Ctx } from './store.js'
import { createMaterialsPage, type UiIntakePageResult } from './uiIntakePage.js'
import { UI_INTAKE_TOOL } from './shared/uiIntake.js'

/** 工具参数。 */
interface IntakeArgs {
  slug?: unknown
  title?: unknown
  overwrite?: unknown
}

/** 工具执行上下文里本工具关心的字段。 */
interface IntakeExec {
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

/** 会话 → 工作区（与 edit_note 共用同一解析器）。 */
export type CwdOf = (session: unknown) => string | null

/** 工具回执（同时供模型阅读与客户端自动打开）。 */
export interface UiIntakeToolResult {
  ok: boolean
  pagePath?: string
  absolutePath?: string
  slug?: string
  projectRoot?: string
  screen?: { w: number; h: number }
  defaults?: UiIntakePageResult['defaults']
  limits?: UiIntakePageResult['limits']
  existing?: boolean
  warnings?: string[]
  hint?: string
  error?: string
}

/**
 * 把页面生成结果转成工具回执；成功时补一句给模型的下一步提示。
 * @author ddj 2026年11月26号
 * @param result 页面生成结果
 * @returns 工具回执
 */
export function toolResultOf(result: UiIntakePageResult): UiIntakeToolResult {
  if (!result.ok) return { ok: false, error: result.error ?? '材料页生成失败', ...(result.warnings?.length ? { warnings: result.warnings } : {}) }
  return {
    ok: true,
    pagePath: result.pagePath,
    absolutePath: result.absolutePath,
    slug: result.slug,
    projectRoot: result.projectRoot,
    screen: result.screen,
    defaults: result.defaults,
    limits: result.limits,
    existing: result.existing === true,
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    hint: '空白材料页已生成。客户端会在 DSH 的 HTML 预览里自动打开；若没有自动打开，请让用户在文件树打开 pagePath。'
      + ' 不要在对话里向用户索要图片或让他们复制指令；等用户在页面提交后，会收到材料清单消息。',
  }
}

/**
 * 构造工具定义（defineTool 入参）。
 * @author ddj 2026年11月26号
 * @param cwdOf 会话工作区解析
 * @returns 工具定义参数
 */
export function uiIntakeToolOptions(cwdOf: CwdOf) {
  /**
   * 生成材料页；无论成功失败都不抛，返回可读 JSON。
   * @author ddj 2026年11月26号
   * @param args 模型参数
   * @param exec 执行上下文
   * @returns 工具回执
   */
  async function execute(args: IntakeArgs, exec: IntakeExec): Promise<UiIntakeToolResult> {
    if (exec.signal?.aborted) return { ok: false, error: '材料页生成已取消' }
    const slug = typeof args?.slug === 'string' ? args.slug.trim() : ''
    if (!slug) return { ok: false, error: 'slug 必须是非空的小写标识，例如 create-ui' }
    const cwd = cwdOf(exec.agent?.session)
    if (!cwd) return { ok: false, error: '材料页需要所属会话的工作区' }
    const result = await createMaterialsPage({
      cwd,
      slug,
      ...(typeof args.title === 'string' && args.title.trim() ? { title: args.title } : {}),
      overwrite: args.overwrite === true,
    })
    return toolResultOf(result)
  }
  /** @author ddj 2026年11月26号 @param _args 参数 @param result 回执 @returns 模型可见 JSON 文本 */
  function render(_args: IntakeArgs, result: UiIntakeToolResult) {
    return [{ type: 'text', text: JSON.stringify(result) }]
  }
  return {
    name: UI_INTAKE_TOOL,
    description: 'Create the blank UI material intake page for a design slug under <project>/<pagesConfig>/<slug>/intake/materials.html, '
      + 'injecting the project config.json defaults (reference resolution, UI system, binding style, asset roots) and a page token. '
      + 'Use this as the default entry for "create UI": the page is where the user drops the mock and material images, and it submits '
      + 'them back to the current session. Do not ask the user to paste instructions or images into the chat. This tool only creates '
      + 'the page and does not build prefabs or modify project assets.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Lowercase kebab-case design slug, e.g. create-ui or gift-popup; unique per design directory.' },
      title: { type: 'string', description: 'Optional screen title used as the page default. The user can still edit it on the page.' },
      overwrite: { type: 'boolean', description: 'Replace an existing material page (new token). Default false: reuse the existing page and token.' },
    },
    output: { schema: { type: 'json' }, render },
    isConcurrencySafe: false,
    execute,
  }
}

/**
 * 注册工具；宿主缺少工具服务时静默跳过，不影响其余功能。
 * @author ddj 2026年11月26号
 * @param ctx Host 插件上下文
 * @param cwdOf 会话工作区解析
 * @returns 无
 */
export async function installUiIntakeTool(ctx: Ctx, cwdOf: CwdOf): Promise<void> {
  let module: { defineTool: (options: unknown) => unknown }
  try {
    module = await loadHostModule('@deepseek-ai/dsh-tools') as { defineTool: (options: unknown) => unknown }
  } catch {
    log.warn('ui_builder_intake 未注册：无法从宿主加载 @deepseek-ai/dsh-tools')
    return
  }
  const definition = module.defineTool(uiIntakeToolOptions(cwdOf))
  /** @author ddj 2026年11月26号 @returns 注册释放器 */
  function install(): () => void {
    const tools = ctx.get('tools') as { register?: (item: unknown) => () => void } | undefined
    if (!tools || typeof tools.register !== 'function') {
      log.warn('ui_builder_intake 未注册：宿主没有 tools 服务')
      return () => {}
    }
    return tools.register(definition)
  }
  ctx.effect(install, 'vscode-mode:ui-intake-tool')
}

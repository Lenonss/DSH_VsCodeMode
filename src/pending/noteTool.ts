/** 只读编辑说明的工具入口：模型可以留一句话，但它不参与差异判定。 @author ddj 2026年11月25号 */
import { loadHostModule } from '../hostImport.js'
import type { Ctx } from '../store.js'
import { declareNote, NOTE_MAX } from './notes.js'

/** 工具参数。 */
interface NoteArgs {
  path?: unknown
  note?: unknown
}

/** 工具执行上下文里本工具关心的字段。 */
interface NoteExec {
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

/** 工具回执。 */
interface NoteResult {
  ok: boolean
  path?: string
  note?: string
  error?: string
}

/** 会话 → 工作区。 */
export type CwdOf = (session: unknown) => string | null

/**
 * @author ddj 2026年11月25号
 * @description: 构造工具定义；只写进程内说明表，不碰磁盘、不碰工具参数。
 * @param ctx Host 上下文（取 fs 解析路径）
 * @param cwdOf 会话工作区解析
 * @returns 定义选项
 */
export function noteToolOptions(ctx: Ctx, cwdOf: CwdOf) {
  /**
   * @author ddj 2026年11月25号
   * @description: 记录一条说明；非法输入返回可读原因，不抛错。
   * @param args 模型参数
   * @param exec 执行上下文
   * @returns 回执
   */
  async function execute(args: NoteArgs, exec: NoteExec): Promise<NoteResult> {
    const path = typeof args.path === 'string' ? args.path.trim() : ''
    const note = typeof args.note === 'string' ? args.note.trim() : ''
    if (!path || !note) return { ok: false, error: 'path 与 note 都必须是非空字符串' }
    if (note.length > NOTE_MAX) return { ok: false, error: 'note 超过 ' + NOTE_MAX + ' 个字符' }
    if (exec.signal?.aborted) return { ok: false, error: '说明已取消' }
    const cwd = cwdOf(exec.agent?.session)
    if (!cwd) return { ok: false, error: '编辑说明需要所属会话的工作区' }
    const target = await ctx.get('fs').resolve(path, { cwd })
    const identity = ctx.get('fs').processPath(target)
    if (typeof identity !== 'string' || !identity) return { ok: false, error: '路径不可解析：' + path }
    declareNote(cwd, identity, note)
    return { ok: true, path, note }
  }
  /** @author ddj 2026年11月25号 @param _args 模型参数 @param result 回执 @returns 模型可见文本 */
  function render(_args: NoteArgs, result: NoteResult) {
    return [{ type: 'text', text: result.ok ? '已记录只读说明：' + result.path : '说明未记录：' + result.error }]
  }
  return {
    name: 'edit_note',
    description: 'Record a read-only note on a file for the review panel: why this file was changed. '
      + 'It is display-only: it never decides whether a diff is real, never writes files, and never changes tool arguments.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path, resolved by the filesystem backend in the session workspace.' },
      note: { type: 'string', required: true, description: 'One sentence for the reviewer. At most ' + NOTE_MAX + ' characters.' },
    },
    output: { schema: { type: 'json' }, render },
    isConcurrencySafe: true,
    execute,
  }
}

/**
 * @author ddj 2026年11月25号
 * @description: 注册工具；宿主缺少工具服务时静默跳过，不影响其余功能。
 * @param ctx Host 插件上下文
 * @param cwdOf 会话工作区解析
 * @returns 无
 */
export async function installNoteTool(ctx: Ctx, cwdOf: CwdOf): Promise<void> {
  let module: { defineTool: (options: unknown) => unknown }
  try {
    module = await loadHostModule('@deepseek-ai/dsh-tools') as typeof module
  } catch {
    return
  }
  const definition = module.defineTool(noteToolOptions(ctx, cwdOf))
  /** @author ddj 2026年11月25号 @returns 注册释放器 */
  function install(): () => void {
    return ctx.get('tools').register(definition)
  }
  ctx.effect(install, 'vscode-mode:edit-note')
}

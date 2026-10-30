/**
 * 待审差异采集：环绕一次文件写入读取真实前后内容，只有内容确实变化才落库。
 * @author ddj 2026年10月29号
 */
import { cwdOf } from '../registry.js'
import { resolveTarget } from '../store.js'
import type { Ctx } from '../store.js'
import { log } from '../log.js'

/** 可被采信为待审来源的写文件工具。 */
const WRITE_TOOLS = ['edit', 'write', 'str_replace_editor']
/** 单文件文本上限：超过即标注 oversized，不静默截断。 */
const MAX_TEXT = 1024 * 1024

/** 一次已确认的写入。 */
export interface PendingWrite {
  cwd: string
  sessionId: string
  path: string
  identity: string
  before: string | null
  after: string | null
  now: number
}

/** 采集器。 */
export interface PendingCapture {
  /** 释放监听并丢弃暂存。 */
  dispose(): void
}

/**
 * @author ddj 2026年10月29号
 * @description: 安装写文件采集；读写失败只影响待审来源，绝不影响用户工具本身。
 * @param ctx Host 生命周期
 * @param sink 已确认写入的接收方
 * @returns 可释放的采集器
 */
export function installPendingCapture(ctx: Ctx, sink: (write: PendingWrite) => void): PendingCapture {
  const busy = new Set<string>()
  let stopped = false
  ctx.on('tools/execute', aroundTool)
  return { dispose }

  /**
   * @author ddj 2026年10月29号
   * @description: 写工具执行前后各读一次，内容变化才上报。
   * @param exec 工具分发上下文
   * @param next 原始分发
   * @returns 原始工具结果，永不因采集失败而改变
   */
  async function aroundTool(exec: any, next: () => Promise<any>): Promise<any> {
    const session = exec.agent?.session
    const path = exec.arguments?.file_path ?? exec.arguments?.path
    if (stopped || !session?.id || typeof path !== 'string' || !WRITE_TOOLS.includes(exec.name)) return next()
    const cwd = cwdOf(session)
    if (!cwd) return next()
    let before: string | null = null
    let identity: string | null = null
    try {
      const fs = ctx.get('fs')
      const target = await resolveTarget(ctx, session, path)
      const key = fs.processPath(target)
      if (typeof key !== 'string' || !key) return next()
      if (busy.has(key)) return next()
      before = await readText(fs, target)
      if (before !== null && before.length > MAX_TEXT) return next()
      identity = key
      busy.add(key)
    } catch (error) {
      log.debug('待审采集跳过：' + String(error))
      return next()
    }
    try {
      return await next()
    } finally {
      if (identity !== null) {
        const key: string = identity
        try { report(String(cwd), String(session.id), String(path), key, before, exec) } catch (error) {
          log.debug('待审上报失败：' + String(error))
        }
        busy.delete(key)
      }
    }
  }

  /**
   * @author ddj 2026年10月29号
   * @description: 写后读回并比较，内容一致视为无净变化不产生条目。
   * @param cwd 工作区
   * @param sessionId 会话
   * @param path 展示路径
   * @param identity 目标身份
   * @param before 写前内容
   * @param exec 工具分发上下文
   * @returns 无
   */
  function report(
    cwd: string, sessionId: string, path: string, identity: string, before: string | null, exec: any,
  ): void {
    const fs = ctx.get('fs')
    void resolveTarget(ctx, exec.agent.session, path).then(async (target: any) => {
      const after = await readText(fs, target)
      if (after !== null && after.length > MAX_TEXT) return
      if (before === after) return
      sink({ cwd, sessionId, path, identity, before, after, now: Date.now() })
    }).catch((error: unknown) => log.debug('待审读回失败：' + String(error)))
  }

  /**
   * @author ddj 2026年10月29号
   * @description: 释放监听。
   * @returns 无
   */
  function dispose(): void {
    stopped = true
    busy.clear()
  }
}

/**
 * @author ddj 2026年10月29号
 * @description: 读取全文；缺失或不可读按"无内容"处理，交由上层决定语义。
 * @param fs 文件系统
 * @param target 目标
 * @returns 文本或 null
 */
export async function readText(fs: any, target: any): Promise<string | null> {
  try {
    return String(await fs.readText(target))
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT' || code === 'FS_NOT_FOUND' || code === 'FS_TOO_LARGE') return null
    throw error
  }
}

/**
 * dsh-vscode-mode host — 捕获层：监听 tools/result，把 edit/write/remote_ssh_write
 * 差异落成审查记录。
 * 迁移自原 src/index.ts 的 tools/result 处理；2026-09-23（issue #7）增补
 * remote_ssh_write：远端工作区会话里 agent 直写远端的全量覆写——before 取本地
 * 镜像快照、after 取参数 content，捕获后把同一内容**写穿**回镜像（node:fs 直写，
 * 刻意不走 ctx.fs，避开 dsh-remote-ssh 写桥的重复推送与补丁次序问题），使镜像 =
 * 远端最新内容，读/stale/决策口径与远端一致。
 * 作者 ddj 2026-08-20（2026-09-23 扩展 remote_ssh_write 捕获）
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DiffRecord, Hunk } from './shared/types.js'
import { annotateHunks, fingerprint } from './shared/diff.js'
import type { Ctx, Session } from './store.js'
import { READ_CAP, loadBucket, saveBucket } from './store.js'
import { fileMaxBatch, prune } from './model.js'
import type { Registry } from './registry.js'
import { cwdOf } from './registry.js'
import { findRemoteWs, mirrorTargetOf } from './remoteWorkspace.js'
import { invalidateIndex } from './treeIndex.js'
import { log } from './log.js'

/** 捕获所需的工具执行最小形状（DSH ToolExecution 的结构子集）。 */
interface CaptureExec {
  name?: unknown
  callId?: unknown
}

/** 捕获所需的工具结果最小形状（tools/result 的结构子集）。 */
interface CaptureResult {
  isError?: unknown
  value?: { path?: unknown; before?: unknown; after?: unknown } | null
  meta?: { diffs?: unknown }
}

/** 镜像文件读取状态（区分真实缺失、过大/非文件与真实内容）。 */
type MirrorState = { kind: 'content'; content: string } | { kind: 'missing' } | { kind: 'unreadable' }

/** 校验并提取工具 result meta 中的文件 hunk。 */
function validHunks(raw: unknown): Hunk[] {
  if (!Array.isArray(raw)) return []
  const hunks: Hunk[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const hunk = item as Record<string, unknown>
    if (typeof hunk.newText !== 'string') continue
    if (hunk.oldText !== null && typeof hunk.oldText !== 'string') continue
    hunks.push({ oldText: hunk.oldText as string | null, newText: hunk.newText })
  }
  return hunks
}

/** 已有文件 write 的元数据缺失时，用权威整文件快照保底。 */
function fallbackHunks(toolName: string, args: Record<string, unknown>, before: string | null, after: string | null, create: boolean): Hunk[] {
  if (create) return [{ oldText: null, newText: after ?? (typeof args.content === 'string' ? args.content : '') }]
  if (toolName === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    return [{ oldText: args.old_string, newText: args.new_string }]
  }
  if (toolName === 'write' && before !== null && after !== null && before !== after) {
    return [{ oldText: before, newText: after }]
  }
  if (toolName === 'write' && after !== null) return [{ oldText: null, newText: after }]
  return []
}

// --region 记录构造

/**
 * 是否为纳入审查的编辑类工具（本地 edit/write + 远端 remote_ssh_write）。
 * @author ddj 2026年09月23号
 * @param name 工具名
 * @returns 纳入审查返回 true
 */
function isCapturable(name: unknown): boolean {
  return name === 'edit' || name === 'write' || name === 'remote_ssh_write'
}

/**
 * 本地 edit/write 执行结果 → 审查记录（原 captureToolResult 主体语义不变）。
 * @author ddj 2026年09月23号
 * @param exec 工具执行描述
 * @param args 工具参数
 * @param result 工具执行结果
 * @returns 记录；hunk 为空或缺 callId 返回 null
 */
function buildLocalRecord(exec: CaptureExec, args: Record<string, unknown>, result: CaptureResult): DiffRecord | null {
  const value = result.value
  const path = value && typeof value.path === 'string' ? value.path : args.file_path
  if (typeof path !== 'string' || !path) return null
  const before = value && typeof value.before === 'string' ? value.before : null
  const after = value && typeof value.after === 'string' ? value.after : (typeof args.content === 'string' ? args.content : null)
  const create = exec.name === 'write' && !!value && value.before === null
  const callHunk = exec.name === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string'
    ? { oldText: args.old_string, newText: args.new_string }
    : null
  const metaHunks = validHunks(result.meta?.diffs)
  const rawHunks = metaHunks.length ? metaHunks : fallbackHunks(String(exec.name), args, before, after, create)
  const hunks = annotateHunks(rawHunks, before, after)
  if (!hunks.length || typeof exec.callId !== 'string') return null
  return {
    callId: exec.callId,
    toolName: exec.name === 'write' ? 'write' : 'edit',
    path,
    before,
    after,
    baseFingerprint: fingerprint(before),
    afterFingerprint: fingerprint(after),
    legacy: false,
    conflict: false,
    create,
    callHunk,
    hunks,
    decisions: { call: 'pending', perHunk: hunks.map(() => 'pending') },
    note: create ? '新建文件：全部拒绝将删除该文件' : before === null ? '未捕获修改前内容（大文件）' : null,
    superseded: false,
    archived: false,
    batch: 0,
    at: new Date().toISOString(),
  }
}

/**
 * 读取镜像文件当前内容（node:fs 直读；缺失 → missing，非文件/过大/读失败 → unreadable）。
 * @author ddj 2026年09月23号
 * @param absPath 镜像内绝对路径
 * @returns 读取状态
 */
async function readMirrorState(absPath: string): Promise<MirrorState> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absPath)
  } catch {
    return { kind: 'missing' }
  }
  if (!info.isFile()) return { kind: 'unreadable' }
  if ((info.size ?? 0) > READ_CAP) return { kind: 'unreadable' }
  try {
    return { kind: 'content', content: await readFile(absPath, 'utf8') }
  } catch {
    return { kind: 'unreadable' }
  }
}

/**
 * 把远端写入内容写穿回本地镜像（node:fs 直写 + mkdir -p 父目录）。
 * 刻意不用 ctx.fs：避免触发 dsh-remote-ssh 写桥把相同内容再推回远端。
 * @author ddj 2026年09月23号
 * @param absPath 镜像内绝对路径
 * @param content 远端写入后的完整内容
 * @returns 成功返回 null；失败返回错误文案（不抛）
 */
async function syncMirrorFile(absPath: string, content: string): Promise<string | null> {
  try {
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, content, 'utf8')
    return null
  } catch (error) {
    return String(error)
  }
}

/**
 * 远端记录的 note 组装（新建/未捕获 before/镜像外路径/写穿失败可叠加）。
 * @author ddj 2026年09月23号
 * @param create 镜像中目标不存在（远端新建）
 * @param before 镜像快照内容（null = 未捕获）
 * @param mirrorAbs 可映射的镜像绝对路径（null = 路径不在镜像内）
 * @param syncErr 写穿失败原因（null = 成功）
 * @returns note 文本；无需提示返回 null
 */
function remoteNoteOf(create: boolean, before: string | null, mirrorAbs: string | null, syncErr: string | null): string | null {
  const notes: string[] = []
  if (!mirrorAbs) {
    notes.push('远端路径不在工作区镜像内（仅记录，无法本地审查）')
  } else if (create) {
    notes.push('新建文件：全部拒绝将删除该文件')
  } else if (before === null) {
    notes.push('未捕获修改前内容（大文件）')
  }
  if (syncErr) notes.push('远端内容写回镜像失败（记录仍已保存）：' + syncErr)
  return notes.length ? notes.join('；') : null
}

/**
 * remote_ssh_write 执行 → 审查记录（含镜像写穿，issue #7）。
 * 非远程工作区、参数不合法或内容无变化返回 null（不产生记录）。
 * @author ddj 2026年09月23号
 * @param cwd 会话工作区（远程会话即镜像根）
 * @param exec 工具执行描述
 * @param args 工具参数（path 相对远端工作区目录，或绝对/`~` 形态）
 * @returns 记录；不满足捕获条件返回 null
 */
async function buildRemoteRecord(cwd: string, exec: CaptureExec, args: Record<string, unknown>): Promise<DiffRecord | null> {
  const ws = findRemoteWs(cwd)
  if (!ws) return null
  const argPath = typeof args.path === 'string' ? args.path : ''
  const after = typeof args.content === 'string' ? args.content : null
  if (!argPath || after === null || typeof exec.callId !== 'string') return null
  const mirrorAbs = mirrorTargetOf(argPath, ws)
  const state = mirrorAbs ? await readMirrorState(mirrorAbs) : ({ kind: 'unreadable' } as const)
  const before = state.kind === 'content' ? state.content : null
  const create = state.kind === 'missing'
  if (before !== null && before === after) return null
  // 内容无差异已 return；走到这里必须写穿，使镜像与远端一致（失败经 note 降级）
  const syncErr = mirrorAbs ? await syncMirrorFile(mirrorAbs, after) : null
  const hunks = annotateHunks([{ oldText: before, newText: after }], before, after)
  return {
    callId: exec.callId,
    toolName: 'remote_ssh_write',
    path: mirrorAbs ?? argPath,
    before,
    after,
    baseFingerprint: fingerprint(before),
    afterFingerprint: fingerprint(after),
    legacy: false,
    conflict: false,
    create,
    callHunk: null,
    hunks,
    decisions: { call: 'pending', perHunk: hunks.map(() => 'pending') },
    note: remoteNoteOf(create, before, mirrorAbs, syncErr),
    superseded: false,
    archived: false,
    batch: 0,
    at: new Date().toISOString(),
  }
}
// --endregion

/**
 * 记录入桶：按工作区分桶（缺失先加载）、按文件递增批次、裁剪、落盘。
 * @author ddj 2026年09月23号
 * @param ctx DSH 上下文
 * @param registry 工作区记录桶注册表
 * @param session 会话
 * @param cwd 会话工作区
 * @param record 待入桶记录
 */
async function persistRecord(ctx: Ctx, registry: Registry, session: Session, cwd: string, record: DiffRecord): Promise<void> {
  let bucket = registry.get(cwd)
  if (!bucket) { bucket = await loadBucket(ctx, cwd); registry.set(cwd, bucket) }
  record.batch = fileMaxBatch(bucket, record.path) + 1
  bucket.set(record.callId, record)
  // 同一文件的多次 edit/write 都保留为独立记录，便于逐条审查。
  // 旧实现按文件 batch 自动归档 prior，会导致界面看起来每个文件只剩一条差异。
  prune(bucket)
  await saveBucket(ctx, cwd, bucket, session)
}

/**
 * 捕获一次工具执行结果（tools/result）：edit/write/remote_ssh_write 成功时
 * 构造记录、递增文件批次、落盘；远端写入额外做镜像写穿（issue #7）。
 * @author ddj 2026年08月20号
 * @param ctx DSH 上下文
 * @param registry 工作区记录桶注册表
 * @param exec 工具执行描述（name/arguments/callId/agent.session）
 * @param result 执行结果（value/meta/isError）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function captureToolResult(ctx: Ctx, registry: Registry, exec: any, result: any): Promise<void> {
  const session: Session | undefined = exec?.agent?.session
  if (!session || !isCapturable(exec?.name)) return
  if (result?.isError) return
  // remote_ssh_write 只依赖参数与 isError（其 result.value 形状不受本插件约束）
  if (exec.name !== 'remote_ssh_write' && !result?.value) return
  try {
    const cwd = cwdOf(session)
    if (!cwd) return
    const args = ((exec.arguments || {}) as Record<string, unknown>)
    const record = exec.name === 'remote_ssh_write'
      ? await buildRemoteRecord(cwd, exec as CaptureExec, args)
      : buildLocalRecord(exec as CaptureExec, args, result as CaptureResult)
    if (!record) return
    await persistRecord(ctx, registry, session, cwd, record)
    // agent 写盘后目录树可能变化（新建/删除文件/目录）：父目录+祖先进失效，后台自愈。
    invalidateIndex(ctx, cwd, record.path)
  } catch (error) {
    log.error('capture failed: ' + String(error))
  }
}

/**
 * dsh-vscode-mode host — 19 个 §svn_*§ agent 工具（22-agent-tools-and-commit）。
 *
 * 为什么要有工具层：此前模型只能在大 Bash 里裸跑 §svn§——没有只读/只写边界、
 * 没有输出归一（0.2.x 会因 §undefined§/NaN 整次失败），也没有路径白名单。
 * 这里把「会话绑定 + 路径归一 + 执行 + 无损输出」收敛成一份适配层，
 * 执行本身仍走 svn.ts 的既有 handler / 统一执行器（单一执行路径）。
 *
 * 纪律：写工具受只读设置拦截（执行器层）；只读工具声明 §isConcurrencySafe§ 以允许并行；
 * 位置参数（属性名/changelist/URL）拒 §-§ 开头；路径操作数一律在 §--§ 之后。
 * @author ddj 2026年11月15号
 */
import type { Ctx } from './store.js'
import { loadHostModule } from './hostImport.js'
import { toLosslessJson, toolJsonText } from './svnToolJson.js'
import { classifySvnError, svnErrorOf, svnOperandErrorOf } from './svnCore.js'
import { COMMIT_PATHS_CAP } from './shared/svn.js'

/** 只读子命令超时。 */
const READ_GRACE_MS = 30_000
/** 写子命令超时。 */
const MUTATE_GRACE_MS = 120_000
/** 状态类超时。 */
const STATUS_GRACE_MS = 120_000
/** 输出收集上限（工具载荷，8MB 足够看一个目录的 diff）。 */
const OUTPUT_CAP = 8 * 1024 * 1024

/** 工具作用域（会话工作区 + 工作副本根）。 */
export interface SvnToolScope {
  /** 会话工作区目录。 */
  cwd: string
  /** 工作副本根绝对路径。 */
  root: string
}

/** 工具执行 API（由 svn.ts 的 createSvnRpc 提供）。 */
export interface SvnToolApi {
  /** 既有 RPC handler（写操作复用同一执行路径）。 */
  handlers: Record<string, (args: Record<string, unknown>) => Promise<{ ok: boolean } & Record<string, unknown>>>
  /** 统一执行器（只读门禁/超时倍数在 svnCore）。 */
  run: (cwd: string, argv: string[], graceMs: number, stdoutCap?: number, allowFallback?: boolean) => Promise<{ code: number | null; stdout: string; stderr: string }>
  /** 会话 → 作用域。 */
  scopeOf: (sessionId?: string) => Promise<SvnToolScope | { err: string }>
  /** 工作区相对路径 → svn 目标（越界返回 null）。 */
  targetOf: (cwd: string, root: string, rel: string) => string | null
  /** 路径归一（越界返回 null）。 */
  relOf: (raw: unknown) => string | null
}

/** 工具执行上下文（只取所需字段）。 */
interface ToolExec {
  agent?: { session?: { id?: string } }
  signal?: AbortSignal
}

/** 工具定义（渲染 + 执行）。 */
interface ToolSpec {
  /** 工具名（§svn_*§）。 */
  name: string
  /** 给模型的说明（英文为主，含边界）。 */
  description: string
  /** 参数 schema（dsh-tools 的属性表）。 */
  parameters: Record<string, unknown>
  /** 是否只读（true = 允许并行）。 */
  safe: boolean
  /** 执行体（args 已由框架校验，仍是 unknown 语义）。 */
  execute: (args: Record<string, unknown>, exec: ToolExec, api: SvnToolApi) => Promise<unknown>
}

/**
 * 取执行会话 id（工具必须绑定会话：所有操作都限定在该会话工作区）。
 * @author ddj 2026年11月15号
 * @param exec 执行上下文
 * @returns 会话 id
 */
function sessionIdOf(exec: ToolExec): string {
  const id = exec.agent?.session?.id
  if (!id) throw new Error('SVN 工具需要所属会话')
  return id
}

/**
 * 读数：整数参数收敛。
 * @author ddj 2026年11月15号
 * @param value 原始值
 * @returns 整数或 undefined
 */
function intOf(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(num) ? num : undefined
}

/**
 * 读数：字符串数组参数收敛（去空白/去重）。
 * @author ddj 2026年11月15号
 * @param value 原始值
 * @returns 路径数组
 */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))]
}

/**
 * 解析目标路径：URL 原样透传（防被当文件路径），其余按工作区相对路径归一。
 * @author ddj 2026年11月15号
 * @param api 工具 API @param scope 作用域 @param raw 原始路径
 * @returns svn 目标操作数
 */
async function targetOfPath(api: SvnToolApi, scope: SvnToolScope, raw: unknown): Promise<string> {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const isUrl = /^(?:svn|[a-z][a-z0-9+.-]*):\/\//i.test(text) || text.startsWith('^/')
  if (isUrl) {
    const error = svnOperandErrorOf(text)
    if (error) throw new Error(error)
    return text
  }
  const rel = api.relOf(text)
  if (rel === null) throw new Error('路径不合法（越界或非法字符）')
  const target = api.targetOf(scope.cwd, scope.root, rel)
  if (!target) throw new Error('目标不在 SVN 工作副本内')
  return target
}

/**
 * 跑一条只读命令并返回文本（失败转可读错误）。
 * @author ddj 2026年11月15号
 * @param api 工具 API @param scope 作用域 @param argv 参数 @param cap 输出上限
 * @returns stdout
 */
async function readText(api: SvnToolApi, scope: SvnToolScope, argv: string[], cap = OUTPUT_CAP): Promise<{ text: string; truncated: boolean }> {
  const outcome = await api.run(scope.root, argv, READ_GRACE_MS, cap)
  if (outcome.code !== 0) {
    const info = classifySvnError([outcome.stderr, outcome.stdout].filter(Boolean).join('\n'))
    throw new Error(info.message)
  }
  return { text: outcome.stdout, truncated: outcome.stdout.length >= cap }
}

/**
 * 跑一条写命令（批量 add/delete 等无专用 handler 的场景）。
 * @author ddj 2026年11月15号
 * @param api 工具 API @param scope 作用域 @param argv 参数
 * @returns 退出码与合并输出
 */
async function runWrite(api: SvnToolApi, scope: SvnToolScope, argv: string[]): Promise<{ code: number | null; text: string }> {
  const outcome = await api.run(scope.root, argv, MUTATE_GRACE_MS)
  const text = [outcome.stdout, outcome.stderr].filter(Boolean).join('\n').trim()
  if (outcome.code !== 0) {
    const info = classifySvnError(text)
    throw new Error(info.message)
  }
  return { code: outcome.code, text }
}

/**
 * 包一层统一错误处理：只读拒绝带 code，其余透传可读文案。
 * @author ddj 2026年11月15号
 * @param exec 执行上下文 @param api 工具 API @param body 实现
 * @returns 归一化结果
 */
async function guarded(exec: ToolExec, api: SvnToolApi, body: (scope: SvnToolScope, sessionId: string) => Promise<unknown>): Promise<unknown> {
  try {
    if (exec.signal?.aborted) return { ok: false, error: '调用已取消' }
    const sessionId = sessionIdOf(exec)
    const scope = await api.scopeOf(sessionId)
    if ('err' in scope) return { ok: false, error: scope.err }
    return toLosslessJson(await body(scope, sessionId))
  } catch (error) {
    const info = svnErrorOf(error)
    return toLosslessJson({ ok: false, ...(info.code ? { code: info.code } : {}), error: info.error })
  }
}

/**
 * 复用既有 RPC handler（写操作的唯一执行路径）。
 * @author ddj 2026年11月15号
 * @param api 工具 API @param method handler 名 @param args 参数
 * @returns handler 结果
 */
async function callHandler(api: SvnToolApi, method: string, args: Record<string, unknown>): Promise<{ ok: boolean } & Record<string, unknown>> {
  const handler = api.handlers[method]
  if (!handler) return { ok: false, error: '该能力在当前宿主不可用：' + method }
  return handler(args)
}

/** 路径数组参数（1 个以上）。 */
const PATHS_PARAM = { type: 'array', items: { type: 'string' }, required: true, description: '工作区相对路径列表（最多 ' + COMMIT_PATHS_CAP + ' 个）' }
/** 可选路径参数。 */
const PATH_PARAM = { type: 'string', description: '工作区相对路径（缺省 = 工作副本根）；允许 svn:// 或 https:// 仓库 URL' }

/** 19 个工具定义（顺序仅影响列表展示）。 */
const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'svn_status',
    description: 'List working-copy changes (status). Read-only. Returns entries with path/status/changelist/revision plus changelist grouping.',
    parameters: { force: { type: 'boolean', description: 'Skip the 5s cache and re-read' } },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const result = await callHandler(api, 'svn.changes', { sessionId, force: args.force === true })
      return result
    }),
  },
  {
    name: 'svn_info',
    description: 'Show repository information for the workspace or a path (revision, URL, repository root). Read-only.',
    parameters: { path: PATH_PARAM },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const target = await targetOfPath(api, scope, args.path)
      const { text } = await readText(api, scope, ['info', '--xml', '--', target])
      const revision = /<entry[^>]*\brevision="(\d+)"/.exec(text)?.[1]
      const url = /<url>([^<]*)<\/url>/.exec(text)?.[1]
      const rootUrl = /<root>([^<]*)<\/root>/.exec(text)?.[1]
      return {
        ok: true,
        path: target,
        revision: revision ? Number(revision) : undefined,
        url,
        repositoryRoot: rootUrl,
      }
    }),
  },
  {
    name: 'svn_diff',
    description: 'Show a unified diff. Read-only. Without revisions it diffs BASE against the working copy; with revision/revA/revB it diffs repository revisions.',
    parameters: {
      path: PATH_PARAM,
      revision: { type: 'integer', description: 'Diff this revision against its previous revision' },
      revA: { type: 'integer', description: 'Left revision (with revB)' },
      revB: { type: 'integer', description: 'Right revision (with revA)' },
      ignoreWhitespace: { type: 'boolean', description: 'Ignore whitespace-only changes' },
    },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const target = await targetOfPath(api, scope, args.path)
      const argv = ['diff']
      const revA = intOf(args.revA)
      const revB = intOf(args.revB)
      const revision = intOf(args.revision)
      if (revA !== undefined && revB !== undefined) argv.push('-r', revA + ':' + revB)
      else if (revision !== undefined) argv.push('-c', String(revision))
      if (args.ignoreWhitespace === true) argv.push('-x', '-w')
      argv.push('--', target)
      const { text, truncated } = await readText(api, scope, argv)
      return { ok: true, path: target, text, truncated }
    }),
  },
  {
    name: 'svn_log',
    description: 'Read commit history (log) for the workspace or a path. Read-only. Returns entries with revision/author/date/message/paths.',
    parameters: {
      path: PATH_PARAM,
      limit: { type: 'integer', description: 'Maximum entries (default 50, cap 500)' },
      startRev: { type: 'integer', description: 'Range start revision (with endRev)' },
      endRev: { type: 'integer', description: 'Range end revision' },
      stopOnCopy: { type: 'boolean', description: 'Stop at the copy point' },
      showMerged: { type: 'boolean', description: 'Include merged revisions (-g)' },
    },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope, sessionId) => {
      const rel = api.relOf(args.path)
      if (rel === null) throw new Error('路径不合法')
      const startRev = intOf(args.startRev)
      const endRev = intOf(args.endRev)
      const result = await callHandler(api, 'svn.log', {
        sessionId,
        ...(rel ? { path: rel } : {}),
        limit: intOf(args.limit),
        stopOnCopy: args.stopOnCopy === true,
        showMerged: args.showMerged === true,
        ...(startRev !== undefined ? { startRev } : {}),
        ...(endRev !== undefined ? { endRev } : {}),
      })
      return result
    }),
  },
  {
    name: 'svn_blame',
    description: 'Show line-by-line last-change attribution (blame) for one file. Read-only.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path relative to the workspace' },
      revision: { type: 'integer', description: 'Blame at this revision (default HEAD)' },
    },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const target = await targetOfPath(api, scope, args.path)
      const argv = ['blame']
      const revision = intOf(args.revision)
      if (revision !== undefined) argv.push('-r', String(revision))
      argv.push('--', target)
      const { text, truncated } = await readText(api, scope, argv)
      return { ok: true, path: target, text, truncated }
    }),
  },
  {
    name: 'svn_list',
    description: 'List directory entries in a working copy or repository URL (svn list). Read-only.',
    parameters: { path: PATH_PARAM },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const target = await targetOfPath(api, scope, args.path)
      const { text, truncated } = await readText(api, scope, ['list', '--', target])
      const entries = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      return { ok: true, path: target, entries, truncated }
    }),
  },
  {
    name: 'svn_cat',
    description: 'Read file content from the working copy BASE or a repository revision (svn cat). Read-only.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path (workspace-relative) or repository URL' },
      revision: { type: 'string', description: 'Revision, BASE or HEAD (default working copy BASE)' },
    },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const target = await targetOfPath(api, scope, args.path)
      const revision = typeof args.revision === 'string' && args.revision.trim() ? args.revision.trim() : 'BASE'
      const revError = svnOperandErrorOf(revision)
      if (revError) throw new Error(revError)
      const { text, truncated } = await readText(api, scope, ['cat', '-r', revision, '--', target])
      return { ok: true, path: target, revision, text, truncated }
    }),
  },
  {
    name: 'svn_propget',
    description: 'Read one versioned property (e.g. svn:ignore, svn:eol-style). Read-only.',
    parameters: {
      path: PATH_PARAM,
      name: { type: 'string', required: true, description: 'Property name such as svn:ignore' },
    },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const name = String(args.name ?? '').trim()
      const nameError = svnOperandErrorOf(name)
      if (nameError) throw new Error(nameError)
      const target = await targetOfPath(api, scope, args.path)
      const { text } = await readText(api, scope, ['propget', name, '--', target])
      return { ok: true, path: target, name, value: text.replace(/\r?\n$/, '') }
    }),
  },
  {
    name: 'svn_proplist',
    description: 'List all versioned properties of a path. Read-only.',
    parameters: { path: PATH_PARAM },
    safe: true,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const target = await targetOfPath(api, scope, args.path)
      const { text, truncated } = await readText(api, scope, ['proplist', '-v', '--', target])
      return { ok: true, path: target, text, truncated }
    }),
  },
  {
    name: 'svn_add',
    description: 'Schedule unversioned paths for addition (svn add). Write operation; blocked in read-only mode.',
    parameters: { paths: PATHS_PARAM },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const paths = stringsOf(args.paths)
      if (!paths.length) throw new Error('未提供任何路径')
      return callHandler(api, 'svn.add', { sessionId, paths })
    }),
  },
  {
    name: 'svn_delete',
    description: 'Schedule versioned paths for deletion (svn delete). Write operation; blocked in read-only mode.',
    parameters: { paths: PATHS_PARAM },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const paths = stringsOf(args.paths)
      if (!paths.length) throw new Error('未提供任何路径')
      const targets: string[] = []
      for (const path of paths) {
        const rel = api.relOf(path)
        if (rel === null || rel === '') throw new Error('路径不合法：' + path)
        const target = api.targetOf(scope.cwd, scope.root, rel)
        if (!target) throw new Error('目标不在 SVN 工作副本内：' + path)
        targets.push(target)
      }
      const { text } = await runWrite(api, scope, ['delete', '--', ...targets])
      const count = (text.match(/^(?:D|Deleting|正在删除)\b/gm) ?? []).length
      return { ok: true, count, summary: '已计划删除 ' + (count || targets.length) + ' 项', output: text }
    }),
  },
  {
    name: 'svn_revert',
    description: 'Revert local changes of the given paths (svn revert). Destructive; blocked in read-only mode.',
    parameters: {
      paths: PATHS_PARAM,
      depth: { type: 'string', enum: ['empty'], description: 'Revert only the given entries (no recursion)' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const paths = stringsOf(args.paths)
      if (!paths.length) throw new Error('未提供任何路径')
      return callHandler(api, 'svn.revert', { sessionId, paths, ...(args.depth === 'empty' ? { depth: 'empty' } : {}) })
    }),
  },
  {
    name: 'svn_commit',
    description: 'Commit the given paths with a message (native commit: host re-checks status first, optionally auto-adds unversioned and auto-deletes missing files). Write operation; blocked in read-only mode. Never resolves conflicts automatically.',
    parameters: {
      paths: PATHS_PARAM,
      message: { type: 'string', required: true, description: 'Commit message (first line becomes the subject)' },
      changelist: { type: 'string', description: 'Only commit entries of this changelist' },
      keepLocks: { type: 'boolean', description: 'Keep locks after commit (--no-unlock)' },
      autoAdd: { type: 'boolean', description: 'Auto svn add selected unversioned paths (default from settings)' },
      autoDelete: { type: 'boolean', description: 'Auto svn delete selected missing paths (default from settings)' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const paths = stringsOf(args.paths)
      if (!paths.length) throw new Error('未提供任何路径')
      const message = typeof args.message === 'string' ? args.message : ''
      if (!message.trim()) throw new Error('提交信息不能为空')
      return callHandler(api, 'svn.commit', {
        sessionId,
        paths,
        message,
        ...(typeof args.changelist === 'string' && args.changelist.trim() ? { changelist: args.changelist.trim() } : {}),
        keepLocks: args.keepLocks === true,
        ...(typeof args.autoAdd === 'boolean' ? { autoAdd: args.autoAdd } : {}),
        ...(typeof args.autoDelete === 'boolean' ? { autoDelete: args.autoDelete } : {}),
      })
    }),
  },
  {
    name: 'svn_update',
    description: 'Update the working copy (svn update). Write operation; blocked in read-only mode.',
    parameters: { path: PATH_PARAM },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const rel = api.relOf(args.path)
      if (rel === null) throw new Error('路径不合法')
      return callHandler(api, 'svn.update', { sessionId, ...(rel ? { path: rel } : {}) })
    }),
  },
  {
    name: 'svn_resolve',
    description: 'Mark a conflicted path resolved with the given strategy (svn resolve). Write operation; blocked in read-only mode.',
    parameters: {
      path: { type: 'string', required: true, description: 'Conflicted path relative to the workspace' },
      accept: { type: 'string', required: true, enum: ['working', 'mine-full', 'theirs-full'], description: 'Conflict strategy' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const accept = String(args.accept ?? '')
      if (!['working', 'mine-full', 'theirs-full'].includes(accept)) throw new Error('解决策略不合法')
      const rel = api.relOf(args.path)
      if (rel === null || rel === '') throw new Error('路径不合法')
      return callHandler(api, 'svn.resolve', { sessionId, path: rel, accept })
    }),
  },
  {
    name: 'svn_cleanup',
    description: 'Clean up the working copy locks (svn cleanup); optionally remove unversioned/ignored files. Write operation; blocked in read-only mode.',
    parameters: {
      removeUnversioned: { type: 'boolean', description: 'Also delete unversioned files' },
      removeIgnored: { type: 'boolean', description: 'Also delete ignored files' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => callHandler(api, 'svn.cleanup', {
      sessionId,
      removeUnversioned: args.removeUnversioned === true,
      removeIgnored: args.removeIgnored === true,
    })),
  },
  {
    name: 'svn_propset',
    description: 'Set one versioned property value (svn propset), e.g. svn:ignore or svn:eol-style. Write operation; blocked in read-only mode.',
    parameters: {
      path: PATH_PARAM,
      name: { type: 'string', required: true, description: 'Property name' },
      value: { type: 'string', required: true, description: 'Property value (use \n for multi-line values)' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const name = String(args.name ?? '').trim()
      const nameError = svnOperandErrorOf(name)
      if (nameError) throw new Error(nameError)
      const value = typeof args.value === 'string' ? args.value : ''
      const target = await targetOfPath(api, scope, args.path)
      await runWrite(api, scope, ['propset', name, value, '--', target])
      return { ok: true, path: target, name, summary: '已写入属性 ' + name }
    }),
  },
  {
    name: 'svn_propdel',
    description: 'Delete one versioned property (svn propdel). Write operation; blocked in read-only mode.',
    parameters: {
      path: PATH_PARAM,
      name: { type: 'string', required: true, description: 'Property name' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (scope) => {
      const name = String(args.name ?? '').trim()
      const nameError = svnOperandErrorOf(name)
      if (nameError) throw new Error(nameError)
      const target = await targetOfPath(api, scope, args.path)
      await runWrite(api, scope, ['propdel', name, '--', target])
      return { ok: true, path: target, name, summary: '已删除属性 ' + name }
    }),
  },
  {
    name: 'svn_changelist',
    description: 'Assign or remove changelist membership for paths (svn changelist). Write operation; blocked in read-only mode.',
    parameters: {
      paths: PATHS_PARAM,
      name: { type: 'string', description: 'Changelist name (required unless remove=true)' },
      remove: { type: 'boolean', description: 'Remove the paths from their changelist' },
    },
    safe: false,
    execute: (args, exec, api) => guarded(exec, api, async (_scope, sessionId) => {
      const paths = stringsOf(args.paths)
      if (!paths.length) throw new Error('未提供任何路径')
      const remove = args.remove === true
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (!remove && !name) throw new Error('未提供分区分名')
      return callHandler(api, 'svn.changelist', { sessionId, paths, ...(name ? { name } : {}), remove })
    }),
  },
]

/**
 * 构造一个工具的 defineTool 选项（参数/输出/render/执行）。
 * @author ddj 2026年11月15号
 * @param spec 工具定义
 * @param api 工具 API
 * @returns defineTool 选项
 */
function optionsOf(spec: ToolSpec, api: SvnToolApi) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'json' },
      /** @author ddj 2026年11月15号 @param _args 参数 @param value 结果 @returns 模型可见内容 */
      render(_args: unknown, value: unknown) {
        return [{ type: 'text', text: toolJsonText(value) }]
      },
    },
    isConcurrencySafe: () => spec.safe,
    /** @author ddj 2026年11月15号 @param args 参数 @param exec 执行上下文 @returns 工具结果 */
    execute: (args: unknown, exec: ToolExec) => spec.execute((args ?? {}) as Record<string, unknown>, exec, api),
  }
}

/**
 * 注册全部 SVN 工具（每个工具独立 disposer，随插件卸载回收）。
 * @author ddj 2026年11月15号
 * @param ctx host 插件上下文
 * @param api 工具执行 API
 */
export async function installSvnTools(ctx: Ctx, api: SvnToolApi): Promise<void> {
  const module = await loadHostModule('@deepseek-ai/dsh-tools') as { defineTool: (options: unknown) => unknown }
  const tools = ctx.get('tools') as { register: (definition: unknown) => () => void } | null | undefined
  if (!tools || typeof tools.register !== 'function') return
  for (const spec of TOOL_SPECS) {
    const definition = module.defineTool(optionsOf(spec, api))
    ctx.effect(() => tools.register(definition), 'vscode-mode:svn-tool-' + spec.name)
  }
}

/** 已注册的工具名清单（测试/诊断用）。 */
export const SVN_TOOL_NAMES: readonly string[] = TOOL_SPECS.map((spec) => spec.name)

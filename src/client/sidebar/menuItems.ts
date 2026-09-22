/**
 * dsh-vscode-mode client — 文件管理右键菜单内置项。
 *
 * 分组与显隐对齐 CodeBuddy 资源管理器参考图（区分文件/文件夹/根空白区）：
 * - 文件：打开方式… ｜ 浏览器打开 ｜ 对话 ｜ 剪切·复制 ｜ 复制路径 ｜ 重命名·删除 ｜ SVN 组
 * - 文件夹：新建两项 ｜ 浏览器打开 ｜ 对话·在文件夹中查找 ｜ 剪切·复制·粘贴 ｜ 复制路径 ｜ 重命名·永久删除 ｜ SVN 组
 * - 根空白区（path === ''）：文件夹菜单去掉全部「仅非根」项
 * 参考图中本架构无法实现的条目（在集成终端中打开 / 运行测试 / 调试测试 / Build 等）不显示。
 * 反馈统一走 ctx.notify（由 EditorView 提供，落到编辑区路径栏状态）。
 * 作者 ddj 2026-08-27 / 2026-09-03 / 2026-09-16 / 2026年09月22号
 */
import { isSvnDiffable } from '../../shared/svn.js'
import type { SvnChangeEntry } from '../../shared/svn.js'
import { svnActionOn, svnActionsFor } from '../../shared/svnActions.js'
import type { SvnActionContext, SvnTargetType } from '../../shared/svnActions.js'
import { baseNameOf, checkNewName, checkRenameName, joinRelPath } from '../../shared/fsNames.js'
import type { RpcMethod, RpcRequestMap, RpcResult } from '../../shared/rpc.js'
import { runSvnAction } from '../svnActions.js'
import type { SvnActionRunCtx } from '../svnActions.js'
import { revealInExplorer } from '../fileReveal.js'
import { statusOfAdd } from '../addToConversation.js'
import { rpc } from '../rpc.js'
import { absoluteOf, relativeOf } from '../tabActions.js'
import { copyText } from '../copyText.js'
import { clearFileClip, fileClipOf, setFileClip } from '../fileClipboard.js'
import type { TreeMenuItem } from './contextMenu.js'
import type { SidebarCtx } from './types.js'
import type { TreeMenuTarget } from './contextMenu.js'

/** 内置条目 order 分段（每段留空隙供后续插入；SVN 组统一 200+，不与内置段交叠）。 */
const ORDER_OPEN = 5
const ORDER_NEW_FILE = 10
const ORDER_NEW_FOLDER = 20
const ORDER_REVEAL = 30
const ORDER_ADD_REF = 50
const ORDER_FIND = 60
const ORDER_CUT = 70
const ORDER_COPY = 80
const ORDER_PASTE = 90
const ORDER_COPY_PATH = 110
const ORDER_COPY_REL = 120
const ORDER_RENAME = 140
const ORDER_DELETE = 150
const SVN_ORDER_BASE = 200

/** 分组号（组切换处由 buildTreeMenu 出分隔线；SVN 组起始 7，组内分段随共享元数据递增）。 */
const GROUP_OPEN = 1
const GROUP_REVEAL = 2
const GROUP_REF = 3
const GROUP_CLIP = 4
const GROUP_COPY_PATH = 5
const GROUP_EDIT = 6
const SVN_GROUP_BASE = 7

// --region 目标判定与动作收尾

/**
 * 目标是否有具体路径（非根空白区；复制路径/剪切/重命名/删除等「仅非根」守卫）。
 * @author ddj 2026年09月22号
 * @param target 右键目标
 * @returns 是否非根
 */
function hasPath(target: TreeMenuTarget): boolean {
  return Boolean(target.path)
}

/**
 * 目标是否目录（含根空白区）。
 * @author ddj 2026年09月22号
 * @param target 右键目标
 * @returns 是否目录
 */
function isDirTarget(target: TreeMenuTarget): boolean {
  return target.type === 'directory'
}

/**
 * 目标是否文件（树条目的非目录类型按文件处理）。
 * @author ddj 2026年09月22号
 * @param target 右键目标
 * @returns 是否文件
 */
function isFileTarget(target: TreeMenuTarget): boolean {
  return target.type !== 'directory'
}

/**
 * 是否有可用工作区目录（复制相对路径需要）。
 * @author ddj 2026年09月22号
 * @param ctx 面板上下文
 * @returns 是否可用
 */
function hasCwd(ctx: SidebarCtx): boolean {
  return typeof ctx.cwd === 'string' && ctx.cwd.trim() !== ''
}

/**
 * 派发窗口事件（文件树刷新 / 页签路径改写 / 关签；node 测试环境安全 no-op）。
 * @author ddj 2026年09月22号
 * @param name 事件名
 * @param detail 事件载荷
 */
function emit(name: string, detail: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

/**
 * 文件操作 RPC 兜底执行：网络异常折算为失败结果，菜单动作统一按 ok/error 分支。
 * @author ddj 2026年09月22号
 * @param method RPC 方法名（edrv.fs.*）
 * @param args 请求载荷
 * @returns RPC 结果；异常时为失败结果
 */
async function fsCall<M extends RpcMethod>(method: M, args: RpcRequestMap[M]): Promise<RpcResult<M>> {
  try {
    return await rpc(method, args)
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * 文件操作成功收尾：反馈 + 目录树刷新 + SVN 变更重查。
 * @author ddj 2026年09月22号
 * @param ctx 面板上下文
 * @param okText 成功反馈文案
 */
function fsDone(ctx: SidebarCtx, okText: string): void {
  ctx.notify?.(okText)
  emit('edrv:refresh', {})
  ctx.refreshSvnChanges?.()
}

/**
 * 破坏性动作确认（ctx.confirm 缺省回退 window.confirm；无确认通道一律拒绝）。
 * @author ddj 2026年09月22号
 * @param ctx 面板上下文
 * @param message 确认文案
 * @returns 是否确认执行
 */
function confirmed(ctx: SidebarCtx, message: string): boolean {
  if (typeof ctx.confirm === 'function') return ctx.confirm(message)
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(message)
  return false
}

// --endregion

// --region 文件管理动作（新建 / 重命名 / 删除 / 粘贴）

/**
 * 新建文件/文件夹：名称弹窗 → shared 校验 → RPC（同名拒绝）→ 文件即打开 + 刷新。
 * @author ddj 2026年09月22号
 * @param target 右键目标（目录）
 * @param ctx 面板上下文
 * @param kind file = 新建文件；directory = 新建文件夹
 */
async function createEntry(target: TreeMenuTarget, ctx: SidebarCtx, kind: 'file' | 'directory'): Promise<void> {
  const ask = ctx.prompt
  if (!ask) {
    ctx.notify?.('名称输入不可用')
    return
  }
  const name = await ask(kind === 'file' ? '新建文件' : '新建文件夹', '')
  if (name === null) return
  const bad = checkNewName(name)
  if (bad) {
    ctx.notify?.(bad)
    return
  }
  const path = joinRelPath(target.path, name)
  const res = await fsCall(kind === 'file' ? 'edrv.fsCreateFile' : 'edrv.fsCreateDir', { sessionId: ctx.sessionId, path })
  if (!res.ok) {
    ctx.notify?.((kind === 'file' ? '新建文件失败：' : '新建文件夹失败：') + res.error)
    return
  }
  if (kind === 'file') ctx.openFile(path)
  fsDone(ctx, (kind === 'file' ? '已新建文件 ' : '已新建文件夹 ') + path)
}

/**
 * 重命名：名称弹窗（预填原名）→ shared 校验 → RPC → 页签路径改写事件 + 刷新。
 * @author ddj 2026年09月22号
 * @param target 右键目标
 * @param ctx 面板上下文
 */
async function renameEntry(target: TreeMenuTarget, ctx: SidebarCtx): Promise<void> {
  const ask = ctx.prompt
  if (!ask) {
    ctx.notify?.('名称输入不可用')
    return
  }
  const from = target.path
  const name = await ask('重命名', baseNameOf(from))
  if (name === null || name === baseNameOf(from)) return
  const bad = checkRenameName(name)
  if (bad) {
    ctx.notify?.(bad)
    return
  }
  const res = await fsCall('edrv.fsRename', { sessionId: ctx.sessionId, path: from, newName: name })
  if (!res.ok) {
    ctx.notify?.('重命名失败：' + res.error)
    return
  }
  if (res.to !== res.from) emit('edrv:path-renamed', { from: res.from, to: res.to })
  fsDone(ctx, '已重命名')
}

/**
 * 删除（文件文案「删除」/ 文件夹文案「永久删除」）：确认框把关 → RPC → 关签事件 + 刷新。
 * @author ddj 2026年09月22号
 * @param target 右键目标
 * @param ctx 面板上下文
 */
async function deleteEntry(target: TreeMenuTarget, ctx: SidebarCtx): Promise<void> {
  const dirTarget = isDirTarget(target)
  const name = baseNameOf(target.path)
  const message = dirTarget
    ? '永久删除文件夹「' + name + '」及其全部内容？该操作不可恢复。'
    : '删除文件「' + name + '」？该操作不可恢复。'
  if (!confirmed(ctx, message)) return
  const res = await fsCall('edrv.fsDelete', { sessionId: ctx.sessionId, path: target.path })
  if (!res.ok) {
    ctx.notify?.('删除失败：' + res.error)
    return
  }
  emit('edrv:path-deleted', { path: target.path })
  fsDone(ctx, (dirTarget ? '已永久删除「' : '已删除「') + name + '」')
}

/**
 * 粘贴文件剪贴板内容到目标目录（copy → fsCopy；cut → fsMove 成功后清槽）。
 * @author ddj 2026年09月22号
 * @param target 右键目标（目录）
 * @param ctx 面板上下文
 */
async function pasteInto(target: TreeMenuTarget, ctx: SidebarCtx): Promise<void> {
  const clip = fileClipOf()
  if (!clip) {
    ctx.notify?.('剪贴板为空')
    return
  }
  const cut = clip.mode === 'cut'
  const res = await fsCall(cut ? 'edrv.fsMove' : 'edrv.fsCopy', { sessionId: ctx.sessionId, from: clip.path, toDir: target.path })
  if (!res.ok) {
    ctx.notify?.('粘贴失败：' + res.error)
    return
  }
  if (cut) {
    clearFileClip()
    emit('edrv:path-renamed', { from: res.from, to: res.to })
  }
  fsDone(ctx, (cut ? '已移动到 ' : '已复制到 ') + (target.path || '工作区根目录'))
}

// --endregion

// --region 内置菜单项分组

/**
 * 分组 1：打开方式…（文件专属）+ 新建文件…/新建文件夹（文件夹专属，含根空白区）。
 * @author ddj 2026年09月22号
 * @returns 分组条目
 */
function openGroupItems(): TreeMenuItem[] {
  return [
    {
      id: 'open-with',
      label: '打开方式…',
      order: ORDER_OPEN,
      group: GROUP_OPEN,
      visible: (target, ctx) => isFileTarget(target) && hasPath(target) && typeof ctx.openWith === 'function',
      run: (target, ctx) => ctx.openWith?.(target.path),
    },
    {
      id: 'new-file',
      label: '新建文件…',
      order: ORDER_NEW_FILE,
      group: GROUP_OPEN,
      visible: (target) => isDirTarget(target),
      run: (target, ctx) => { void createEntry(target, ctx, 'file') },
    },
    {
      id: 'new-folder',
      label: '新建文件夹',
      order: ORDER_NEW_FOLDER,
      group: GROUP_OPEN,
      visible: (target) => isDirTarget(target),
      run: (target, ctx) => { void createEntry(target, ctx, 'directory') },
    },
  ]
}

/**
 * 分组 2：在文件资源管理器中显示（文件/文件夹/根空白区共有）。
 * @author ddj 2026年09月22号
 * @returns 分组条目
 */
function revealGroupItems(): TreeMenuItem[] {
  return [
    {
      id: 'reveal-in-explorer',
      label: '在文件资源管理器中显示',
      order: ORDER_REVEAL,
      group: GROUP_REVEAL,
      run: (target, ctx) => {
        void revealInExplorer(ctx.sessionId, target.path).then((outcome) => {
          ctx.notify?.(outcome.ok ? '已在文件浏览器中打开' : '打开失败：' + (outcome.error ?? '未知错误'))
        })
      },
    },
  ]
}

/**
 * 分组 3：添加引用到对话（仅非根）+ 在文件夹中查找…（文件夹专属）。
 * @author ddj 2026年09月22号
 * @returns 分组条目
 */
function refGroupItems(): TreeMenuItem[] {
  return [
    {
      id: 'add-to-conversation',
      label: '添加引用到对话',
      order: ORDER_ADD_REF,
      group: GROUP_REF,
      // 排除根目录空白区（path==='' 无意义）、无会话、动作集缺失时隐藏
      visible: (target, ctx) => Boolean(target.path && ctx.sessionId && ctx.addToConversation),
      run: (target, ctx) => {
        const isDir = target.type === 'directory'
        const add = ctx.addToConversation
        if (!add) {
          ctx.notify?.('添加到对话不可用')
          return
        }
        const okText = isDir ? '已添加文件夹引用' : '已添加文件引用'
        void add.appendReference(ctx.sessionId, target.path, undefined, isDir ? 'folder' : 'file').then((outcome) => {
          ctx.notify?.(statusOfAdd(outcome, okText))
        })
      },
    },
    {
      id: 'find-in-folder',
      label: '在文件夹中查找…',
      order: ORDER_FIND,
      group: GROUP_REF,
      visible: (target, ctx) => isDirTarget(target) && typeof ctx.searchInFolder === 'function',
      run: (target, ctx) => ctx.searchInFolder?.(target.path),
    },
  ]
}

/**
 * 分组 4：剪切/复制（仅非根）+ 粘贴（文件夹专属，剪贴板空时灰显）。
 * @author ddj 2026年09月22号
 * @returns 分组条目
 */
function clipGroupItems(): TreeMenuItem[] {
  return [
    {
      id: 'cut',
      label: '剪切',
      order: ORDER_CUT,
      group: GROUP_CLIP,
      visible: hasPath,
      run: (target, ctx) => {
        setFileClip('cut', target.path)
        ctx.notify?.('已剪切「' + baseNameOf(target.path) + '」')
      },
    },
    {
      id: 'copy',
      label: '复制',
      order: ORDER_COPY,
      group: GROUP_CLIP,
      visible: hasPath,
      run: (target, ctx) => {
        setFileClip('copy', target.path)
        ctx.notify?.('已复制「' + baseNameOf(target.path) + '」')
      },
    },
    {
      id: 'paste',
      label: '粘贴',
      order: ORDER_PASTE,
      group: GROUP_CLIP,
      visible: isDirTarget,
      disabled: () => fileClipOf() === null,
      run: (target, ctx) => { void pasteInto(target, ctx) },
    },
  ]
}

/**
 * 分组 5：复制路径 / 复制相对路径（仅非根；相对路径还需 cwd）。
 * @author ddj 2026年09月22号
 * @returns 分组条目
 */
function copyPathItems(): TreeMenuItem[] {
  return [
    {
      id: 'copy-path',
      label: '复制路径',
      order: ORDER_COPY_PATH,
      group: GROUP_COPY_PATH,
      visible: hasPath,
      run: (target, ctx) => {
        void copyText(absoluteOf(target.path, ctx.cwd), '已复制路径', (message) => ctx.notify?.(message))
      },
    },
    {
      id: 'copy-relative-path',
      label: '复制相对路径',
      order: ORDER_COPY_REL,
      group: GROUP_COPY_PATH,
      visible: (target, ctx) => hasPath(target) && hasCwd(ctx),
      run: (target, ctx) => {
        void copyText(relativeOf(target.path, ctx.cwd), '已复制相对路径', (message) => ctx.notify?.(message))
      },
    },
  ]
}

/**
 * 分组 6：重命名…（仅非根）+ 删除/永久删除（仅非根；danger，文件与文件夹文案不同）。
 * @author ddj 2026年09月22号
 * @returns 分组条目
 */
function editGroupItems(): TreeMenuItem[] {
  return [
    {
      id: 'rename',
      label: '重命名…',
      order: ORDER_RENAME,
      group: GROUP_EDIT,
      visible: hasPath,
      run: (target, ctx) => { void renameEntry(target, ctx) },
    },
    {
      id: 'delete',
      // 文案对齐参考图：文件 = 「删除」，文件夹 = 「永久删除」（行为均为确认后的磁盘删除）
      label: (target) => (isDirTarget(target) ? '永久删除' : '删除'),
      order: ORDER_DELETE,
      group: GROUP_EDIT,
      danger: true,
      visible: hasPath,
      run: (target, ctx) => { void deleteEntry(target, ctx) },
    },
  ]
}

// --endregion

// --region SVN 组（动作清单来自 shared/svnActions.ts）

/** 目标路径对应的变更条目（不在清单里返回 undefined）。 */
function svnEntryOf(target: TreeMenuTarget, ctx: SidebarCtx): SvnChangeEntry | undefined {
  if (!target.path) return undefined
  const map = ctx.svnChangeMap
  return map ? map[target.path] : undefined
}

/**
 * 把树菜单目标投影为动作求值上下文（能力 + 目标类型 + 状态门禁）。
 * 显隐判定统一交给 shared 的 svnActionOn，避免与页签菜单/命令栏漂移。
 * @author ddj 2026年09月16号
 * @param target 右键目标
 * @param ctx 面板上下文
 * @returns 求值上下文；无 SVN 状态返回 null
 */
function svnContextOf(target: TreeMenuTarget, ctx: SidebarCtx): SvnActionContext | null {
  const svn = ctx.svn
  if (!svn) return null
  const entry = svnEntryOf(target, ctx)
  const isRoot = target.path === ''
  const targetType: SvnTargetType = isRoot ? 'root' : (target.type === 'directory' ? 'directory' : 'file')
  return {
    managed: svn.managed,
    svnCli: svn.svnCli,
    tortoise: svn.tortoise,
    // 自研能力集合：驱动「自研替换时间线」（隐藏已被自研覆盖的 Tortoise 项）
    svnFeatures: svn.svnFeatures,
    target: targetType,
    // 不在变更清单里视为受版本控制（干净文件）；未版本控制条目显式为 false
    versioned: entry ? entry.versioned : true,
    status: entry?.status,
    diffable: isSvnDiffable(target.path, entry?.status),
  }
}

/**
 * 树菜单动作执行上下文（RPC 与反馈经面板 ctx 注入）。
 * @author ddj 2026年09月16号
 * @param target 右键目标
 * @param ctx 面板上下文
 * @returns 执行上下文
 */
function treeRunCtx(target: TreeMenuTarget, ctx: SidebarCtx): SvnActionRunCtx {
  return {
    sessionId: ctx.sessionId,
    scope: ctx.scope,
    path: target.path,
    notify: (message) => ctx.notify?.(message),
    openSvnDiff: (p) => ctx.openSvnDiff?.(p),
    openSvnLog: ctx.openSvnLog,
    refreshChanges: ctx.refreshSvnChanges,
    // 确认对话框可注入（测试/宿主可替换；缺省走 window.confirm）
    confirm: ctx.confirm,
  }
}

/**
 * 构造 SVN 组菜单项（动作清单来自 shared/svnActions.ts）。
 *
 * 收敛收益：此前每个动作在这里手写一项、页签菜单再手写一遍、命令栏第三遍，
 * 显隐规则三处漂移（P2 的「加入/还原」状态矩阵就重复过两份）。现在只做映射。
 * 共享元数据的 separator 意为「新分段」：映射为分组号 +1，分隔线由 buildTreeMenu 统一出。
 * @author ddj 2026年09月16号 / 2026年09月22号
 * @returns SVN 组条目
 */
function svnMenuItems(): TreeMenuItem[] {
  const items: TreeMenuItem[] = []
  let group = SVN_GROUP_BASE
  for (const action of svnActionsFor('tree')) {
    if (action.separator === true) group += 1
    items.push({
      id: 'svn-' + action.id,
      label: action.label,
      order: SVN_ORDER_BASE + action.order,
      group,
      danger: action.danger === true,
      visible: (target: TreeMenuTarget, ctx: SidebarCtx) => {
        const context = svnContextOf(target, ctx)
        return context !== null && svnActionOn(action, context)
      },
      run: (target: TreeMenuTarget, ctx: SidebarCtx) => {
        runSvnAction(action, treeRunCtx(target, ctx))
      },
    })
  }
  return items
}

// --endregion

/**
 * 构造内置右键菜单项列表（后续内置项按分组追加）。
 * @author ddj 2026年08月27号 / 2026年09月22号
 * @returns 内置菜单项数组
 */
export function createDefaultFileMenuItems(): TreeMenuItem[] {
  return [
    ...openGroupItems(),
    ...revealGroupItems(),
    ...refGroupItems(),
    ...clipGroupItems(),
    ...copyPathItems(),
    ...editGroupItems(),
    ...svnMenuItems(),
  ]
}

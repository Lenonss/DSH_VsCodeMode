/**
 * dsh-vscode-mode client — 编辑区状态作用域键（scope key）。
 * 编辑区 UI 状态（页签/展开树/视图状态/侧边栏等）按「工作区」隔离：同一工作区下
 * 切换对话恢复同一份状态，无体感差别；会话没有 cwd 时回退按会话隔离（旧行为）。
 * 另提供旧「会话键」数据到「工作区键」的一次性迁移（只复制不删除，幂等）。
 * 键前缀统一走 paths.ts PathConst（CACHE_KEY），本模块只产出拼接用的作用域串。
 * 作者 ddj 2026-09-09
 */
import { CACHE_KEY } from '../paths.js'

// --region 归一化与作用域键

/** Windows 盘符绝对路径（如 D:/ 或 d:\），大小写不敏感。 */
const WIN_DRIVE_RE = /^[a-z]:\//i

/**
 * 归一化工作区路径：trim、反斜杠→斜杠、去尾部斜杠；
 * Windows 盘符绝对路径整体小写（文件系统大小写不敏感），POSIX 路径保留大小写。
 * @author ddj 2026年09月09号
 * @param cwd 工作区目录（sessions 快照 byId[sessionId].cwd）
 * @returns 归一化路径；空值返回 ''
 */
export function normalizeWsPath(cwd: string | undefined | null): string {
  const s = String(cwd ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!s) return ''
  return WIN_DRIVE_RE.test(s) ? s.toLowerCase() : s
}

/**
 * 计算编辑区状态作用域键：有 cwd → 'ws:' + 归一化路径（同工作区共享）；
 * 无 cwd → 'sid:' + sessionId（回退按会话隔离，对齐旧行为）。
 * @author ddj 2026年09月09号
 * @param cwd 工作区目录（可为 null/undefined）
 * @param sessionId 会话 id（cwd 缺失时的隔离键）
 * @returns 作用域键字符串
 */
export function workspaceScopeOf(cwd: string | undefined | null, sessionId: string | undefined): string {
  const ws = normalizeWsPath(cwd)
  if (ws) return 'ws:' + ws
  return 'sid:' + String(sessionId ?? '')
}
// --endregion

// --region 旧会话键迁移

/** 参与迁移的 localStorage 键前缀（编辑区全部按会话持久化的旧键）。 */
const MIGRATE_PREFIXES: readonly string[] = [
  CACHE_KEY.editor,
  CACHE_KEY.viewstate,
  CACHE_KEY.sidebar + 'side.',
  CACHE_KEY.sidebar,
  CACHE_KEY.search,
  CACHE_KEY.expanded,
  CACHE_KEY.entries,
]

/** 已迁移过的 scope+sessionId 组合（按 storage 实例分组；每页生命周期只跑一次）。 */
const migratedPairs = new WeakMap<object, Set<string>>()

/**
 * 把旧「前缀+sessionId」键的数据一次性复制到「前缀+scope」键（目标已存在则跳过）。
 * 只复制不删除旧键；幂等，可安全重复调用。升级后首个工作区键为空时兜底恢复旧数据。
 * @author ddj 2026年09月09号
 * @param scope 目标作用域键
 * @param sessionId 旧数据所属会话 id
 * @param storage localStorage 注入口（缺省 window.localStorage，测试可传内存桩）
 */
export function migrateScopedKeys(scope: string, sessionId: string | undefined, storage?: Storage): void {
  if (!scope || !sessionId) return
  let store: Storage | null = null
  try {
    store = storage ?? window.localStorage
  } catch (error) {
    return
  }
  if (!store) return
  let pairs = migratedPairs.get(store)
  if (!pairs) {
    pairs = new Set()
    migratedPairs.set(store, pairs)
  }
  const pair = scope + '|' + sessionId
  if (pairs.has(pair)) return
  pairs.add(pair)
  const legacy = String(sessionId)
  for (const prefix of MIGRATE_PREFIXES) {
    const target = prefix + scope
    try {
      if (store.getItem(target) !== null) continue
      const raw = store.getItem(prefix + legacy)
      if (raw === null) continue
      store.setItem(target, raw)
    } catch (error) { /* 配额满/隐私模式忽略，不阻塞 */ }
  }
}
// --endregion

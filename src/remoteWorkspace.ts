/**
 * dsh-vscode-mode host — dsh-remote-ssh 远程工作区探测与镜像↔远端路径映射。
 * 背景（issue #7）：dsh-remote-ssh 的「原生远程工作区」cwd 指向本机镜像目录
 * （如 ~/.dsh/remote-workspaces/<id>，根下含 .remote-ssh.json {profileId, host,
 * user, remotePath}），agent 的 remote_ssh_write 直写远端；差异审查需要把
 * 远端参数路径映射回镜像（捕获/读/决策复用本地链路），并把展示路径翻译成远端形态。
 * 判据与上游 dsh-remote-ssh 的 findMirrorRoot 对齐（host/user/remotePath 必填、
 * 向上 ≤8 层有界）；纯函数为主，node:fs 仅用于标记读取（带 60s TTL 缓存）。
 * 作者 ddj 2026年09月23号
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// --region 常量与类型
/** dsh-remote-ssh 工作区标记文件名。 */
const MARKER = '.remote-ssh.json'
/** 向上探测的最大层数（含 cwd 自身；与上游 findMirrorRoot 的 8 层有界一致）。 */
const MAX_DEPTH = 8
/** 探测结果 TTL（edrv.list 为 5s 轮询，避免每轮都做文件 IO）。 */
const TTL_MS = 60_000

/** 远程工作区（镜像根 + 标记内容）。 */
export interface RemoteWs {
  /** 镜像根（含标记文件的目录，平台绝对路径）。 */
  root: string
  host: string
  user: string
  /** 远端工作区目录（`~/proj` 或绝对路径，原样保留）。 */
  remotePath: string
  profileId?: string
}
// --endregion

// --region 探测
/** cwd → { at, ws } 探测缓存（含阴性结果）。 */
const cache = new Map<string, { at: number; ws: RemoteWs | null }>()

/**
 * 标记内容 → 远程工作区（host/user/remotePath 缺任一字段判非法，与上游一致）。
 * @author ddj 2026年09月23号
 * @param root 标记所在目录
 * @param raw 标记文件文本
 * @returns 合法返回 RemoteWs；非法返回 null
 */
function markerWsOf(root: string, raw: string): RemoteWs | null {
  try {
    const info = JSON.parse(raw) as Record<string, unknown>
    if (typeof info.host !== 'string' || !info.host) return null
    if (typeof info.user !== 'string' || !info.user) return null
    if (typeof info.remotePath !== 'string' || !info.remotePath) return null
    const ws: RemoteWs = { root, host: info.host, user: info.user, remotePath: info.remotePath }
    if (typeof info.profileId === 'string' && info.profileId) ws.profileId = info.profileId
    return ws
  } catch {
    return null
  }
}

/**
 * 从 cwd 起向上有界探测标记（不走缓存）。
 * @author ddj 2026年09月23号
 * @param cwd 会话工作区根
 * @returns 命中合法标记返回 RemoteWs；否则 null
 */
function walkRemoteWs(cwd: string): RemoteWs | null {
  let dir = cwd
  for (let i = 0; i < MAX_DEPTH; i++) {
    try {
      const ws = markerWsOf(dir, readFileSync(join(dir, MARKER), 'utf8'))
      if (ws) return ws
    } catch {
      // 无标记或不可读/JSON 损坏：继续向上（与上游 findMirrorRoot 行为一致）
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 探测工作区是否为 dsh-remote-ssh 远程工作区（cwd 或向上 ≤8 层找 .remote-ssh.json）。
 * 结果按 cwd 缓存 60s（含阴性）；标记变更后可用 clearWsCache 立即重置。
 * @author ddj 2026年09月23号
 * @param cwd 会话工作区根（可空）
 * @returns 远程工作区信息；非远程或标记非法返回 null
 */
export function findRemoteWs(cwd: string | null | undefined): RemoteWs | null {
  if (!cwd) return null
  const now = Date.now()
  const hit = cache.get(cwd)
  if (hit && now - hit.at < TTL_MS) return hit.ws
  const ws = walkRemoteWs(cwd)
  cache.set(cwd, { at: now, ws })
  return ws
}

/**
 * 清空探测缓存（测试与标记变更后重置用）。
 * @author ddj 2026年09月23号
 */
export function clearWsCache(): void {
  cache.clear()
}
// --endregion

// --region 路径映射
/**
 * 前缀剥离：path 必须严格位于 root 之下；等于 root 或不匹配返回 null。
 * @author ddj 2026年09月23号
 * @param path 待剥离路径（posix 形态）
 * @param root 前缀（posix 形态、无尾斜杠）
 * @returns 相对段；不匹配返回 null
 */
function prefixRel(path: string, root: string): string | null {
  if (path === root || !path.startsWith(root + '/')) return null
  return path.slice(root.length + 1)
}

/**
 * 远端参数路径 → 相对远端工作区目录的相对段。
 * 支持：相对路径（工具语义即基于远端工作区目录）、绝对路径且 remotePath 为绝对
 * 形态并为其前缀、`~` 形态且 remotePath 同为 `~` 前缀；Windows 盘符形态按
 * 非远端语义拒绝。含 `..` 逃逸或空相对段返回 null。
 * @author ddj 2026年09月23号
 * @param argPath remote_ssh_write 的 path 参数
 * @param ws 远程工作区
 * @returns posix 相对段；不可映射返回 null
 */
function remoteRelOf(argPath: string, ws: RemoteWs): string | null {
  const path = argPath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!path) return null
  const root = ws.remotePath.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return null
  let rel: string | null
  if (path.startsWith('/')) {
    rel = root.startsWith('/') ? prefixRel(path, root) : null
  } else if (path === '~' || path.startsWith('~/')) {
    rel = root.startsWith('~/') ? prefixRel(path, root) : null
  } else if (/^[A-Za-z]:\//.test(path)) {
    rel = null
  } else {
    rel = path
  }
  if (rel === null || rel.split('/').some((seg) => seg === '..')) return null
  return rel
}

/**
 * 远端工具参数路径 → 本机镜像绝对路径。
 * @author ddj 2026年09月23号
 * @param argPath remote_ssh_write 的 path 参数
 * @param ws 远程工作区
 * @returns 镜像内绝对路径；镜像外/前缀形态不一致/逃逸返回 null
 */
export function mirrorTargetOf(argPath: string, ws: RemoteWs): string | null {
  const rel = remoteRelOf(argPath, ws)
  return rel === null ? null : join(ws.root, rel)
}

/**
 * 镜像内绝对路径 → 远端展示路径（remotePath + 相对段，posix 拼接）。
 * @author ddj 2026年09月23号
 * @param mirrorAbs 镜像内绝对路径（通常是记录 path）
 * @param ws 远程工作区
 * @returns 远端路径；不在镜像根下返回 null（调用方回落原 path）
 */
export function remoteDisplayOf(mirrorAbs: string, ws: RemoteWs): string | null {
  const path = mirrorAbs.replace(/\\/g, '/')
  const root = ws.root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return null
  const rel = prefixRel(path, root)
  if (rel === null || rel.split('/').some((seg) => seg === '..')) return null
  const remoteRoot = ws.remotePath.replace(/\/+$/, '')
  return remoteRoot + '/' + rel
}
// --endregion

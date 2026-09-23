/**
 * host remoteWorkspace.ts 测试 — dsh-remote-ssh 远程工作区探测与镜像↔远端路径映射。
 * 覆盖：findRemoteWs（合法/缺字段/损坏/嵌套/越界/TTL 缓存）/ mirrorTargetOf 四类
 * 路径矩阵 / remoteDisplayOf 展示翻译。
 * CI 为 ubuntu：路径断言一律 path.join 构造 + 反斜杠归一，不写死盘符/分隔符。
 * 作者 ddj 2026-09-23
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearWsCache, findRemoteWs, mirrorTargetOf, remoteDisplayOf, type RemoteWs } from '../src/remoteWorkspace.js'

/** 反斜杠归一（Windows 本地与 ubuntu CI 同断言）。 */
const norm = (p: string): string => p.replace(/\\/g, '/')

const FULL_MARKER = { profileId: 'p1', host: 'hpc.example', user: 'u', remotePath: '/home/u/proj' }

let base: string

/** 造一个工作区目录（marker=null 不写标记）。 */
function mkRoot(name: string, marker: object | string | null): string {
  const root = join(base, name)
  mkdirSync(root, { recursive: true })
  if (marker !== null) {
    writeFileSync(join(root, '.remote-ssh.json'), typeof marker === 'string' ? marker : JSON.stringify(marker))
  }
  return root
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'edrv-rw-'))
  clearWsCache()
})

afterEach(() => {
  clearWsCache()
  rmSync(base, { recursive: true, force: true })
})

describe('findRemoteWs', () => {
  it('cwd 自身含合法标记 → 命中（字段齐全）', () => {
    const root = mkRoot('w1', FULL_MARKER)
    const ws = findRemoteWs(root)
    expect(ws).not.toBeNull()
    expect(ws!.root).toBe(root)
    expect(ws!.host).toBe('hpc.example')
    expect(ws!.user).toBe('u')
    expect(ws!.remotePath).toBe('/home/u/proj')
    expect(ws!.profileId).toBe('p1')
  })

  it('嵌套子目录向上命中镜像根', () => {
    const root = mkRoot('w2', FULL_MARKER)
    const nested = join(root, 'docs', 'deep')
    mkdirSync(nested, { recursive: true })
    expect(findRemoteWs(nested)?.root).toBe(root)
  })

  it('标记缺必需字段不误判（继续向上也无标记 → null）', () => {
    const root = mkRoot('w3', { profileId: 'p1' })
    expect(findRemoteWs(root)).toBeNull()
  })

  it('损坏 JSON → null', () => {
    const root = mkRoot('w4', 'not-json{')
    expect(findRemoteWs(root)).toBeNull()
  })

  it('无标记目录向上到文件系统根 → null', () => {
    const root = mkRoot('w5', null)
    expect(findRemoteWs(root)).toBeNull()
  })

  it('超过 8 层 → null（有界，避免病态遍历）', () => {
    const root = mkRoot('w6', FULL_MARKER)
    let deep = root
    for (let i = 0; i < 9; i++) {
      deep = join(deep, 'd' + i)
      mkdirSync(deep)
    }
    expect(findRemoteWs(deep)).toBeNull()
  })

  it('空 cwd → null', () => {
    expect(findRemoteWs(null)).toBeNull()
    expect(findRemoteWs(undefined)).toBeNull()
    expect(findRemoteWs('')).toBeNull()
  })

  it('TTL 缓存：阴性结果被缓存，clearWsCache 后重探生效', () => {
    const root = mkRoot('w7', null)
    expect(findRemoteWs(root)).toBeNull()
    writeFileSync(join(root, '.remote-ssh.json'), JSON.stringify(FULL_MARKER))
    expect(findRemoteWs(root)).toBeNull() // TTL 内仍用缓存
    clearWsCache()
    expect(findRemoteWs(root)).not.toBeNull()
  })
})

describe('mirrorTargetOf', () => {
  const root = join('mirror-root-ignored-by-pure-tests')
  const absWs: RemoteWs = { root, host: 'h', user: 'u', remotePath: '/home/u/proj' }
  const tildeWs: RemoteWs = { root, host: 'h', user: 'u', remotePath: '~/proj' }

  it('相对路径 → 镜像根拼接（含 ./ 前缀归一）', () => {
    expect(norm(mirrorTargetOf('src/a.py', absWs)!)).toBe(norm(join(root, 'src/a.py')))
    expect(norm(mirrorTargetOf('./src/a.py', absWs)!)).toBe(norm(join(root, 'src/a.py')))
    expect(norm(mirrorTargetOf('a.py', tildeWs)!)).toBe(norm(join(root, 'a.py')))
  })

  it('绝对路径位于绝对 remotePath 下 → 映射', () => {
    expect(norm(mirrorTargetOf('/home/u/proj/src/a.py', absWs)!)).toBe(norm(join(root, 'src/a.py')))
  })

  it('~ 路径与 ~ remotePath 同前缀 → 映射', () => {
    expect(norm(mirrorTargetOf('~/proj/src/a.py', tildeWs)!)).toBe(norm(join(root, 'src/a.py')))
  })

  it('镜像外/形态不一致/盘符/逃逸 → null', () => {
    expect(mirrorTargetOf('/elsewhere/a.py', absWs)).toBeNull()
    expect(mirrorTargetOf('/home/u/proj', absWs)).toBeNull() // 等于 remotePath 根（目录）
    expect(mirrorTargetOf('/home/u/proj/a.py', tildeWs)).toBeNull() // 绝对 vs ~ 形态不一致
    expect(mirrorTargetOf('~/other/a.py', tildeWs)).toBeNull()
    expect(mirrorTargetOf('~/proj/a.py', absWs)).toBeNull() // ~ vs 绝对形态不一致
    expect(mirrorTargetOf('~', tildeWs)).toBeNull()
    expect(mirrorTargetOf('C:/x/a.py', absWs)).toBeNull()
    expect(mirrorTargetOf('src/../../a.py', absWs)).toBeNull()
    expect(mirrorTargetOf('', absWs)).toBeNull()
  })
})

describe('remoteDisplayOf', () => {
  const root = mkdtempSync(join(tmpdir(), 'edrv-disp-'))
  const ws: RemoteWs = { root, host: 'h', user: 'u', remotePath: '/home/u/proj' }
  const tildeWs: RemoteWs = { root, host: 'h', user: 'u', remotePath: '~/proj' }

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('镜像内绝对路径 → remotePath + 相对段', () => {
    expect(remoteDisplayOf(join(root, 'src', 'a.py'), ws)).toBe('/home/u/proj/src/a.py')
    expect(remoteDisplayOf(join(root, 'a.py'), tildeWs)).toBe('~/proj/a.py')
  })

  it('镜像根自身/镜像外路径 → null（调用方回落原 path）', () => {
    expect(remoteDisplayOf(root, ws)).toBeNull()
    expect(remoteDisplayOf(join(root, '..', 'other.txt'), ws)).toBeNull()
    expect(remoteDisplayOf('/home/u/proj/a.py', ws)).toBeNull()
  })
})

/**
 * host openBridge.ts 测试：ensureActiveBridge 按当前 profile 开机 provisioning 独立 bridge。
 * 覆盖：桌面 profile（mode=desktop）/ web profile（mode=web）/ 无有效 profile（返回 null，不抛错）。
 * 包源与 home 均用 fixture 注入，不触碰真实 ~/.dsh。
 * 作者 ddj 2026-10-12
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { Ctx } from '../src/store.js'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureActiveBridge, openIni } from '../src/openBridge.js'
import { PLUGIN_ID } from '../src/paths.js'
import { PLUGIN_NAME } from '../src/compat.js'

/** 活动临时根（每个用例独立，afterEach 清理）。 */
let root: string | null = null

async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.edrv-openbridge-'))
  return root
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

/** 造一个运行 profile：<base>/profile-<name>，package.json 依赖本插件。 */
async function makeProfile(base: string, name: string): Promise<string> {
  const profile = join(base, 'profile-' + name)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { [PLUGIN_NAME]: '^0.14.0' } }), 'utf8')
  return profile
}

function ctxOf(profile: string, name: string): Ctx {
  return { get: (key: string) => key === 'profileContext' ? { dir: profile, name } : undefined } as unknown as Ctx
}

describe('ensureActiveBridge（tmp 端到端）', () => {
  it('桌面 profile 生成独立 bridge：mode=desktop + 本 profile inbox/helper/node', async () => {
    const base = await tempRoot()
    const profile = await makeProfile(base, 'desktop')
    const ctx = ctxOf(profile, 'desktop')
    // 桌面模式判定依赖 process.versions.electron（真实桌面宿主为 Electron）；测试进程是 Node，需显式注入
    const previous = (process.versions as Record<string, string | undefined>).electron
    ;(process.versions as Record<string, string | undefined>).electron = '44.0.0'
    try {
      const ini = await ensureActiveBridge(ctx, 'http://127.0.0.1:19387')
      const config = join(profile, PLUGIN_ID, 'bridge', 'dsh-open.ini')
      expect(ini).toBe(config)
      const text = await readFile(config, 'utf8')
      expect(text).toContain('mode=desktop')
      expect(text).toContain('profile=' + profile)
      expect(text).toContain('base=http://127.0.0.1:19387')
      expect(text).toContain('helper=' + join(profile, PLUGIN_ID, 'bridge', 'dsh-open.mjs'))
      expect(text).toContain('nodeMode=electron')
      // 辅助脚本一并落地
      expect(await readFile(join(profile, PLUGIN_ID, 'bridge', 'dsh-open.mjs'), 'utf8')).toContain('requestId')
    } finally {
      if (previous === undefined) delete (process.versions as Record<string, string | undefined>).electron
      else (process.versions as Record<string, string | undefined>).electron = previous
    }
  }, 15_000)

  it('web profile 生成独立 bridge：mode=web + node 解释器', async () => {
    const base = await tempRoot()
    const profile = await makeProfile(base, 'web')
    const ctx = ctxOf(profile, 'web')
    const ini = await ensureActiveBridge(ctx, 'http://127.0.0.1:3080')
    expect(ini).toBe(join(profile, PLUGIN_ID, 'bridge', 'dsh-open.ini'))
    const text = await readFile(ini as string, 'utf8')
    expect(text).toContain('mode=web')
    expect(text).toContain('profile=' + profile)
    expect(text).toContain('nodeMode=node')
  }, 15_000)

  it('无有效 profile 返回 null，不抛错（开机静默）', async () => {
    const base = await tempRoot()
    const plain = join(base, 'plain')
    await mkdir(plain, { recursive: true })
    await writeFile(join(plain, 'package.json'), JSON.stringify({ name: 'not-a-profile' }), 'utf8')
    const ctx = { get: () => undefined } as unknown as Ctx
    expect(await ensureActiveBridge(ctx, 'http://127.0.0.1:19387')).toBeNull()
  })

  it('openIni 拒绝 INI 行注入（换行/回车/NUL）', () => {
    expect(() => openIni('http://x', { mode: 'a\nb=1' })).toThrow('无效的 launcher 配置')
    expect(() => openIni('http://x', { mode: 'a\rb' })).toThrow('无效的 launcher 配置')
    expect(() => openIni('http://x', { mode: 'a\0b' })).toThrow('无效的 launcher 配置')
    expect(openIni('http://x', { mode: 'web' })).toBe('[dsh]\nbase=http://x\nmode=web\n')
  })
})

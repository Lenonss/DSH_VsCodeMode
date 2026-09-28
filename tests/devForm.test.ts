/** devForm 开发形态管理测试：manifest 规划 / profile 发现 / 状态读取。作者 ddj 2026年08月24号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, lstatSync, symlinkSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProfileDir, planManifest, readDevForm, setDevForm } from '../src/devForm.js'

const MANIFEST = `{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-other": "^1.0.0",
    "dsh-vscode-mode": "link:D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review"
  }
}
`

describe('planManifest', () => {
  it('开启开发形态写入 link: 依赖并保留其他字段', () => {
    const next = planManifest(MANIFEST, true, 'D:\\Work\\repo', '0.1.16')
    const parsed = JSON.parse(next)
    expect(parsed.dependencies['dsh-vscode-mode']).toBe('link:D:/Work/repo')
    expect(parsed.dependencies['dsh-other']).toBe('^1.0.0')
    expect(parsed.name).toBe('dsh-profile-web')
    expect(next.startsWith('{')).toBe(true)
  })

  it('关闭开发形态写入版本依赖（^当前版本）', () => {
    const next = planManifest(MANIFEST, false, '', '0.1.16')
    const parsed = JSON.parse(next)
    expect(parsed.dependencies['dsh-vscode-mode']).toBe('^0.1.16')
  })

  it('容忍 UTF-8 BOM 输入且输出无 BOM', () => {
    const next = planManifest('\uFEFF' + MANIFEST, false, '', '0.1.16')
    expect(next.startsWith('\uFEFF')).toBe(false)
    expect(JSON.parse(next).dependencies['dsh-vscode-mode']).toBe('^0.1.16')
  })

  it('非法 JSON 或缺失 dependencies 时抛错', () => {
    expect(() => planManifest('not json', true, 'x', '1')).toThrow()
    expect(() => planManifest('{"name":"x"}', true, 'x', '1')).toThrow()
  })
})

describe('findProfileDir / readDevForm', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-devform-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'other'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), MANIFEST)
    writeFileSync(join(home, 'profiles', 'other', 'package.json'), '{"name":"x","dependencies":{"z":"^1"}}')
    vi.stubEnv('DSH_HOME', home)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('在多个 profile 中定位依赖本插件的 profile', () => {
    expect(findProfileDir()).toBe(join(home, 'profiles', 'web'))
  })

  it('link: 依赖读取为开发形态并带工作区路径', () => {
    expect(readDevForm()).toEqual({ enabled: true, path: 'D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review' })
  })

  it('版本依赖视为非开发形态', () => {
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), MANIFEST.replace('link:D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review', '^0.1.16'))
    expect(readDevForm()).toEqual({ enabled: false })
  })

  it('无 profile 时安全返回未开启', () => {
    rmSync(join(home, 'profiles'), { recursive: true, force: true })
    expect(findProfileDir()).toBeUndefined()
    expect(readDevForm()).toEqual({ enabled: false })
  })

  it('multiple dependent profiles fail closed without runtime context', () => {
    writeFileSync(join(home, 'profiles', 'other', 'package.json'), MANIFEST)
    expect(findProfileDir()).toBeUndefined()
  })

  it('official desktop runtime profile wins over the web profile', () => {
    const desktop = join(home, 'profiles', 'desktop')
    mkdirSync(desktop)
    writeFileSync(join(desktop, 'package.json'), MANIFEST.replace('link:D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review', '^0.13.0'))
    const ctx = { get: (name: string) => name === 'profileContext' ? { dir: desktop } : undefined }
    expect(findProfileDir(ctx)).toBe(desktop)
    expect(readDevForm(ctx)).toEqual({ enabled: false })
  })

  it('invalid or non-owning runtime context never falls through to a different profile', () => {
    expect(findProfileDir({ get: () => ({ dir: 'relative' }) })).toBeUndefined()
    expect(findProfileDir({ get: () => ({ dir: join(home, 'profiles', 'other') }) })).toBeUndefined()
  })
})

/**
 * 构造可控 subprocess 和官方 profileContext。
 * @private
 * @author ddj 2026年09月28号
 * @param dir 当前 profile
 * @param spawn 安装进程替身
 * @param runner Desktop 内置 pnpm 调用
 * @returns host 上下文替身
 */
function contextOf(dir: string, spawn: ReturnType<typeof vi.fn>, runner?: object) {
  return { get: (name: string) => name === 'profileContext' ? { dir, packageManager: runner } : name === 'subprocess' ? { spawn } : undefined }
}

describe('setDevForm transactions', () => {
  let root: string
  let dir: string
  let source: string
  let link: string
  let manifest: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-devform-txn-'))
    dir = join(root, 'profile')
    source = join(root, 'source')
    link = join(dir, 'node_modules', 'dsh-vscode-mode')
    mkdirSync(link, { recursive: true })
    mkdirSync(source)
    writeFileSync(join(source, 'package.json'), '{"name":"dsh-vscode-mode"}')
    writeFileSync(join(source, 'keep.txt'), 'source survives')
    writeFileSync(join(link, 'original.txt'), 'installed version')
    manifest = '{"dependencies":{"dsh-vscode-mode":"^0.11.0","other":"^1"}}\n'
    writeFileSync(join(dir, 'package.json'), manifest)
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'original lock')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

  it('validates missing/wrong source before changing any profile file', async () => {
    const spawn = vi.fn()
    const ctx = contextOf(dir, spawn)
    expect((await setDevForm(ctx, true, join(root, 'missing'))).ok).toBe(false)
    writeFileSync(join(source, 'package.json'), '{"name":"another-package"}')
    expect((await setDevForm(ctx, true, source)).ok).toBe(false)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(link, 'original.txt'), 'utf8')).toBe('installed version')
    expect(spawn).not.toHaveBeenCalled()
    expect(readdirSync(dir).some((name) => name.startsWith('.vscode-mode-backup-'))).toBe(false)
  })

  it('uses desktop runner argv/env with inherit stdio and commits a source junction', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'host-only')
    const spawn = vi.fn(() => ({ done: Promise.resolve({ exitCode: 0 }) }))
    const runner = { command: process.execPath, args: ['runner.cjs', 'pnpm'], env: { ELECTRON_RUN_AS_NODE: '1', CUSTOM_TOKEN: 'explicit' } }
    const result = await setDevForm(contextOf(dir, spawn, runner), true, source)
    expect(result).toEqual({ ok: true, restart: true })
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(source))
    const spec = spawn.mock.calls[0]![0] as any
    expect(spec.argv).toEqual([process.execPath, 'runner.cjs', 'pnpm', 'install'])
    expect(spec.stdio).toEqual({ stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' })
    expect(spec.env).toMatchObject({ ELECTRON_RUN_AS_NODE: '1', CUSTOM_TOKEN: 'explicit' })
    expect(spec.env.DEEPSEEK_API_KEY).toBeUndefined()
    expect(readdirSync(dir).some((name) => name.startsWith('.vscode-mode-backup-'))).toBe(false)
  })

  it('rolls back manifest, lockfile and installed directory on nonzero install', async () => {
    const spawn = vi.fn(() => {
      writeFileSync(join(dir, 'pnpm-lock.yaml'), 'partial lock')
      return { done: Promise.resolve({ exitCode: 7 }) }
    })
    expect(await setDevForm(contextOf(dir, spawn), true, source)).toMatchObject({ ok: false, restart: false, error: expect.stringContaining('exit 7') })
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock')
    expect(readFileSync(join(link, 'original.txt'), 'utf8')).toBe('installed version')
    expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('source survives')
  })

  it('restores a junction on rejected install without deleting its real source', async () => {
    rmSync(link, { recursive: true })
    symlinkSync(source, link, 'junction')
    const original = JSON.stringify({ dependencies: { 'dsh-vscode-mode': 'link:' + source } })
    writeFileSync(join(dir, 'package.json'), original)
    const spawn = vi.fn(() => ({ done: Promise.reject(new Error('spawn ENOENT')) }))
    expect((await setDevForm(contextOf(dir, spawn), false)).ok).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(realpathSync(link)).toBe(realpathSync(source))
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(original)
    expect(readFileSync(join(source, 'keep.txt'), 'utf8')).toBe('source survives')
  })

  it('does not write when subprocess is missing', async () => {
    const ctx = { get: (name: string) => name === 'profileContext' ? { dir } : undefined }
    expect((await setDevForm(ctx, true, source)).ok).toBe(false)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
  })

  it('removes a newly created lockfile on rollback and rejects concurrent switches', async () => {
    rmSync(join(dir, 'pnpm-lock.yaml'))
    let finish!: (value: { exitCode: number }) => void
    const done = new Promise<{ exitCode: number }>((resolve) => { finish = resolve })
    const spawn = vi.fn(() => ({ done }))
    const ctx = contextOf(dir, spawn)
    const first = setDevForm(ctx, true, source)
    expect((await setDevForm(ctx, false)).error).toContain('正在切换')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'created during install')
    finish({ exitCode: 1 })
    expect((await first).ok).toBe(false)
    expect(existsSync(join(dir, 'pnpm-lock.yaml'))).toBe(false)
  })
})

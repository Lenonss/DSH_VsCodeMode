/**
 * dsh-vscode-mode tests — C/C++ LSP（clangd）语言接入：
 *  - LSP_LANGUAGES / langOfPath / LSP_LANG_EXT 三处语言清单必须同时认识 cpp 系列扩展名
 *  - langOfPath 对 .h/.hpp/.c/.cc 统一归到 cpp（宿主侧只认扩展名，语言判定交给 clangd）
 *  - candidateClangdServers 的发现顺序（PATH 优先）与 resolveClangdProvider 手动分支
 * @author ddj 2026年11月17号
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LSP_LANGUAGES, langOfPath } from '../src/lsp/config.js'
import {
  LSP_LANG_EXT,
  candidateClangdServers,
  resolveClangdProvider,
  PROVIDER_RESOLVERS,
} from '../src/lsp/providers.js'

const dirs: string[] = []
const oldPath = process.env.PATH

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cpp-test-'))
  dirs.push(dir)
  return dir
}

/** 造一个可执行的假 clangd（内容不重要，只要求 existsSync 命中）。 */
function fakeClangd(dir: string): string {
  const exe = join(dir, process.platform === 'win32' ? 'clangd.exe' : 'clangd')
  writeFileSync(exe, '#!/bin/sh\nexit 0\n')
  chmodSync(exe, 0o755)
  return exe
}

afterEach(() => {
  process.env.PATH = oldPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('C/C++ 语言清单', () => {
  it('LSP_LANGUAGES 包含 cpp', () => {
    expect([...LSP_LANGUAGES]).toContain('cpp')
  })

  it('LSP_LANG_EXT 覆盖源文件与头文件', () => {
    expect(LSP_LANG_EXT.cpp).toEqual(expect.arrayContaining(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx']))
  })

  it('langOfPath 识别 cpp 系列（大小写不敏感），不误判其它扩展', () => {
    expect(langOfPath('brpc/src/brpc/controller.cpp')).toBe('cpp')
    expect(langOfPath('brpc/src/brpc/controller.h')).toBe('cpp')
    expect(langOfPath('a/b/util.HPP')).toBe('cpp')
    expect(langOfPath('a/b/main.c')).toBe('cpp')
    expect(langOfPath('a/b/main.cc')).toBe('cpp')
    expect(langOfPath('a/b/main.cpp.txt')).toBeNull()
    expect(langOfPath('a/b/main.cxx.inl.txt')).toBeNull()
    expect(langOfPath('a/b/main')).toBeNull()
  })

  it('PROVIDER_RESOLVERS 注册了 cpp', () => {
    expect(PROVIDER_RESOLVERS.cpp).toBe(resolveClangdProvider)
  })
})

describe('candidateClangdServers（clangd 发现顺序）', () => {
  it('PATH 中的 clangd 排第一', () => {
    const dir = tempDir()
    const exe = fakeClangd(dir)
    process.env.PATH = dir
    const candidates = candidateClangdServers()
    expect(candidates[0]?.path).toBe(exe)
  })

  it('候选不重复', () => {
    const dir = tempDir()
    const exe = fakeClangd(dir)
    process.env.PATH = dir
    const paths = candidateClangdServers().map((c) => c.path)
    expect(paths.filter((p) => p === exe)).toHaveLength(1)
  })
})

describe('resolveClangdProvider（手动配置优先，不依赖本机 clangd）', () => {
  it('手动路径存在 → kind=manual，并补齐系统 PATH', () => {
    const dir = tempDir()
    const exe = fakeClangd(dir)
    process.env.PATH = dir
    const spec = resolveClangdProvider({ path: exe })
    expect(spec.languageId).toBe('cpp')
    expect(spec.kind).toBe('manual')
    expect(spec.ready).toBe(true)
    expect(spec.argv).toEqual([exe])
    const pathEnv = spec.env?.PATH ?? ''
    expect(pathEnv.split(':')).toContain(dir)
    expect(pathEnv.split(':')).toContain('/usr/bin')
  })

  it('手动路径不存在 → 不当作 manual，回落到自动发现', () => {
    const dir = tempDir()
    const spec = resolveClangdProvider({ path: join(dir, 'nope', 'clangd') })
    expect(spec.languageId).toBe('cpp')
    expect(spec.kind).not.toBe('manual')
    expect(['discover', 'none']).toContain(spec.kind)
  })
})
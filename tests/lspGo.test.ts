/**
 * dsh-vscode-mode tests — Go LSP 语言接入（本仓库新增能力）：
 *  - LSP_LANGUAGES / langOfPath / LSP_LANG_EXT 三处语言清单必须同时认识 go
 *  - candidateGoServers 的发现顺序（PATH > GOPATH/bin > ~/go/bin > /usr/local/bin > /opt/homebrew/bin）
 *  - resolveGoProvider 手动路径分支（不依赖本机是否装有 gopls）
 * @author ddj 2026年11月15号
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LSP_LANGUAGES, langOfPath } from '../src/lsp/config.js'
import {
  LSP_LANG_EXT,
  candidateGoServers,
  resolveGoProvider,
  PROVIDER_RESOLVERS,
} from '../src/lsp/providers.js'

const dirs: string[] = []
const oldPath = process.env.PATH
const oldGoPath = process.env.GOPATH

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-go-test-'))
  dirs.push(dir)
  return dir
}

/** 造一个可执行的假 gopls（内容不重要，只要求 existsSync 命中）。 */
function fakeGopls(dir: string): string {
  const exe = join(dir, process.platform === 'win32' ? 'gopls.exe' : 'gopls')
  writeFileSync(exe, '#!/bin/sh\nexit 0\n')
  chmodSync(exe, 0o755)
  return exe
}

afterEach(() => {
  process.env.PATH = oldPath
  if (oldGoPath === undefined) delete process.env.GOPATH
  else process.env.GOPATH = oldGoPath
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Go 语言清单', () => {
  it('LSP_LANGUAGES 包含 go', () => {
    expect([...LSP_LANGUAGES]).toContain('go')
  })

  it('LSP_LANG_EXT 映射 .go', () => {
    expect(LSP_LANG_EXT.go).toEqual(['go'])
  })

  it('langOfPath 识别 .go（大小写不敏感），不误判其它扩展', () => {
    expect(langOfPath('dirpc-go/metrics/metrics.go')).toBe('go')
    expect(langOfPath('C:\\work\\main.GO')).toBe('go')
    expect(langOfPath('main.go.txt')).toBeNull()
    expect(langOfPath('util.golang')).toBeNull()
    expect(langOfPath('main')).toBeNull()
  })

  it('PROVIDER_RESOLVERS 注册了 go', () => {
    expect(PROVIDER_RESOLVERS.go).toBe(resolveGoProvider)
  })
})

describe('candidateGoServers（gopls 发现顺序）', () => {
  it('PATH 中的 gopls 排第一', () => {
    const dir = tempDir()
    const exe = fakeGopls(dir)
    process.env.PATH = dir
    delete process.env.GOPATH
    const candidates = candidateGoServers()
    expect(candidates[0]?.path).toBe(exe)
  })

  it('GOPATH/bin 下的 gopls 也会被收录', () => {
    const dir = tempDir()
    process.env.PATH = dir // 清空 PATH 命中，只留 GOPATH 通道
    delete process.env.GOPATH
    const binDir = join(dir, 'gopath', 'bin')
    mkdirSync(binDir, { recursive: true })
    const exe = fakeGopls(binDir)
    process.env.GOPATH = join(dir, 'gopath')
    const paths = candidateGoServers().map((c) => c.path)
    expect(paths).toContain(exe)
    expect(paths.filter((p) => p === exe)).toHaveLength(1)
  })
})

describe('resolveGoProvider（手动配置优先，不依赖本机 gopls）', () => {
  it('手动路径存在 → kind=manual，并补齐 Go 相关 PATH', () => {
    const dir = tempDir()
    const exe = fakeGopls(dir)
    process.env.PATH = dir // 只有临时目录，强制 goLaunchEnv 生效
    const spec = resolveGoProvider({ path: exe })
    expect(spec.languageId).toBe('go')
    expect(spec.kind).toBe('manual')
    expect(spec.ready).toBe(true)
    expect(spec.argv).toEqual([exe])
    const pathEnv = spec.env?.PATH ?? ''
    expect(pathEnv.split(':')).toContain(dir)
    expect(pathEnv.split(':')).toContain('/usr/local/go/bin')
  })

  it('手动路径不存在 → 不当作 manual，回落到自动发现', () => {
    const dir = tempDir()
    const spec = resolveGoProvider({ path: join(dir, 'nope', 'gopls') })
    expect(spec.languageId).toBe('go')
    expect(spec.kind).not.toBe('manual')
    expect(['discover', 'none']).toContain(spec.kind)
  })
})

/**
 * dsh-vscode-mode tests — extmgr（VSIX 扩展管理）：zip 解压往返 /
 * VSIX 清单 / 安装·列表·卸载 / providers 扩展源优先级。
 * 作者 ddj 2026-08-27
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { unzip, zipEntries } from '../src/lsp/zip.js'
import { vsixManifest, unpackVsix, installVsixBuffer, listInstalled, uninstall, extensionsRoot } from '../src/lsp/extmgr.js'
import { resolveLuaProvider, registerExtensionProvider, clearExtensionProviders } from '../src/lsp/providers.js'

/** crc32（zlib 无导出，自实现）。 */
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/** 极简 ZIP 构造器（stored + deflate + UTF-8 目录标记），供 fixture 使用。 */
function buildZip(entries: { path: string; data?: string }[]): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '', 'utf8')
    const isDir = e.path.endsWith('/')
    const method = data.length && !isDir ? 8 : 0
    const raw = method === 8 ? deflateRawSync(data) : data
    const name = Buffer.from(e.path, 'utf8')
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt32LE(crc32(data), 14)
    lh.writeUInt32LE(raw.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    chunks.push(lh, name, raw)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc32(data), 16)
    cd.writeUInt32LE(raw.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + raw.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cdBuf, eocd])
}

/** 最小 LuaLS 风格 VSIX：extension/package.json + server 二进制。 */
function luaVsix(): Buffer {
  return buildZip([
    { path: 'extension/package.json', data: JSON.stringify({ name: 'lua', publisher: 'sumneko', version: '3.19.1', displayName: 'Lua' }) },
    { path: 'extension/server/bin/Windows/lua-language-server.exe', data: 'MZ-fake-binary' },
    { path: 'extension/README.md', data: '# Lua' },
  ])
}

describe('lsp/zip 解压', () => {
  it('zipEntries + unzip 往返（stored/deflate/目录）', () => {
    const buf = buildZip([
      { path: 'extension/package.json', data: '{"a":1}' },
      { path: 'extension/server/bin/x', data: 'hello'.repeat(20) },
      { path: 'extension/empty/' },
    ])
    const entries = zipEntries(buf)
    expect(entries.length).toBe(3)
    const out = unzip(buf)
    const pkg = out.find((e) => e.path === 'extension/package.json')!
    expect(pkg.data.toString('utf8')).toBe('{"a":1}')
    const bin = out.find((e) => e.path === 'extension/server/bin/x')!
    expect(bin.data.toString('utf8')).toBe('hello'.repeat(20))
    expect(out.find((e) => e.path === 'extension/empty/')!.isDirectory).toBe(true)
  })

  it('非 zip 数据抛错', () => {
    expect(() => zipEntries(Buffer.from('not a zip at all'))).toThrow(/ZIP/)
  })
})

describe('lsp/extmgr VSIX 管理', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-ext-test-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('vsixManifest 解析 extension/package.json', () => {
    const manifest = vsixManifest(luaVsix())
    expect(manifest.name).toBe('lua')
    expect(manifest.publisher).toBe('sumneko')
    expect(manifest.version).toBe('3.19.1')
  })

  it('unpackVsix 解出 extension 子树', () => {
    const dest = join(home, 'ext')
    const manifest = unpackVsix(luaVsix(), dest)
    expect(manifest.name).toBe('lua')
    expect(existsSync(join(dest, 'server', 'bin', 'Windows', 'lua-language-server.exe'))).toBe(true)
    expect(existsSync(join(dest, 'README.md'))).toBe(true)
  })

  it('installVsixBuffer → listInstalled → uninstall 闭环', () => {
    const info = installVsixBuffer(luaVsix(), home)
    expect(info.id).toBe('sumneko.lua')
    expect(info.version).toBe('3.19.1')
    expect(existsSync(info.dir)).toBe(true)
    const listed = listInstalled(home)
    expect(listed.length).toBe(1)
    expect(listed[0].id).toBe('sumneko.lua')
    expect(listed[0].displayName).toBe('Lua')
    expect(uninstall('sumneko.lua', home)).toBe(true)
    expect(listInstalled(home).length).toBe(0)
  })

  it('extensionsRoot 落在 DSH 专属目录', () => {
    expect(extensionsRoot(home)).toBe(join(home, 'dsh-vscode-mode', 'extensions'))
  })
})

describe('lsp/providers 扩展源', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-extsrc-')) })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    clearExtensionProviders()
  })

  it('注册扩展源 → kind=extension 优先于自动发现', () => {
    registerExtensionProvider('lua', ['C:/fake/lua-language-server.exe'], undefined, '3.19.1')
    const spec = resolveLuaProvider({}, home)
    expect(spec.ready).toBe(true)
    expect(spec.kind).toBe('extension')
    expect(spec.argv[0]).toBe('C:/fake/lua-language-server.exe')
  })

  it('手动配置仍优先于扩展源', () => {
    registerExtensionProvider('lua', ['C:/fake/lua-language-server.exe'])
    const exe = join(home, 'my-lua.exe')
    writeFileSync(exe, 'x')
    const spec = resolveLuaProvider({ path: exe }, home)
    expect(spec.kind).toBe('manual')
  })

  it('clearExtensionProviders 注销', () => {
    registerExtensionProvider('lua', ['C:/fake/lua-language-server.exe'])
    clearExtensionProviders()
    const spec = resolveLuaProvider({}, home)
    expect(spec.kind).toBe('none')
  })
})

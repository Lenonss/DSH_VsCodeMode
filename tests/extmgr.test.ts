/**
 * dsh-vscode-mode tests — extmgr（VSIX 扩展管理）：zip 解压往返 /
 * VSIX 清单 / 安装·列表·卸载 / providers 扩展源优先级。
 * 作者 ddj 2026-08-27
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { modeOf, unzip, zipEntries } from '../src/lsp/zip.js'
import { applyExecBit, execModeOf, looksExec, vsixManifest, unpackVsix, installVsixBuffer, listInstalled, uninstall, extensionsRoot } from '../src/lsp/extmgr.js'
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

/** 极简 ZIP 构造器（stored + deflate + UTF-8 目录标记 + 可选 Unix mode），供 fixture 使用。 */
function buildZip(entries: { path: string; data?: string; mode?: number }[]): Buffer {
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
    // offset+38 = external attributes：Unix 把 st_mode 放在高 16 位（VS Code 解 VSIX 即读这里）
    if (e.mode !== undefined) cd.writeUInt32LE((e.mode & 0o7777) << 16, 38)
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

  it('modeOf：Unix mode 在高 16 位，0 与纯 DOS 位视为无 mode', () => {
    expect(modeOf(0o100755 << 16)).toBe(0o755)
    expect(modeOf(0o100644 << 16)).toBe(0o644)
    expect(modeOf(0)).toBeUndefined()
    expect(modeOf(0x20)).toBeUndefined() // 仅 DOS archive 位
  })

  it('解包保留归档自带执行位（macOS 语言服务器必现路径）', () => {
    const buf = buildZip([{ path: 'extension/server/bin/macOS/lua-language-server', data: 'bin', mode: 0o100755 }])
    const entry = unzip(buf).find((e) => !e.isDirectory)!
    expect(entry.mode).toBe(0o755)
  })
})

describe('lsp/extmgr 可执行位（POSIX 语言服务器启动前置）', () => {
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-extmode-')) })
  afterEach(() => { rmSync(home, { recursive: true, force: true }) })

  it('looksExec 只认确定语义的入口', () => {
    expect(looksExec('server/bin/macOS/lua-language-server')).toBe(true)
    expect(looksExec('extension/bin/LanguageServer/DotRush.dll')).toBe(true)
    expect(looksExec('scripts/install.sh')).toBe(true)
    expect(looksExec('README.md')).toBe(false)
    expect(looksExec('src/index.ts')).toBe(false)
  })

  it('execModeOf：有 mode 用 mode；无 mode 按启发式补 0o755；普通文件不动', () => {
    expect(execModeOf({ path: 'a/b', data: Buffer.alloc(0), isDirectory: false, mode: 0o700 })).toBe(0o700)
    expect(execModeOf({ path: 'server/bin/x', data: Buffer.alloc(0), isDirectory: false })).toBe(0o755)
    expect(execModeOf({ path: 'src/x.ts', data: Buffer.alloc(0), isDirectory: false })).toBeUndefined()
    expect(execModeOf({ path: 'server/bin/', data: Buffer.alloc(0), isDirectory: true })).toBeUndefined()
  })

  it('applyExecBit：win32 目标平台零行为（不碰文件）', () => {
    const file = join(home, 'lua-language-server')
    writeFileSync(file, 'bin')
    const before = statSync(file).mode & 0o777
    applyExecBit(file, { path: 'server/bin/lua-language-server', data: Buffer.alloc(0), isDirectory: false }, 'win32')
    expect(statSync(file).mode & 0o777).toBe(before)
  })

  // Windows 宿主的 chmod 改不了执行位，真实落盘断言仅在 POSIX 成立（CI 跑 ubuntu 即覆盖）
  it.skipIf(process.platform === 'win32')('applyExecBit：POSIX 落盘补执行位，普通文件不动', () => {
    const file = join(home, 'lua-language-server')
    writeFileSync(file, 'bin')
    applyExecBit(file, { path: 'server/bin/lua-language-server', data: Buffer.alloc(0), isDirectory: false }, 'darwin')
    expect(statSync(file).mode & 0o111, 'darwin 必须补上执行位').not.toBe(0)
    const plain = join(home, 'README.md')
    writeFileSync(plain, 'doc')
    const before = statSync(plain).mode & 0o777
    applyExecBit(plain, { path: 'README.md', data: Buffer.alloc(0), isDirectory: false }, 'darwin')
    expect(statSync(plain).mode & 0o777).toBe(before)
  })

  it('unpackVsix 解包后 macOS 服务器带执行位（Windows 打包 VSIX 无 mode 的兜底）', () => {
    const dest = join(home, 'ext')
    const vsix = buildZip([
      { path: 'extension/package.json', data: JSON.stringify({ name: 'lua', publisher: 'sumneko', version: '3.19.1' }) },
      { path: 'extension/server/bin/macOS/lua-language-server', data: 'bin' },
      { path: 'extension/server/bin/Linux/lua-language-server', data: 'bin' },
      { path: 'extension/README.md', data: '# Lua' },
    ])
    unpackVsix(vsix, dest)
    for (const plat of ['macOS', 'Linux']) {
      const bin = join(dest, 'server', 'bin', plat, 'lua-language-server')
      expect(existsSync(bin)).toBe(true)
      if (process.platform !== 'win32') {
        expect(statSync(bin).mode & 0o111, plat + ' 服务器缺执行位 → spawn EACCES').not.toBe(0)
      }
    }
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
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-extsrc-'))
    // 隔离真实机器扩展：只扫描临时 extensions 目录（DSH_LSP_EXT_DIRS 覆盖）
    process.env.DSH_LSP_EXT_DIRS = join(home, 'dsh-vscode-mode', 'extensions')
  })
  afterEach(() => {
    delete process.env.DSH_LSP_EXT_DIRS
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

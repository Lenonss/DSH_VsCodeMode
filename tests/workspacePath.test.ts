/**
 * lsp/uri.ts — toWorkspacePath 归一化回归测试。
 *
 * 背景：差异记录 rec.path 取自工具参数 file_path（**绝对路径**），而 LSP 文档键与
 * `server.sync()` 拼 file:// URI 的口径都是**工作区相对路径**。不归一化时绝对路径会被拼成
 * `<root>/<root>/Assets/...` 这种畸形 URI，服务器把它当成不存在的文档 → didOpen 落空 →
 * 引用/定义/hover/符号全部返回空（且无任何报错），表现为「引用查找没反应」。
 * 本文件锁定归一化契约，含最容易漏的 Windows 大小写不敏感路径。
 * 作者 ddj 2026-09-11
 */
import { describe, expect, it } from 'vitest'
import { posix, win32 } from 'node:path'
import { toWorkspacePath, isInside, isAbsolutePath } from '../src/lsp/uri.js'

const ROOT = 'D:/Work/PopIsland/IslandSplash_BugFix2'
const REL = 'Assets/Scripts/Lua/Module/Buff/Model/BuffModel.lua'

describe('isAbsolutePath 平台无关（CI 门槛平台的防回归）', () => {
  it('盘符路径在 Windows 与 Linux 语义下判定一致', () => {
    // 旧实现用 node:path.isAbsolute：win32 为 true，posix 为 false → CI(ubuntu) 上恒失败
    expect(win32.isAbsolute('D:/ws/x')).toBe(true)
    expect(posix.isAbsolute('D:/ws/x')).toBe(false)
    // 新实现与平台无关，两种语义下都必须为 true
    expect(isAbsolutePath('D:/ws/x')).toBe(true)
    expect(isAbsolutePath('D:\\ws\\x')).toBe(true)
    expect(isAbsolutePath('d:/ws/x')).toBe(true)
  })

  it('识别 UNC 与 POSIX 根，普通相对路径不误判', () => {
    expect(isAbsolutePath('//server/share/x')).toBe(true)
    expect(isAbsolutePath('/ws/x')).toBe(true)
    expect(isAbsolutePath('Assets/Scripts/a.lua')).toBe(false)
    expect(isAbsolutePath('a/b')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })

  it('裸盘符（无分隔符）不算绝对路径，避免误剥前缀', () => {
    expect(isAbsolutePath('D:')).toBe(false)
    expect(isAbsolutePath('D:a.lua')).toBe(false)
  })
})

describe('toWorkspacePath 归一化', () => {
  it('相对路径原样返回（快路径）', () => {
    expect(toWorkspacePath(ROOT, REL)).toBe(REL)
  })

  it('root 内的绝对路径（正斜杠）剥离为相对路径', () => {
    expect(toWorkspacePath(ROOT, ROOT + '/' + REL)).toBe(REL)
  })

  it('root 内的绝对路径（反斜杠，Windows 工具参数常见形态）剥离为相对路径', () => {
    expect(toWorkspacePath(ROOT, 'D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Assets\\Scripts\\Lua\\Module\\Buff\\Model\\BuffModel.lua')).toBe(REL)
  })

  it('大小写不一致仍能归一（Windows 盘符/目录名常见）', () => {
    expect(toWorkspacePath(ROOT, 'd:/work/popisland/islandsplash_bugfix2/' + REL)).toBe(REL)
  })

  it('root 尾部多余斜杠不影响归一', () => {
    expect(toWorkspacePath(ROOT + '/', ROOT + '/' + REL)).toBe(REL)
    expect(toWorkspacePath(ROOT + '///', ROOT + '/' + REL)).toBe(REL)
  })

  it('root 外的绝对路径原样返回（保持既有宽容行为）', () => {
    const outside = 'D:/Application/Tools/DeepSeekHarness/node_modules/x/client.js'
    expect(toWorkspacePath(ROOT, outside)).toBe(outside)
  })

  it('root 自身归为空串（等价于工作区根）', () => {
    expect(toWorkspacePath(ROOT, ROOT)).toBe('')
  })

  it('前缀相近但不同目录不被误判为 root 内（无边界误匹配）', () => {
    const sibling = ROOT + '-Other/Assets/a.lua'
    expect(toWorkspacePath(ROOT, sibling)).toBe(sibling)
  })

  it('空值/空 root 安全返回，不抛错', () => {
    expect(toWorkspacePath(ROOT, '')).toBe('')
    expect(toWorkspacePath('', ROOT + '/' + REL)).toBe(ROOT + '/' + REL)
  })

  it('幂等：归一化结果再次归一化不变', () => {
    const once = toWorkspacePath(ROOT, ROOT + '/' + REL)
    expect(toWorkspacePath(ROOT, once)).toBe(once)
  })
})

describe('isInside 边界（归一化依赖的前置判定）', () => {
  it('root 内为真、root 自身为真、root 外为假', () => {
    expect(isInside(ROOT, ROOT + '/' + REL)).toBe(true)
    expect(isInside(ROOT, ROOT)).toBe(true)
    expect(isInside(ROOT, 'D:/Elsewhere/a.lua')).toBe(false)
  })

  it('反斜杠混用也能正确判定', () => {
    expect(isInside(ROOT, 'D:\\Work\\PopIsland\\IslandSplash_BugFix2\\Assets\\a.lua')).toBe(true)
  })
})

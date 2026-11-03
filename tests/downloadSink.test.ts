/**
 * client downloadSink.ts 单测（目录选择器判定 + 相对路径写入）。
 * 覆盖：安全上下文/API 缺失判定、用户取消与拒绝的区分、权限二次请求、
 * 逐级建子目录、越界路径段过滤、写出后必须 close。
 * 作者 ddj 2026年11月03号
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canPickDirectory, pickSaveSink, writeFileToDir, type SinkDir } from '../src/client/downloadSink.js'

interface Written {
  path: string
  bytes: Uint8Array
}

/** 记录建目录/写文件调用顺序的假目录句柄。 */
interface FakeDir extends SinkDir {
  createdDirs: string[]
  written: Written[]
  closed: number
}

/**
 * 造一个假目录句柄（getDirectoryHandle 递归返回自身并记录名字）。
 * @param root 根句柄记录容器（子目录共享同一份记录）
 * @returns 假句柄
 */
function fakeDir(root: { createdDirs: string[]; written: Written[]; closed: number } = { createdDirs: [], written: [], closed: 0 }): FakeDir {
  const handle: FakeDir = {
    name: 'picked',
    createdDirs: root.createdDirs,
    written: root.written,
    get closed() {
      return root.closed
    },
    async getDirectoryHandle(name: string) {
      root.createdDirs.push(name)
      return handle
    },
    async getFileHandle(name: string) {
      root.createdDirs.push('file:' + name)
      return {
        async createWritable() {
          return {
            async write(bytes: Uint8Array) {
              root.written.push({ path: name, bytes })
            },
            async close() {
              root.closed += 1
            },
          }
        },
      }
    },
  }
  return handle
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canPickDirectory', () => {
  it('没有 showDirectoryPicker 时为假', () => {
    vi.stubGlobal('isSecureContext', true)
    expect(canPickDirectory()).toBe(false)
  })

  it('非安全上下文时为假（即便 API 存在）', () => {
    vi.stubGlobal('isSecureContext', false)
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    expect(canPickDirectory()).toBe(false)
  })

  it('安全上下文且 API 存在时为真', () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn())
    expect(canPickDirectory()).toBe(true)
  })
})

describe('pickSaveSink', () => {
  it('用户取消选择时返回 cancelled（整批中止，不回落）', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }))
    await expect(pickSaveSink()).resolves.toBe('cancelled')
  })

  it('选择器被拒绝（SecurityError）时回落浏览器下载', async () => {
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => {
      throw Object.assign(new Error('blocked'), { name: 'SecurityError' })
    }))
    await expect(pickSaveSink()).resolves.toEqual({ kind: 'browser', reason: 'denied' })
  })

  it('非安全上下文直接回落并给出 insecure 原因', async () => {
    vi.stubGlobal('isSecureContext', false)
    await expect(pickSaveSink()).resolves.toEqual({ kind: 'browser', reason: 'insecure' })
  })

  it('缺 API 时回落 unsupported', async () => {
    vi.stubGlobal('isSecureContext', true)
    await expect(pickSaveSink()).resolves.toEqual({ kind: 'browser', reason: 'unsupported' })
  })

  it('已授权 readwrite 时返回所选目录', async () => {
    const dir = fakeDir()
    dir.queryPermission = vi.fn(async () => 'granted')
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => dir))
    await expect(pickSaveSink()).resolves.toEqual({ kind: 'dir', dir })
    expect(dir.queryPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
  })

  it('权限为 prompt 时二次请求，取得授权后仍可用', async () => {
    const dir = fakeDir()
    dir.queryPermission = vi.fn(async () => 'prompt')
    dir.requestPermission = vi.fn(async () => 'granted')
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => dir))
    await expect(pickSaveSink()).resolves.toEqual({ kind: 'dir', dir })
    expect(dir.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' })
  })

  it('二次请求被拒时回落 denied', async () => {
    const dir = fakeDir()
    dir.queryPermission = vi.fn(async () => 'prompt')
    dir.requestPermission = vi.fn(async () => 'denied')
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('showDirectoryPicker', vi.fn(async () => dir))
    await expect(pickSaveSink()).resolves.toEqual({ kind: 'browser', reason: 'denied' })
  })
})

describe('writeFileToDir', () => {
  it('按相对路径逐级建目录并写出字节，写完 close', async () => {
    const dir = fakeDir()
    await writeFileToDir(dir, 'docs/sub/a.md', new Uint8Array([1, 2]))

    expect(dir.createdDirs).toEqual(['docs', 'sub', 'file:a.md'])
    expect(dir.written).toHaveLength(1)
    expect(Array.from(dir.written[0].bytes)).toEqual([1, 2])
    expect(dir.closed).toBe(1)
  })

  it('过滤空段与越界 .. 段，末段作文件名', async () => {
    const dir = fakeDir()
    await writeFileToDir(dir, '/../a//b.md', new Uint8Array([9]))

    expect(dir.createdDirs).toEqual(['a', 'file:b.md'])
  })

  it('兼容反斜杠分隔符', async () => {
    const dir = fakeDir()
    await writeFileToDir(dir, 'a\\b\\c.txt', new Uint8Array([1]))

    expect(dir.createdDirs).toEqual(['a', 'b', 'file:c.txt'])
  })

  it('全部段被过滤时退化为 download 文件名', async () => {
    const dir = fakeDir()
    await writeFileToDir(dir, '/../', new Uint8Array([7]))

    expect(dir.createdDirs).toEqual(['file:download'])
  })
})

/**
 * host /html-plan 附件落盘纯逻辑测试：slug 派生、文件名清洗、去重、落盘与指令片段。
 * @author ddj 2026年11月24号
 */
import { describe, expect, it } from 'vitest'
import {
  attachmentLines,
  formatBytes,
  safeFileName,
  slugFromTask,
  stageAttachments,
  uniqueFileName,
} from '../src/htmlPlanAttachments.js'

const FIXED = new Date(2026, 10, 24, 9, 22, 0)

describe('slugFromTask', () => {
  it('取任务里的 ASCII 词做 kebab，去掉虚词', () => {
    expect(slugFromTask('Add HTML plan attachments for composer')).toBe('html-plan-attachments-composer')
    expect(slugFromTask('Fix the attach flow')).toBe('fix-attach-flow')
  })

  it('没有可用词时用时间戳兜底（本地时间）', () => {
    expect(slugFromTask('完善html计划模式', FIXED)).toBe('attach-20261124-0922')
    expect(slugFromTask('', FIXED)).toBe('attach-20261124-0922')
  })

  it('结果只含小写字母、数字与连字符，长度受控', () => {
    const slug = slugFromTask('A'.repeat(120))
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug.length).toBeLessThanOrEqual(40)
  })
})

describe('safeFileName', () => {
  it('去掉目录、非法字符与首尾点，保留扩展名', () => {
    expect(safeFileName('C:\\tmp\\shot.png', 0, 'image', 'image/png')).toBe('shot.png')
    expect(safeFileName('a<b>c:"d?.txt', 0, 'file', 'text/plain')).toBe('abcd.txt')
    expect(safeFileName('  ..hidden..  ', 0, 'file', '')).toBe('hidden')
  })

  it('缺扩展名时按媒体类型补齐；无名字时兜底命名', () => {
    expect(safeFileName('report', 0, 'file', 'application/pdf')).toBe('report.pdf')
    expect(safeFileName('', 0, 'image', 'image/png')).toBe('image-1.png')
    expect(safeFileName('', 2, 'file', '')).toBe('file-3.bin')
  })

  it('避开 Windows 保留名，超长名保住扩展名', () => {
    expect(safeFileName('CON', 0, 'file', '')).toBe('_CON')
    const long = safeFileName('x'.repeat(120) + '.pdf', 0, 'file', 'application/pdf')
    expect(long.endsWith('.pdf')).toBe(true)
    expect(long.length).toBeLessThanOrEqual(80)
  })
})

describe('uniqueFileName', () => {
  it('同名加序号，大小写不敏感', () => {
    const used = new Set<string>()
    expect(uniqueFileName('shot.png', used)).toBe('shot.png')
    expect(uniqueFileName('shot.png', used)).toBe('shot-2.png')
    expect(uniqueFileName('SHOT.PNG', used)).toBe('SHOT-3.PNG')
    expect(uniqueFileName('noext', used)).toBe('noext')
    expect(uniqueFileName('noext', used)).toBe('noext-2')
  })
})

describe('formatBytes', () => {
  it('按 KB / MB 展示，非法值返回空串', () => {
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(2.1 * 1024 * 1024)).toBe('2.1 MB')
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(undefined)).toBe('')
  })
})

/** 造一个图片/文件内容块。 */
function blockOf(kind: 'image' | 'file', id: string, name: string, mediaType = '') {
  return { type: kind, attachment: { attachmentId: id, name, mediaType, bytes: 0 } }
}

describe('stageAttachments', () => {
  it('按提交顺序落盘，图片走 readImage、文件走 readFile', async () => {
    const writes: Array<{ path: string; size: number }> = []
    const result = await stageAttachments({
      blocks: [
        blockOf('image', 'i1', 'shot.png', 'image/png'),
        blockOf('file', 'f1', 'api.pdf', 'application/pdf'),
      ],
      slug: 'attach-x',
      readImage: async () => new Uint8Array([1, 2, 3]),
      readFile: async () => new Uint8Array([4, 5]),
      write: async (path, bytes) => { writes.push({ path, size: bytes.byteLength }) },
    })
    expect(result.dir).toBe('plans/attach-x/assets')
    expect(result.files.map((file) => file.relativePath)).toEqual([
      'plans/attach-x/assets/shot.png',
      'plans/attach-x/assets/api.pdf',
    ])
    expect(writes).toEqual([
      { path: 'plans/attach-x/assets/shot.png', size: 3 },
      { path: 'plans/attach-x/assets/api.pdf', size: 2 },
    ])
    expect(result.skipped).toEqual([])
  })

  it('超过单文件上限、超过数量上限、读字节失败都记进 skipped，不中断其它附件', async () => {
    const result = await stageAttachments({
      blocks: [
        blockOf('file', 'big', 'big.bin'),
        blockOf('file', 'bad', 'bad.bin'),
        blockOf('file', 'ok', 'ok.bin'),
        blockOf('file', 'extra', 'extra.bin'),
        blockOf('file', 'extra2', 'extra2.bin'),
      ],
      slug: 'attach-x',
      maxBytes: 10,
      maxCount: 2,
      readImage: async () => new Uint8Array(),
      readFile: async (ref) => {
        const id = (ref as { attachmentId: string }).attachmentId
        if (id === 'bad') throw new Error('存储损坏')
        return new Uint8Array(id === 'big' ? 20 : 1)
      },
      write: async () => {},
    })
    expect(result.files.map((file) => file.name)).toEqual(['ok.bin', 'extra.bin'])
    expect(result.skipped.map((item) => item.reason)).toEqual(['超过 10 B', '存储损坏', '超过 2 个附件上限'])
  })

  it('同一个 attachmentId 只落一次；非法块记 skipped', async () => {
    const result = await stageAttachments({
      blocks: [blockOf('file', 'same', 'a.txt'), blockOf('file', 'same', 'a.txt'), { type: 'text' }, null],
      slug: 'attach-x',
      readImage: async () => new Uint8Array(),
      readFile: async () => new Uint8Array([1]),
      write: async () => {},
    })
    expect(result.files).toHaveLength(1)
    expect(result.skipped).toHaveLength(2)
    expect(result.skipped[0].reason).toContain('不是可用的图片或文件引用')
  })

  it('同名附件自动加序号', async () => {
    const result = await stageAttachments({
      blocks: [blockOf('file', 'a', 'note.txt'), blockOf('file', 'b', 'note.txt')],
      slug: 'attach-x',
      readImage: async () => new Uint8Array(),
      readFile: async () => new Uint8Array([1]),
      write: async () => {},
    })
    expect(result.files.map((file) => file.name)).toEqual(['note.txt', 'note-2.txt'])
  })

  it('取消信号生效后不再继续处理', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await stageAttachments({
      blocks: [blockOf('file', 'a', 'note.txt')],
      slug: 'attach-x',
      signal: controller.signal,
      readImage: async () => new Uint8Array(),
      readFile: async () => new Uint8Array([1]),
      write: async () => {},
    })
    expect(result.files).toEqual([])
  })
})

describe('attachmentLines', () => {
  it('列出路径、类型、大小与页面写法；跳过的附件写明原因', () => {
    const lines = attachmentLines({
      slug: 'attach-x',
      dir: 'plans/attach-x/assets',
      files: [
        { name: 'shot.png', relativePath: 'plans/attach-x/assets/shot.png', bytes: 2048, kind: 'image' },
        { name: 'api.pdf', relativePath: 'plans/attach-x/assets/api.pdf', bytes: 2 * 1024 * 1024, kind: 'file' },
      ],
      skipped: [{ name: 'big.bin', reason: '超过 25.0 MB' }],
    }).join('\n')
    expect(lines).toContain('plans/attach-x/assets/shot.png（图片，2 KB）')
    expect(lines).toContain('plans/attach-x/assets/api.pdf（文件，2.0 MB）')
    expect(lines).toContain('<doc-attach')
    expect(lines).toContain('read_image')
    expect(lines).toContain('--keep-assets')
    expect(lines).toContain('big.bin：超过 25.0 MB')
  })

  it('没有附件时返回空数组', () => {
    expect(attachmentLines({ slug: 'x', dir: 'plans/x/assets', files: [], skipped: [] })).toEqual([])
  })
})

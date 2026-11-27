/**
 * 宿主 UI 材料落盘测试：路径边界、原始文件、尺寸、清单、去重、送达状态。
 * @author ddj 2026年11月26号
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMaterialsPage } from '../src/uiIntakePage.js'
import { saveIntakeSubmission, latestIntakeSubmission, markIntakeSent, savedNameOf, imageInfoOf } from '../src/uiIntakeStore.js'
import { parseIntakePageConfig } from '../src/shared/uiIntake.js'

const created: string[] = []
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

/** 造一个带 config 的临时项目并生成材料页。 */
async function projectWithPage(): Promise<{ root: string; pagePath: string; token: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ui-intake-store-'))
  created.push(root)
  await mkdir(join(root, '.dsh', 'ui-kit'), { recursive: true })
  await writeFile(join(root, '.dsh', 'ui-kit', 'config.json'), JSON.stringify({
    v: 1,
    ui: { system: 'ugui', refResolution: [1080, 2400], matchMode: 'width', bindStyle: 'componentName', commonDir: 'Assets/UI/Common' },
    assets: { inProject: 'Assets/GameData' },
    pages: { dir: 'plans/ui' },
  }), 'utf8')
  const page = await createMaterialsPage({ cwd: root, slug: 'gift-popup', title: '礼包弹窗' })
  expect(page.ok, page.error).toBe(true)
  const config = parseIntakePageConfig(await readFile(join(root, ...String(page.pagePath).split('/')), 'utf8'))
  expect(config).not.toBeNull()
  return { root, pagePath: config!.pagePath, token: config!.token }
}

/** 造一张只带 PNG 头的图片（宿主只读头，不解码像素）。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/** 固定表单。 */
function formOf(title = '礼包弹窗') {
  return {
    title,
    width: 1080,
    height: 2400,
    notes: '列表滚动，底部按钮固定',
    targetPrefab: 'Assets/UI/GiftPopup.prefab',
    mockPath: '',
    assetPaths: 'Assets/GameData/Atlas/UI',
    sprites: 'btn_close\nbg_gift',
  }
}

describe('savedNameOf', () => {
  it('保留中文原名、去路径、同名加序号', () => {
    const used = new Set<string>()
    expect(savedNameOf('C:\\tmp\\礼包 图.png', 'image/png', used)).toBe('礼包 图.png')
    expect(savedNameOf('礼包 图.png', 'image/png', used)).toBe('礼包 图-2.png')
    expect(savedNameOf('CON', 'image/png', used)).toBe('_CON.png')
    expect(savedNameOf('', 'image/webp', used)).toBe('image.webp')
  })
})

describe('imageInfoOf', () => {
  it('读 PNG 尺寸；类型不符/坏字节拒绝', () => {
    const info = imageInfoOf(pngBytes(8, 12), 'image/png')
    expect(info.ok).toBe(true)
    if (info.ok) expect([info.info.width, info.info.height, info.info.mediaType]).toEqual([8, 12, 'image/png'])
    expect(imageInfoOf(pngBytes(8, 12), 'image/jpeg').ok).toBe(false)
    expect(imageInfoOf(new Uint8Array([1, 2, 3]), 'image/png').ok).toBe(false)
  })
})

describe('saveIntakeSubmission', () => {
  it('保存原始图片、原始文件名、尺寸、表单与可追踪清单', async () => {
    const { root, pagePath, token } = await projectWithPage()
    const bytes = pngBytes(8, 12)
    const result = await saveIntakeSubmission({
      projectRoot: root,
      sessionId: 'session-1',
      pagePath,
      token,
      submissionId: 'sub-12345678',
      form: formOf(),
      files: [{ role: 'mock', originalName: '效果 图 中文.png', mediaType: 'image/png', bytes }],
    })
    expect(result.ok, result.ok ? '' : result.error).toBe(true)
    if (!result.ok) return
    expect(result.manifestPath).toBe('plans/ui/gift-popup/intake/submissions/sub-12345678/request.json')
    const manifest = JSON.parse(await readFile(join(root, ...result.manifestPath.split('/')), 'utf8'))
    expect(manifest.v).toBe(2)
    expect(manifest.kind).toBe('ui-builder-intake')
    expect(manifest.screen).toEqual({ w: 1080, h: 2400 })
    expect(manifest.notes).toContain('滚动')
    expect(manifest.assets[0].originalName).toBe('效果 图 中文.png')
    expect(manifest.assets[0].savedName).toBe('效果 图 中文.png')
    expect(manifest.assets[0].width).toBe(8)
    expect(manifest.assets[0].height).toBe(12)
    expect(manifest.assets[0].bytes).toBe(bytes.byteLength)
    expect(manifest.page.path).toBe(pagePath)
    expect(manifest.page.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.message).toContain('/ui-builder 继续设计')
    expect(manifest.message).toContain(result.manifestPath)
    const saved = await readFile(join(root, ...manifest.assets[0].relativePath.split('/')))
    expect(Array.from(saved)).toEqual(Array.from(bytes))
  })

  it('同内容重复提交复用旧清单，不新增目录', async () => {
    const { root, pagePath, token } = await projectWithPage()
    const input = {
      projectRoot: root,
      sessionId: 'session-1',
      pagePath,
      token,
      form: formOf(),
      files: [{ role: 'material' as const, originalName: '按钮.png', mediaType: 'image/png', bytes: pngBytes(4, 4) }],
    }
    const first = await saveIntakeSubmission({ ...input, submissionId: 'sub-first-0001' })
    expect(first.ok).toBe(true)
    const second = await saveIntakeSubmission({ ...input, submissionId: 'sub-second-002' })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.duplicate).toBe(true)
    expect(second.submissionId).toBe('sub-first-0001')
    const entries = await readdir(join(root, 'plans', 'ui', 'gift-popup', 'intake', 'submissions'))
    expect(entries.filter((name) => !name.startsWith('.'))).toEqual(['sub-first-0001'])
  })

  it('拒绝错误令牌、越界页面路径、坏图片与超量文件', async () => {
    const { root, pagePath, token } = await projectWithPage()
    const base = {
      projectRoot: root,
      sessionId: 'session-1',
      pagePath,
      submissionId: 'sub-bad-00001',
      form: formOf(),
    }
    expect((await saveIntakeSubmission({ ...base, token: 'b'.repeat(32), files: [] })).ok).toBe(false)
    expect((await saveIntakeSubmission({ ...base, token, pagePath: 'plans/ui/../outside/intake/materials.html', files: [] })).ok).toBe(false)
    expect((await saveIntakeSubmission({
      ...base,
      token,
      files: [{ role: 'mock', originalName: 'x.png', mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    })).ok).toBe(false)
    const many = Array.from({ length: 51 }, (_, index) => ({
      role: 'material' as const,
      originalName: 'x' + index + '.png',
      mediaType: 'image/png',
      bytes: pngBytes(1, 1),
    }))
    expect((await saveIntakeSubmission({ ...base, token, files: many })).ok).toBe(false)
  })

  it('latest 读回最近提交，markSent 写入送达状态', async () => {
    const { root, pagePath, token } = await projectWithPage()
    const saved = await saveIntakeSubmission({
      projectRoot: root,
      sessionId: 'session-1',
      pagePath,
      token,
      submissionId: 'sub-latest-001',
      form: formOf('邮件弹窗'),
      files: [{ role: 'mock', originalName: '邮件.png', mediaType: 'image/png', bytes: pngBytes(6, 7) }],
    })
    expect(saved.ok).toBe(true)
    const latest = await latestIntakeSubmission({ projectRoot: root, pagePath, token })
    expect(latest.ok).toBe(true)
    expect(latest.found).toBe(true)
    expect(latest.submissionId).toBe('sub-latest-001')
    expect(latest.form?.title).toBe('邮件弹窗')
    expect(latest.assets?.[0].width).toBe(6)
    const marked = await markIntakeSent({ projectRoot: root, pagePath, token, submissionId: 'sub-latest-001', confirmed: true })
    expect(marked.ok).toBe(true)
    const again = await latestIntakeSubmission({ projectRoot: root, pagePath, token })
    expect(again.sentAt).toBeTruthy()
    expect(again.sentConfirmed).toBe(true)
  })
})

/**
 * 宿主材料页生成测试：项目根探测、config 默认值、复用/覆盖、模板注入。
 * @author ddj 2026年11月26号
 */
import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createMaterialsPage,
  defaultsOfConfig,
  intakeRuntimeDirs,
  projectRootOf,
  renderIntakePage,
} from '../src/uiIntakePage.js'
import { parseIntakePageConfig } from '../src/shared/uiIntake.js'

const created: string[] = []
afterAll(async () => {
  for (const dir of created) await rm(dir, { recursive: true, force: true })
})

/** 临时项目目录。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

describe('projectRootOf', () => {
  it('优先 config，其次 .git，最后会话目录', async () => {
    const root = await tempDir('ui-intake-root-')
    await mkdir(join(root, '.dsh', 'ui-kit'), { recursive: true })
    await writeFile(join(root, '.dsh', 'ui-kit', 'config.json'), '{}', 'utf8')
    await mkdir(join(root, 'sub', 'deep'), { recursive: true })
    const exists = async (path: string): Promise<boolean> => {
      try { await stat(path); return true } catch { return false }
    }
    const found = await projectRootOf(join(root, 'sub', 'deep'), exists)
    expect(found.root.replace(/\\/g, '/')).toBe(root.replace(/\\/g, '/'))
    expect(found.source).toBe('.dsh/ui-kit/config.json')

    const repo = await tempDir('ui-intake-git-')
    await mkdir(join(repo, '.git'), { recursive: true })
    const git = await projectRootOf(repo, exists)
    expect(git.source).toBe('.git')
  })
})

describe('defaultsOfConfig', () => {
  it('读取尺寸/UI/素材/设计目录；缺失时给默认并告警', () => {
    const { defaults, warnings } = defaultsOfConfig({
      ui: { system: 'ugui', refResolution: [1080, 2400], matchMode: 'width', bindStyle: 'componentName' },
      assets: { inProject: 'Assets/GameData' },
      pages: { dir: 'plans/ui' },
    })
    expect(defaults.screen).toEqual({ w: 1080, h: 2400 })
    expect(defaults.pagesDir).toBe('plans/ui')
    expect(defaults.ui.system).toBe('ugui')
    expect(defaults.assets.inProject).toBe('Assets/GameData')
    expect(warnings).toEqual([])
    const fallback = defaultsOfConfig({})
    expect(fallback.defaults.screen).toEqual({ w: 1080, h: 1920 })
    expect(fallback.warnings.length).toBeGreaterThan(0)
  })

  it('runtime 目录项目优先、母版兜底', async () => {
    const root = await tempDir('ui-intake-runtime-')
    const dirs = intakeRuntimeDirs(root)
    expect(dirs[0].replace(/\\/g, '/')).toContain('/.dsh/skills/ui-builder/runtime/intake')
    expect(dirs[dirs.length - 1].replace(/\\/g, '/')).toContain('/dsh-vscodemode-ui-kit/runtime/intake')
  })
})

describe('renderIntakePage', () => {
  it('缺占位符抛错；注入后的 < 被转义', () => {    expect(() => renderIntakePage('<html></html>', {
      token: 'a'.repeat(32),
      pagePath: 'plans/ui/x/intake/materials.html',
      slug: 'x',
      pagesDir: 'plans/ui',
      projectRoot: 'D:/P',
      title: '',
      screen: { w: 1, h: 1 },
      ui: {},
      assets: {},
      limits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1, maxPixels: 1, maxSide: 1, mediaTypes: [] },
      createdAt: '',
    })).toThrow()
    const html = renderIntakePage('<script id="dsh-ui-intake-config">__DSH_UI_INTAKE_CONFIG__</script>', {
      token: 'a'.repeat(32),
      pagePath: 'plans/ui/x/intake/materials.html',
      slug: 'x',
      pagesDir: 'plans/ui',
      projectRoot: 'D:/P',
      title: '<b>x</b>',
      screen: { w: 1, h: 1 },
      ui: {},
      assets: {},
      limits: { maxFiles: 1, maxFileBytes: 1, maxTotalBytes: 1, maxPixels: 1, maxSide: 1, mediaTypes: [] },
      createdAt: '',
    })
    expect(html).toContain('\\u003cb\\u003e')
    expect(html).not.toContain('</script></script>')
  })

  it('真实母版模板自包含、带提交与降级提示，注入后配置可读回', () => {
    const template = readFileSync(join(process.cwd(), 'skills/dsh-vscodemode-ui-kit/runtime/intake/materials.html'), 'utf8')
    expect(template).toContain('__DSH_UI_INTAKE_CONFIG__')
    expect(template).toContain('提交并继续设计')
    expect(template).toContain('未连接（仍在重试）')
    expect(template).not.toMatch(/<link\b[^>]*href=/i)
    expect(template).not.toMatch(/<script\b[^>]*src=/i)
    expect(template).not.toMatch(/https?:\/\//i)
    const page = renderIntakePage(template, {
      token: 'a'.repeat(32),
      pagePath: 'plans/ui/gift-popup/intake/materials.html',
      slug: 'gift-popup',
      pagesDir: 'plans/ui',
      projectRoot: 'D:/P',
      title: '',
      screen: { w: 1080, h: 2400 },
      ui: {},
      assets: {},
      limits: { maxFiles: 50, maxFileBytes: 1, maxTotalBytes: 1, maxPixels: 1, maxSide: 1, mediaTypes: ['image/png'] },
      createdAt: '2026-11-26T00:00:00.000Z',
    })
    expect(page).not.toContain('__DSH_UI_INTAKE_CONFIG__')
    expect(parseIntakePageConfig(page)?.slug).toBe('gift-popup')
  })
})

describe('createMaterialsPage', () => {
  it('生成页面并读回配置；再次调用复用 token；overwrite 换新 token', async () => {
    const root = await tempDir('ui-intake-page-')
    await mkdir(join(root, '.dsh', 'ui-kit'), { recursive: true })
    await writeFile(join(root, '.dsh', 'ui-kit', 'config.json'), JSON.stringify({
      ui: { system: 'ugui', refResolution: [1080, 2400], matchMode: 'width', bindStyle: 'componentName' },
      pages: { dir: 'plans/ui' },
    }), 'utf8')
    const first = await createMaterialsPage({ cwd: root, slug: 'gift-popup', title: '礼包' })
    expect(first.ok, first.error).toBe(true)
    if (!first.ok) return
    expect(first.pagePath).toBe('plans/ui/gift-popup/intake/materials.html')
    const config = parseIntakePageConfig(await readFile(join(root, ...first.pagePath.split('/')), 'utf8'))
    expect(config?.screen).toEqual({ w: 1080, h: 2400 })
    expect(config?.title).toBe('礼包')
    const second = await createMaterialsPage({ cwd: root, slug: 'gift-popup' })
    expect(second.ok && second.existing).toBe(true)
    const secondConfig = parseIntakePageConfig(await readFile(join(root, ...second.pagePath!.split('/')), 'utf8'))
    expect(secondConfig?.token).toBe(config?.token)
    const third = await createMaterialsPage({ cwd: root, slug: 'gift-popup', overwrite: true })
    expect(third.ok && !third.existing).toBe(true)
    const thirdConfig = parseIntakePageConfig(await readFile(join(root, ...third.pagePath!.split('/')), 'utf8'))
    expect(thirdConfig?.token).not.toBe(config?.token)
  })

  it('缺 config 仍生成页面并告警，使用默认尺寸', async () => {
    const root = await tempDir('ui-intake-plain-')
    const result = await createMaterialsPage({ cwd: root, slug: 'plain-ui' })
    expect(result.ok, result.error).toBe(true)
    expect(result.warnings?.length).toBeGreaterThan(0)
    if (!result.ok) return
    const config = parseIntakePageConfig(await readFile(join(root, ...result.pagePath!.split('/')), 'utf8'))
    expect(config?.screen).toEqual({ w: 1080, h: 1920 })
  })

  it('非法 slug 拒绝', async () => {
    const root = await tempDir('ui-intake-bad-')
    const result = await createMaterialsPage({ cwd: root, slug: '../Bad' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('slug')
  })
})

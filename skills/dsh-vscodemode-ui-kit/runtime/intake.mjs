#!/usr/bin/env node
/**
 * ui-kit intake：生成空白 UI 材料页（与插件宿主工具同一模板/配置/限制）。
 *
 *   node intake.mjs --slug <slug> [--title <界面名>] [--project <项目根>] [--overwrite]
 *   node intake.mjs --selftest
 *
 * 默认写到 `<项目>/<pagesDir>/<slug>/intake/materials.html`；已存在时默认复用原页面
 * 与令牌，避免把用户正在填写的页面换掉。插件内的 `ui_builder_intake` 工具走同一套规则。
 * @author ddj 2026年11月26号
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATE_PATH = join(HERE, 'intake', 'materials.html')
const LIMITS_PATH = join(HERE, 'intake', 'limits.json')
const CONFIG_ID = 'dsh-ui-intake-config'
const PLACEHOLDER = '__DSH_UI_INTAKE_CONFIG__'
const DEFAULT_PAGES_DIR = 'plans/ui'
const DEFAULT_SCREEN = [1080, 1920]
const DEFAULT_LIMITS = {
  maxFiles: 50,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxPixels: 40_000_000,
  maxSide: 10_000,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/

/** 读 JSON；失败返回 null。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return null
  }
}

/** 归一化相对目录（/ 分隔，拒绝绝对路径与 ..）。 */
export function normalizeRel(value) {
  if (typeof value !== 'string') return null
  const raw = value.trim().replace(/\\/g, '/')
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return null
  const parts = []
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') return null
    parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

/** 判断路径 child 是否在 parent 下（Windows 盘符大小写不敏感）。 */
function under(parent, child) {
  const a = parent.replace(/\\/g, '/').replace(/\/+$/, '')
  const b = child.replace(/\\/g, '/').replace(/\/+$/, '')
  const fold = (value) => (/^[a-z]:\//i.test(value) ? value.toLowerCase() : value)
  return fold(b) === fold(a) || fold(b).startsWith(fold(a) + '/')
}

/** 向上找项目根：config > .git > 会话目录。 */
export function projectRootOf(cwd) {
  const start = resolve(cwd)
  let dir = start
  let gitRoot = null
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(dir, '.dsh', 'ui-kit', 'config.json'))) return dir.replace(/\\/g, '/')
    if (gitRoot === null && existsSync(join(dir, '.git'))) gitRoot = dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return (gitRoot ?? start).replace(/\\/g, '/')
}

/** 项目 config → 页面默认值。 */
export function defaultsOf(config) {
  const ui = config && typeof config.ui === 'object' && config.ui ? config.ui : {}
  const assets = config && typeof config.assets === 'object' && config.assets ? config.assets : {}
  const pages = config && typeof config.pages === 'object' && config.pages ? config.pages : {}
  const screen = Array.isArray(ui.refResolution) && ui.refResolution.length === 2 &&
    Number.isInteger(Number(ui.refResolution[0])) && Number.isInteger(Number(ui.refResolution[1])) &&
    Number(ui.refResolution[0]) > 0 && Number(ui.refResolution[1]) > 0
    ? [Number(ui.refResolution[0]), Number(ui.refResolution[1])]
    : DEFAULT_SCREEN.slice()
  return {
    pagesDir: normalizeRel(pages.dir) ?? DEFAULT_PAGES_DIR,
    screen: { w: screen[0], h: screen[1] },
    ui: {
      system: typeof ui.system === 'string' && ui.system ? ui.system : 'other',
      bindStyle: typeof ui.bindStyle === 'string' && ui.bindStyle ? ui.bindStyle : 'componentName',
      commonDir: typeof ui.commonDir === 'string' && ui.commonDir ? ui.commonDir : 'Assets/UI/Common',
      matchMode: typeof ui.matchMode === 'string' && ui.matchMode ? ui.matchMode : 'width',
    },
    assets: {
      inProject: typeof assets.inProject === 'string' ? assets.inProject : '',
      artRoot: typeof assets.artRoot === 'string' ? assets.artRoot : '',
    },
  }
}

/** 读限制文件，缺省用内置默认。 */
export function limitsOf(path = LIMITS_PATH) {
  const raw = readJson(path)
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_LIMITS, mediaTypes: DEFAULT_LIMITS.mediaTypes.slice() }
  const positive = (key) => {
    const value = Number(raw[key])
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_LIMITS[key]
  }
  return {
    maxFiles: positive('maxFiles'),
    maxFileBytes: positive('maxFileBytes'),
    maxTotalBytes: positive('maxTotalBytes'),
    maxPixels: positive('maxPixels'),
    maxSide: positive('maxSide'),
    mediaTypes: Array.isArray(raw.mediaTypes) && raw.mediaTypes.length
      ? raw.mediaTypes.filter((item) => typeof item === 'string')
      : DEFAULT_LIMITS.mediaTypes.slice(),
  }
}

/** 页面配置对象。 */
export function buildPageConfig(options) {
  return {
    token: options.token,
    pagePath: options.pagePath,
    slug: options.slug,
    pagesDir: options.pagesDir,
    projectRoot: options.projectRoot,
    title: options.title || '',
    targetPrefab: options.targetPrefab || '',
    screen: options.screen,
    ui: options.ui,
    assets: options.assets,
    limits: options.limits,
    createdAt: options.createdAt || new Date().toISOString(),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.taskId ? { taskId: options.taskId } : {}),
  }
}

/** 把配置注入模板（< 转义，避免提前闭合 script）。 */
export function renderIntakePage(template, config) {
  if (!template.includes(PLACEHOLDER)) throw new Error('材料页模板缺少 ' + PLACEHOLDER + ' 占位符')
  const json = JSON.stringify(config, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
  return template.split(PLACEHOLDER).join(json)
}

/** 从页面文本读回配置（只做最小校验）。 */
export function readPageConfig(html) {
  const match = new RegExp('<script[^>]*\\bid=["\']' + CONFIG_ID + '["\'][^>]*>([\\s\\S]*?)</script>', 'i').exec(String(html || ''))
  if (!match) return null
  let raw
  try {
    raw = JSON.parse(match[1])
  } catch (error) {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.token !== 'string' || typeof raw.pagePath !== 'string' || typeof raw.slug !== 'string') return null
  return raw
}

/**
 * 生成（或复用）材料页。
 * @author ddj 2026年11月26号
 * @param {{cwd?: string, slug: string, title?: string, overwrite?: boolean, now?: Date}} options
 * @returns {{ok: boolean, pagePath?: string, absolutePath?: string, projectRoot?: string, existing?: boolean, token?: string, warnings: string[], error?: string}}
 */
export function createIntakePage(options) {
  const warnings = []
  const slug = String(options.slug || '').trim()
  if (!SLUG_RE.test(slug)) return { ok: false, warnings, error: 'slug 必须是小写字母、数字与短横线组成的短标识（1~64 位）' }
  const projectRoot = projectRootOf(options.cwd || process.cwd())
  const configPath = join(projectRoot, '.dsh', 'ui-kit', 'config.json')
  let config = {}
  if (existsSync(configPath)) {
    config = readJson(configPath) || {}
    if (!readJson(configPath)) warnings.push('项目 config.json 解析失败，材料页使用默认值')
  } else {
    warnings.push('未找到项目 config.json，材料页使用默认值')
  }
  const defaults = defaultsOf(config)
  const pagePath = defaults.pagesDir + '/' + slug + '/intake/materials.html'
  const absolutePath = join(projectRoot, ...pagePath.split('/'))
  if (!under(projectRoot, absolutePath)) return { ok: false, warnings, error: '材料页路径越界' }

  if (existsSync(absolutePath) && options.overwrite !== true) {
    const current = readPageConfig(readFileSync(absolutePath, 'utf8'))
    if (!current || current.slug !== slug || current.pagePath !== pagePath) {
      return { ok: false, warnings, error: '已有材料页但配置无法读取；换 slug 或加 --overwrite 重建' }
    }
    return {
      ok: true,
      pagePath,
      absolutePath: absolutePath.replace(/\\/g, '/'),
      projectRoot,
      existing: true,
      token: current.token,
      warnings: [...warnings, '材料页已存在，已复用原页面与令牌'],
    }
  }

  let template
  try {
    template = readFileSync(TEMPLATE_PATH, 'utf8')
  } catch (error) {
    return { ok: false, warnings, error: '找不到材料页模板：' + String(error) }
  }
  const pageConfig = buildPageConfig({
    token: randomBytes(16).toString('hex'),
    pagePath,
    slug,
    pagesDir: defaults.pagesDir,
    projectRoot,
    title: String(options.title || '').slice(0, 120),
    targetPrefab: String(options.targetPrefab || '').slice(0, 512),
    screen: defaults.screen,
    ui: defaults.ui,
    assets: defaults.assets,
    limits: limitsOf(),
    createdAt: (options.now || new Date()).toISOString(),
  })
  const html = renderIntakePage(template, pageConfig)
  try {
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, html, 'utf8')
  } catch (error) {
    return { ok: false, warnings, error: '材料页写入失败：' + String(error) }
  }
  return {
    ok: true,
    pagePath,
    absolutePath: absolutePath.replace(/\\/g, '/'),
    projectRoot,
    existing: false,
    token: pageConfig.token,
    warnings,
  }
}

/** 自检：临时项目里生成、复用、覆盖、缺 config 的默认值。 */
function selftest() {
  const root = join(tmpdir(), 'ui-intake-selftest-' + randomBytes(4).toString('hex'))
  const plain = join(tmpdir(), 'ui-intake-plain-' + randomBytes(4).toString('hex'))
  let passed = 0
  try {
    mkdirSync(join(root, '.dsh', 'ui-kit'), { recursive: true })
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(root, '.dsh', 'ui-kit', 'config.json'), JSON.stringify({
      v: 1,
      ui: { system: 'ugui', refResolution: [1080, 2400], matchMode: 'width', bindStyle: 'componentName', commonDir: 'Assets/UI/Common' },
      assets: { inProject: 'Assets/GameData' },
      pages: { dir: 'plans/ui' },
    }), 'utf8')
    const first = createIntakePage({ cwd: root, slug: 'check-ui', title: '检查页', now: new Date('2026-11-26T00:00:00Z') })
    if (!first.ok || !existsSync(join(first.absolutePath))) throw new Error('生成失败')
    const config = readPageConfig(readFileSync(first.absolutePath, 'utf8'))
    if (!config || config.screen.w !== 1080 || config.screen.h !== 2400 || config.token.length !== 32) throw new Error('配置注入失败')
    passed += 1
    const second = createIntakePage({ cwd: root, slug: 'check-ui' })
    if (!second.ok || !second.existing || second.token !== first.token) throw new Error('复用失败')
    passed += 1
    const third = createIntakePage({ cwd: root, slug: 'check-ui', overwrite: true })
    if (!third.ok || third.existing || third.token === first.token) throw new Error('覆盖失败')
    passed += 1
    const missing = createIntakePage({ cwd: plain, slug: 'no-config' })
    if (!missing.ok || !missing.warnings.length) throw new Error('缺 config 降级失败')
    const missingConfig = readPageConfig(readFileSync(missing.absolutePath, 'utf8'))
    if (missingConfig.screen.w !== 1080 || missingConfig.screen.h !== 1920) throw new Error('默认尺寸错误')
    passed += 1
    if (createIntakePage({ cwd: root, slug: 'Bad Slug' }).ok) throw new Error('非法 slug 未拒绝')
    passed += 1
    if (createIntakePage({ cwd: root, slug: 'check-ui' }).pagePath !== 'plans/ui/check-ui/intake/materials.html') throw new Error('页面路径错误')
    passed += 1
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(plain, { recursive: true, force: true })
  }
  console.log('UI intake selftest: ' + passed + '/6 passed')
}

/** 项目事实：根、config、默认值。 */
function projectFacts(project) {
  const root = projectRootOf(project || process.cwd())
  const configPath = join(root, '.dsh', 'ui-kit', 'config.json')
  const config = existsSync(configPath) ? (readJson(configPath) || {}) : {}
  return { root, config, defaults: defaultsOf(config) }
}

/** 页面相对路径。 */
function pageRelOf(defaults, slug) {
  return defaults.pagesDir + '/' + slug + '/intake/materials.html'
}

/** 读已有页面配置；损坏返回 null。 */
function existingPageOf(pageAbs) {
  if (!existsSync(pageAbs)) return null
  const config = readPageConfig(readFileSync(pageAbs, 'utf8'))
  return config && config.slug ? config : null
}

/** 启动本机材料服务并生成页面。 */
async function serve(args) {
  const facts = projectFacts(args.project)
  const slug = String(args.slug || '').trim()
  if (!SLUG_RE.test(slug)) throw new Error('slug 必须是小写字母、数字与短横线组成的短标识（1~64 位）')
  const pagePath = pageRelOf(facts.defaults, slug)
  const pageAbs = join(facts.root, ...pagePath.split('/'))
  const planAbs = join(facts.root, ...(facts.defaults.pagesDir + '/' + slug + '/plan.html').split('/'))
  const existing = existingPageOf(pageAbs)
  if (existing && !args.resume && !args.overwrite) {
    throw new Error('材料页已存在。要恢复草稿与服务用 --resume；要重建材料页用 --overwrite。')
  }
  if (args.overwrite && existsSync(planAbs)) {
    throw new Error('已有正式设计稿 ' + planAbs.replace(/\\/g, '/') + '，不能覆盖；请换 slug。')
  }
  if (existsSync(planAbs) && !existing) {
    throw new Error('该 slug 已有正式设计稿 ' + planAbs.replace(/\\/g, '/') + '；请换 slug，材料页不会覆盖设计稿。')
  }
  if (existing && args.resume && existing.transport !== 'local') {
    throw new Error('现有材料页不是本机服务模式，无法恢复；换 slug 或显式 --overwrite。')
  }
  if (existing && args.overwrite) {
    // 只覆盖材料页；正式设计稿与已提交材料另由路径检查保护。
  }
  const token = existing && !args.overwrite ? existing.token : randomBytes(32).toString('hex')
  const screen = args.width && args.height
    ? { w: args.width, h: args.height }
    : existing?.screen || facts.defaults.screen
  const { startIntakeServer, writeServicePage, readServiceState, stopIntakeService } = await import('./intake/server.mjs')
  const state = readServiceState(facts.root, slug, facts.defaults.pagesDir)
  if (args.overwrite && state && state.status === 'running') await stopIntakeService(facts.root, slug, facts.defaults.pagesDir)
  if (state?.status === 'running' && existing && args.resume) {
    console.log('UI_INTAKE_URL=' + state.url)
    console.log('UI_INTAKE_PAGE=' + pageAbs.replace(/\\/g, '/'))
    console.log('UI_INTAKE_TASK=' + state.taskId)
    console.log('UI_INTAKE_STATE=' + join(facts.root, ...(facts.defaults.pagesDir + '/' + slug + '/intake/service.json').split('/')).replace(/\\/g, '/'))
    return
  }
  let run
  const preferred = Number(args.port) || (state && Number(state.port)) || 0
  try {
    run = await startIntakeServer({
      projectRoot: facts.root,
      slug,
      pagesDir: facts.defaults.pagesDir,
      token,
      port: preferred,
      ui: facts.defaults.ui,
      assets: facts.defaults.assets,
      screen,
      title: args.title || existing?.title || '',
      pagePath,
    })
  } catch (error) {
    if (!preferred) throw error
    console.log('WARN 端口 ' + preferred + ' 不可用，改用随机端口：' + String(error && error.message ? error.message : error))
    run = await startIntakeServer({
      projectRoot: facts.root,
      slug,
      pagesDir: facts.defaults.pagesDir,
      token,
      port: 0,
      ui: facts.defaults.ui,
      assets: facts.defaults.assets,
      screen,
      title: args.title || existing?.title || '',
      pagePath,
    })
  }
  writeServicePage({
    projectRoot: facts.root,
    slug,
    pagesDir: facts.defaults.pagesDir,
    token,
    endpoint: 'http://127.0.0.1:' + run.port,
    pagePath,
    taskId: run.taskId,
    title: args.title || existing?.title || '',
    targetPrefab: args.prefab || existing?.targetPrefab || '',
    screen,
    ui: facts.defaults.ui,
    assets: facts.defaults.assets,
    previous: existing,
  })
  const statePath = join(facts.root, ...(facts.defaults.pagesDir + '/' + slug + '/intake/service.json').split('/'))
  console.log('UI_INTAKE_URL=' + run.url)
  console.log('UI_INTAKE_PAGE=' + pageAbs.replace(/\\/g, '/'))
  console.log('UI_INTAKE_REL=' + pagePath)
  console.log('UI_INTAKE_SLUG=' + slug)
  console.log('UI_INTAKE_TASK=' + run.taskId)
  console.log('UI_INTAKE_STATE=' + statePath.replace(/\\/g, '/'))
  console.log('UI_INTAKE_PORT=' + run.port)
  const stop = () => run.server.close()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await run.closed
}

/** CLI 参数解析。 */
function parseArgs(argv) {
  const out = { slug: '', title: '', prefab: '', project: '', port: 0, width: 0, height: 0, overwrite: false, resume: false, serve: false, stop: false, status: false, selftest: false, selftestHttp: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--slug') out.slug = argv[++index] || ''
    else if (arg === '--title') out.title = argv[++index] || ''
    else if (arg === '--prefab') out.prefab = argv[++index] || ''
    else if (arg === '--project') out.project = argv[++index] || ''
    else if (arg === '--port') out.port = Number(argv[++index]) || 0
    else if (arg === '--width') out.width = Number(argv[++index]) || 0
    else if (arg === '--height') out.height = Number(argv[++index]) || 0
    else if (arg === '--overwrite') out.overwrite = true
    else if (arg === '--resume') out.resume = true
    else if (arg === '--serve') out.serve = true
    else if (arg === '--stop') out.stop = true
    else if (arg === '--status') out.status = true
    else if (arg === '--selftest') out.selftest = true
    else if (arg === '--selftest-http') out.selftestHttp = true
    else throw new Error('未知参数：' + arg)
  }
  return out
}

/** CLI 入口。 */
async function main(argv) {
  if (argv.includes('--selftest')) {
    selftest()
    return
  }
  if (argv.includes('--selftest-http')) {
    const { runHttpSelftest } = await import('./intake/selftest.mjs')
    await runHttpSelftest()
    return
  }
  const args = parseArgs(argv)
  if (args.stop) {
    if (!args.slug) throw new Error('缺少 --slug')
    const { stopIntakeService } = await import('./intake/server.mjs')
    const facts = projectFacts(args.project)
    const result = await stopIntakeService(facts.root, args.slug, facts.defaults.pagesDir)
    if (!result.ok) throw new Error(result.error || '停止服务失败')
    console.log('UI_INTAKE_STOPPED=' + (result.stopped ? '1' : '0'))
    return
  }
  if (args.status) {
    if (!args.slug) throw new Error('缺少 --slug')
    const { readServiceState } = await import('./intake/server.mjs')
    const facts = projectFacts(args.project)
    const state = readServiceState(facts.root, args.slug, facts.defaults.pagesDir)
    if (!state) throw new Error('没有找到材料服务状态')
    console.log(JSON.stringify(state, null, 2))
    return
  }
  if (!args.slug) throw new Error('缺少 --slug')
  if (args.serve) {
    await serve(args)
    return
  }
  const result = createIntakePage({
    cwd: args.project || process.cwd(),
    slug: args.slug,
    title: args.title,
    targetPrefab: args.prefab,
    overwrite: args.overwrite,
  })
  if (!result.ok) throw new Error(result.error || '材料页生成失败')
  for (const warning of result.warnings) console.log('WARN ' + warning)
  console.log('UI_MATERIALS_PAGE=' + result.absolutePath)
  console.log('UI_MATERIALS_REL=' + result.pagePath)
  console.log('UI_MATERIALS_SLUG=' + args.slug)
  console.log('UI_MATERIALS_EXISTING=' + (result.existing ? '1' : '0'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('UI intake error: ' + (error && error.message ? error.message : String(error)))
    process.exitCode = 1
  })
}

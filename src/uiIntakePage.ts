/**
 * dsh-vscode-mode host — 生成空白 UI 材料页（项目 config 注入 + 随机令牌 + 单文件）。
 *
 * 页面模板属于 ui-kit 母版；本模块只负责找项目根、读项目差异、注入默认值并落盘。
 * 模板与限制优先用项目内已安装的 runtime（升级后即项目自己的版本），缺失时回落到
 * 插件随包母版，保证没装项目技能也能打开页面。
 * @author ddj 2026年11月26号
 */
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { skillsDirOf } from './paths.js'
import {
  UI_INTAKE_DEFAULT_LIMITS,
  UI_INTAKE_DEFAULT_PAGES_DIR,
  UI_INTAKE_PAGE_FILE,
  UI_INTAKE_SCHEMA,
  intakePagePathOf,
  isIntakeSlug,
  normalizeRelPath,
  parseIntakePageConfig,
  type UiIntakeLimits,
  type UiIntakePageConfig,
} from './shared/uiIntake.js'

/** 模板里配置注入占位符。 */
const CONFIG_PLACEHOLDER = '__DSH_UI_INTAKE_CONFIG__'

/** 母版技能目录名（随包 skills/ 下的目录）。 */
const MASTER_SKILL_DIR = 'dsh-vscodemode-ui-kit'

/** 项目内生成的技能目录名（安装时由母版生成）。 */
const PROJECT_SKILL_DIR = 'ui-builder'

/** 页面配置默认值（config.json 缺失或字段非法时使用；会在结果里给出警告）。 */
export interface UiIntakeDefaults {
  pagesDir: string
  screen: { w: number; h: number }
  ui: { system: string; bindStyle: string; commonDir: string; matchMode: string }
  assets: { inProject: string; artRoot: string }
}

/** 读取项目根的结果。 */
export interface UiIntakeProjectRoot {
  root: string
  source: '.dsh/ui-kit/config.json' | '.git' | 'cwd'
}

/** 页面生成结果。 */
export interface UiIntakePageResult {
  ok: boolean
  pagePath?: string
  absolutePath?: string
  slug?: string
  projectRoot?: string
  screen?: { w: number; h: number }
  defaults?: UiIntakeDefaults
  limits?: UiIntakeLimits
  existing?: boolean
  warnings?: string[]
  error?: string
}

/** 页面生成选项（测试可注入 IO）。 */
export interface CreatePageOptions {
  cwd: string
  slug: string
  title?: string
  overwrite?: boolean
  /** 文件是否存在探测（缺省 access）。 */
  exists?: (path: string) => Promise<boolean>
  /** 文本读取（缺省 readFile utf8）。 */
  readText?: (path: string) => Promise<string>
  /** 文本写入（缺省 writeFile utf8）。 */
  writeText?: (path: string, content: string) => Promise<void>
  /** 目录创建（缺省 mkdir recursive）。 */
  makeDir?: (path: string) => Promise<void>
  /** 当前时间（测试固定）。 */
  now?: Date
}

/** 归一化路径为 / 分隔（不解析大小写）。 */
function slash(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/u, '')
}

/**
 * 判断 child 是否位于 parent 之下（含相等）；Windows 大小写不敏感。
 * @author ddj 2026年11月26号
 * @param parent 父路径
 * @param child 子路径
 * @returns 是否包含
 */
export function isPathInside(parent: string, child: string): boolean {
  const a = slash(parent)
  const b = slash(child)
  if (!a || !b) return false
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value)
  const left = fold(a)
  const right = fold(b)
  return right === left || right.startsWith(left + '/')
}

/**
 * 向上找项目根：优先含 `.dsh/ui-kit/config.json` 的最近祖先，其次含 `.git` 的最近祖先，
 * 都没有时退回会话目录（与 ui-kit 安装探测同判据）。
 * @author ddj 2026年11月26号
 * @param cwd 会话当前目录
 * @param exists 存在性探测
 * @returns 项目根与来源
 */
export async function projectRootOf(cwd: string, exists: (path: string) => Promise<boolean>): Promise<UiIntakeProjectRoot> {
  const start = resolve(cwd)
  let dir = start
  let gitRoot: string | null = null
  for (let depth = 0; depth < 64; depth += 1) {
    const config = join(dir, '.dsh', 'ui-kit', 'config.json')
    if (await exists(config)) return { root: slash(dir), source: '.dsh/ui-kit/config.json' }
    if (gitRoot === null && await exists(join(dir, '.git'))) gitRoot = slash(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (gitRoot !== null) return { root: gitRoot, source: '.git' }
  return { root: slash(start), source: 'cwd' }
}

/** 把 config.ui.refResolution 解析成正整数对。 */
function screenOf(value: unknown): { w: number; h: number } | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const width = Number(value[0])
  const height = Number(value[1])
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null
  return { w: width, h: height }
}

/**
 * 从项目 config.json 提取材料页需要的项目差异。
 * @author ddj 2026年11月26号
 * @param raw 解析后的 config（任意形状）
 * @returns 默认值与告警
 */
export function defaultsOfConfig(raw: unknown): { defaults: UiIntakeDefaults; warnings: string[] } {
  const warnings: string[] = []
  const row = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const ui = row.ui !== null && typeof row.ui === 'object' ? row.ui as Record<string, unknown> : {}
  const assets = row.assets !== null && typeof row.assets === 'object' ? row.assets as Record<string, unknown> : {}
  const pages = row.pages !== null && typeof row.pages === 'object' ? row.pages as Record<string, unknown> : {}
  const screen = screenOf(ui.refResolution)
  if (!screen) warnings.push('config.ui.refResolution 缺失或非法，材料页使用 1080×1920 默认尺寸')
  const pagesDir = normalizeRelPath(pages.dir) ?? UI_INTAKE_DEFAULT_PAGES_DIR
  if (!normalizeRelPath(pages.dir)) warnings.push('config.pages.dir 缺失或非法，材料页使用 ' + UI_INTAKE_DEFAULT_PAGES_DIR)
  const uiSystem = typeof ui.system === 'string' && ui.system ? ui.system : 'other'
  const bindStyle = typeof ui.bindStyle === 'string' && ui.bindStyle ? ui.bindStyle : 'componentName'
  const commonDir = typeof ui.commonDir === 'string' && ui.commonDir ? ui.commonDir : 'Assets/UI/Common'
  const matchMode = typeof ui.matchMode === 'string' && ui.matchMode ? ui.matchMode : 'width'
  return {
    defaults: {
      pagesDir,
      screen: screen ?? { w: 1080, h: 1920 },
      ui: { system: uiSystem, bindStyle, commonDir, matchMode },
      assets: {
        inProject: typeof assets.inProject === 'string' ? assets.inProject : '',
        artRoot: typeof assets.artRoot === 'string' ? assets.artRoot : '',
      },
    },
    warnings,
  }
}

/** 限制文件解析：只接受正整数与字符串数组，缺省回落到默认值。 */
function limitsOfConfig(raw: unknown): UiIntakeLimits {
  const row = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const media = Array.isArray(row.mediaTypes)
    ? row.mediaTypes.filter((item): item is string => typeof item === 'string' && UI_INTAKE_DEFAULT_LIMITS.mediaTypes.includes(item))
    : []
  const positive = (key: keyof UiIntakeLimits, fallback: number): number => {
    const value = Number(row[key])
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  return {
    maxFiles: positive('maxFiles', UI_INTAKE_DEFAULT_LIMITS.maxFiles),
    maxFileBytes: positive('maxFileBytes', UI_INTAKE_DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: positive('maxTotalBytes', UI_INTAKE_DEFAULT_LIMITS.maxTotalBytes),
    maxPixels: positive('maxPixels', UI_INTAKE_DEFAULT_LIMITS.maxPixels),
    maxSide: positive('maxSide', UI_INTAKE_DEFAULT_LIMITS.maxSide),
    mediaTypes: media.length ? media : [...UI_INTAKE_DEFAULT_LIMITS.mediaTypes],
  }
}

/**
 * 模板与限制文件候选目录：项目安装的 runtime 优先，插件母版兜底。
 * @author ddj 2026年11月26号
 * @param projectRoot 项目根
 * @returns 绝对目录列表（按优先级）
 */
export function intakeRuntimeDirs(projectRoot: string): string[] {
  const bundled = join(skillsDirOf(import.meta.url), MASTER_SKILL_DIR, 'runtime', 'intake')
  return [
    join(projectRoot, '.dsh', 'skills', PROJECT_SKILL_DIR, 'runtime', 'intake'),
    bundled,
  ]
}

/** 读第一个存在的文本文件；都缺失返回 null。 */
async function firstText(paths: string[], readText: (path: string) => Promise<string>): Promise<{ path: string; text: string } | null> {
  for (const path of paths) {
    try {
      return { path, text: await readText(path) }
    } catch {
      /* 继续下一个候选 */
    }
  }
  return null
}

/**
 * 读宿主侧上传限制：项目安装的 runtime → 插件母版 → 内置默认。
 * @author ddj 2026年11月26号
 * @param projectRoot 项目根
 * @param readText 文本读取（测试注入）
 * @returns 限制
 */
export async function loadUiIntakeLimits(
  projectRoot: string,
  readText: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<UiIntakeLimits> {
  for (const dir of intakeRuntimeDirs(projectRoot)) {
    try {
      return limitsOfConfig(JSON.parse(await readText(join(dir, 'limits.json'))))
    } catch {
      /* 继续下一个候选 */
    }
  }
  return UI_INTAKE_DEFAULT_LIMITS
}

/**
 * 渲染材料页：把配置 JSON 注入模板。配置里的 `<` 一律转义，避免提前闭合 script。
 * @author ddj 2026年11月26号
 * @param template 模板文本
 * @param config 页面配置
 * @returns 可落盘的单文件 HTML
 * @throws 模板缺占位符
 */
export function renderIntakePage(template: string, config: UiIntakePageConfig): string {
  if (!template.includes(CONFIG_PLACEHOLDER)) throw new Error('材料页模板缺少 ' + CONFIG_PLACEHOLDER + ' 占位符')
  const json = JSON.stringify(config, null, 2)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
  return template.split(CONFIG_PLACEHOLDER).join(json)
}

/** 把产物包装成统一结果。 */
function fail(error: string, warnings: string[] = []): UiIntakePageResult {
  return { ok: false, error, ...(warnings.length ? { warnings } : {}) }
}

/**
 * 生成（或复用）空白材料页。
 *
 * 已存在页面默认复用其令牌（不覆盖可能正在填写的页面）；只有 `overwrite` 为真时才
 * 生成新令牌并替换内容。这样重复执行“创建 UI”不会让已打开的页面突然失效。
 * @author ddj 2026年11月26号
 * @param options 会话目录、slug、标题、覆盖开关与 IO
 * @returns 页面路径、项目默认值与告警
 */
export async function createMaterialsPage(options: CreatePageOptions): Promise<UiIntakePageResult> {
  const exists = options.exists ?? (async (path: string) => { try { await access(path); return true } catch { return false } })
  const readText = options.readText ?? ((path: string) => readFile(path, 'utf8'))
  const writeText = options.writeText ?? ((path: string, content: string) => writeFile(path, content, 'utf8'))
  const makeDir = options.makeDir ?? ((path: string) => mkdir(path, { recursive: true }).then(() => undefined))
  const now = options.now ?? new Date()
  if (!isIntakeSlug(options.slug)) return fail('slug 必须是小写字母、数字与短横线组成的短标识（1~64 位）')

  const root = await projectRootOf(options.cwd, exists)
  const warnings: string[] = []
  let configRaw: unknown = {}
  const configPath = join(root.root, '.dsh', 'ui-kit', 'config.json')
  if (await exists(configPath)) {
    try {
      configRaw = JSON.parse(await readText(configPath))
    } catch (error) {
      warnings.push('项目 config.json 解析失败，材料页使用默认值：' + String(error))
    }
  } else {
    warnings.push('未找到项目 config.json，材料页使用默认值；建议先安装项目 UI 技能')
  }
  const defaults = defaultsOfConfig(configRaw)
  warnings.push(...defaults.warnings)
  const pagePath = intakePagePathOf(defaults.defaults.pagesDir, options.slug)
  if (!pagePath) return fail('无法根据 config.pages.dir 与 slug 生成材料页路径', warnings)
  const absolutePath = join(root.root, ...pagePath.split('/'))
  const limits = await loadUiIntakeLimits(root.root, readText)

  if (await exists(absolutePath) && options.overwrite !== true) {
    const current = parseIntakePageConfig(await readText(absolutePath))
    if (!current) return fail('已有材料页但配置无法读取；换一个 slug，或显式覆盖后重建', warnings)
    if (current.slug !== options.slug || current.pagePath !== pagePath) return fail('已有材料页的 slug/路径与本次不一致，请换 slug 或显式覆盖', warnings)
    return {
      ok: true,
      pagePath,
      absolutePath: slash(absolutePath),
      slug: options.slug,
      projectRoot: root.root,
      screen: current.screen,
      defaults: defaults.defaults,
      limits: current.limits,
      existing: true,
      warnings: [...warnings, '材料页已存在，已复用原页面与令牌；如需重建请传 overwrite'],
    }
  }

  const templateCandidates = intakeRuntimeDirs(root.root).map((dir) => join(dir, UI_INTAKE_PAGE_FILE))
  const template = await firstText(templateCandidates, readText)
  if (!template) return fail('找不到材料页模板：请升级 dsh-vscode-mode 或重新安装项目 UI 技能', warnings)
  const pageConfig: UiIntakePageConfig = {
    token: randomBytes(16).toString('hex'),
    pagePath,
    slug: options.slug,
    pagesDir: defaults.defaults.pagesDir,
    projectRoot: root.root,
    title: typeof options.title === 'string' ? options.title.trim().slice(0, 120) : '',
    screen: defaults.defaults.screen,
    ui: defaults.defaults.ui,
    assets: defaults.defaults.assets,
    limits,
    createdAt: now.toISOString(),
  }
  let html: string
  try {
    html = renderIntakePage(template.text, pageConfig)
  } catch (error) {
    return fail('材料页模板渲染失败：' + String(error), warnings)
  }
  try {
    await makeDir(dirname(absolutePath))
    await writeText(absolutePath, html)
  } catch (error) {
    return fail('材料页写入失败：' + String(error), warnings)
  }
  return {
    ok: true,
    pagePath,
    absolutePath: slash(absolutePath),
    slug: options.slug,
    projectRoot: root.root,
    screen: pageConfig.screen,
    defaults: defaults.defaults,
    limits,
    existing: false,
    warnings,
  }
}

/** 读取材料页配置（供测试与宿主工具复用）。 */
export async function readMaterialPageConfig(path: string): Promise<UiIntakePageConfig | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 2 * 1024 * 1024) return null
    return parseIntakePageConfig(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/** 清单 schema 常量（保存侧复用，避免字符串漂移）。 */
export const UI_INTAKE_MANIFEST_SCHEMA = UI_INTAKE_SCHEMA

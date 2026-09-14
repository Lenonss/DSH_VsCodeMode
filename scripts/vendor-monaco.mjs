/**
 * vendor-monaco — 从 npm registry 拉取固定版本 monaco-editor（min/vs AMD 构建），
 * 铺到 assets/vendor/monaco/vs/。
 *
 * 为什么需要本脚本：vendor 是预构建产物，过去无生成流程，导致仓库里躺着一份**被裁剪的**
 * 构建——缺 gotoSymbol / peekView 贡献模块（editor.action.referenceSearch.trigger 等动作
 * 在运行时不存在），「查找所有引用」与 Ctrl+点击原生 Peek 静默失效。本脚本把「用哪个版本、
 * 从哪来、怎么处理」固化成可复现的一步。
 *
 * 产物（离线随包分发，经 /edrv/vendor/* 路由可达，见 src/routes.ts）：
 *   loader.js  editor/editor.main.js  editor/editor.main.css
 *   base/**  basic-languages/**  language/**
 *   editor/editor.main.nls.js  editor/editor.main.nls.zh-cn.js   本地化（见 KEEP_NLS）
 *
 * 关键处理：
 * - **版本断言**：解包后读 loader.js 头部，核对版本号与 commit 与常量一致，防静默换错构建。
 * - **剥离 sourceMappingURL**：官方 25 个 js 指向未随包分发的 min-maps/，不剥会让浏览器
 *   持续 404（网络面板噪声 + 无谓请求）。
 * - **NLS 白名单**：默认只保留英文基线 + 简体中文；官方 12 种全量约 1.9MB，其余语言对
 *   本项目无消费方。
 * - **原子替换**：旧目录先移为 vs.bak-<时间戳>，失败可整体回滚。
 *
 * 用法：node scripts/vendor-monaco.mjs [--force]
 * @author ddj 2026年09月11号
 */
import { mkdir, readFile, writeFile, rm, cp, readdir, rename, stat, unlink } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

/** 锁定版本（与既有 vendor 一致；换版本必须同步改 MONACO_COMMIT）。 */
const MONACO_VERSION = '0.42.0-dev-20230906'
/** loader.js 头部声明的上游 commit（版本断言的第二把锁）。 */
const MONACO_COMMIT = 'e7d7a5b072e74702a912a4c855a3bda21a7757e7'
/** 保留的 NLS 语言：英文为基线（nls.js 无后缀），中文为项目默认界面语言。 */
const KEEP_NLS = ['editor.main.nls.js', 'editor.main.nls.zh-cn.js', 'simpleWorker.nls.js', 'simpleWorker.nls.zh-cn.js']

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(PKG_ROOT, 'assets', 'vendor', 'monaco', 'vs')
const LICENSE_DIR = join(PKG_ROOT, 'assets', 'vendor', 'monaco')
const TMP_DIR = join(PKG_ROOT, 'tmp', 'monaco-vendor')
const FORCE = process.argv.includes('--force')

/**
 * 递归遍历目录下全部文件（返回绝对路径）。
 * @author ddj 2026年09月11号
 * @param dir 起始目录
 * @returns 文件绝对路径数组
 */
async function walkFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walkFiles(full))
    else out.push(full)
  }
  return out
}

/**
 * 剥离 //# sourceMappingURL 注释（避免指向未分发的 min-maps/ 造成 404）。
 * @author ddj 2026年09月11号
 * @param dir 目标目录
 * @returns 改动的文件数
 */
async function stripSourceMaps(dir) {
  let changed = 0
  for (const file of await walkFiles(dir)) {
    if (!file.endsWith('.js') && !file.endsWith('.css')) continue
    const text = await readFile(file, 'utf8')
    const stripped = text.replace(/^\/\/# sourceMappingURL=.*$/gm, '').replace(/^\/\*# sourceMappingURL=.*?\*\/$/gm, '')
    if (stripped !== text) {
      await writeFile(file, stripped, 'utf8')
      changed++
    }
  }
  return changed
}

/**
 * 按白名单裁剪 NLS 本地化文件（其余语言删除）。
 * 注意必须用 basename（join 在 Windows 产出反斜杠，手工切 '/' 会拿到全路径 → 白名单恒不命中）。
 * @author ddj 2026年09月11号
 * @param dir 目标目录
 * @returns 删除的文件数
 */
async function pruneNls(dir) {
  let removed = 0
  for (const file of await walkFiles(dir)) {
    if (!/\.nls(\.[a-z-]+)?\.js$/.test(file)) continue
    if (KEEP_NLS.includes(basename(file))) continue
    await unlink(file)
    removed++
  }
  return removed
}

/**
 * 校验 loader.js 头部版本与 commit（防静默换错构建）。
 * @author ddj 2026年09月11号
 * @param loaderFile loader.js 绝对路径
 */
async function assertVersion(loaderFile) {
  const head = (await readFile(loaderFile, 'utf8')).slice(0, 600)
  if (!head.includes(MONACO_VERSION)) throw new Error('loader.js 版本号不符：期望 ' + MONACO_VERSION)
  if (!head.includes(MONACO_COMMIT)) throw new Error('loader.js commit 不符：期望 ' + MONACO_COMMIT)
}

/**
 * 下载文件到目标路径（registry 直链；失败即抛出中止）。
 * 不用 npm pack：Windows 下 npm 是 .cmd，execFileSync 无法直接 spawn（ENOENT）。
 * @author ddj 2026年09月11号
 * @param url 下载地址
 * @param dest 目标文件路径
 */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error('下载失败 ' + res.status + '：' + url)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/** 主流程：已存在则跳过（--force 覆盖）→ 下载解包 → 断言 → 裁剪/剥离 → 原子替换 → 自检。 */
async function main() {
  console.log('[vendor-monaco] 版本：' + MONACO_VERSION)
  if (existsSync(OUT_DIR) && !FORCE) {
    const head = (await readFile(join(OUT_DIR, 'loader.js'), 'utf8').catch(() => '')).slice(0, 600)
    if (head.includes(MONACO_VERSION) && head.includes(MONACO_COMMIT)) {
      console.log('[vendor-monaco] 已是目标版本，跳过（--force 可强制重铺）')
      return
    }
    throw new Error('已存在 vendor 但版本不符；确认后用 --force 覆盖')
  }

  await rm(TMP_DIR, { recursive: true, force: true })
  await mkdir(TMP_DIR, { recursive: true })
  const tarball = join(TMP_DIR, 'monaco-editor.tgz')
  const url = 'https://registry.npmjs.org/monaco-editor/-/monaco-editor-' + MONACO_VERSION + '.tgz'
  console.log('[vendor-monaco] 下载：' + url)
  await download(url, tarball)
  // stdio:'ignore'：tar 输出无消费价值，且子进程管道捕获在受限环境触发 EPERM
  execFileSync('tar', ['-xzf', tarball, '-C', TMP_DIR], { stdio: 'ignore' })

  const srcVs = join(TMP_DIR, 'package', 'min', 'vs')
  const srcLoader = join(srcVs, 'loader.js')
  if (!existsSync(srcLoader)) throw new Error('官方包缺少 min/vs/loader.js，布局异常')
  await assertVersion(srcLoader)
  console.log('[vendor-monaco] 版本断言通过（' + MONACO_VERSION + ' @ ' + MONACO_COMMIT.slice(0, 10) + '）')

  // 在临时区完成裁剪/剥离，避免污染最终目录
  const staged = join(TMP_DIR, 'vs-staged')
  await cp(srcVs, staged, { recursive: true })
  const removedNls = await pruneNls(staged)
  const stripped = await stripSourceMaps(staged)
  console.log('[vendor-monaco] NLS 裁剪 ' + removedNls + ' 个文件；剥离 sourceMappingURL ' + stripped + ' 个文件')

  // 原子替换：旧目录先移走，失败可整体回滚
  if (existsSync(OUT_DIR)) {
    const backup = OUT_DIR + '.bak-' + Date.now()
    await rename(OUT_DIR, backup)
    console.log('[vendor-monaco] 旧 vendor 已备份：' + backup)
  }
  await mkdir(dirname(OUT_DIR), { recursive: true })
  await cp(staged, OUT_DIR, { recursive: true })

  // 合规：随包分发微软构建需带许可声明（原 vendor 缺失，此处补齐）
  for (const name of ['LICENSE', 'ThirdPartyNotices.txt']) {
    const src = join(TMP_DIR, 'package', name)
    if (existsSync(src)) await cp(src, join(LICENSE_DIR, name), { force: true })
  }

  await assertVersion(join(OUT_DIR, 'loader.js'))
  const size = (await Promise.all((await walkFiles(OUT_DIR)).map(async (f) => (await stat(f)).size))).reduce((a, b) => a + b, 0)
  await rm(TMP_DIR, { recursive: true, force: true })
  console.log('[vendor-monaco] 完成：' + OUT_DIR + '（' + (size / 1024 / 1024).toFixed(2) + ' MB）')
}

main().catch((error) => {
  console.error('[vendor-monaco] 失败：' + String(error))
  process.exit(1)
})

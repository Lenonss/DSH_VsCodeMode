/**
 * vendor-pdfjs — 从 npm registry 拉取固定版本 pdfjs-dist，铺到 assets/vendor/pdfjs/。
 *
 * 产物（离线随包分发，经 /edrv/vendor/pdfjs/* 路由可达，见 src/routes.ts）：
 *   build/pdf.mjs  build/pdf.worker.mjs        核心 + Worker
 *   web/pdf_viewer.mjs  web/pdf_viewer.css     组件层（PDFViewer/注释编辑器）
 *   cmaps/**                                    CJK 字符映射（中文 PDF 必备）
 *   standard_fonts/**                           未嵌字体兜底
 *
 * 三份 JS 产物必须同版本（PDFViewer 构造时断言 version 一致），故一次性整体铺齐。
 * 若 pdf_viewer.mjs 头部 import 为裸说明符（"pdfjs-lib" 等），此处重写为相对路径，
 * 保证浏览器原生 ESM import 可解析。
 *
 * 用法：node scripts/vendor-pdfjs.mjs [版本号]（缺省 PDFJS_VERSION）
 * @author ddj 2026年09月22号
 */
import { mkdir, readFile, writeFile, rm, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const PDFJS_VERSION = process.argv[2] || '5.4.624'
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(PKG_ROOT, 'assets', 'vendor', 'pdfjs')
const TMP_DIR = join(PKG_ROOT, 'tmp', 'pdfjs-vendor')

/**
 * 下载文件到目标路径（registry 直链，失败即抛出中止整个 vendor 流程）。
 * @author ddj 2026年09月22号
 * @param url 下载地址
 * @param dest 目标文件路径
 */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error('下载失败 ' + res.status + '：' + url)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

/**
 * 铺单个目录树到产物目录（已存在先清空，保证幂等且不留旧版本残留）。
 * @author ddj 2026年09月22号
 * @param src 源目录（不存在则跳过）
 * @param dest 产物目录
 */
async function mirrorDir(src, dest) {
  if (!existsSync(src)) return
  await rm(dest, { recursive: true, force: true })
  await cp(src, dest, { recursive: true })
}

/**
 * 重写 pdf_viewer.mjs 头部裸说明符 import 为相对路径（浏览器原生 ESM 可解析）。
 * @author ddj 2026年09月22号
 * @param file pdf_viewer.mjs 绝对路径
 */
async function patchViewerImports(file) {
  const text = await readFile(file, 'utf8')
  const patched = text
    .replace(/from\s*["']pdfjs-lib["']/g, 'from "../build/pdf.mjs"')
    .replace(/from\s*["']\.\/pdf\.mjs["']/g, 'from "../build/pdf.mjs"')
  if (patched !== text) {
    await writeFile(file, patched, 'utf8')
    console.log('[vendor-pdfjs] pdf_viewer.mjs import 说明符已重写为 ../build/pdf.mjs')
  }
}

/** 主流程：下载 tgz → 解包（npm pack）→ 铺产物 → patch → 清理 → 校验版本一致。 */
async function main() {
  console.log('[vendor-pdfjs] 版本：' + PDFJS_VERSION)
  await rm(TMP_DIR, { recursive: true, force: true })
  await mkdir(TMP_DIR, { recursive: true })

  const tarball = join(TMP_DIR, 'pdfjs-dist.tgz')
  const url = 'https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-' + PDFJS_VERSION + '.tgz'
  console.log('[vendor-pdfjs] 下载：' + url)
  await download(url, tarball)

  // stdio:'ignore'：tar 输出无消费价值，且子进程管道捕获在受限环境触发 EPERM
  execFileSync('tar', ['-xzf', tarball, '-C', TMP_DIR], { stdio: 'ignore' })
  const pkgDir = join(TMP_DIR, 'package')
  const distVersion = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')).version
  if (distVersion !== PDFJS_VERSION) throw new Error('版本不一致：期望 ' + PDFJS_VERSION + ' 实得 ' + distVersion)

  // 整目录重建：清除旧版本残留（含上一次铺入的 .map/.min 等已收敛产物）
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })
  // 只铺运行必需产物：.map/.min/sandbox 不入包（构建目录瘦身为 ~2.7MB）
  await mkdir(join(OUT_DIR, 'build'), { recursive: true })
  await mkdir(join(OUT_DIR, 'web'), { recursive: true })
  await cp(join(pkgDir, 'build', 'pdf.mjs'), join(OUT_DIR, 'build', 'pdf.mjs'), { force: true })
  await cp(join(pkgDir, 'build', 'pdf.worker.mjs'), join(OUT_DIR, 'build', 'pdf.worker.mjs'), { force: true })
  await cp(join(pkgDir, 'web', 'pdf_viewer.mjs'), join(OUT_DIR, 'web', 'pdf_viewer.mjs'), { force: true })
  await cp(join(pkgDir, 'web', 'pdf_viewer.css'), join(OUT_DIR, 'web', 'pdf_viewer.css'), { force: true })
  await mirrorDir(join(pkgDir, 'cmaps'), join(OUT_DIR, 'cmaps'))
  await mirrorDir(join(pkgDir, 'standard_fonts'), join(OUT_DIR, 'standard_fonts'))

  await patchViewerImports(join(OUT_DIR, 'web', 'pdf_viewer.mjs'))

  // 三份产物版本一致性自检（PDFViewer 构造时会再次断言，这里提前暴露）
  const pdfHead = await readFile(join(OUT_DIR, 'build', 'pdf.mjs'), 'utf8')
  const verHit = pdfHead.match(/const\s+version\s*=\s*["']([^"']+)["']/)
  if (!verHit || verHit[1] !== PDFJS_VERSION) {
    throw new Error('build/pdf.mjs 版本标记异常：' + (verHit ? verHit[1] : '未找到'))
  }

  await rm(TMP_DIR, { recursive: true, force: true })
  console.log('[vendor-pdfjs] 完成：' + OUT_DIR)
}

main().catch((error) => {
  console.error('[vendor-pdfjs] 失败：' + String(error))
  process.exit(1)
})

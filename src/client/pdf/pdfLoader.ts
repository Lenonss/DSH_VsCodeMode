// @ts-nocheck
/**
 * dsh-vscode-mode client — pdf.js 加载器（vendor 产物离线随包，/edrv/vendor/pdfjs/*）。
 * 加载链：module script 内按序动态 import build/pdf.mjs（自挂 globalThis.pdfjsLib）→
 * web/pdf_viewer.mjs（从 globalThis.pdfjsLib 解构）→ window.__edrvPdfjs handoff。
 * 用 script 注入而非打包内 import()：客户端包是 CJS，bundler 会改写动态 import 破坏 URL 语义。
 * 作者 ddj 2026-09-22
 */

/** vendor 根（routes.ts /edrv/vendor 前缀路由分发 assets/vendor/*）。 */
export const PDFJS_BASE = '/edrv/vendor/pdfjs'
/** pdf.js Worker 地址（GlobalWorkerOptions.workerSrc）。 */
export const PDFJS_WORKER_SRC = PDFJS_BASE + '/build/pdf.worker.mjs'
/** CJK 字符映射目录（中文 PDF 渲染必需，尾斜杠固定）。 */
export const PDFJS_CMAP_URL = PDFJS_BASE + '/cmaps/'
/** 标准字体目录（未嵌字体 PDF 兜底，尾斜杠固定）。 */
export const PDFJS_FONT_URL = PDFJS_BASE + '/standard_fonts/'
/** 组件层样式（pdfViewer/textLayer/annotationEditor 布局）。 */
const PDFJS_CSS_URL = PDFJS_BASE + '/web/pdf_viewer.css'

let pdfjsPromise = null

/**
 * 注入 pdf_viewer.css（幂等；vendor 路由带 etag 协商缓存，重复挂载走 304）。
 * @author ddj 2026年09月22号
 */
function ensurePdfCss() {
  if (typeof document === 'undefined') return
  if (document.querySelector('link[data-edrv-pdfjs-css]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = PDFJS_CSS_URL
  link.dataset.edrvPdfjsCss = '1'
  document.head.appendChild(link)
}

/**
 * 加载 pdf.js（core + viewer 组件层）：去重 promise，失败重置允许重试（对齐 monaco loader）。
 * @author ddj 2026年09月22号
 * @returns Promise<{lib, viewer}> lib=build/pdf.mjs（getDocument/GlobalWorkerOptions/编辑器枚举等），viewer=web/pdf_viewer.mjs（PDFViewer/EventBus 等）
 */
export function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = new Promise((resolve, reject) => {
      ensurePdfCss()
      const boot = () => {
        const handoff = window.__edrvPdfjs
        if (handoff && handoff.lib && handoff.viewer) {
          try {
            handoff.lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC
          } catch (error) { /* worker 配置失败留给 getDocument 报错 */ }
          resolve(handoff)
          return
        }
        reject(new Error('pdf.js 模块加载失败：handoff 缺失'))
      }
      const fail = (error) => {
        pdfjsPromise = null
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const existing = document.querySelector('script[data-edrv-pdfjs-loader]')
      if (existing) {
        // 前一次注入仍在执行：等 handoff 出现（module 评估完即写入）
        existing.addEventListener('edrv-pdfjs-ready', boot, { once: true })
        if (window.__edrvPdfjs) boot()
        return
      }
      const s = document.createElement('script')
      s.type = 'module'
      s.textContent =
        'import * as lib from "' + PDFJS_BASE + '/build/pdf.mjs";\n' +
        'import * as viewer from "' + PDFJS_BASE + '/web/pdf_viewer.mjs";\n' +
        'window.__edrvPdfjs = { lib, viewer };\n' +
        'document.querySelector("script[data-edrv-pdfjs-loader]")?.dispatchEvent(new Event("edrv-pdfjs-ready"));'
      s.dataset.edrvPdfjsLoader = '1'
      s.onload = boot
      s.onerror = () => fail(new Error('pdf.js loader 脚本加载失败（检查 assets/vendor/pdfjs 完整 / /edrv/vendor 路由可达）'))
      document.head.appendChild(s)
    })
  }
  return pdfjsPromise
}

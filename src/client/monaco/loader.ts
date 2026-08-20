// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco 加载与语言映射（AMD 构建，离线随包分发）。
 * 迁移自原 src/client/index.ts 的 MONACO_BASE/LANG_BY_EXT/langOf/loadMonaco，语义不改。
 * 作者 ddj 2026-08-20
 */

export const MONACO_BASE = '/edrv/vendor/monaco/vs'
let monacoPromise = null

/** 扩展名 → Monaco language id（常见语言；未知回退 plaintext）。 */
export const LANG_BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', vue: 'html', xml: 'xml',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini',
  py: 'python', sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell',
  lua: 'lua', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sql: 'sql',
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart', dockerfile: 'dockerfile'
}

/**
 * 路径 → Monaco language id：取 basename 扩展名（dockerfile/Dockerfile 特判）。
 * @author ddj 2026年08月20号
 * @param path 文件路径
 * @returns language id
 */
export function langOf(path) {
  const base = String(path || '').split(/[\\/]/).pop() || ''
  if (/^dockerfile$/i.test(base)) return 'dockerfile'
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'plaintext'
  return LANG_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}

/**
 * 加载 Monaco Editor（AMD 构建，随插件包离线分发）：注入 loader.js → require.config → editor.main。
 * @author ddj 2026年08月20号
 * @returns Promise<object> window.monaco
 */
export function loadMonaco() {
  if (!monacoPromise) {
    monacoPromise = new Promise((resolve, reject) => {
      const boot = () => {
        try {
          window.require.config({ paths: { vs: MONACO_BASE } })
          window.require(['vs/editor/editor.main'], () => resolve(window.monaco), (err) => {
            monacoPromise = null
            reject(new Error('Monaco 模块加载失败：' + String(err)))
          })
        } catch (error) {
          monacoPromise = null
          reject(error)
        }
      }
      const existing = document.querySelector('script[data-edrv-monaco-loader]')
      if (existing) boot()
      else {
        const s = document.createElement('script')
        s.src = MONACO_BASE + '/loader.js'
        s.dataset.edrvMonacoLoader = '1'
        s.onload = boot
        s.onerror = () => { monacoPromise = null; reject(new Error('Monaco loader 加载失败')) }
        document.head.appendChild(s)
      }
    })
  }
  return monacoPromise
}

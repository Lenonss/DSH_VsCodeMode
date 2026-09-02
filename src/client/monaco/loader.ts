// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco 加载与语言映射（AMD 构建，离线随包分发）。
 * 迁移自原 src/client/index.ts 的 MONACO_BASE/LANG_BY_EXT/langOf/loadMonaco，语义不改。
 * 作者 ddj 2026-08-20
 */
import { applyTheme, registerThemes } from './theme.js'

export const MONACO_BASE = '/edrv/vendor/monaco/vs'
let monacoPromise = null
let monacoStage = { phase: 'idle', progress: 0, message: '准备加载 Monaco…' }
const stageListeners = new Set()

/**
 * Monaco 加载阶段：这是阶段进度而非网络字节进度，避免误导用户。
 * @author ddj 2026年08月22号
 */
export const MONACO_STAGES = {
  loader: { progress: 18, message: '加载 Monaco 引导模块…' },
  core: { progress: 72, message: '加载编辑器核心模块…' },
  ready: { progress: 100, message: 'Monaco 编辑器已就绪' },
  error: { progress: 0, message: 'Monaco 编辑器加载失败' },
}

/**
 * 发布 Monaco 加载阶段，监听器异常不得影响编辑器加载。
 * @author ddj 2026年08月22号
 * @param phase 阶段名
 * @param progress 阶段百分比
 * @param message 用户可读状态
 */
function publishStage(phase, progress, message) {
  monacoStage = { phase, progress, message }
  for (const listener of stageListeners) {
    try { listener(monacoStage) } catch (error) { /* UI 回调异常忽略 */ }
  }
}

/**
 * 订阅 Monaco 加载阶段。
 * @author ddj 2026年08月22号
 * @param listener 阶段回调
 * @returns 取消订阅函数
 */
function subscribeStage(listener) {
  if (typeof listener !== 'function') return () => {}
  stageListeners.add(listener)
  listener(monacoStage)
  return () => stageListeners.delete(listener)
}

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
  swift: 'swift', kt: 'kotlin', kts: 'kotlin', dart: 'dart', dockerfile: 'dockerfile',
  // 工程/配置文件（拿到正确语法分色，而非 plaintext）
  csproj: 'xml', props: 'xml', targets: 'xml', plist: 'xml',
  lua51: 'lua', luac: 'lua',
  gitattributes: 'ini', editorconfig: 'ini', env: 'ini', properties: 'ini',
  json5: 'jsonc', log: 'plaintext', txt: 'plaintext',
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
export function loadMonaco(onProgress) {
  const unsubscribe = subscribeStage(onProgress)
  if (!monacoPromise) {
    publishStage('loader', MONACO_STAGES.loader.progress, MONACO_STAGES.loader.message)
    monacoPromise = new Promise((resolve, reject) => {
      const fail = (error) => {
        monacoPromise = null
        publishStage('error', MONACO_STAGES.error.progress, MONACO_STAGES.error.message)
        reject(error)
      }
      const boot = () => {
        try {
          window.require.config({ paths: { vs: MONACO_BASE } })
          publishStage('core', MONACO_STAGES.core.progress, MONACO_STAGES.core.message)
          window.require(['vs/editor/editor.main'], () => {
            publishStage('ready', MONACO_STAGES.ready.progress, MONACO_STAGES.ready.message)
            // 分色主题注册 + 应用（rich token 配色，替掉内置基础 vs 的少层次着色）
            try {
              registerThemes(window.monaco)
              applyTheme(window.monaco)
            } catch (error) { /* 主题失败不阻塞编辑器 */ }
            resolve(window.monaco)
          }, (err) => fail(new Error('Monaco 模块加载失败：' + String(err))))
        } catch (error) {
          fail(error)
        }
      }
      const existing = document.querySelector('script[data-edrv-monaco-loader]')
      if (existing) boot()
      else {
        const s = document.createElement('script')
        s.src = MONACO_BASE + '/loader.js'
        s.dataset.edrvMonacoLoader = '1'
        s.onload = boot
        s.onerror = () => fail(new Error('Monaco loader 加载失败'))
        document.head.appendChild(s)
      }
    })
  }
  return monacoPromise.finally(unsubscribe)
}

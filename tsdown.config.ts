import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, relative, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'

/**
 * dsh-vscode-mode dual-face bundle config (modeled on the dsh-web-ui family
 * preset / dsh-thinking-intensity):
 * - host  : lib/index.js  node ESM; @deepseek-ai/* + cordis + schemastery stay
 *           external (resolved from the profile tree at runtime).
 * - client: lib/client.js browser CJS wrapped in
 *           window.__ModuleLoader__.load({id, factory}) with react / cordis
 *           resolved through the injected require (loader module table).
 * Plain .css imports become the registration's `meta.stylesheets` (DSH 0.2.3+
 * installs them when the record mounts and removes them when it unloads), so
 * nothing is injected into the document from module code anymore.
 */

/** Package id stamped into the __ModuleLoader__ handoff and style tags.
 * 必须等于包的安装名（dsh-vscode-mode），否则 web shell 报
 * "loaded without registering '<entry name>' via __ModuleLoader__.load"。 */
const ID = 'dsh-vscode-mode'

/** Browser platform modules resolved from the loader module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-settings',
  // 官方 UI 原语虚拟模块（loader 提供，含 FileTypeIcon/classifyFileType 与 Icon* 图标集）：
  // 必须外置——它不在本地 node_modules，内联会在构建期解析失败。
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** Host-half modules resolved from the profile tree at runtime. */
const HOST_EXTERNALS = [
  'cordis',
  'schemastery',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-settings',
]

/** Virtual-id wrapper keeping plain CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** tsdown/rolldown virtual ids carry a NUL prefix; strip it for file paths. */
function fileIdOf(virtualId: string): string {
  return virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
}

/** One artifact's collected stylesheets: package-relative path → CSS text. */
type Styles = Map<string, string>

/** Package root, used to key stylesheets by their path inside the package. */
const PACKAGE_ROOT = resolvePath('.')

/**
 * Key a stylesheet by its path inside the owning package.
 * Third-party CSS from node_modules keeps a readable `vendor/<pkg>/<path>` key.
 * @private @author ddj 2026年11月23号
 * @param fileId Absolute path of the stylesheet.
 * @returns Path relative to the package root, POSIX separators.
 */
function stylePathOf(fileId: string): string {
  const normalized = fileId.replace(/\\/g, '/')
  const inside = relative(PACKAGE_ROOT, fileId).replace(/\\/g, '/')
  // 第三方样式（node_modules，含 pnpm 的 .pnpm 中转目录）统一挂 vendor/ 前缀，
  // 取最后一段 node_modules 之后的部分，避免把 store 哈希写进产物。
  const marker = normalized.lastIndexOf('/node_modules/')
  if (marker >= 0) return 'vendor/' + normalized.slice(marker + '/node_modules/'.length)
  if (!inside.startsWith('..')) return inside
  return 'vendor/' + basename(normalized)
}

/** A url() whose target is relative, so it needs the official asset resolver. */
const RELATIVE_URL = /url\(\s*(?!['"]?(?:data:|blob:|https?:|#|\/\/))/i

/**
 * Reject relative url() references: they must be resolved through the official
 * `context.asset()` hook inside `text(context)`, never hand-joined. Self-contained
 * references (data:/blob:/http(s):/fragment) stay inlined as written.
 * @private @author ddj 2026年11月23号
 * @param css Stylesheet text.
 * @param fileId Source file, for the diagnostic.
 * @throws When the stylesheet references a relative asset by URL.
 */
function assertNoUrls(css: string, fileId: string): void {
  if (!RELATIVE_URL.test(css)) return
  throw new Error(fileId + ': 样式里的相对 url() 必须经 meta.stylesheets 的 context.asset() 解析，不能内联固定地址')
}

/**
 * Emit the registration's `meta` factory with every collected stylesheet.
 * @private @author ddj 2026年11月23号
 * @param styles Collected stylesheets.
 * @returns JavaScript source of the meta factory.
 */
function metaSourceOf(styles: Styles): string {
  const rows = [...styles].map(([path, css]) => JSON.stringify(path) + ': { text: () => ' + JSON.stringify(css) + ' }')
  return '() => ({ stylesheets: { ' + rows.join(', ') + ' } })'
}

/**
 * Wrap a rendered chunk in the loader registration, with styles in `meta`.
 * @private @author ddj 2026年11月23号
 * @param code Rendered chunk code.
 * @param chunk Package-local chunk name, or undefined for the root entry.
 * @param styles Collected stylesheets of this artifact.
 * @returns The registration source.
 */
function registrationOf(code: string, chunk: string | undefined, styles: Styles): string {
  const head = 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID)
    + (chunk === undefined ? '' : ', chunk: ' + JSON.stringify(chunk)) + ', factory: (require) => {\n'
  const tail = chunk === undefined
    ? 'module.exports.__setPanelImport(require.async?.bind(require)); return module.exports; }'
    : 'return module.exports; }'
  return head + 'var module = { exports: {} }; var exports = module.exports;\n' + code + '\n' + tail
    + ', meta: ' + metaSourceOf(styles) + ' });\n'
}

/** Host-half config (node ESM, one face of the plugin). */
function hostConfig(): UserConfig {
  return {
    name: `${ID}/host`,
    // Object form pins the output name (array form would emit index.mjs).
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: true,
    external: HOST_EXTERNALS,
    outputOptions: {
      // Force lib/index.js (package.json main/exports point there).
      entryFileNames: 'index.js',
    },
  }
}

/** Independent built-in chunks: the Excel engine and its codec load only when a workbook is opened. */
const PANEL_ENTRIES = {
  rules: 'src/client/sidebar/panels/RulesPanel.ts',
  debug: 'src/client/sidebar/panels/DebugPanel.ts',
  excel: 'src/client/excel/panel.ts',
  excelcodec: 'src/client/excel/codecEntry.ts',
} as const
type PanelKey = keyof typeof PANEL_ENTRIES

/** @private @author ddj 2026年10月22号 @param panel Optional independent built-in chunk entry. @returns Browser CJS config using the documented ModuleLoader chunk handoff. */
function clientConfig(panel?: PanelKey): UserConfig {
  const chunk = panel ? `client.${panel}.js` : undefined
  /** Stylesheets collected for this artifact only; they ride in its registration meta. */
  const styles: Styles = new Map()
  const shared = new Map([
    [resolvePath('src/client/rpc.ts'), ['rpc', 'dbg']],
    [resolvePath('src/client/dap/store.ts'), ['dapStore']],
    [resolvePath('src/client/dap/BpWidget.ts'), ['BP_MODE', 'MODES', 'fieldOfMode']],
    [resolvePath('src/client/ui/ContextMenu.ts'), ['ContextMenu']],
    // Excel chunk must reuse the root session map and the patched native-file opener.
    [resolvePath('src/client/excel/controller.ts'), ['editExcel', 'exportExcel', 'notifyExcel']],
    [resolvePath('src/client/remoteOpenRouter.ts'), ['openOriginal']],
  ])
  return {
    name: `${ID}/${panel ?? 'client'}`,
    entry: panel ? { [panel]: PANEL_ENTRIES[panel] } : { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    // Client bytes are on the page-load critical path; the panel chunks are downloaded on demand.
    minify: true,
    // Inline everything not in the loader module table (our own code).
    external: panel ? [ID, ...CLIENT_EXTERNALS] : CLIENT_EXTERNALS,
    noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) || (panel && source === ID) ? undefined : true),
    plugins: [
      {
        name: 'excel-browser-entry',
        /** @private @author ddj 2026年10月28号 @param source Import id. @returns Browser-only ExcelJS bundle, excluding filesystem/streaming writer implementations. */
        resolveId(source: string) { return source === 'exceljs' ? createRequire(import.meta.url).resolve('exceljs/dist/exceljs.min.js') : null },
        /** @private @author ddj 2026年10月28号 @param code Browser chunk. @returns No transform. @throws If a Node-only loader or worker entry leaks into the client artifact. */
        renderChunk(code: string) {
          if (/\brequire(?:\$\d+)?\(["'](?:node:)?(?:module|worker_threads)["']\)/.test(code)) throw new Error('Browser bundle contains a Node-only module/worker_threads import')
          return null
        },
      },
      {
        name: 'dsh-shared-panel-state',
        /** @author ddj 2026年10月22号 @param source Import request. @param importer Requesting module. @returns Virtual bridge only for shared live root objects. */
        resolveId(source: string, importer: string | undefined) {
          if (!panel || !importer || !source.startsWith('.')) return null
          const target = resolvePath(dirname(importer), source).replace(/\.js$/, '.ts')
          return shared.has(target) ? '\0panel-shared:' + target : null
        },
        /** @author ddj 2026年10月22号 @param id Resolved bridge. @returns Named exports from the already materialized root plugin; never duplicate stores. */
        load(id: string) {
          if (!id.startsWith('\0panel-shared:')) return null
          const names = shared.get(id.slice('\0panel-shared:'.length))!
          return `import { __lazyShared } from '${ID}';\n` + names.map((name) => `export const ${name} = __lazyShared.${name};`).join('\n')
        },
      },
      {
        // Collect plain .css into this artifact's meta.stylesheets; module code stays clean.
        name: 'dsh-css-meta',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.css')) return null
          const abs =
            source.startsWith('.') && importer !== undefined ? resolvePath(dirname(importer), source) : createRequire(import.meta.url).resolve(source)
          return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
        },
        async load(virtualId: string) {
          if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
          const fileId = fileIdOf(virtualId)
          this.addWatchFile(fileId)
          const css = await readFile(fileId, 'utf8')
          assertNoUrls(css, fileId)
          styles.set(stylePathOf(fileId), css)
          return 'export default null;'
        },
      },
      {
        // Install the collected styles through the registration's meta factory.
        name: 'dsh-meta-registration',
        /** @private @author ddj 2026年11月23号 @param options Output options (unused). @param bundle Emitted files. @returns Nothing. */
        generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string }>) {
          for (const file of Object.values(bundle)) {
            if (file.type !== 'chunk' || typeof file.code !== 'string') continue
            file.code = registrationOf(file.code, chunk, styles)
          }
        },
      },
    ],
    outputOptions: {
      entryFileNames: chunk ?? 'client.js',
      codeSplitting: false,
    },
  }
}

export default [hostConfig(), clientConfig(), clientConfig('rules'), clientConfig('debug'), clientConfig('excel'), clientConfig('excelcodec')] satisfies UserConfig[]

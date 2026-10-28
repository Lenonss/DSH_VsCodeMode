import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'

/**
 * dsh-vscode-mode dual-face bundle config (modeled on the dsh-web-ui family
 * preset / dsh-thinking-intensity):
 * - host  : lib/index.js  node ESM; @deepseek-ai/* + cordis + schemastery stay
 *           external (resolved from the profile tree at runtime).
 * - client: lib/client.js browser CJS wrapped in
 *           window.__ModuleLoader__.load({id, factory}) with react / cordis
 *           resolved through the injected require (loader module table).
 * Plain .css imports are inlined as an injected <style data-plugin-css> tag
 * (module CSS virtualization, same pattern as the family preset).
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

/** @private @author ddj 2026年10月22号 @param panel Optional independent built-in panel entry. @returns Browser CJS config using the documented ModuleLoader chunk handoff. */
function clientConfig(panel?: 'rules' | 'debug'): UserConfig {
  const chunk = panel ? `client.${panel}.js` : undefined
  const shared = new Map([
    [resolvePath('src/client/rpc.ts'), ['rpc', 'dbg']],
    [resolvePath('src/client/dap/store.ts'), ['dapStore']],
    [resolvePath('src/client/dap/BpWidget.ts'), ['BP_MODE', 'MODES', 'fieldOfMode']],
    [resolvePath('src/client/ui/ContextMenu.ts'), ['ContextMenu']],
  ])
  return {
    name: `${ID}/${panel ?? 'client'}`,
    entry: panel ? { [panel]: `src/client/sidebar/panels/${panel === 'rules' ? 'RulesPanel' : 'DebugPanel'}.ts` } : { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
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
        // Inline plain .css as an injected <style data-plugin-css> tag.
        name: 'dsh-css-inline',
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
          const tagId = `${ID}/${basename(fileId)}`
          return [
            `const css = ${JSON.stringify(css)};`,
            `const tagId = ${JSON.stringify(tagId)};`,
            `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
            `  const tag = document.createElement('style');`,
            `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
            '  tag.dataset.pluginCss = tagId;',
            '  tag.textContent = css;',
            '  document.head.appendChild(tag);',
            '}',
            'export default null;',
          ].join('\n')
        },
      },
    ],
    outputOptions: {
      entryFileNames: chunk ?? 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk ? `chunk: ${JSON.stringify(chunk)}, ` : ''}factory: (require) => {`,
      footer: panel ? 'return module.exports; } });' : 'module.exports.__setPanelImport(require.async?.bind(require)); return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

export default [hostConfig(), clientConfig(), clientConfig('rules'), clientConfig('debug')] satisfies UserConfig[]

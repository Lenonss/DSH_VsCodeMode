import { readFile } from 'node:fs/promises'
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
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-settings',
]

/** Host-half modules resolved from the profile tree at runtime. */
const HOST_EXTERNALS = [
  'cordis',
  'schemastery',
  '@deepseek-ai/dsh-client-ui-slots',
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

/** Client bundle config (format cjs + browser + ModuleLoader wrapper). */
function clientConfig(): UserConfig {
  return {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    sourcemap: true,
    // Inline everything not in the loader module table (our own code).
    noExternal: (source: string) => (CLIENT_EXTERNALS.includes(source) ? undefined : true),
    plugins: [
      {
        // Inline plain .css as an injected <style data-plugin-css> tag.
        name: 'dsh-css-inline',
        resolveId(source: string, importer: string | undefined) {
          if (!source.endsWith('.css')) return null
          const abs =
            importer !== undefined ? resolvePath(dirname(importer), source) : source
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
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  }
}

export default [hostConfig(), clientConfig()] satisfies UserConfig[]

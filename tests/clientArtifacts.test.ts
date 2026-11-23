import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkArtifacts, inspectArtifacts, verifyNativeLoader } from '../scripts/check-client-artifacts.mjs'

const directories: string[] = []
const OWNER = 'dsh-vscode-mode'

/**
 * Registration `meta` with one stylesheet (or none), mirroring the real build.
 * @author ddj 2026年11月23号
 * @param path Package-relative stylesheet path; omitted for an empty set.
 * @returns JavaScript source of the meta field.
 */
function metaOf(path?: string): string {
  const sheets = path ? `{'${path}':{text:()=>'body{}'}}` : '{}'
  return `,meta:()=>({stylesheets:${sheets}})`
}

const ROOT_META = metaOf('src/client/styles/editor.css')

/**
 * 0.2.2 及以前的样式自注入回退块（与 tsdown 生成的形状一致，只做契约校验用）。
 * @author ddj 2026年11月23号
 * @param css 本产物样式文本；省略表示不带回退块。
 * @returns JavaScript 片段，含审计脚本识别的起止标记。
 */
function fallbackOf(css?: string): string {
  if (!css) return ''
  const probe = JSON.stringify(css.trim().slice(0, 48))
  return `/*dsh-style-fallback*/try{if(typeof document!=="undefined"&&document&&document.head){var p=${probe};`
    + `var s=document.querySelectorAll("style"),i=0;for(;i<s.length;i+=1){var t=s[i]&&s[i].textContent;`
    + `if(t&&t.indexOf(p)>=0){s=null;break}}if(s){var g=document.createElement("style");`
    + `g.setAttribute("data-plugin","${OWNER}");g.textContent=${JSON.stringify(css)};`
    + `document.head.appendChild(g)}}}catch(e){};/*dsh-style-fallback-end*/`
}

/** Fixture stylesheet text carried by both channels. */
const SHEET_TEXT = 'body{}'

const root = `window.__ModuleLoader__.load({id:'${OWNER}',factory:(require)=>{
  ${fallbackOf(SHEET_TEXT)}
  const exports = { __lazyShared: {rpc(){},dbg(){},dapStore:{},BP_MODE:{},MODES:[],fieldOfMode(){},ContextMenu(){},editExcel(){},exportExcel(){},notifyExcel(){},openOriginal(){}}, __setPanelImport(){} };
  exports.__setPanelImport(require.async?.bind(require)); return exports;
}${ROOT_META}});`

/** Root keys each chunk is contracted to consume. */
const CHUNK_KEYS: Record<string, string[]> = {
  'client.rules.js': ['rpc'],
  'client.debug.js': ['dapStore', 'BP_MODE', 'MODES', 'fieldOfMode', 'ContextMenu', 'rpc'],
  'client.excel.js': ['editExcel', 'exportExcel', 'notifyExcel', 'openOriginal'],
  'client.excelcodec.js': [],
}

/** Chunk stylesheet each chunk must declare (only the engine carries CSS today). */
const CHUNK_STYLES: Record<string, string | undefined> = {
  'client.excel.js': 'src/client/excel/panel.css',
}

/**
 * @private @author ddj 2026年10月22号
 * @param name Chunk resource.
 * @param exported Expected chunk export.
 * @returns Native chunk wrapper using root singleton bridge.
 */
function chunk(name: string, exported: string): string {
  const keys = CHUNK_KEYS[name] ?? []
  const bridge = keys.length ? `const {${keys.join(',')}} = require('${OWNER}').__lazyShared;` : ''
  const sheet = CHUNK_STYLES[name]
  return `window.__ModuleLoader__.load({id:'${OWNER}',chunk:'${name}',factory:(require)=>{
    ${bridge}
    ${fallbackOf(sheet ? SHEET_TEXT : undefined)}
    return {${exported}:function(){return 1}};
  }${metaOf(sheet)}});`
}

/** @private @author ddj 2026年10月22号 @returns Isolated fixture artifacts; no project lib changes. */
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'edrv-artifacts-'))
  directories.push(directory)
  await Promise.all([
    writeFile(join(directory, 'index.js'), "export const name='dsh-vscode-mode'; export const inject=[]; export function apply(){}"),
    writeFile(join(directory, 'client.js'), root),
    writeFile(join(directory, 'client.rules.js'), chunk('client.rules.js', 'RulesPanel')),
    writeFile(join(directory, 'client.debug.js'), chunk('client.debug.js', 'DebugPanel')),
    writeFile(join(directory, 'client.excel.js'), chunk('client.excel.js', 'excelPanel')),
    writeFile(join(directory, 'client.excelcodec.js'), `window.__ModuleLoader__.load({id:'${OWNER}',chunk:'client.excelcodec.js',factory:(require)=>({decodeExcel:function(){return 1},downloadExcel:function(){return 1}})${metaOf()}});`),
  ])
  return directory
}

/** @private @author ddj 2026年10月22号 @returns Remove only exact temporary directories created by these tests. */
async function cleanup(): Promise<void> {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
}
afterEach(cleanup)

describe('client artifact registration contract', () => {
  it('accepts the root and all four native package-local chunk wrappers', async () => {
    const result = await checkArtifacts(await fixture(), undefined, { engineFloor: 0 })
    expect(Object.keys(result.bytes)).toEqual(['index.js', 'client.js', 'client.rules.js', 'client.debug.js', 'client.excel.js', 'client.excelcodec.js'])
    expect(result.native).toHaveProperty('skipped')
  })
  it('rejects a root bundle that re-inlined an engine chunk', async () => {
    const directory = await fixture()
    await expect(inspectArtifacts(directory, { rootBudget: 100 })).rejects.toThrow('root bundle exceeds')
  })
  it('rejects an engine chunk below the expected floor', async () => {
    const directory = await fixture()
    await expect(inspectArtifacts(directory, { engineFloor: 1024 })).rejects.toThrow('engine chunk below')
  })
  it('rejects missing and empty mandatory artifacts', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'index.js'), '')
    await expect(inspectArtifacts(directory)).rejects.toThrow('index.js: empty artifact')
    await rm(join(directory, 'index.js'))
    await expect(inspectArtifacts(directory)).rejects.toThrow()
  })
  it('rejects malformed Host artifacts and missing plugin exports without executing them', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'index.js'), 'export function apply( {')
    await expect(inspectArtifacts(directory)).rejects.toThrow('malformed JavaScript')
    await writeFile(join(directory, 'index.js'), 'throw new Error("must never execute"); export function apply(){}')
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing plugin export name')
    await writeFile(join(directory, 'index.js'), 'export const name="p",inject=[],apply=42')
    await expect(inspectArtifacts(directory)).rejects.toThrow('apply export must resolve to a function')
  })
  it('rejects mismatched chunk registration', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.rules.js'), chunk('client.wrong.js', 'RulesPanel'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('wrong chunk registration')
  })
  it('rejects wrong owners and duplicate registrations', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace(OWNER, 'wrong-owner'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('wrong owner')
    await writeFile(join(directory, 'client.js'), root + root)
    await expect(inspectArtifacts(directory)).rejects.toThrow('exactly one registration')
  })
  it('rejects root registered as a chunk and missing native import injection', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace('factory:', "chunk:'client.root.js',factory:"))
    await expect(inspectArtifacts(directory)).rejects.toThrow('root must not register as a chunk')
    await writeFile(join(directory, 'client.js'), root.replace('require.async?.bind(require)', 'undefined'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('native asynchronous require')
  })
  it('rejects missing shared bridges and copied singleton implementation', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.rules.js'), chunk('client.rules.js', 'RulesPanel').replace('__lazyShared', 'wrong'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing shared bridge')
    await writeFile(join(directory, 'client.rules.js'), chunk('client.rules.js', 'RulesPanel') + '\nfunction rpc(){}')
    await expect(inspectArtifacts(directory)).rejects.toThrow('duplicated singleton')
  })
  it('ignores import/require text in comments and string literals but rejects executable dynamic import', async () => {
    const directory = await fixture()
    const harmless = '\n// import("node:fs"); require("node:fs")\nconst text = \'import("node:fs")\';'
    await writeFile(join(directory, 'client.js'), root + harmless)
    await expect(inspectArtifacts(directory)).resolves.toHaveProperty('root')
    await writeFile(join(directory, 'client.js'), root + '\nimport("./bad.js")')
    await expect(inspectArtifacts(directory)).rejects.toThrow('native ESM dynamic import')
  })
  it('rejects executable unexpected externals', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.rules.js'), chunk('client.rules.js', 'RulesPanel') + '\nrequire("node:fs")')
    await expect(inspectArtifacts(directory)).rejects.toThrow('unexpected external node:fs')
  })
  it('rejects bare ESM rather than treating it as a loader bundle', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.rules.js'), 'export const RulesPanel = () => null')
    await expect(inspectArtifacts(directory)).rejects.toThrow()
  })
  it('rejects a registration that carries no stylesheet meta', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace(ROOT_META, ''))
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing meta factory')
  })
  it('rejects a chunk that does not declare the stylesheet it installed before', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.excel.js'), chunk('client.excel.js', 'excelPanel').replace(metaOf('src/client/excel/panel.css'), metaOf()))
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing stylesheet src/client/excel/panel.css')
  })
  it('rejects artifacts without the pre-0.2.3 style fallback', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace(fallbackOf(SHEET_TEXT), ''))
    await expect(inspectArtifacts(directory)).rejects.toThrow('missing pre-0.2.3 style fallback')
  })
  it('rejects a fallback block that drops a declared stylesheet or ignores installed styles', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'client.js'), root.replace('g.textContent="body{}"', 'g.textContent="other{}"'))
    await expect(inspectArtifacts(directory)).rejects.toThrow('fallback dropped a stylesheet')
    // 去掉「已装跳过」后，宿主已注入时会被检出错插。
    const ignoring = fallbackOf(SHEET_TEXT).replace('if(t&&t.indexOf(p)>=0){s=null;break}', '')
    await writeFile(join(directory, 'client.js'), root.replace(fallbackOf(SHEET_TEXT), ignoring))
    await expect(inspectArtifacts(directory)).rejects.toThrow('duplicated styles')
  })
})

const loaderPath = process.env.EDRV_MODULE_LOADER
const artifactDir = process.env.EDRV_ARTIFACT_DIR

describe('explicit actual Host loader validation', () => {
  it.skipIf(!loaderPath)('uses actual ClientModuleSystem for URL, cache, retry, and HMR fixtures (requires EDRV_MODULE_LOADER)', async () => {
    const evidence = await verifyNativeLoader(await inspectArtifacts(await fixture()), loaderPath!)
    expect(evidence.arrivals).toHaveLength(5)
    expect(evidence.arrivals.at(-1)).toContain('client.rules.js?rev=two')
  })
  it.skipIf(!artifactDir)('validates explicitly requested real build artifacts (requires EDRV_ARTIFACT_DIR)', async () => {
    const evidence = await checkArtifacts(artifactDir!, loaderPath)
    expect(evidence.bytes['client.rules.js']).toBeGreaterThan(0)
    expect(evidence.bytes['client.debug.js']).toBeGreaterThan(0)
    if (loaderPath) expect(evidence.native.loader).toBe('actual ClientModuleSystem')
  })
})

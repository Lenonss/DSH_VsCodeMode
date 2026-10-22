import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript'

const OWNER = 'dsh-vscode-mode'
const CHUNKS = ['client.rules.js', 'client.debug.js']
const SHARED = ['rpc', 'dbg', 'dapStore', 'BP_MODE', 'MODES', 'fieldOfMode', 'ContextMenu']

/** @private @author ddj 2026年10月22号 @param source Bundle source. @param filename Diagnostic filename. @returns Registration without materializing its factory. */
function registration(source, filename) {
  const rows = []
  const context = createContext({ window: { __ModuleLoader__: { load(row) { rows.push(row) } } } })
  runInContext(source, context, { filename, timeout: 5000 })
  assert.equal(rows.length, 1, `${filename}: expected exactly one registration`)
  assert.equal(rows[0].id, OWNER, `${filename}: wrong owner`)
  assert.equal(typeof rows[0].factory, 'function', `${filename}: missing factory`)
  return rows[0]
}

/** @private @author ddj 2026年10月22号 @returns Explicit platform seeds; unknown externals never silently resolve. */
function platformSeeds() {
  const react = { memo: (component) => component, forwardRef: (component) => component,
    createContext: () => ({ Provider() {}, Consumer() {} }), Component: class {}, PureComponent: class {} }
  return { react, 'react-dom': {}, 'react-dom/client': {}, '@deepseek-ai/dsh-client-ui-primitives': {} }
}

/** @private @author ddj 2026年10月22号 @param source JavaScript source. @param name Filename. @param allowed Permitted externals. @returns Reject unsupported executable imports, ignoring comments and literals. */
function verifySyntax(source, name, allowed) {
  const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0, `${name}: malformed JavaScript`)
  /** @private @author ddj 2026年10月22号 @param node Parsed syntax node. @returns Validate executable import and external calls recursively. */
  function visit(node) {
    assert.ok(!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node), `${name}: bare ESM is unsupported`)
    if (ts.isCallExpression(node)) {
      assert.notEqual(node.expression.kind, ts.SyntaxKind.ImportKeyword, `${name}: native ESM dynamic import is unsupported`)
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const specifier = node.arguments[0]
        assert.ok(specifier && ts.isStringLiteral(specifier), `${name}: computed require is unsupported`)
        assert.ok(allowed.has(specifier.text), `${name}: unexpected external ${specifier.text}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}

/** @private @author ddj 2026年10月22号 @param source Host ESM source. @returns Validate public plugin export shape without executing imports or apply. */
function verifyHost(source) {
  const ast = ts.createSourceFile('index.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0, 'index.js: malformed JavaScript')
  const exports = new Map()
  for (const statement of ast.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) exports.set(element.name.text, element.propertyName?.text ?? element.name.text)
    }
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) && statement.name) exports.set(statement.name.text, statement.name.text)
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) exports.set(declaration.name.text, declaration.name.text)
      }
    }
  }
  for (const key of ['name', 'apply', 'inject']) assert.ok(exports.has(key), `index.js: missing plugin export ${key}`)
  const applyName = exports.get('apply')
  assert.ok(ast.statements.some((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === applyName), 'index.js: apply export must resolve to a function declaration')
}

/** @private @author ddj 2026年10月22号 @param row Captured chunk factory. @param name Chunk filename. @returns Verify factory reads shared root objects rather than a private copy. */
function verifySharedReads(row, name) {
  const reads = new Set()
  const shared = new Proxy(Object.fromEntries(SHARED.map((key) => [key, Object.freeze({ key })])), {
    get(target, key) { reads.add(key); assert.ok(key in target, `Unknown shared key: ${String(key)}`); return target[key] },
  })
  const seeds = platformSeeds()
  const exported = row.factory((specifier) => {
    if (specifier === OWNER) return { __lazyShared: shared }
    assert.equal(specifier, 'react', `${name}: chunk external drift`)
    return seeds.react
  })
  const expected = name === 'client.debug.js' ? ['dapStore', 'BP_MODE', 'MODES', 'fieldOfMode', 'ContextMenu', 'rpc'] : ['rpc']
  for (const key of expected) assert.ok(reads.has(key), `${name}: did not consume root shared ${key}`)
  assert.equal(typeof exported?.[name === 'client.rules.js' ? 'RulesPanel' : 'DebugPanel'], 'function', `${name}: missing panel export`)
}

/** @public @author ddj 2026年10月22号 @param libDir Read-only artifact directory. @returns Validated registrations and artifact byte counts. @throws Invalid or missing artifact. */
export async function inspectArtifacts(libDir) {
  const sources = {}
  const bytes = {}
  for (const name of ['index.js', 'client.js', ...CHUNKS]) {
    const source = await readFile(join(libDir, name), 'utf8')
    assert.ok(source.trim(), `${name}: empty artifact`)
    sources[name] = source
    bytes[name] = Buffer.byteLength(source)
  }
  verifyHost(sources['index.js'])
  for (const name of ['client.js', ...CHUNKS]) {
    const allowed = new Set(name === 'client.js' ? Object.keys(platformSeeds()) : ['react', OWNER])
    verifySyntax(sources[name], name, allowed)
  }
  const root = registration(sources['client.js'], 'client.js')
  assert.equal(root.chunk, undefined, 'root must not register as a chunk')
  const chunks = CHUNKS.map((name) => {
    const row = registration(sources[name], name)
    assert.equal(row.chunk, name, `${name}: wrong chunk registration`)
    assert.match(sources[name], /require\(["']dsh-vscode-mode["']\)/, `${name}: missing shared root dependency`)
    assert.match(sources[name], /__lazyShared/, `${name}: missing shared bridge`)
    assert.doesNotMatch(sources[name], /function\s+(rpc|createDapStore)\s*\(/, `${name}: duplicated singleton implementation`)
    verifySharedReads(row, name)
    return row
  })
  assert.match(sources['client.js'], /require\.async\??\.bind\(require\)/, 'root must inject native asynchronous require')
  return { root, chunks, sources, bytes }
}

/** @private @author ddj 2026年10月22号 @param source Official loader bundle. @returns Actual exported loader class, not a reimplementation. */
function readLoader(source) {
  let exported
  const context = createContext({ console, window: { __ModuleLoader__: { load(row) {
    exported = row.factory((name) => { throw new Error(`Unexpected loader dependency: ${name}`) })
  } } } })
  runInContext(source, context, { filename: 'official-client-modules.js', timeout: 5000 })
  assert.equal(typeof exported?.ClientModuleSystem, 'function', 'official loader did not export ClientModuleSystem')
  assert.equal(typeof exported?.createClientModuleSystem, 'function', 'official loader contract changed')
  return exported.ClientModuleSystem
}

/** @public @author ddj 2026年10月22号 @param artifacts Inspected artifacts. @param loaderPath Explicit real Host loader path. @returns Native loader URL/cache/retry/HMR evidence. @throws Runtime contract mismatch. */
export async function verifyNativeLoader(artifacts, loaderPath) {
  const ModuleSystem = readLoader(await readFile(loaderPath, 'utf8'))
  const arrivals = []
  let failNext = false
  const target = { mode: 'queue', pendingQueue: [artifacts.root] }
  const row = { id: OWNER, url: `/base/??${OWNER}/client.js&rev=one`, rev: 'one', inject: [], external: [] }
  /** @private @author ddj 2026年10月22号 @param url Native resource URL. @returns Register requested artifact or simulate one transport failure. */
  async function loadBundle(url) {
    arrivals.push(url)
    if (failNext) { failNext = false; throw new Error('fixture transport failure') }
    const filename = url.includes('/??') ? 'client.js' : url.split('/').pop().split('?')[0]
    const index = CHUNKS.indexOf(filename)
    assert.ok(filename === 'client.js' || index >= 0, `Unexpected resource URL: ${url}`)
    target.load(filename === 'client.js' ? artifacts.root : artifacts.chunks[index])
  }
  const system = new ModuleSystem({ manifest: { rev: 'one', modules: [row], plugins: [] },
    staticModules: platformSeeds(), bootstrapModule: { id: 'fixture-bootstrap', exports: {} },
    registrationTarget: target, loadBundle })
  const root = await system.import(OWNER)
  assert.equal(typeof root.__setPanelImport, 'function', 'missing panel import setter')
  for (const key of SHARED) assert.ok(root.__lazyShared?.[key] !== undefined, `missing shared export: ${key}`)
  const nativeRequire = system.makeRequire(OWNER, new Set())
  const [first, concurrent] = await Promise.all([nativeRequire.async('./client.rules.js'), nativeRequire.async('./client.rules.js')])
  assert.equal(first, concurrent, 'concurrent loads must reuse materialized exports')
  assert.equal(typeof first.RulesPanel, 'function', 'missing RulesPanel')
  assert.equal(arrivals.length, 1, 'concurrent chunk requests must share transport')
  assert.equal(arrivals[0], `/base/${OWNER}/client.rules.js?rev=one`)
  failNext = true
  await assert.rejects(nativeRequire.async('./client.debug.js'), /fixture transport failure/)
  const debug = await nativeRequire.async('./client.debug.js')
  assert.equal(typeof debug.DebugPanel, 'function', 'missing DebugPanel after retry')
  assert.equal(await nativeRequire.async('./client.debug.js'), debug)
  assert.equal(arrivals.length, 3, 'failed transport must be retryable and success cached')
  system.invalidate(OWNER, 'two')
  assert.equal(system.loadCache.has(`${OWNER}/client.rules.js`), false, 'HMR must drop chunk cache')
  const replacement = await system.import(OWNER)
  assert.notEqual(replacement, root, 'HMR must replace root exports')
  const refreshed = await system.makeRequire(OWNER, new Set()).async('./client.rules.js')
  assert.notEqual(refreshed, first, 'HMR must replace chunk exports')
  assert.equal(arrivals.at(-1), `/base/${OWNER}/client.rules.js?rev=two`)
  return { arrivals, sharedKeys: SHARED, loader: 'actual ClientModuleSystem' }
}

/** @public @author ddj 2026年10月22号 @param libDir Artifact directory. @param loaderPath Optional explicit Host bundle. @returns Validation evidence; native validation omission is explicit. */
export async function checkArtifacts(libDir, loaderPath) {
  const artifacts = await inspectArtifacts(resolve(libDir))
  const native = loaderPath ? await verifyNativeLoader(artifacts, loaderPath) : { skipped: 'Set EDRV_MODULE_LOADER to validate the actual Host loader' }
  return { directory: resolve(libDir), bytes: artifacts.bytes, native }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await checkArtifacts(process.argv[2] ?? 'lib', process.env.EDRV_MODULE_LOADER), null, 2))
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  }
}

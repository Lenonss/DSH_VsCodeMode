/** Package-local CJS chunk loading; transport, revision URLs and HMR belong to DSH. @author ddj 2026年10月22号 */
import React from 'react'
import type { SidebarCtx } from './sidebar/types.js'

type Panel = React.ComponentType<{ ctx: SidebarCtx }>
type PanelKey = 'rules' | 'debug'
type ChunkExports = Record<string, unknown>
type ChunkImport = (file: string) => Promise<ChunkExports>
interface ChunkLoad<T> { pending?: Promise<T>; value?: T }
const FILES = { rules: './client.rules.js', debug: './client.debug.js' } as const
const EXPORTS = { rules: 'RulesPanel', debug: 'DebugPanel' } as const
const loads = new Map<string, ChunkLoad<unknown>>()
let generation = 0
let importer: ChunkImport | undefined

/** @public @author ddj 2026年10月22号 @param transport Injected ModuleLoader require.async, never a global require. @description Start a new plugin generation and discard older results. */
export function setPanelImport(transport?: ChunkImport): void {
  generation++
  loads.clear()
  importer = transport
}

/** @private @author ddj 2026年11月10号 @param file Chunk file relative to the root module. @param pick Projection from raw chunk exports. @returns Shared pending load or cached projection; failures are never cached. */
function loadModule<T>(file: string, pick: (exports: ChunkExports) => T): Promise<T> {
  const cached = loads.get(file) as ChunkLoad<T> | undefined
  if (cached?.value !== undefined) return Promise.resolve(cached.value)
  if (cached?.pending) return cached.pending
  if (!importer) return Promise.reject(new Error('当前 DSH 不支持包内面板加载，请升级宿主'))

  const epoch = generation
  const transport = importer
  const state: ChunkLoad<T> = {}
  const pending = Promise.resolve().then(() => transport(file)).then((exports) => {
    const value = pick(exports)
    if (epoch !== generation) throw new Error('面板加载已失效，请重试')
    state.value = value
    return value
  }).catch((error) => {
    if (loads.get(file) === state) loads.delete(file)
    throw error
  })
  state.pending = pending
  loads.set(file, state as ChunkLoad<unknown>)
  return pending
}

/** @public @author ddj 2026年11月10号 @param file Chunk file relative to the root module. @returns Raw exports, cached per file; used by non-React boundaries such as the Excel engine and codec. */
export function loadChunk(file: string): Promise<ChunkExports> {
  return loadModule(file, (exports) => exports)
}

/** @public @author ddj 2026年10月22号 @param key Fixed built-in panel key. @returns Shared pending load or cached component. @throws Unsupported loader or invalid chunk export. */
export function loadPanel(key: PanelKey): Promise<Panel> {
  return loadModule(FILES[key], (exports) => {
    const component = exports[EXPORTS[key]]
    if (typeof component !== 'function') throw new Error('面板脚本缺少组件导出')
    return component as Panel
  })
}

/** @public @author ddj 2026年10月22号 @param props Fixed panel and current context. @returns Loading, explicit retry, or the loaded panel subtree. */
export function LazyPanel(props: { panel: PanelKey; ctx: SidebarCtx }): React.ReactElement {
  const [attempt, retry] = React.useState(0)
  const [view, setView] = React.useState<{ component?: Panel; error?: string }>({})
  /** @private @author ddj 2026年10月22号 @returns Cleanup invalidating callbacks after switch or unmount. */
  function loadEffect(): () => void {
    let active = true
    setView({})
    /** @author ddj 2026年10月22号 @param component Loaded panel. */
    function ready(component: Panel): void { if (active) setView({ component }) }
    /** @author ddj 2026年10月22号 @param error Loader failure. */
    function failed(error: unknown): void { if (active) setView({ error: String(error) }) }
    void loadPanel(props.panel).then(ready, failed)
    return () => { active = false }
  }
  React.useEffect(loadEffect, [props.panel, attempt])
  /** @private @author ddj 2026年10月22号 @description Explicit retry; failures never loop automatically. */
  function onRetry(): void { retry(attempt + 1) }
  if (view.component) return React.createElement(view.component, { ctx: props.ctx })
  return React.createElement('div', { className: 'edrv-empty', role: view.error ? 'alert' : 'status' },
    view.error ?? '正在加载面板…', view.error && React.createElement('button', { onClick: onRetry }, '重试'))
}

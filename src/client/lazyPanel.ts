/** Package-local CJS panel loading; transport, revision URLs and HMR belong to DSH. @author ddj 2026年10月22号 */
import React from 'react'
import type { SidebarCtx } from './sidebar/types.js'

type Panel = React.ComponentType<{ ctx: SidebarCtx }>
type PanelKey = 'rules' | 'debug'
type PanelImport = (file: string) => Promise<Record<string, unknown>>
interface PanelLoad { pending?: Promise<Panel>; component?: Panel }
const FILES = { rules: './client.rules.js', debug: './client.debug.js' } as const
const EXPORTS = { rules: 'RulesPanel', debug: 'DebugPanel' } as const
const loads = new Map<PanelKey, PanelLoad>()
let generation = 0
let importer: PanelImport | undefined

/** @public @author ddj 2026年10月22号 @param transport Injected ModuleLoader require.async, never a global require. @description Start a new plugin generation and discard older results. */
export function setPanelImport(transport?: PanelImport): void {
  generation++
  loads.clear()
  importer = transport
}

/** @public @author ddj 2026年10月22号 @param key Fixed built-in panel key. @returns Shared pending load or cached component. @throws Unsupported loader or invalid chunk export. */
export function loadPanel(key: PanelKey): Promise<Panel> {
  const cached = loads.get(key)
  if (cached?.component) return Promise.resolve(cached.component)
  if (cached?.pending) return cached.pending
  if (!importer) return Promise.reject(new Error('当前 DSH 不支持包内面板加载，请升级宿主'))

  const epoch = generation
  const transport = importer
  const state: PanelLoad = {}
  const pending = Promise.resolve().then(() => transport(FILES[key])).then((exports) => {
    const component = exports[EXPORTS[key]]
    if (typeof component !== 'function') throw new Error('面板脚本缺少组件导出')
    if (epoch !== generation) throw new Error('面板加载已失效，请重试')
    state.component = component as Panel
    return state.component
  }).catch((error) => {
    if (loads.get(key) === state) loads.delete(key)
    throw error
  })
  state.pending = pending
  loads.set(key, state)
  return pending
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

import React from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react', async (original) => {
  const real = await original<typeof import('react')>()
  return { ...real, default: { ...real.default,
    useState: (value: any) => [typeof value === 'function' ? value() : value, vi.fn()],
    useRef: (value: any) => ({ current: value }),
    useMemo: (factory: any) => factory(), useCallback: (fn: any) => fn,
    useEffect: vi.fn(), useLayoutEffect: vi.fn(),
  } }
})
vi.mock('../src/client/sidebar/panels/useExplorerSvn.js', () => ({
  useExplorerSvn: () => ({ local: null, remote: null, message: '', canCheck: false, busy: true, checkRemote: vi.fn() }),
}))
vi.mock('../src/client/sidebar/panels/useExplorerReveal.js', () => ({
  useExplorerReveal: () => ({ revealPath: null }), treeRevealPath: () => null,
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: 'toolbar-button' }))
vi.mock('../src/client/ui/icons.js', () => ({
  IconFolderClose16: null, IconFolderOpen16: null, IconRefreshOutline16: null, fileIconEl: () => null,
}))
import { FileExplorer } from '../src/client/sidebar/panels/FileExplorer.js'
import { SvnPanel } from '../src/client/sidebar/panels/SvnPanel.js'

/** @private @author ddj 2026年10月15号 @param node Production element tree. @returns Flattened elements without mounting side effects. */
function flatten(node: any): any[] {
  if (Array.isArray(node)) return node.flatMap(flatten)
  if (!React.isValidElement(node)) return []
  return [node, ...flatten((node.props as any).children)]
}
/** @private @author ddj 2026年10月15号 @param component Panel component. @param options Capability overrides. @returns Actual rendered root-update button and callback spy. */
function panelButton(component: any, options: Record<string, any> = {}) {
  const openSvnUpdate = vi.fn()
  const ctx = { scope: 'entry-test', sessionId: 's', pendingByPath: {}, svnChanges: [],
    svn: { managed: true, svnCli: true }, openSvnUpdate, ...options }
  const nodes = flatten(component({ ctx }))
  return { button: nodes.find((node) => node.props['aria-label'] === '更新项目'), openSvnUpdate }
}

describe.each([['explorer', FileExplorer], ['changes', SvnPanel]] as const)('%s project update entry', (_, component) => {
  it('opens the shared plugin window at the project root even without local changes or a completed scan', () => {
    const { button, openSvnUpdate } = panelButton(component)
    expect(button).toBeDefined()
    expect(button.props.disabled).toBe(false)
    expect(button.props.title).toContain('打开 SVN 更新窗口')
    button.props.onClick()
    expect(openSvnUpdate.mock.calls).toEqual([['']])
  })
  it('disables the entry without CLI or a window callback', () => {
    expect(panelButton(component, { svn: { managed: true, svnCli: false } }).button.props.disabled).toBe(true)
    const { button } = panelButton(component, { openSvnUpdate: undefined })
    expect(button.props.disabled).toBe(true)
    expect(() => button.props.onClick()).not.toThrow()
  })
})
it('hides the explorer update entry for non-SVN and unknown projects', () => {
  expect(panelButton(FileExplorer, { svn: null }).button).toBeUndefined()
  expect(panelButton(FileExplorer, { svn: { managed: false, svnCli: true } }).button).toBeUndefined()
})

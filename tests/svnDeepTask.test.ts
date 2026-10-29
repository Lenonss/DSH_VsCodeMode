/** Real SVN button result decisions under isolated IO, not real Host acceptance. @author ddj 2026年10月29号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface HookMemo { deps?: unknown[]; result: unknown }
interface HookEffect { deps?: unknown[]; cleanup?: () => void }
interface PanelNode { type: unknown; props: Record<string, any>; children: unknown[] }
interface CallerCase { label: string; created: boolean; status: string; appended: 'ok' | 'unavailable'; draft: boolean }
const hooks = vi.hoisted(() => ({ slots: [] as any[], cursor: 0, effects: [] as HookEffect[], effectCursor: 0, commits: [] as Array<() => void>, poll: vi.fn(), forbidden: vi.fn() }))
vi.mock('react', () => ({ default: {
  memo: (component: unknown) => component,
  createElement: (type: unknown, props: Record<string, any>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
  useState: stateHook, useRef: refHook, useMemo: memoHook,
  useCallback: (callback: unknown, deps?: unknown[]) => memoHook(() => callback, deps),
  useEffect: effectHook,
} }))
vi.mock('../src/client/ui/icons.js', () => ({ IconRefreshOutline16: null, fileIconEl: () => null }))
vi.mock('../src/client/ui/ContextMenu.js', () => ({ ContextMenu: 'context-menu' }))
vi.mock('../src/client/ui/SvnAiPlanDialog.js', () => ({ SvnAiPlanDialog: 'plan-dialog' }))
vi.mock('../src/client/svnStatus.js', () => ({
  svnAiPlanPending: hooks.poll, svnChangesCapped: () => false,
  svnFileSizes: hooks.forbidden, refreshSvnChanges: hooks.forbidden, runPlanSteps: hooks.forbidden,
  svnAdd: hooks.forbidden, svnAiPlan: hooks.forbidden, svnChangelist: hooks.forbidden,
  svnConflictArtifacts: hooks.forbidden, svnIgnore: hooks.forbidden, svnRemoteStatus: hooks.forbidden, svnRevert: hooks.forbidden,
}))
import { SvnPanel } from '../src/client/sidebar/panels/SvnPanel.js'
import { createAddToConversation } from '../src/client/addToConversation.js'
import { buildAgentPrompt } from '../src/shared/svn.js'

/** @private @author ddj 2026年10月29号 @param initial Initial state. @returns Persistent state and setter. */
function stateHook(initial: any): [any, (next: any) => void] {
  const index = hooks.cursor++
  if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? initial() : initial
  /** @private @author ddj 2026年10月29号 @param next State or update function. Updates the owned hook slot. */
  function setState(next: any): void { hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next }
  return [hooks.slots[index], setState]
}
/** @private @author ddj 2026年10月29号 @param initial Initial reference. @returns Persistent reference object. */
function refHook(initial: unknown): { current: unknown } {
  const index = hooks.cursor++
  if (!(index in hooks.slots)) hooks.slots[index] = { current: initial }
  return hooks.slots[index]
}
/** @private @author ddj 2026年10月29号 @param previous Last dependency list. @param next Current list. @returns Whether React dependency identity is unchanged. */
function sameDeps(previous?: unknown[], next?: unknown[]): boolean {
  return Boolean(previous && next && previous.length === next.length && next.every((entry, index) => Object.is(entry, previous[index])))
}
/** @private @author ddj 2026年10月29号 @param factory Value factory. @param deps Hook dependencies. @returns Dependency-cached value or original callback. */
function memoHook(factory: () => unknown, deps?: unknown[]): unknown {
  const index = hooks.cursor++
  const previous = hooks.slots[index] as HookMemo | undefined
  if (!previous || !sameDeps(previous.deps, deps)) hooks.slots[index] = { deps, result: factory() }
  return hooks.slots[index].result
}
/** @private @author ddj 2026年10月29号 @param effect Commit effect. @param deps Hook dependencies. Queues cleanup and the new effect. */
function effectHook(effect: () => (() => void) | void, deps?: unknown[]): void {
  const index = hooks.effectCursor++
  const previous = hooks.effects[index]
  if (previous && sameDeps(previous.deps, deps)) return
  /** @private @author ddj 2026年10月29号 Commits one effect after the real component render. */
  function commit(): void {
    previous?.cleanup?.()
    hooks.effects[index] = { deps, cleanup: effect() || undefined }
  }
  hooks.commits.push(commit)
}
/** @private @author ddj 2026年10月29号 @param branch Synthetic element branch. @returns Nodes without invoking child components. */
function flatten(branch: unknown): PanelNode[] {
  if (Array.isArray(branch)) return branch.flatMap(flatten)
  if (!branch || typeof branch !== 'object' || !('children' in branch)) return []
  const node = branch as PanelNode
  return [node, ...flatten(node.children)]
}
/** @private @author ddj 2026年10月29号 @param ctx Isolated actual panel context. @returns Real component tree after effect commit. */
function renderPanel(ctx: any): PanelNode[] {
  hooks.cursor = 0
  hooks.effectCursor = 0
  const nodes = flatten(SvnPanel({ ctx }))
  for (const commit of hooks.commits.splice(0)) commit()
  return nodes
}
/** @private @author ddj 2026年10月29号 @param nodes Real component nodes. @returns Unique deep-analysis button. */
function deepButton(nodes: PanelNode[]): PanelNode {
  const buttons = nodes.filter((node) => node.type === 'button' && node.children.includes('深度分析'))
  expect(buttons).toHaveLength(1)
  return buttons[0]
}
/** @private @author ddj 2026年10月29号 @param ctx Isolated context. @returns Rendered state after bounded Promise microtasks; void onClick is not awaited. */
async function flushPanel(ctx: any): Promise<PanelNode[]> {
  for (let step = 0; step < 8; step += 1) await Promise.resolve()
  return renderPanel(ctx)
}
/** @private @author ddj 2026年10月29号 @param scenario Controlled caller receipt. @returns IO-free context with spies wired to the actual panel. */
function callerContext(scenario: CallerCase) {
  const addToConversation = {
    startDraftSession: vi.fn().mockResolvedValue({ ok: scenario.created, id: scenario.created ? 'target-session' : undefined }),
    sendTask: vi.fn().mockResolvedValue(true),
    sendTaskResult: vi.fn().mockResolvedValue({ status: scenario.status, legacyOk: true }),
    appendText: vi.fn().mockResolvedValue(scenario.appended),
  }
  return { scope: 'workspace', sessionId: 'current-session', svn: { managed: true, svnCli: true, wcRoot: '/isolated-wc' },
    svnChanges: [{ path: 'changed.ts', status: 'modified', versioned: true }], addToConversation, notify: vi.fn() }
}
/** @private @author ddj 2026年10月29号 @param ctx Actual panel input. @param scenario Receipt scenario. Checks targets, exact prompt and side-effect counts. */
function assertCalls(ctx: ReturnType<typeof callerContext>, scenario: CallerCase): void {
  const add = ctx.addToConversation
  expect(add.startDraftSession).toHaveBeenCalledExactlyOnceWith('/isolated-wc')
  expect(add.sendTask).not.toHaveBeenCalled()
  expect(add.sendTaskResult).toHaveBeenCalledTimes(Number(scenario.created))
  if (scenario.created) expect(add.sendTaskResult).toHaveBeenCalledWith('target-session', buildAgentPrompt('/isolated-wc', 'target-session'))
  expect(add.appendText).toHaveBeenCalledTimes(Number(scenario.draft))
  if (scenario.draft) expect(add.appendText).toHaveBeenCalledWith('current-session', buildAgentPrompt('/isolated-wc', 'current-session'))
}
/** @private @author ddj 2026年10月29号 @param ctx Actual panel input. @param waiting Expected pre-fix waiting state. @returns One fake tick and observable rendered state. */
async function assertPolling(ctx: ReturnType<typeof callerContext>, waiting: boolean): Promise<void> {
  const nodes = await flushPanel(ctx)
  expect(deepButton(nodes).props.disabled).toBe(waiting)
  expect(nodes.some((node) => node.children.includes('等待助手投递…'))).toBe(waiting)
  expect(vi.getTimerCount()).toBe(Number(waiting))
  expect(hooks.poll).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3000)
  expect(hooks.poll).toHaveBeenCalledTimes(Number(waiting))
  if (waiting) expect(hooks.poll).toHaveBeenCalledWith('current-session', new Date('2026-10-29T04:00:00Z').getTime())
  expect(hooks.forbidden).not.toHaveBeenCalled()
}
/** @private @author ddj 2026年10月29号 Installs only isolated browser state and fail-closed IO traps. */
function setup(): void {
  hooks.slots = []; hooks.effects = []; hooks.commits = []
  vi.clearAllMocks()
  hooks.poll.mockResolvedValue({ ok: true })
  hooks.forbidden.mockImplementation(() => { throw new Error('Unexpected diagnostic IO') })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T04:00:00Z'))
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: hooks.forbidden }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('fetch', hooks.forbidden)
}
/** @private @author ddj 2026年10月29号 Unmounts every effect and verifies timer cleanup before restoring globals. */
function cleanup(): void {
  try {
    for (const effect of hooks.effects) effect?.cleanup?.()
    expect(hooks.commits).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  }
}
beforeEach(setup)
afterEach(cleanup)

const scenarios: CallerCase[] = [
  { label: 'rejected only inserts an honest current draft', created: true, status: 'rejected', appended: 'ok', draft: true },
  { label: 'unavailable only inserts an honest current draft', created: true, status: 'unavailable', appended: 'ok', draft: true },
  { label: 'creation failure inserts current draft without watching', created: false, status: 'unavailable', appended: 'ok', draft: true },
  { label: 'accepted alone starts watching', created: true, status: 'accepted', appended: 'ok', draft: false },
  { label: 'failed draft reports failure without watching', created: true, status: 'rejected', appended: 'unavailable', draft: true },
  ...['unknown', 'submitted', 'cancelled', 'invalid'].map((status) => ({ label: status + ' never inserts or watches despite legacyOk true', created: true, status, appended: 'ok' as const, draft: false })),
]
describe('SVN deep-analysis detailed-result regression', () => {
  it.each(scenarios)('$label', async (scenario) => {
    const ctx = callerContext(scenario)
    const button = deepButton(renderPanel(ctx))
    expect(button.props.disabled).toBe(false)
    button.props.onClick()
    await flushPanel(ctx)
    assertCalls(ctx, scenario)

    const waiting = scenario.status === 'accepted'
    if (waiting) expect(ctx.notify).toHaveBeenCalledWith('已在新会话「AI 深度分析」受理任务，请在左侧会话列表点开查看进度')
    else if (scenario.draft && scenario.appended === 'ok') expect(ctx.notify).toHaveBeenCalledWith('已填入当前草稿，请手动发送')
    else if (scenario.draft) expect(ctx.notify).toHaveBeenCalledWith('发起失败：无会话或输入框不可用')
    else expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('target-session'))
    await assertPolling(ctx, waiting)
    assertCalls(ctx, scenario)
  })

  it.each([true, false])('missing detailed API never invokes old boolean %s or draft', async (legacy) => {
    const ctx = callerContext(scenarios[0])
    delete (ctx.addToConversation as any).sendTaskResult
    ctx.addToConversation.sendTask.mockResolvedValue(legacy)
    deepButton(renderPanel(ctx)).props.onClick()
    await flushPanel(ctx)
    expect(ctx.addToConversation.sendTask).not.toHaveBeenCalled()
    expect(ctx.addToConversation.appendText).not.toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith('发送接口不支持受理确认，本次未自动发送，请手动处理')
    await assertPolling(ctx, false)
  })
  it('a creation exception can only insert a manual current draft', async () => {
    const ctx = callerContext(scenarios[0])
    ctx.addToConversation.startDraftSession.mockRejectedValue(new Error('create unavailable'))
    deepButton(renderPanel(ctx)).props.onClick()
    await flushPanel(ctx)
    expect(ctx.addToConversation.sendTaskResult).not.toHaveBeenCalled()
    expect(ctx.addToConversation.appendText).toHaveBeenCalledExactlyOnceWith('current-session', buildAgentPrompt('/isolated-wc', 'current-session'))
    expect(ctx.notify).toHaveBeenCalledWith('已填入当前草稿，请手动发送')
    await assertPolling(ctx, false)
  })
  it('a thrown detailed API never falls back', async () => {
    const ctx = callerContext(scenarios[0])
    ctx.addToConversation.sendTaskResult.mockRejectedValue(new Error('unknown'))
    deepButton(renderPanel(ctx)).props.onClick()
    await flushPanel(ctx)
    expect(ctx.addToConversation.appendText).not.toHaveBeenCalled()
    expect(ctx.addToConversation.sendTask).not.toHaveBeenCalled()
    expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('受理未确认'))
    await assertPolling(ctx, false)
  })
  it.each(['false', 'throw'])('real facade prompt %s reaches real caller decision', async (outcome) => {
    const ctx = callerContext(scenarios[0])
    const prompt = vi.fn().mockResolvedValue({ ok: false }), release = vi.fn(), remote = { prompt: vi.fn() }
    if (outcome === 'throw') prompt.mockRejectedValue(new Error('lost receipt'))
    const sessions = { retain: vi.fn(() => ({ ready: Promise.resolve({ session: { prompt } }), release })) }
    const actions = createAddToConversation({ get: (name) => name === 'sessions' ? sessions : remote })
    ctx.addToConversation.sendTaskResult.mockImplementation(actions.sendTaskResult!)
    deepButton(renderPanel(ctx)).props.onClick()
    await flushPanel(ctx)
    expect(prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: buildAgentPrompt('/isolated-wc', 'target-session') }], 'queue', expect.any(AbortSignal))
    expect(release).toHaveBeenCalledTimes(1)
    expect(remote.prompt).not.toHaveBeenCalled()
    expect(ctx.addToConversation.appendText).toHaveBeenCalledTimes(Number(outcome === 'false'))
    if (outcome === 'false') expect(ctx.addToConversation.appendText).toHaveBeenCalledWith('current-session', buildAgentPrompt('/isolated-wc', 'current-session'))
    else expect(ctx.notify).toHaveBeenCalledWith(expect.stringContaining('受理未确认'))
    await assertPolling(ctx, false)
  })

  it('real appendText inserts once without submit, retain, prompt, remote send or setDraft', async () => {
    const input = { state: { getSnapshot: () => ({ draft: '', draftRev: 7 }) }, insertReference: vi.fn(),
      insertText: vi.fn(() => true), setDraft: vi.fn(), submit: vi.fn() }
    const prompt = vi.fn(), remotePrompt = vi.fn(), retain = vi.fn()
    const scope = { session: { prompt } }
    const sessions = { binding: vi.fn(() => ({ ctx: scope })), retain, prompt }
    const conversation = { input: { for: vi.fn(() => input) } }
    const services = { sessions, conversation, 'remote.session': { prompt: remotePrompt } }
    const ctx = { get: (name: string) => services[name as keyof typeof services] }
    expect(await createAddToConversation(ctx).appendText('current-session', '仅草稿任务')).toBe('ok')
    expect(sessions.binding).toHaveBeenCalledExactlyOnceWith('current-session')
    expect(conversation.input.for).toHaveBeenCalledExactlyOnceWith(scope)
    expect(input.insertText).toHaveBeenCalledExactlyOnceWith('仅草稿任务', { start: 0, end: 0, draftRev: 7 })
    for (const send of [input.submit, retain, prompt, remotePrompt, input.setDraft]) expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

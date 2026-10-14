import { describe, expect, it } from 'vitest'
import { editorHeight } from '../src/client/editorLayout.js'

// Existing composer-boundary coverage remains alongside the new group-layout tests.
describe('editorHeight', () => {
  it('uses the composer top as the lower boundary', () => {
    expect(editorHeight(100, 900, 700)).toBe(600)
  })
  it('falls back to the scrollport bottom without a composer', () => {
    expect(editorHeight(100, 900)).toBe(800)
  })
  it('uses the nearer boundary when composer extends below the scrollport', () => {
    expect(editorHeight(100, 900, 980)).toBe(800)
  })
  it('clamps an already covered editor to zero', () => {
    expect(editorHeight(700, 900, 650)).toBe(0)
  })
  it('normalizes invalid geometry without throwing', () => {
    expect(editorHeight(Number.NaN, 900, Number.NaN)).toBe(900)
  })
})
import { clampFloat, createLayout, focusGroup, GROUP_LIMIT, moveTab, ownerOf, parseLayout, returnGroup, syncTabs } from '../src/client/state/editorLayout.js'

describe('editor layout transactions', () => {
  it('migrates legacy selection and preserves fixed records', () => {
    const state = createLayout([{ path: 'a', pinned: true }, { path: 'b' }], 'b')
    expect(state.groups[0]?.active).toBe('b')
    expect(state.groups[0]?.tabs[0]?.pinned).toBe(true)
  })
  it('reorders using original insertion slots without duplicating a file', () => {
    const state = createLayout(['a', 'b', 'c'].map((path) => ({ path })), 'a')
    const next = moveTab(state, 'a', { kind: 'group', group: 'main', index: 3 })
    expect(next.groups[0]?.tabs.map((tab) => tab.path)).toEqual(['b', 'c', 'a'])
    expect(state.groups[0]?.tabs.map((tab) => tab.path)).toEqual(['a', 'b', 'c'])
  })
  it('keeps fixed and unpinned partitions during reordering', () => {
    const state = createLayout([{ path: 'p', pinned: true }, { path: 'a' }, { path: 'b' }])
    expect(moveTab(state, 'b', { kind: 'group', group: 'main', index: 0 }).groups[0]?.tabs.map((tab) => tab.path)).toEqual(['p', 'b', 'a'])
    expect(moveTab(state, 'p', { kind: 'group', group: 'main', index: 3 }).groups[0]?.tabs[0]?.path).toBe('p')
  })
  it.each(['left', 'right', 'top', 'bottom'] as const)('splits to %s and collapses empty auxiliary groups', (edge) => {
    const split = moveTab(createLayout([{ path: 'a' }, { path: 'b' }], 'a'), 'a', { kind: 'split', group: 'main', edge })
    expect(split.groups).toHaveLength(2)
    expect(split.focused).toBe('group-1')
    expect('axis' in split.tree && split.tree.axis).toBe(edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical')
    const back = moveTab(split, 'a', { kind: 'group', group: 'main' })
    expect(back.groups).toHaveLength(1)
    expect(back.tree).toEqual({ group: 'main' })
    expect(back.groups[0]?.tabs).toHaveLength(2)
  })
  it('retains primary empty leaf when the last main tab moves out', () => {
    const state = moveTab(createLayout([{ path: 'a' }]), 'a', { kind: 'split', group: 'main', edge: 'right' })
    expect(state.groups.find((group) => group.id === 'main')?.tabs).toEqual([])
    expect(ownerOf(state, 'a')?.id).toBe('group-1')
  })
  it('returns floating tabs instead of closing files', () => {
    let state = moveTab(createLayout([{ path: 'a', pinned: true }, { path: 'b' }]), 'a', { kind: 'float', rect: { left: 10, top: 20, width: 600, height: 400 } })
    state = moveTab(state, 'b', { kind: 'group', group: state.focused })
    const back = returnGroup(state, state.focused)
    expect(back.floats).toEqual([])
    expect(back.groups[0]?.tabs).toEqual([{ path: 'a', pinned: true }, { path: 'b' }])
  })
  it('rejects invalid targets and enforces total group cap', () => {
    let state = createLayout(Array.from({ length: 10 }, (_, n) => ({ path: String(n) })))
    expect(moveTab(state, '0', { kind: 'group', group: 'missing' })).toBe(state)
    expect(moveTab(state, 'missing', { kind: 'split', group: 'main', edge: 'right' })).toBe(state)
    for (let n = 0; n < GROUP_LIMIT - 1; n++) state = moveTab(state, String(n), { kind: 'split', group: 'main', edge: 'right' })
    expect(state.groups).toHaveLength(GROUP_LIMIT)
    expect(moveTab(state, '8', { kind: 'split', group: 'main', edge: 'right' })).toBe(state)
  })
  it('reconciles opens and closes without mutating the input', () => {
    const state = moveTab(createLayout([{ path: 'a' }, { path: 'b' }]), 'a', { kind: 'split', group: 'main', edge: 'right' })
    const next = syncTabs(state, [{ path: 'b' }, { path: 'c' }], 'c')
    expect(next.groups).toHaveLength(2)
    expect(ownerOf(next, 'c')?.id).toBe('group-1')
    expect(ownerOf(state, 'a')?.id).toBe('group-1')
    expect(ownerOf(state, 'c')).toBeUndefined()
  })
  it('focuses only actual groups and paths', () => {
    const state = createLayout([{ path: 'a' }])
    expect(focusGroup(state, 'missing')).toBe(state)
    expect(focusGroup(state, 'main', 'missing')).toBe(state)
  })
})

describe('layout persistence and bounds', () => {
  it('roundtrips nested split and floating state', () => {
    let state = moveTab(createLayout(['a', 'b', 'c'].map((path) => ({ path }))), 'a', { kind: 'split', group: 'main', edge: 'bottom' })
    state = moveTab(state, 'b', { kind: 'float', rect: { left: 10, top: 20, width: 600, height: 400 } })
    expect(parseLayout(JSON.stringify(state))).toEqual(state)
  })
  it.each([null, '', '{', '{}', '{"v":2}'])('rejects corrupted or unsupported layout %s', (text) => {
    expect(parseLayout(text)).toBeNull()
  })
  it('rejects duplicate paths and missing leaves', () => {
    const state = createLayout([{ path: 'a' }])
    const invalid = { ...state, serial: 1, groups: [...state.groups, { id: 'group-1', tabs: [{ path: 'a' }], active: 'a' }] }
    expect(parseLayout(JSON.stringify(invalid))).toBeNull()
    invalid.groups[1]!.tabs = [{ path: 'b' }]
    expect(parseLayout(JSON.stringify(invalid))).toBeNull()
  })
  it('normalizes workspace paths when restoring', () => {
    const state = createLayout([{ path: 'D:/work/a.ts' }], 'D:/work/a.ts')
    expect(parseLayout(JSON.stringify(state), 'D:/work')?.groups[0]?.active).toBe('a.ts')
  })
  it('keeps float bounds on small viewport and sanitizes nonfinite values', () => {
    expect(clampFloat({ left: 2000, top: 2000, width: 1000, height: 1000 }, 300, 200)).toEqual({ left: 0, top: 0, width: 300, height: 200 })
    expect(clampFloat({ left: NaN, top: Infinity, width: NaN, height: Infinity }, 900, 700)).toEqual({ left: 0, top: 0, width: 600, height: 400 })
  })
})

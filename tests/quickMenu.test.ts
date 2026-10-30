import { describe, expect, it } from 'vitest'
import {
  anchorLauncher,
  bindingKey,
  canCreateAt,
  centerScale,
  childrenOf,
  composePrompt,
  defaultDoc,
  depthOf,
  descendantIds,
  inheritWorkspaces,
  itemStatus,
  itemVisibleIn,
  matchWorkspace,
  normalizeDoc,
  normalizePath,
  parseDoc,
  placeColumn,
  serializeDoc,
  validateItem,
  validateRule,
  validateSkill,
} from '../src/shared/quickMenu.js'
import type { QuickButton, QuickMenuDoc, RuleInfo, RuleProject } from '../src/shared/quickMenu.js'

/** 构造一条规则元信息（只覆盖断言需要的字段）。 */
function rule(file: string, extra: Partial<RuleInfo> = {}): RuleInfo {
  return {
    scope: 'user', file, absPath: 'C:\\Users\\1\\.dsh\\rules\\' + file, relHint: 'rules/' + file,
    description: '', type: 'always', globs: [], enabled: true, size: 10, mtime: 1, ...extra,
  }
}

/** 构造一个项目规则聚合。 */
function project(path: string, rules: RuleInfo[], missingDir = false): RuleProject {
  return { workspacePath: path, title: path, rules, missingDir }
}

/** 构造一个按钮项（默认顶层、全部工作区）。 */
function button(id: string, extra: Partial<QuickButton> = {}): QuickButton {
  return {
    id, type: 'button', name: id, order: 100, parentId: null, workspaces: null,
    prompt: '检查提交', skills: [], rules: [], ruleMode: 'reference', ...extra,
  }
}

/** 构造一份含三层结构的文档。 */
function tree(): QuickMenuDoc {
  return normalizeDoc({
    maxDepth: 3,
    items: [
      { id: 'g1', type: 'group', name: '代码审查', order: 10 },
      { id: 'b1', type: 'button', name: '审查改动', order: 10, parentId: 'g1', prompt: '审查' },
      { id: 'b2', type: 'button', name: '顶层按钮', order: 20, prompt: '直接执行' },
      { id: 'g2', type: 'group', name: '子组', order: 20, parentId: 'g1' },
      { id: 'b3', type: 'button', name: '深层按钮', order: 10, parentId: 'g2', prompt: '深层' },
      { id: 'g3', type: 'group', name: '三层组', order: 20, parentId: 'g2' },
    ],
  })
}

describe('normalizeDoc', () => {
  it('falls back to defaults on non-object input', () => {
    const doc = normalizeDoc(null)
    expect(doc.items).toEqual([])
    expect(doc.clickAction).toBe('send')
    expect(doc.maxDepth).toBe(3)
  })
  it('drops duplicate ids and items without id', () => {
    const doc = normalizeDoc({ items: [{ id: 'a', type: 'group' }, { id: 'a', type: 'group' }, { type: 'group' }] })
    expect(doc.items.map((item) => item.id)).toEqual(['a'])
  })
  it('hoists orphan children and children of buttons to root', () => {
    const doc = normalizeDoc({
      items: [
        { id: 'b1', type: 'button', name: 'b1' },
        { id: 'x', type: 'button', name: 'x', parentId: 'b1' },
        { id: 'y', type: 'group', name: 'y', parentId: 'missing' },
      ],
    })
    expect(doc.items.find((item) => item.id === 'x')?.parentId).toBeNull()
    expect(doc.items.find((item) => item.id === 'y')?.parentId).toBeNull()
  })
  it('breaks parent cycles', () => {
    const doc = normalizeDoc({
      items: [
        { id: 'g1', type: 'group', name: 'g1', parentId: 'g2' },
        { id: 'g2', type: 'group', name: 'g2', parentId: 'g1' },
      ],
    })
    const g1 = doc.items.find((item) => item.id === 'g1')
    const g2 = doc.items.find((item) => item.id === 'g2')
    // 至少有一个被上抬到顶层，不能两边互指
    expect(g1?.parentId === null || g2?.parentId === null).toBe(true)
  })
  it('normalizes sibling order to stable steps', () => {
    const doc = normalizeDoc({
      items: [
        { id: 'a', type: 'group', name: 'a', order: 500 },
        { id: 'b', type: 'group', name: 'b', order: 5 },
      ],
    })
    expect(doc.items.find((item) => item.id === 'b')?.order).toBe(10)
    expect(doc.items.find((item) => item.id === 'a')?.order).toBe(20)
  })
  it('clamps maxDepth and truncates over-long text', () => {
    const doc = normalizeDoc({ maxDepth: 99, items: [{ id: 'b', type: 'button', name: 'n'.repeat(60), prompt: 'p'.repeat(9000) }] })
    expect(doc.maxDepth).toBe(5)
    expect(doc.items[0]?.name.length).toBeLessThanOrEqual(40)
    expect((doc.items[0] as QuickButton).prompt.length).toBeLessThanOrEqual(8192)
  })
  it('keeps only kebab-case skills and normalizes workspaces', () => {
    const doc = normalizeDoc({
      items: [{ id: 'b', type: 'button', name: 'b', skills: ['ok-skill', 'Bad_Skill', ''], workspaces: ['D:/Proj/A/', 'd:\\proj\\a'] }],
    })
    const item = doc.items[0] as QuickButton
    expect(item.skills).toEqual(['ok-skill'])
    expect(item.workspaces).toEqual(['d:\\proj\\a'])
  })
})

describe('serializeDoc / parseDoc', () => {
  it('round-trips a document', () => {
    const doc = tree()
    const parsed = parseDoc(serializeDoc(doc))
    expect(parsed.doc.items.length).toBe(doc.items.length)
    expect(parsed.warning).toBeUndefined()
  })
  it('reports a warning and defaults on broken JSON', () => {
    const parsed = parseDoc('{ not json')
    expect(parsed.doc.items).toEqual([])
    expect(parsed.warning).toContain('解析失败')
  })
})

describe('workspace matching', () => {
  it('normalizes separators, trailing slash and case', () => {
    expect(normalizePath('D:/Work/Proj/')).toBe('d:\\work\\proj')
    expect(normalizePath('')).toBe('')
  })
  it('respects directory boundaries', () => {
    expect(matchWorkspace(['C:\\a'], 'C:\\a')).toBe(true)
    expect(matchWorkspace(['C:\\a'], 'C:\\a\\sub')).toBe(true)
    expect(matchWorkspace(['C:\\a'], 'C:\\ab')).toBe(false)
  })
  it('treats null/empty list and unknown cwd as visible', () => {
    expect(matchWorkspace(null, 'C:\\a')).toBe(true)
    expect(matchWorkspace([], 'C:\\a')).toBe(true)
    expect(matchWorkspace(['C:\\a'], '')).toBe(true)
  })
})

describe('tree helpers', () => {
  it('computes depth with root children as level 1', () => {
    const doc = tree()
    expect(depthOf(doc, 'b2')).toBe(1)
    expect(depthOf(doc, 'b1')).toBe(2)
    expect(depthOf(doc, 'b3')).toBe(3)
  })
  it('blocks creating deeper than maxDepth', () => {
    const doc = tree()
    expect(canCreateAt(doc, null)).toBe(true)
    expect(canCreateAt(doc, 'g1')).toBe(true)
    expect(canCreateAt(doc, 'g2')).toBe(true)
    // 三层组下再建子项会到第 4 层，超出 maxDepth=3
    expect(canCreateAt(doc, 'g3')).toBe(false)
  })
  it('lists sorted visible children', () => {
    const doc = tree()
    expect(childrenOf(doc, null).map((item) => item.id)).toEqual(['g1', 'b2'])
    expect(childrenOf(doc, 'g1').map((item) => item.id)).toEqual(['b1', 'g2'])
  })
  it('inherits workspace limit from ancestors', () => {
    const doc = normalizeDoc({
      items: [
        { id: 'g1', type: 'group', name: 'g1', workspaces: ['D:\\proj\\a'] },
        { id: 'b1', type: 'button', name: 'b1', parentId: 'g1' },
        { id: 'g2', type: 'group', name: 'g2', parentId: 'g1', workspaces: ['D:\\proj\\b'] },
        { id: 'b2', type: 'button', name: 'b2', parentId: 'g2' },
      ],
    })
    const byId = (id: string) => doc.items.find((item) => item.id === id)!
    expect(inheritWorkspaces(doc, byId('b1'))).toEqual(['d:\\proj\\a'])
    expect(inheritWorkspaces(doc, byId('b2'))).toEqual(['d:\\proj\\b'])
    expect(itemVisibleIn(doc, byId('b1'), 'D:\\proj\\a\\src')).toBe(true)
    expect(itemVisibleIn(doc, byId('b1'), 'D:\\proj\\b')).toBe(false)
  })
  it('collects descendants for cycle protection', () => {
    const doc = tree()
    expect(descendantIds(doc, 'g1').sort()).toEqual(['b1', 'b3', 'g1', 'g2', 'g3'])
  })
})

describe('binding validation', () => {
  const snapshot = {
    user: [rule('ok.mdc'), rule('off.mdc', { enabled: false }), rule('bad.mdc', { error: 'frontmatter 非法' }), rule('legacy.mdc', { origin: 'legacy' as const })],
    projects: [
      project('D:\\proj\\a', [rule('proj.mdc', { scope: 'project' as const })]),
      project('D:\\proj\\gone', [], true),
    ],
  }
  const ctx = { rules: snapshot, cwd: 'D:\\proj\\a', skillNames: ['frontend-design'] }

  it('passes for an existing enabled rule', () => {
    expect(validateRule({ scope: 'user', file: 'ok.mdc' }, ctx).state).toBe('ok')
  })
  it('reports missing, disabled and broken rules', () => {
    expect(validateRule({ scope: 'user', file: 'gone.mdc' }, ctx).reason).toContain('不存在或已移除')
    expect(validateRule({ scope: 'user', file: 'off.mdc' }, ctx).state).toBe('warn')
    expect(validateRule({ scope: 'user', file: 'bad.mdc' }, ctx).reason).toContain('解析失败')
  })
  it('reports missing project rule directory', () => {
    const status = validateRule({ scope: 'project', workspacePath: 'D:\\proj\\gone', file: 'x.mdc' }, ctx)
    expect(status.state).toBe('error')
    expect(status.reason).toContain('目录不存在')
  })
  it('warns on rules from another workspace', () => {
    const status = validateRule({ scope: 'project', workspacePath: 'D:\\proj\\a', file: 'proj.mdc' }, { ...ctx, cwd: 'D:\\proj\\a' })
    expect(status.state, JSON.stringify(status)).toBe('ok')
    const other = validateRule({ scope: 'project', workspacePath: 'D:\\proj\\a', file: 'proj.mdc' }, { ...ctx, cwd: 'D:\\proj\\b' })
    expect(other.state).toBe('warn')
  })
  it('reports a project rule that does not exist', () => {
    const status = validateRule({ scope: 'project', workspacePath: 'D:\\proj\\a', file: 'ghost.mdc' }, ctx)
    expect(status.state).toBe('error')
  })
  it('returns unknown when the rule snapshot is absent', () => {
    expect(validateRule({ scope: 'user', file: 'ok.mdc' }, {}).state).toBe('unknown')
  })
  it('validates skills by session visibility', () => {
    expect(validateSkill('frontend-design', ctx).state).toBe('ok')
    expect(validateSkill('ghost', ctx).state).toBe('warn')
    expect(validateSkill('ghost', { skillNames: null }).state).toBe('unknown')
  })
  it('aggregates item status', () => {
    const status = itemStatus(button('b', { rules: [{ scope: 'user', file: 'gone.mdc' }], skills: ['ghost'] }), ctx)
    expect(status.errors.length).toBe(1)
    expect(status.warnings.length).toBe(1)
  })
})

describe('validateItem', () => {
  const doc = tree()
  it('rejects empty names and empty payloads', () => {
    const status = validateItem(button('b', { name: '  ', prompt: '' }), doc)
    expect(status.errors.join()).toContain('名称不能为空')
    expect(status.errors.join()).toContain('没有内容可发送')
  })
  it('warns on duplicate sibling names', () => {
    const status = validateItem(button('new', { name: '顶层按钮' }), doc)
    expect(status.warnings.join()).toContain('同名')
  })
  it('rejects a button as parent and self-descendant moves', () => {
    expect(validateItem(button('n1', { parentId: 'b1' }), doc).errors.join()).toContain('只能归属到组')
    expect(validateItem(button('g1', { parentId: 'g2' }), doc).errors.join()).toContain('自己的子组')
  })
  it('rejects creating beyond maxDepth', () => {
    const status = validateItem(button('deep', { parentId: 'g3' }), doc)
    expect(status.errors.join()).toContain('最大嵌套层数')
  })
})

describe('composePrompt', () => {
  const snapshot = {
    user: [rule('style.mdc')],
    projects: [project('D:\\proj\\a', [rule('proj.mdc', { scope: 'project' as const })])],
  }
  const ctx = { rules: snapshot, cwd: 'D:\\proj\\a', skillNames: ['frontend-design'], date: '2026-10-30' }

  it('appends skill tokens on their own line', () => {
    const { text } = composePrompt(button('b', { prompt: '审查 {{workspace}}', skills: ['frontend-design'] }), ctx)
    expect(text).toContain('审查 D:\\proj\\a')
    expect(text.split('\n').some((line) => line === '/frontend-design')).toBe(true)
  })
  it('adds rule references with absolute paths', () => {
    const { text } = composePrompt(button('b', { rules: [{ scope: 'user', file: 'style.mdc' }] }), ctx)
    expect(text).toContain('引用的规则')
    expect(text).toContain('C:\\Users\\1\\.dsh\\rules\\style.mdc')
  })
  it('skips invalid bindings and collects warnings', () => {
    const { text, warnings } = composePrompt(button('b', { rules: [{ scope: 'user', file: 'gone.mdc' }], skills: ['ghost'] }), ctx)
    expect(warnings.length).toBe(2)
    expect(text).not.toContain('gone.mdc')
  })
  it('inlines rule bodies and truncates them', () => {
    const key = bindingKey({ scope: 'user', file: 'style.mdc' })
    const long = 'A'.repeat(9000)
    const { text } = composePrompt(
      button('b', { rules: [{ scope: 'user', file: 'style.mdc' }], ruleMode: 'inline' }),
      { ...ctx, inlineContents: { [key]: long } },
    )
    expect(text).toContain('已绑定规则（节选）')
    expect(text).toContain('…')
  })
  it('warns when inline body is unavailable', () => {
    const { warnings } = composePrompt(button('b', { rules: [{ scope: 'user', file: 'style.mdc' }], ruleMode: 'inline' }), ctx)
    expect(warnings.join()).toContain('未能读取规则正文')
  })
})

describe('geometry', () => {
  it('anchors the launcher above the composer seat', () => {
    const seat = { left: 300, top: 700, width: 600, height: 120 }
    const layer = { left: 0, top: 0, width: 1400, height: 900 }
    const pos = anchorLauncher(seat, layer, { width: 32, height: 32 }, 8)
    expect(pos.left).toBe(300)
    expect(pos.top).toBe(700 - 32 - 8)
  })
  it('clamps a launcher with no seat into the layer', () => {
    const pos = anchorLauncher(null, { left: 0, top: 0, width: 200, height: 100 }, { width: 32, height: 32 }, 8)
    expect(pos).toEqual({ left: 8, top: 8 })
  })
  it('places submenus to the right and flips when overflowing', () => {
    const size = { width: 220, height: 300 }
    const viewport = { width: 1000, height: 800 }
    expect(placeColumn({ left: 10, top: 100, width: 220, height: 300 }, size, viewport).left).toBe(10 + 220 + 6)
    expect(placeColumn({ left: 760, top: 100, width: 220, height: 300 }, size, viewport).left).toBe(760 - 220 - 6)
  })
  it('scales items around the column center', () => {
    expect(centerScale(0, 1).scale).toBe(1)
    const middle = centerScale(2, 5)
    const edge = centerScale(0, 5)
    expect(middle.scale).toBeGreaterThan(edge.scale)
    expect(middle.opacity).toBeGreaterThan(edge.opacity)
    // 幅度上限：中心行略放大但仍留在 220px 列内，边缘行不至于读不清
    expect(middle.scale).toBeGreaterThan(1)
    expect(middle.scale).toBeLessThanOrEqual(1.03)
    expect(edge.scale).toBeGreaterThanOrEqual(0.95)
    expect(edge.opacity).toBeGreaterThanOrEqual(0.6)
  })
})

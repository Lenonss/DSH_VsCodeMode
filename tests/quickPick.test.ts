/**
 * shared/quickPick.ts 测试：工作区下拉摘要 / 多选摘要 / 工作区集合切换。
 *
 * 这三个纯函数决定「下拉触发器上显示什么」与「点一项后列表变成什么」，
 * 放在 vitest 里覆盖，避免只能靠肉眼在弹窗里点。
 * 作者 ddj 2026年10月30号
 */
import { describe, expect, it } from 'vitest'
import { selectionLabel, toggleWorkspace, workspaceLabel } from '../src/shared/quickPick.js'

const WORKSPACE_A = 'D:\\Work\\A'
const WORKSPACE_B = 'D:\\Work\\B'

describe('workspaceLabel', () => {
  it('null 与空数组都表示全部工作区', () => {
    expect(workspaceLabel(null)).toEqual({ mode: 'all', label: '全部工作区', paths: [] })
    expect(workspaceLabel([]).mode).toBe('all')
    expect(workspaceLabel([], WORKSPACE_A).label).toBe('全部工作区')
  })

  it('单个路径等于当前工作区时判为「当前工作区」（大小写与分隔符归一化）', () => {
    const summary = workspaceLabel(['d:/work/a/'], WORKSPACE_A)
    expect(summary.mode).toBe('current')
    expect(summary.label).toBe('当前工作区')
    // 原始路径不被改写，仍回传调用方传入的写法
    expect(summary.paths).toEqual(['d:/work/a/'])
  })

  it('单个路径但无 cwd 时只能落到「已选 1 个」', () => {
    const summary = workspaceLabel([WORKSPACE_A])
    expect(summary.mode).toBe('some')
    expect(summary.label).toBe('已选 1 个工作区')
  })

  it('多个路径判为自定义集合', () => {
    const summary = workspaceLabel([WORKSPACE_A, WORKSPACE_B], WORKSPACE_A)
    expect(summary.mode).toBe('some')
    expect(summary.label).toBe('已选 2 个工作区')
    expect(summary.paths).toHaveLength(2)
  })
})

describe('selectionLabel', () => {
  it('空选择显示未绑定', () => {
    expect(selectionLabel([], '个技能')).toBe('未绑定')
  })

  it('1~2 项全部列出', () => {
    expect(selectionLabel(['alpha'], '个技能')).toBe('alpha')
    expect(selectionLabel(['alpha', 'beta'], '条规则')).toBe('alpha、beta')
  })

  it('超过 2 项折叠成「前两项 等 N 单位」', () => {
    expect(selectionLabel(['alpha', 'beta', 'gamma'], '个技能')).toBe('alpha、beta 等 3 个技能')
  })
})

describe('toggleWorkspace', () => {
  it('从未选状态加入一项', () => {
    expect(toggleWorkspace(null, WORKSPACE_A)).toEqual([WORKSPACE_A])
  })

  it('已存在时移除，且末项移除后回到 null（全部工作区）', () => {
    expect(toggleWorkspace([WORKSPACE_A], WORKSPACE_A)).toBeNull()
    expect(toggleWorkspace([WORKSPACE_A, WORKSPACE_B], WORKSPACE_A)).toEqual([WORKSPACE_B])
  })

  it('按归一化路径去重：同一目录的另一种写法也算已选', () => {
    expect(toggleWorkspace(['d:/work/a'], WORKSPACE_A)).toBeNull()
    expect(toggleWorkspace(['d:/work/a'], WORKSPACE_B)).toEqual(['d:/work/a', WORKSPACE_B])
  })

  it('不修改传入数组', () => {
    const source = [WORKSPACE_A]
    toggleWorkspace(source, WORKSPACE_B)
    expect(source).toEqual([WORKSPACE_A])
  })
})

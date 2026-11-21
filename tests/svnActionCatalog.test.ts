// @ts-nocheck
/**
 * SVN 动作目录中的提交动作单测（22-agent-tools-and-commit）。
 * 守护：提交动作存在且不被状态门禁挡住（资源管理器右键/命令栏/页签/编辑区常驻）、原生提交就绪后隐藏 Tortoise 提交项。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { SVN_ACTION_BY_ID, svnActionCovered, svnActionOn, svnActionsFor } from '../src/shared/svnActions.js'

const ctx = { managed: true, svnCli: true, tortoise: true, target: 'file' }

describe('提交动作', () => {
  it('目录里有 commit，命令 id 与入口齐全', () => {
    const action = SVN_ACTION_BY_ID.commit
    expect(action).toBeTruthy()
    expect(action.commandId).toBe('edrv.svnCommit')
    expect(action.surfaces).toContain('palette')
    expect(action.surfaces).toContain('tree')
    expect(action.surfaces).toContain('tab')
    // 提交动作本身不该带 coveredBy（带了会因 svnFeatures 含 commit 而自我隐藏）
    expect(action.coveredBy).toBeUndefined()
    expect(SVN_ACTION_BY_ID['tortoise-commit'].coveredBy).toBe('commit')
    expect(svnActionsFor('palette').some((item) => item.id === 'commit')).toBe(true)
  })

  it('四入口常驻：不受变更状态门禁（干净文件 / 目录 / 根 / 编辑区都可用）', () => {
    const action = SVN_ACTION_BY_ID.commit
    expect(svnActionOn(action, { ...ctx, status: 'modified' })).toBe(true)
    expect(svnActionOn(action, { ...ctx, status: 'unversioned' })).toBe(true)
    // 命令栏 / 页签 / 编辑区的求值上下文不带 status：按 changed 判会让这些入口整项消失
    expect(svnActionOn(action, { ...ctx, status: 'normal' })).toBe(true)
    expect(svnActionOn(action, { ...ctx, status: undefined })).toBe(true)
    for (const target of ['file', 'directory', 'root', 'editor'] as const) {
      expect(svnActionOn(action, { ...ctx, target }), target).toBe(true)
    }
    // 能力门禁仍然生效（未受管理 / CLI 不可用时整项隐藏）
    expect(svnActionOn(action, { ...ctx, managed: false })).toBe(false)
    expect(svnActionOn(action, { ...ctx, svnCli: false })).toBe(false)
  })

  it('原生提交就绪后隐藏 Tortoise 提交项', () => {
    expect(svnActionCovered(SVN_ACTION_BY_ID['tortoise-commit'], ['commit'])).toBe(true)
    expect(svnActionCovered(SVN_ACTION_BY_ID['tortoise-commit'], [])).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID['tortoise-commit'], { ...ctx, svnFeatures: ['commit'] })).toBe(false)
  })
})

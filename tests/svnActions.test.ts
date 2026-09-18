/**
 * SVN 动作目录（F1 单一事实源）测试。
 *
 * 这层是 P3/P4 复用性的关键：三个入口（命令栏/树菜单/页签菜单）+ 编辑区右键共用同一份
 * 动作元数据与显隐规则，故这里守三件容易静默出错的事：
 * ① **执行器键与动作 id 必须一一对应**——键不匹配时 `runSvnAction` 静默返回 false，
 *    表现为「菜单项点了没反应」（本次重构已实际踩到：id 改名后 runner 键未同步）；
 * ② 能力/目标/状态三类门禁的组合语义（各入口按同一规则求值，不再各自实现）；
 * ③ **自研替换时间线**——自研已有等价能力时必须隐藏对应 Tortoise 项，
 *    否则自研项与官方同名项并列、用户会点到官方弹窗（用户实测反馈的根因）。
 * 作者 ddj 2026-09-16
 */
import { describe, expect, it } from 'vitest'
import {
  SVN_ACTIONS, SVN_ACTION_BY_ID, svnActionCovered, svnActionOn, svnActionsFor, visibleSvnActions,
} from '../src/shared/svnActions.js'
import type { SvnActionContext } from '../src/shared/svnActions.js'
import type { SvnFeature } from '../src/shared/svn.js'

/** 全能力就绪的求值上下文（文件、受版本控制、可比较）。 */
const ready = (over: Partial<SvnActionContext> = {}): SvnActionContext => ({
  managed: true, svnCli: true, tortoise: true, target: 'file', versioned: true, diffable: true, ...over,
})

/** 自研已就绪的能力（P2 差异/还原 + P3 日志）——与 host 的 SVN_FEATURES 保持同一口径。 */
const FEATURES: readonly SvnFeature[] = ['diff', 'revert', 'log']

describe('动作目录结构', () => {
  it('动作 id 唯一（重复会让执行器表与显隐规则互相覆盖）', () => {
    const ids = SVN_ACTIONS.map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('命令栏动作都声明了 commandId（命令注册表需要）', () => {
    for (const action of svnActionsFor('palette')) {
      expect(action.commandId, action.id).toBeTruthy()
    }
  })

  it('id 查表覆盖全部动作', () => {
    for (const action of SVN_ACTIONS) {
      expect(SVN_ACTION_BY_ID[action.id]).toBe(action)
    }
  })

  it('P3 新动作在册：查看日志（三入口）+ 清理（仅命令栏）', () => {
    expect(SVN_ACTION_BY_ID.log?.surfaces).toEqual(expect.arrayContaining(['tree', 'tab', 'palette']))
    expect(SVN_ACTION_BY_ID.cleanup?.surfaces).toEqual(['palette'])
  })

  it('P4 预留：提交动作尚未加入（本阶段不做提交）', () => {
    expect(SVN_ACTION_BY_ID.commit).toBeUndefined()
  })

  it('Tortoise 组首条带分隔线（与 CLI 组视觉分离）', () => {
    expect(SVN_ACTION_BY_ID['tortoise-commit']?.separator).toBe(true)
  })
})

describe('svnActionOn 门禁', () => {
  it('未受管理时一切动作不可用（非 SVN 工作区零曝光）', () => {
    expect(visibleSvnActions('tree', ready({ managed: false }))).toEqual([])
    expect(visibleSvnActions('tab', ready({ managed: false }))).toEqual([])
    expect(visibleSvnActions('palette', ready({ managed: false }))).toEqual([])
  })

  it('能力门禁：CLI 动作需 svnCli，Tortoise 动作需 tortoise', () => {
    const noCli = ready({ svnCli: false })
    expect(svnActionOn(SVN_ACTION_BY_ID.update, noCli)).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID['tortoise-commit'], noCli)).toBe(true)
    const noTortoise = ready({ tortoise: false })
    expect(svnActionOn(SVN_ACTION_BY_ID['tortoise-commit'], noTortoise)).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID.update, noTortoise)).toBe(true)
  })

  it('目标类型门禁：diff-base 仅文件/编辑器，log 不含根，tortoise-commit 含根', () => {
    expect(svnActionOn(SVN_ACTION_BY_ID['diff-base'], ready({ target: 'directory' }))).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID['diff-base'], ready({ target: 'file' }))).toBe(true)
    expect(svnActionOn(SVN_ACTION_BY_ID.log, ready({ target: 'root' }))).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID.log, ready({ target: 'directory' }))).toBe(true)
    expect(svnActionOn(SVN_ACTION_BY_ID['tortoise-commit'], ready({ target: 'root' }))).toBe(true)
  })

  it('状态门禁：add 仅未版本控制；revert 仅已改动且受版本控制', () => {
    expect(svnActionOn(SVN_ACTION_BY_ID.add, ready({ versioned: false }))).toBe(true)
    expect(svnActionOn(SVN_ACTION_BY_ID.add, ready({ versioned: true, status: 'modified' }))).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID['revert-cli'], ready({ status: 'modified' }))).toBe(true)
    // 干净文件（不在变更清单）不出还原项
    expect(svnActionOn(SVN_ACTION_BY_ID['revert-cli'], ready({ status: undefined }))).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID['revert-cli'], ready({ status: 'normal' }))).toBe(false)
    // 未版本控制无改动可还
    expect(svnActionOn(SVN_ACTION_BY_ID['revert-cli'], ready({ versioned: false, status: 'unversioned' }))).toBe(false)
  })

  it('diffable 门禁：二进制文件不出「与基线比较」，但仍可还原', () => {
    const binary = ready({ diffable: false, status: 'modified' })
    expect(svnActionOn(SVN_ACTION_BY_ID['diff-base'], binary)).toBe(false)
    expect(svnActionOn(SVN_ACTION_BY_ID['revert-cli'], binary)).toBe(true)
  })

  it('log 门禁：未版本控制文件无日志', () => {
    expect(svnActionOn(SVN_ACTION_BY_ID.log, ready({ versioned: false, status: 'unversioned' }))).toBe(false)
  })

  it('cleanup 不受目标状态限制（修工作副本锁）', () => {
    for (const status of [undefined, 'modified', 'conflicted', 'unversioned'] as const) {
      expect(svnActionOn(SVN_ACTION_BY_ID.cleanup, ready({ status }))).toBe(true)
    }
  })
})

describe('入口动作表', () => {
  it('三入口动作表按 order 升序', () => {
    for (const surface of ['palette', 'tree', 'tab'] as const) {
      const orders = svnActionsFor(surface).map((action) => action.order)
      expect(orders).toEqual([...orders].sort((a, b) => a - b))
    }
  })

  it('refresh-changes / cleanup 仅命令栏（无目标语义，放菜单会误导）', () => {
    expect(svnActionsFor('tree').some((a) => a.id === 'refresh-changes')).toBe(false)
    expect(svnActionsFor('tab').some((a) => a.id === 'cleanup')).toBe(false)
  })

  it('树与页签入口的 CLI 动作集合一致（避免两处菜单能力不对等）', () => {
    const cliIds = (surface: 'tree' | 'tab') => svnActionsFor(surface)
      .filter((action) => (action.capability ?? 'cli') === 'cli')
      .map((action) => action.id)
    expect(cliIds('tree')).toEqual(cliIds('tab'))
  })

  it('求值结果保持目录顺序（面板/菜单渲染稳定）', () => {
    // 不传 svnFeatures → 自研未声明覆盖，Tortoise 项全部可见（降级口径）
    const visible = visibleSvnActions('tree', ready({ status: 'modified' })).map((a) => a.id)
    expect(visible).toEqual(['update', 'diff-base', 'revert-cli', 'log', 'tortoise-commit', 'tortoise-log', 'tortoise-diff', 'tortoise-blame', 'tortoise-revert'])
  })
})

describe('自研替换时间线（自研就绪项隐藏对应 Tortoise 项）', () => {
  it('覆盖声明齐备：差异/还原/日志三项声明 coveredBy，提交与追溯不声明', () => {
    expect(SVN_ACTION_BY_ID['tortoise-diff']?.coveredBy).toBe('diff')
    expect(SVN_ACTION_BY_ID['tortoise-revert']?.coveredBy).toBe('revert')
    expect(SVN_ACTION_BY_ID['tortoise-log']?.coveredBy).toBe('log')
    // 提交（P4 未做）与追溯（无自研计划）必须保留官方入口
    expect(SVN_ACTION_BY_ID['tortoise-commit']?.coveredBy).toBeUndefined()
    expect(SVN_ACTION_BY_ID['tortoise-blame']?.coveredBy).toBeUndefined()
  })

  it('svnActionCovered：仅当能力集合含 coveredBy 时为真', () => {
    const diff = SVN_ACTION_BY_ID['tortoise-diff']
    expect(svnActionCovered(diff, FEATURES)).toBe(true)
    expect(svnActionCovered(diff, [])).toBe(false)
    expect(svnActionCovered(diff, undefined)).toBe(false)
    expect(svnActionCovered(diff, ['revert'])).toBe(false)
    // 未声明 coveredBy 的动作永不被覆盖
    expect(svnActionCovered(SVN_ACTION_BY_ID['tortoise-commit'], FEATURES)).toBe(false)
  })

  it('自研就绪时：三入口的 Tortoise 差异/还原/日志全部隐藏，提交与追溯保留', () => {
    for (const surface of ['palette', 'tree', 'tab'] as const) {
      const ids = visibleSvnActions(surface, ready({ svnFeatures: FEATURES, status: 'modified' })).map((a) => a.id)
      expect(ids, surface).not.toContain('tortoise-diff')
      expect(ids, surface).not.toContain('tortoise-revert')
      expect(ids, surface).not.toContain('tortoise-log')
      expect(ids, surface).toContain('tortoise-commit')
      expect(ids, surface).toContain('tortoise-blame')
    }
  })

  it('自研项本身不受影响（覆盖只隐藏 Tortoise 项，不隐藏自研项）', () => {
    const ids = visibleSvnActions('tree', ready({ svnFeatures: FEATURES, status: 'modified' })).map((a) => a.id)
    expect(ids).toContain('diff-base')
    expect(ids).toContain('revert-cli')
    expect(ids).toContain('log')
  })

  it('降级口径：能力集合缺省/空时 Tortoise 三项恢复显示（旧 payload 不丢能力）', () => {
    for (const features of [undefined, [] as SvnFeature[]]) {
      const ids = visibleSvnActions('tree', ready({ svnFeatures: features, status: 'modified' })).map((a) => a.id)
      expect(ids).toContain('tortoise-diff')
      expect(ids).toContain('tortoise-revert')
      expect(ids).toContain('tortoise-log')
    }
  })

  it('用户实测根因回归：自研就绪后菜单不再同时出现「与基线比较」与「TortoiseSVN 差异」', () => {
    const labels = visibleSvnActions('tree', ready({ svnFeatures: FEATURES, status: 'modified' })).map((a) => a.label)
    expect(labels).toContain('与基线比较')
    expect(labels).not.toContain('TortoiseSVN 差异')
    expect(labels).not.toContain('TortoiseSVN 还原')
    expect(labels).not.toContain('TortoiseSVN 日志')
  })
})

describe('执行器表与动作目录一致（防「点了没反应」）', () => {
  it('每个动作 id 都有对应执行器', async () => {
    const { SVN_ACTION_RUNNERS } = await import('../src/client/svnActions.js')
    const missing = SVN_ACTIONS.filter((action) => typeof SVN_ACTION_RUNNERS[action.id] !== 'function')
    expect(missing.map((a) => a.id)).toEqual([])
  })

  it('执行器表不含目录外的孤儿键（防改 id 后遗留旧键）', async () => {
    const { SVN_ACTION_RUNNERS } = await import('../src/client/svnActions.js')
    const known = new Set(SVN_ACTIONS.map((action) => action.id))
    const orphans = Object.keys(SVN_ACTION_RUNNERS).filter((id) => !known.has(id))
    expect(orphans).toEqual([])
  })
})

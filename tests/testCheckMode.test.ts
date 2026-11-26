/**
 * 测试验收模式：投影折叠、两条系统提示段、工具准入与上报/导出工具的真实落盘行为。
 * @author ddj 2026年11月25号
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TEST_CHECK_INITIAL,
  checkProjectionDefinition,
  finishToolOptions,
  foldCheckMode,
  reportToolOptions,
  setupCheckMode,
  type CheckModeState,
} from '../src/testCheckMode.js'
import { testCheckPolicyText, testCheckStatusText } from '../src/testCheckGuidance.js'
import { disposeTestCheck } from '../src/testCheckStore.js'
import {
  TEST_CHECK_FINISH_TOOL,
  TEST_CHECK_MODE_KEY,
  TEST_CHECK_REPORT_TOOL,
  testCheckIdOf,
} from '../src/shared/testCheck.js'

//region 夹具

/** 造一条会话事件。 */
function event(type: string, data: Record<string, unknown>): { type: string; data: Record<string, unknown> } {
  return { type, data }
}

/** 造一条 run + done 配对。 */
function pair(name: string, args: string, kind: 'success' | 'error' = 'success'): Array<{ type: string; data: Record<string, unknown> }> {
  return [
    event('command/run', { commandId: name + '-1', name, args }),
    event('command/done', { commandId: name + '-1', kind }),
  ]
}

/** 依次折叠。 */
function foldAll(events: Array<{ type: string; data: Record<string, unknown> }>, initial: CheckModeState = TEST_CHECK_INITIAL): CheckModeState {
  return events.reduce((state, item) => foldCheckMode(state, item), initial)
}

/** 进入过模式的起始状态。 */
const ENTERED: CheckModeState = { active: true, entered: true, id: 'settings-ui', running: null }

/** 临时工作区（每个用例一份）。 */
const workspaces: string[] = []

/** 造一个含定义文件的临时工作区。 */
async function workspaceWithItems(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'edrv-tc-mode-'))
  workspaces.push(dir)
  const sheet = join(dir, '.dsh', 'test-check', 'settings-ui')
  await mkdir(sheet, { recursive: true })
  await writeFile(join(sheet, 'items.json'), JSON.stringify({
    id: 'settings-ui',
    title: '设置页',
    version: 1,
    items: [{ id: 'settings.ui.001', title: '开关立即生效', files: ['src/a.ts'] }],
  }), 'utf8')
  return dir
}

afterEach(async () => {
  disposeTestCheck()
  for (const dir of workspaces.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('foldCheckMode', () => {
  it('进入模式：active + entered + 从任务派生的单子 id', () => {
    const state = foldAll(pair('test-check', 'verify settings toggles'))
    expect(state.active).toBe(true)
    expect(state.entered).toBe(true)
    expect(state.id).toBe(testCheckIdOf('verify settings toggles'))
  })

  it('off 退出但保留单子 id（chip 与页签继续显示同一张单）', () => {
    const state = foldAll(pair('test-check', 'off'), ENTERED)
    expect(state.active).toBe(false)
    expect(state.id).toBe('settings-ui')
    expect(state.entered).toBe(true)
  })

  it('命令失败不改变模式状态', () => {
    const state = foldAll(pair('test-check', 'anything', 'error'), TEST_CHECK_INITIAL)
    expect(state.active).toBe(false)
    expect(state.entered).toBe(false)
    expect(state.running).toBeNull()
  })

  it('进入官方 /plan 或 /html-plan 时关闭本模式', () => {
    expect(foldAll(pair('plan', '任务'), ENTERED).active).toBe(false)
    expect(foldAll(pair('html-plan', '任务'), ENTERED).active).toBe(false)
  })

  it('它们各自的 off 不关本模式', () => {
    expect(foldAll(pair('plan', 'off'), ENTERED).active).toBe(true)
    expect(foldAll(pair('html-plan', 'off'), ENTERED).active).toBe(true)
  })

  it('命令 id 不匹配的 done 直接忽略', () => {
    const state = foldCheckMode(
      { ...TEST_CHECK_INITIAL, running: { commandId: 'a', off: false, id: 'x' } },
      event('command/done', { commandId: 'b', kind: 'success' }),
    )
    expect(state.active).toBe(false)
    expect(state.running).not.toBeNull()
  })

  it('投影定义：key 与 wire 视图（客户端只拿 active 与 id）', () => {
    expect(checkProjectionDefinition.key).toBe(TEST_CHECK_MODE_KEY)
    expect(checkProjectionDefinition.wire.view(ENTERED)).toEqual({ active: true, id: 'settings-ui' })
  })
})

describe('系统提示段', () => {
  it('规则首句限定适用范围，并写清「必须带证据」', () => {
    const text = testCheckPolicyText()
    expect(text.startsWith('The following instructions apply only while test-check mode is active.')).toBe(true)
    expect(text).toContain('test_check_report')
    expect(text).toContain('不许口头通过')
    expect(text).toContain('/test-check off')
  })

  it('状态段：未进入为空，进入后按活跃切换', () => {
    expect(testCheckStatusText(false, false)).toBe('')
    expect(testCheckStatusText(true, true)).toContain('active')
    expect(testCheckStatusText(true, false)).toContain('inactive')
  })
})

describe('setupCheckMode 装配', () => {
  it('注册投影、两条 section、两个工具（带准入）与命令', async () => {
    const sections: Array<{ name: string; order: number; text: (asm: unknown) => string }> = []
    const tools: Array<{ definition: { name?: string }; options?: { when?: (context: unknown) => boolean } }> = []
    const commands: Array<{ name?: string }> = []
    let projectionKey = ''
    const state: CheckModeState = ENTERED
    const ctx = {
      get(name: string) {
        if (name === 'sessionProjections') {
          return {
            register: async (definition: { key?: string }) => {
              projectionKey = String(definition.key)
              return { stateOf: () => state }
            },
          }
        }
        if (name === 'systemPrompt') {
          return {
            section: (spec: { name: string; order: number; text: (asm: unknown) => string }) => { sections.push(spec); return () => {} },
            getSectionOrder: () => 500,
          }
        }
        if (name === 'tools') {
          return { register: (definition: { name?: string }, options?: { when?: (context: unknown) => boolean }) => { tools.push({ definition, options }); return () => {} } }
        }
        if (name === 'commands') {
          return { register: (definition: { name?: string }) => { commands.push(definition); return () => {} } }
        }
        return undefined
      },
    }
    const loadModule = async (specifier: string) => {
      if (specifier === '@deepseek-ai/dsh-tools') return { defineTool: (options: unknown) => options }
      if (specifier === '@deepseek-ai/dsh-llm') return { createUserMessage: (input: unknown) => input }
      throw new Error('unexpected module: ' + specifier)
    }

    const ok = await setupCheckMode(ctx, { loadModule })
    expect(ok).toBe(true)
    expect(projectionKey).toBe(TEST_CHECK_MODE_KEY)
    expect(sections.map((section) => section.name)).toEqual([
      'vscode-mode:test-check-policy',
      'vscode-mode:test-check-status',
    ])
    expect(sections[0].order).toBeCloseTo(500.7)
    expect(sections[1].order).toBeCloseTo(501.7)
    expect(sections[0].text({ agent: { session: {} } })).toContain('test-check')
    expect(tools.map((tool) => tool.definition.name).sort()).toEqual([TEST_CHECK_FINISH_TOOL, TEST_CHECK_REPORT_TOOL].sort())
    expect(tools[0].options?.when?.({ agent: { session: {} } })).toBe(true)
    expect(tools[0].options?.when?.({ agent: { session: null } })).toBe(false)
    expect(commands[0].name).toBe('test-check')
  })

  it('宿主没有 sessionProjections 时装配失败但不抛', async () => {
    const ok = await setupCheckMode({ get: () => undefined }, { loadModule: async () => ({}) })
    expect(ok).toBe(false)
  })
})

describe('test_check_report 工具', () => {
  it('带证据的 pass 落盘并返回计数', async () => {
    const dir = await workspaceWithItems()
    const tool = reportToolOptions({
      cwdOf: () => dir,
      idOf: () => 'settings-ui',
      activeOf: () => true,
    })
    const result = await tool.execute({
      item: 'settings.ui.001',
      status: 'pass',
      summary: 'tests/a.test.ts 3/3 通过',
      command: 'npx vitest run tests/a.test.ts',
      exitCode: 0,
    }, { agent: { session: {} } })
    expect(result.ok).toBe(true)
    expect(result.counts?.pass).toBe(1)
    expect(result.file).toMatch(/\.json$/)
    const text = await readFile(join(dir, '.dsh', 'test-check', 'settings-ui', 'events', String(result.file)), 'utf8')
    expect(text).toContain('tests/a.test.ts 3/3 通过')
    expect(tool.output.render({}, result)[0].text).toContain('已记录')
  })

  it('没写 summary 就拒绝（不许口头通过）', async () => {
    const dir = await workspaceWithItems()
    const tool = reportToolOptions({ cwdOf: () => dir, idOf: () => 'settings-ui', activeOf: () => true })
    const result = await tool.execute({ item: 'settings.ui.001', status: 'pass' }, { agent: { session: {} } })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('summary')
  })

  it('模式未激活、测试点不存在、状态非法都给出可读原因', async () => {
    const dir = await workspaceWithItems()
    const inactive = reportToolOptions({ cwdOf: () => dir, idOf: () => 'settings-ui', activeOf: () => false })
    expect(String((await inactive.execute({ item: 'settings.ui.001', status: 'pass', summary: 'x' }, {})).error)).toContain('未激活')

    const tool = reportToolOptions({ cwdOf: () => dir, idOf: () => 'settings-ui', activeOf: () => true })
    const unknown = await tool.execute({ item: 'settings.ui.999', status: 'pass', summary: 'x' }, { agent: { session: {} } })
    expect(String(unknown.error)).toContain('定义里没有')

    const badStatus = await tool.execute({ item: 'settings.ui.001', status: 'passed', summary: 'x' }, { agent: { session: {} } })
    expect(String(badStatus.error)).toContain('status')
  })
})

describe('test_check_finish 工具', () => {
  it('导出 docs/acceptance-<id>.html，默认随后退出模式', async () => {
    const dir = await workspaceWithItems()
    const exits: string[] = []
    const tool = finishToolOptions({
      cwdOf: () => dir,
      idOf: () => 'settings-ui',
      activeOf: () => true,
      exitMode: async () => { exits.push('off'); return { ok: true } },
    })
    const result = await tool.execute({}, { agent: { session: {} } })
    expect(result.ok).toBe(true)
    expect(result.exited).toBe(true)
    expect(exits).toEqual(['off'])
    expect(String(result.path)).toContain('docs/acceptance-settings-ui.html')
    const html = await readFile(join(dir, 'docs', 'acceptance-settings-ui.html'), 'utf8')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('导出快照')
    const text = tool.output.render({}, result)[0].text
    expect(text).toContain('验收快照已导出')
    expect(text).toContain('已退出')
  })

  it('stay: true 时只导出、不退出（留在模式里补验）', async () => {
    const dir = await workspaceWithItems()
    let called = false
    const tool = finishToolOptions({
      cwdOf: () => dir,
      idOf: () => 'settings-ui',
      activeOf: () => true,
      exitMode: async () => { called = true; return { ok: true } },
    })
    const result = await tool.execute({ stay: true }, { agent: { session: {} } })
    expect(result.ok).toBe(true)
    expect(result.exited).toBe(false)
    expect(called).toBe(false)
    expect(tool.output.render({}, result)[0].text).toContain('模式保留')
  })

  it('退出失败不影响导出，并提示手动 /test-check off', async () => {
    const dir = await workspaceWithItems()
    const tool = finishToolOptions({
      cwdOf: () => dir,
      idOf: () => 'settings-ui',
      activeOf: () => true,
      exitMode: async () => ({ ok: false, error: '命令服务不可用' }),
    })
    const result = await tool.execute({}, { agent: { session: {} } })
    expect(result.ok).toBe(true)
    expect(result.exited).toBe(false)
    expect(result.exitError).toBe('命令服务不可用')
    const text = tool.output.render({}, result)[0].text
    expect(text).toContain('手动执行 /test-check off')
  })

  it('模式未激活时拒绝导出', async () => {
    const tool = finishToolOptions({
      cwdOf: () => '/tmp',
      idOf: () => 'x',
      activeOf: () => false,
      exitMode: async () => ({ ok: true }),
    })
    const result = await tool.execute({}, {})
    expect(result.ok).toBe(false)
  })
})

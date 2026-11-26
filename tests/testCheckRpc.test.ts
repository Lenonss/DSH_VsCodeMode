/**
 * 测试验收模式：路径发现 + RPC 三个方法端到端（临时工作区，真实读写盘）。
 * @author ddj 2026年11月25号
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { baseDirOf, disposeTestCheck, projectRootOf, sheetPathsOf } from '../src/testCheckStore.js'
import { checkHandlers } from '../src/testCheckRpc.js'
import type { RpcHandlerMap } from '../src/shared/rpc.js'

//region 夹具

/** 临时目录（每个用例一份）。 */
const dirs: string[] = []

/** 造一个临时目录。 */
async function tempDir(prefix = 'edrv-tc-rpc-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/** 假宿主：只提供 sessions，工作区取会话头的 cwd。 */
function fakeCtx(cwd: string): unknown {
  const session = { id: 's1', header: { cwd } }
  return {
    get(name: string) {
      if (name === 'sessions') {
        return {
          get: (id: string) => (id === 's1' ? session : undefined),
          list: () => [session],
        }
      }
      return undefined
    },
  }
}

/** 在临时工作区里写一份定义。 */
async function writeItems(dir: string): Promise<void> {
  const sheet = join(dir, '.dsh', 'test-check', 'settings-ui')
  await mkdir(sheet, { recursive: true })
  await writeFile(join(sheet, 'items.json'), JSON.stringify({
    id: 'settings-ui',
    title: '设置页',
    version: 1,
    items: [
      { id: 'settings.ui.001', title: '开关立即生效', files: ['src/a.ts'] },
      { id: 'settings.ui.002', title: '重置恢复默认' },
    ],
  }), 'utf8')
}

/** 取一个 handler（类型上总表是全的，测试里按方法取）。 */
function handlerOf(handlers: Partial<RpcHandlerMap>, method: string): (args: unknown) => Promise<Record<string, unknown>> {
  const fn = (handlers as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new Error('缺少 handler：' + method)
  return fn as (args: unknown) => Promise<Record<string, unknown>>
}

afterEach(async () => {
  disposeTestCheck()
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

//endregion

describe('路径发现', () => {
  it('从会话 cwd 向上找第一个含 .dsh/test-check 的目录', async () => {
    const root = await tempDir()
    const deep = join(root, 'packages', 'app', 'src')
    await mkdir(join(root, '.dsh', 'test-check'), { recursive: true })
    await mkdir(deep, { recursive: true })
    expect(projectRootOf(deep)).toBe(root)
  })

  it('都没有时回落会话 cwd', async () => {
    const dir = await tempDir()
    expect(projectRootOf(dir)).toBe(dir)
  })

  it('DSH_TEST_CHECK_DIR 覆盖数据根目录（项目根仍是 cwd）', async () => {
    const root = await tempDir()
    const override = await tempDir('edrv-tc-base-')
    expect(baseDirOf(root, { DSH_TEST_CHECK_DIR: override })).toBe(override)
    const paths = sheetPathsOf(root, 'settings-ui', { DSH_TEST_CHECK_DIR: override })
    expect(paths.dir).toBe(join(override, 'settings-ui'))
    expect(paths.itemsPath).toBe(join(override, 'settings-ui', 'items.json'))
  })
})

describe('edrv.testCheck.get', () => {
  it('没有 items.json 时返回 missing 视图（页签据此给建单引导）', async () => {
    const dir = await tempDir()
    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const result = await get({ sessionId: 's1', id: 'settings-ui' })
    expect(result.ok).toBe(true)
    const view = result.view as { state: string; itemsPath: string }
    expect(view.state).toBe('missing')
    expect(view.itemsPath).toContain('.dsh/test-check/settings-ui/items.json')
  })

  it('有定义时按定义列出条目（未验）', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const result = await get({ sessionId: 's1', id: 'settings-ui' })
    const view = result.view as { state: string; counts: { total: number; todo: number }; groups: Array<{ items: unknown[] }> }
    expect(view.state).toBe('ready')
    expect(view.counts.total).toBe(2)
    expect(view.counts.todo).toBe(2)
    expect(view.groups[0].items).toHaveLength(2)
  })

  it('定义有错时返回 invalid 与逐条原因，不抛错', async () => {
    const dir = await tempDir()
    const sheet = join(dir, '.dsh', 'test-check', 'settings-ui')
    await mkdir(sheet, { recursive: true })
    await writeFile(join(sheet, 'items.json'), JSON.stringify({ items: [{ id: 'bad', title: 'x' }] }), 'utf8')
    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const result = await get({ sessionId: 's1', id: 'settings-ui' })
    const view = result.view as { state: string; error?: string }
    expect(view.state).toBe('invalid')
    expect(String(view.error)).toContain('bad')
  })

  it('会话不存在时返回 ok:false 与可读原因', async () => {
    const dir = await tempDir()
    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const result = await get({ sessionId: 'nope', id: 'settings-ui' })
    expect(result.ok).toBe(false)
    expect(String(result.error).length).toBeGreaterThan(0)
  })
})

describe('edrv.testCheck.report', () => {
  it('写一个事件文件，视图立刻变成通过并计入汇总', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    const result = await report({
      sessionId: 's1',
      id: 'settings-ui',
      item: 'settings.ui.001',
      status: 'pass',
      summary: 'npx vitest run tests/a.test.ts 3/3',
    })
    expect(result.ok).toBe(true)
    const view = result.view as { counts: { pass: number; total: number } }
    expect(view.counts.pass).toBe(1)
    expect(view.counts.total).toBe(2)

    const filed = String(result.filed)
    const eventDir = join(dir, '.dsh', 'test-check', 'settings-ui', 'events')
    expect(existsSync(join(eventDir, filed))).toBe(true)
    const payload = JSON.parse(await readFile(join(eventDir, filed), 'utf8'))
    expect(payload).toMatchObject({ item: 'settings.ui.001', status: 'pass' })
    expect(payload.evidence.summary).toContain('3/3')
  })

  it('缺证据、缺 item、状态非法都拒绝', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    expect((await report({ sessionId: 's1', id: 'settings-ui', item: 'settings.ui.001', status: 'pass', summary: '  ' })).ok).toBe(false)
    expect((await report({ sessionId: 's1', id: 'settings-ui', item: '', status: 'pass', summary: 'x' })).ok).toBe(false)
    expect((await report({ sessionId: 's1', id: 'settings-ui', item: 'settings.ui.001', status: 'ok', summary: 'x' })).ok).toBe(false)
  })

  it('写未知测试点返回可读错误（typo 不会被静默吞掉）', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    const result = await report({ sessionId: 's1', id: 'settings-ui', item: 'settings.ui.999', status: 'pass', summary: 'x' })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('settings.ui.999')
  })

  it('单子 id 带路径分隔或 .. 时拒绝（id 会拼进路径）', async () => {
    const dir = await tempDir()
    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    const result = await report({ sessionId: 's1', id: '../evil', item: 'settings.ui.001', status: 'pass', summary: 'x' })
    expect(result.ok).toBe(false)
    expect(String(result.error)).toContain('不合法')
  })
})

describe('edrv.testCheck.snapshot', () => {
  it('导出 docs/acceptance-<id>.html，内容含条目且无脚本', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    await report({ sessionId: 's1', id: 'settings-ui', item: 'settings.ui.002', status: 'fail', summary: '断言失败' })

    const snapshot = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.snapshot')
    const result = await snapshot({ sessionId: 's1', id: 'settings-ui' })
    expect(result.ok).toBe(true)
    const target = join(dir, 'docs', 'acceptance-settings-ui.html')
    expect(existsSync(target)).toBe(true)
    const html = await readFile(target, 'utf8')
    expect(html).toContain('settings.ui.002')
    expect(html).toContain('断言失败')
    expect(html).not.toContain('<script')
  })
})

describe('1 秒内反映（不靠 force，只靠 watch 标脏 + 兜底重扫）', () => {
  it('手写一个事件文件后，下一次轮询就能看到新状态', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const before = await get({ sessionId: 's1', id: 'settings-ui' })
    expect((before.view as { counts: { fail: number } }).counts.fail).toBe(0)

    const eventsDir = join(dir, '.dsh', 'test-check', 'settings-ui', 'events')
    await mkdir(eventsDir, { recursive: true })
    await writeFile(join(eventsDir, '20261125T200000-abcd.json'), JSON.stringify({
      item: 'settings.ui.002',
      status: 'fail',
      evidence: { summary: '手写事件（模拟任何语言的脚本）' },
    }), 'utf8')

    const started = Date.now()
    let fail = 0
    while (Date.now() - started < 1_500) {
      const now = await get({ sessionId: 's1', id: 'settings-ui' })
      fail = (now.view as { counts: { fail: number } }).counts.fail
      if (fail > 0) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const elapsed = Date.now() - started
    expect(fail, '写文件后 ' + String(elapsed) + 'ms 内应看到新状态').toBe(1)
    expect(elapsed).toBeLessThan(1_500)
  })
})

describe('需复验判定（上报自动带指纹）', () => {  it('上报时按定义 files 自动记指纹；改文件后该条变「需复验」', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    await mkdir(join(dir, 'src'), { recursive: true })
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    const reported = await report({
      sessionId: 's1',
      id: 'settings-ui',
      item: 'settings.ui.001',
      status: 'pass',
      summary: 'vitest 3/3',
    })
    expect((reported.view as { counts: { pass: number; stale: number } }).counts).toMatchObject({ pass: 1, stale: 0 })

    // 上报方（AI 工具或脚本）都不用自己算 sha256：host 按 definition.files 现场记了一次指纹
    const filed = String(reported.filed)
    const payload = JSON.parse(await readFile(join(dir, '.dsh', 'test-check', 'settings-ui', 'events', filed), 'utf8'))
    expect(String(payload.subject?.hash)).toMatch(/^sha256:[0-9a-f]{64}$/)

    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const fresh = await get({ sessionId: 's1', id: 'settings-ui', force: true })
    expect((fresh.view as { counts: { stale: number; pass: number } }).counts).toMatchObject({ stale: 0, pass: 1 })

    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2\n', 'utf8')
    const changed = await get({ sessionId: 's1', id: 'settings-ui', force: true })
    expect((changed.view as { counts: { stale: number; pass: number } }).counts).toMatchObject({ stale: 1, pass: 0 })
  })

  it('定义里没写 files 的条目不做失效判定（改文件也不变色）', async () => {
    const dir = await tempDir()
    await writeItems(dir)
    const report = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.report')
    const reported = await report({
      sessionId: 's1',
      id: 'settings-ui',
      item: 'settings.ui.002',
      status: 'pass',
      summary: '手点了一遍',
    })
    const filed = String(reported.filed)
    const payload = JSON.parse(await readFile(join(dir, '.dsh', 'test-check', 'settings-ui', 'events', filed), 'utf8'))
    expect(payload.subject).toBeUndefined()

    const get = handlerOf(checkHandlers(fakeCtx(dir) as never), 'edrv.testCheck.get')
    const fresh = await get({ sessionId: 's1', id: 'settings-ui', force: true })
    expect((fresh.view as { counts: { stale: number; pass: number } }).counts).toMatchObject({ stale: 0, pass: 1 })
  })
})

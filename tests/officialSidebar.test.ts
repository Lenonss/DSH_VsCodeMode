/**
 * client officialSidebar 纯函数与装配测试（不触 DOM/窗口事件，mock ctx/slots）。
 * 作者 ddj 2026-09-09
 */
import { describe, expect, it } from 'vitest'
import {
  detectOfficial,
  installOfficial,
  parseOfficialFileAddress,
  officialFileTitle,
  buildFileAddress,
  registerOfficialFileClaim,
  resolveNavOpen,
  OFFICIAL_FILE_TAB_ID,
  OFFICIAL_SERVICE,
  OFFICIAL_SLOT_NAME,
  OFFICIAL_TAB_ID,
  OFFICIAL_TAB_KIND,
  OFFICIAL_TAB_TITLE,
  OFFICIAL_TABS_SERVICE,
} from '../src/client/officialSidebar.js'
import { routeSideEditor, setEnsureSideEditor } from '../src/client/sidebarBridge.js'

/** 构造探测用 ctx：name→value 映射，可注入抛错。 */
function ctxOf(map: Record<string, unknown>, boom = false): { get: (name: string) => unknown } {
  return {
    get: (name: string) => {
      if (boom) throw new Error('ctx get failed')
      return map[name]
    },
  }
}

/** 合格的一对官方服务。 */
const goodTabs = { register: () => () => {} }
const goodService = { openTab: () => {} }

describe('detectOfficial', () => {
  it('缺服务/缺 register 或 openTab 时返回 undefined', () => {
    expect(detectOfficial(ctxOf({}))).toBeUndefined()
    expect(detectOfficial(ctxOf({ [OFFICIAL_TABS_SERVICE]: { register: () => () => {} } }))).toBeUndefined()
    expect(detectOfficial(ctxOf({ [OFFICIAL_SERVICE]: goodService }))).toBeUndefined()
  })
  it('get 抛错时安全降级', () => {
    expect(detectOfficial(ctxOf({}, true))).toBeUndefined()
  })
  it('一对完整服务通过探测', () => {
    const hit = detectOfficial(ctxOf({ [OFFICIAL_TABS_SERVICE]: goodTabs, [OFFICIAL_SERVICE]: goodService }))
    expect(hit?.tabs).toBe(goodTabs)
    expect(hit?.service).toBe(goodService)
  })
})

describe('resolveNavOpen', () => {
  it('openPath/focusDiff 正常解析', () => {
    expect(resolveNavOpen({ openPath: 'src/a.ts', focusDiff: true }))
      .toEqual({ path: 'src/a.ts', focusDiff: true })
  })
  it('缺参/坏类型安全降级为空请求', () => {
    expect(resolveNavOpen(undefined)).toEqual({ path: null, focusDiff: false })
    expect(resolveNavOpen(null)).toEqual({ path: null, focusDiff: false })
    expect(resolveNavOpen({ openPath: 42, focusDiff: 'yes' })).toEqual({ path: null, focusDiff: false })
    expect(resolveNavOpen({ openPath: '' })).toEqual({ path: null, focusDiff: false })
  })
})

describe('installOfficial', () => {
  it('注册类型定义 + keyed slot 正文，路由透传到 openTab', () => {
    const definitions: unknown[] = []
    const slotSpecs: unknown[] = []
    const slotRenders: unknown[] = []
    const openCalls: Array<{ kind: string; options?: { params?: unknown } }> = []
    const tabs = { register: (d: unknown) => { definitions.push(d); return () => {} } }
    const service = { openTab: (kind: string, options?: { params?: unknown }) => { openCalls.push({ kind, options }) } }
    const slots = {
      inject: (name: string, register: () => unknown) => {
        expect(name).toBe(OFFICIAL_SLOT_NAME)
        const disposer = register() as () => void
        expect(typeof disposer).toBe('function')
        return () => {}
      },
      register: (spec: object, render: unknown) => { slotSpecs.push(spec); slotRenders.push(render); return () => {} },
    }
    setEnsureSideEditor(null)
    const dispose = installOfficial({
      tabs, service, slots,
      renderTab: () => null,
      guide: { title: () => OFFICIAL_TAB_TITLE, description: () => 'd' },
    })
    expect(typeof dispose).toBe('function')
    // 类型定义形状：id/kind/priority/title/guide
    const definition = definitions[0] as Record<string, unknown>
    expect(definition['id']).toBe(OFFICIAL_TAB_ID)
    expect(definition['kind']).toBe(OFFICIAL_TAB_KIND)
    expect(definition['priority']).toBe('extension')
    expect((definition['title'] as () => string)()).toBe(OFFICIAL_TAB_TITLE)
    // 正文 slot：key = 定义 id
    expect(slotSpecs[0]).toEqual({ name: OFFICIAL_SLOT_NAME, key: OFFICIAL_TAB_ID })
    expect(typeof slotRenders[0]).toBe('function')
    // 路由：ensure → openTab(kind, params)
    expect(routeSideEditor('src/a.ts', true)).toBe(true)
    expect(openCalls).toEqual([{ kind: OFFICIAL_TAB_KIND, options: { params: { openPath: 'src/a.ts', focusDiff: true } } }])
    // 卸载后路由撤销
    dispose!()
    expect(routeSideEditor('src/a.ts', false)).toBe(false)
  })
  it('空路径打开时 params.openPath 为 undefined', () => {
    const openCalls: Array<{ params?: unknown } | undefined> = []
    setEnsureSideEditor(null)
    const dispose = installOfficial({
      tabs: { register: () => () => {} },
      service: { openTab: (_kind: string, options?: { params?: unknown }) => { openCalls.push(options) } },
      slots: { inject: (_n: string, register: () => unknown) => { (register() as () => void)(); return () => {} }, register: () => () => {} },
      renderTab: () => null,
      guide: { title: () => 't', description: () => 'd' },
    })
    expect(routeSideEditor(null, false)).toBe(true)
    expect(openCalls[0]?.params).toEqual({ openPath: undefined, focusDiff: false })
    dispose!()
  })
  it('openTab 抛错时路由返回 false（降级其他打开器）', () => {
    setEnsureSideEditor(null)
    const dispose = installOfficial({
      tabs: { register: () => () => {} },
      service: { openTab: () => { throw new Error('no seat mounted') } },
      slots: { inject: (_n: string, register: () => unknown) => { (register() as () => void)(); return () => {} }, register: () => () => {} },
      renderTab: () => null,
      guide: { title: () => 't', description: () => 'd' },
    })
    expect(routeSideEditor('a.ts', false)).toBe(false)
    dispose!()
  })
  it('类型注册抛错时返回 null 且不接管路由', () => {
    setEnsureSideEditor(null)
    const dispose = installOfficial({
      tabs: { register: () => { throw new Error('id taken') } },
      service: goodService,
      slots: { inject: () => { throw new Error('should not reach') }, register: () => () => {} },
      renderTab: () => null,
      guide: { title: () => 't', description: () => 'd' },
    })
    expect(dispose).toBeNull()
    expect(routeSideEditor('a.ts', false)).toBe(false)
  })
})

describe('parseOfficialFileAddress', () => {
  it('session 域：解码 sessionId 与逐段编码路径', () => {
    expect(parseOfficialFileAddress('dsh-resource://file/session/s1/src/a%20b.txt'))
      .toEqual({ path: 'src/a b.txt', sessionId: 's1' })
  })
  it('absolute 域：POSIX 补前导 /', () => {
    expect(parseOfficialFileAddress('dsh-resource://file/absolute/home/ys/notes.txt'))
      .toEqual({ path: '/home/ys/notes.txt' })
  })
  it('absolute 域：Windows 盘符原样', () => {
    expect(parseOfficialFileAddress('dsh-resource://file/absolute/C:/x/y.txt'))
      .toEqual({ path: 'C:/x/y.txt' })
  })
  it('absolute 域：UNC 保留空首段', () => {
    expect(parseOfficialFileAddress('dsh-resource://file/absolute//server/share/x.txt'))
      .toEqual({ path: '//server/share/x.txt' })
  })
  it('非 file 地址/缺路径/坏编码/空会话 id 一律 null', () => {
    expect(parseOfficialFileAddress('sidebar://guide')).toBeNull()
    expect(parseOfficialFileAddress('dsh-resource://file/absolute')).toBeNull()
    expect(parseOfficialFileAddress('dsh-resource://file/absolute/')).toBeNull()
    expect(parseOfficialFileAddress('dsh-resource://file/session//x.txt')).toBeNull()
    expect(parseOfficialFileAddress('dsh-resource://file/session/s1')).toBeNull()
    expect(parseOfficialFileAddress('dsh-resource://file/session/s1/%zz.txt')).toBeNull()
    expect(parseOfficialFileAddress(undefined)).toBeNull()
    expect(parseOfficialFileAddress(42)).toBeNull()
  })
})

describe('officialFileTitle', () => {
  it('取解码后的 basename，解码失败回退原始切片', () => {
    expect(officialFileTitle('dsh-resource://file/session/s1/src/a%20b.txt')).toBe('a b.txt')
    expect(officialFileTitle('dsh-resource://file/absolute/C:/x/y.ts')).toBe('y.ts')
    expect(officialFileTitle('dsh-resource://file/session/s1/%zz.ts')).toBe('%zz.ts')
    expect(officialFileTitle(undefined)).toBe('')
  })
})

describe('buildFileAddress', () => {
  it('相对路径 → session 域（逐段编码）', () => {
    expect(buildFileAddress('src/a b.ts', 's1')).toBe('dsh-resource://file/session/s1/src/a%20b.ts')
    expect(buildFileAddress('./src/a.ts', 's1')).toBe('dsh-resource://file/session/s1/src/a.ts')
  })
  it('绝对路径 → absolute 域（POSIX/Windows/UNC）', () => {
    expect(buildFileAddress('/home/ys/notes.txt')).toBe('dsh-resource://file/absolute/home/ys/notes.txt')
    expect(buildFileAddress('C:\\repo\\x.ts')).toBe('dsh-resource://file/absolute/C:/repo/x.ts')
    expect(buildFileAddress('//server/share/x.txt')).toBe('dsh-resource://file/absolute//server/share/x.txt')
  })
  it('空路径/相对路径缺会话 id 抛错', () => {
    expect(() => buildFileAddress('  ')).toThrow()
    expect(() => buildFileAddress('src/a.ts')).toThrow()
  })
  it('构造→解析往返一致', () => {
    const parsed = parseOfficialFileAddress(buildFileAddress('src/a b.txt', 's1'))
    expect(parsed).toEqual({ path: 'src/a b.txt', sessionId: 's1' })
  })
})

describe('registerOfficialFileClaim', () => {
  it('注册 file 资源类型 + keyed 正文，canOpen 否决畸形地址', () => {
    const definitions: unknown[] = []
    const slotKeys: unknown[] = []
    const tabs = { register: (d: unknown) => { definitions.push(d); return () => {} } }
    const slots = {
      inject: (_name: string, register: () => unknown) => { register(); return () => {} },
      register: (spec: object) => { slotKeys.push((spec as { key?: string }).key); return () => {} },
    }
    const dispose = registerOfficialFileClaim({ tabs, slots, renderTab: () => null })
    expect(typeof dispose).toBe('function')
    const definition = definitions[0] as Record<string, unknown>
    expect(definition['id']).toBe(OFFICIAL_FILE_TAB_ID)
    expect(definition['kind']).toBe('edrvEditorFile')
    expect(definition['patterns']).toEqual(['dsh-resource://file/**'])
    expect(definition['priority']).toBe('extension')
    expect(slotKeys).toEqual([OFFICIAL_FILE_TAB_ID])
    const canOpen = definition['canOpen'] as (a: string) => boolean
    expect(canOpen('dsh-resource://file/session/s1/a.ts')).toBe(true)
    expect(canOpen('sidebar://guide')).toBe(false)
    expect(canOpen('dsh-resource://file/session/s1/%zz.ts')).toBe(false)
    const title = definition['title'] as (a: string) => string
    expect(title('dsh-resource://file/session/s1/src/a%20b.txt')).toBe('a b.txt')
    dispose!()
  })
  it('类型注册抛错时返回 null（回落官方查看器）', () => {
    const dispose = registerOfficialFileClaim({
      tabs: { register: () => { throw new Error('id taken') } },
      slots: { inject: () => { throw new Error('should not reach') }, register: () => () => {} },
      renderTab: () => null,
    })
    expect(dispose).toBeNull()
  })
})

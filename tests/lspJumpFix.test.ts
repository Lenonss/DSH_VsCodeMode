/**
 * dsh-vscode-mode tests — LSP 跳转修复纯函数：
 *  - server.nudgeToWordEnd：EmmyLua 0.9.41 词边界怪癖（位置在标识符前半 → 空/"unknown"）的规避
 *  - derive.deriveCrossFileDeclaration：definition 空时从 references 推导跨文件字段声明
 * 作者 ddj 2026-10-15
 */
import { describe, it, expect } from 'vitest'
import { nudgeToWordEnd } from '../src/lsp/server.js'
import { deriveCrossFileDeclaration } from '../src/lsp/derive.js'

// 用户报告场景的最小复现（0-based 行 3 即用户工程 __GetEventBinds 的 EventId 链行）
const DOC = [
  '---@return table',
  'function this.__GetEventBinds()',
  '    return {',
  '        { EventId.ISTaskSystem.TaskStateChange, this.CheckAllActivityEventCompletions },',
  '        { EventId.IAP.PurchaseSuccess, this.OnActivityEventPurchaseSuccess },',
  '        { EventId.NewActivity.DynamicActivityExpired, this.OnActivityEventDynamicExpired },',
  '    }',
  'end',
].join('\n')

// 行 3：`        { EventId.ISTaskSystem.TaskStateChange, ...`
// EventId=10..16  .=17  ISTaskSystem=18..29  .=30  TaskStateChange=31..45

describe('nudgeToWordEnd（EmmyLua 词边界怪癖规避）', () => {
  it('标识符前半 → 词尾', () => {
    expect(nudgeToWordEnd(DOC, { line: 3, character: 10 })).toEqual({ line: 3, character: 16 })
    expect(nudgeToWordEnd(DOC, { line: 3, character: 12 })).toEqual({ line: 3, character: 16 })
    expect(nudgeToWordEnd(DOC, { line: 3, character: 31 })).toEqual({ line: 3, character: 45 })
    expect(nudgeToWordEnd(DOC, { line: 3, character: 40 })).toEqual({ line: 3, character: 45 })
  })
  it('词尾本身不挪', () => {
    expect(nudgeToWordEnd(DOC, { line: 3, character: 16 })).toEqual({ line: 3, character: 16 })
    expect(nudgeToWordEnd(DOC, { line: 3, character: 45 })).toEqual({ line: 3, character: 45 })
  })
  it('非标识符位置不挪（点号/空白/标点）', () => {
    expect(nudgeToWordEnd(DOC, { line: 3, character: 17 })).toEqual({ line: 3, character: 17 })
    expect(nudgeToWordEnd(DOC, { line: 3, character: 9 })).toEqual({ line: 3, character: 9 })
    expect(nudgeToWordEnd(DOC, { line: 3, character: 8 })).toEqual({ line: 3, character: 8 })
  })
  it('越界行原样返回', () => {
    expect(nudgeToWordEnd(DOC, { line: 99, character: 0 })).toEqual({ line: 99, character: 0 })
  })
})

describe('deriveCrossFileDeclaration（字段声明跨文件推导）', () => {
  // EventId.lua 片段：基全局 + 外层表声明 + 叶字段声明（1-based 对应真实工程结构）
  const eventIdLua = [
    'local _M = {}',
    'EventId = {}',
    'EventId.IAP = {',
    '    PurchaseSuccess = 11500,',
    '}',
    'EventId.ISTaskSystem = {',
    '    TaskStateChange = 50000,',
    '}',
    'EventId.NewActivity = {',
    '    DynamicActivityExpired = 64053,',
    '}',
    'return _M',
  ].join('\n')
  const files = new Map<string, string>([
    ['file:///D:/w/EventId.lua', eventIdLua],
    ['file:///D:/w/Other.lua', 'local x = EventId.ISTaskSystem.TaskStateChange'],
    ['file:///D:/w/NoMatch.lua', 'foo()'],
  ])
  const readText = async (uri: string): Promise<string | null> => files.get(uri) ?? null

  const SELF_CHAIN = { uri: 'file:///D:/w/SubHandler.lua', range: { start: { line: 3, character: 10 }, end: { line: 3, character: 46 } } }
  const EVENTID_DECL = { uri: 'file:///D:/w/EventId.lua', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 12 } } }
  const LEAF_DECL = { uri: 'file:///D:/w/EventId.lua', range: { start: { line: 6, character: 4 }, end: { line: 6, character: 26 } } }
  const OTHER_USE = { uri: 'file:///D:/w/Other.lua', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 31 } } }

  it('点击 TaskStateChange（叶字段）→ EventId.lua 内 `TaskStateChange = 50000,` 声明', async () => {
    const refs = [SELF_CHAIN, LEAF_DECL, OTHER_USE]
    const result = await deriveCrossFileDeclaration({ line: 3, character: 45 }, refs, DOC, 'file:///D:/w/SubHandler.lua', { readText })
    expect(result).toEqual(LEAF_DECL)
  })
  it('点击 EventId（基标识符）→ EventId.lua 内 `EventId = {}` 全局声明', async () => {
    const refs = [SELF_CHAIN, EVENTID_DECL, OTHER_USE]
    const result = await deriveCrossFileDeclaration({ line: 3, character: 10 }, refs, DOC, 'file:///D:/w/SubHandler.lua', { readText })
    expect(result).toEqual(EVENTID_DECL)
  })
  it('引用里没有声明形候选（仅使用）→ null', async () => {
    const refs = [SELF_CHAIN, OTHER_USE]
    const result = await deriveCrossFileDeclaration({ line: 3, character: 45 }, refs, DOC, 'file:///D:/w/SubHandler.lua', { readText })
    expect(result).toBeNull()
  })
  it('引用全为当前文件（局部变量场景）→ null（不误跳到别处）', async () => {
    const refs = [SELF_CHAIN]
    const result = await deriveCrossFileDeclaration({ line: 3, character: 45 }, refs, DOC, 'file:///D:/w/SubHandler.lua', { readText })
    expect(result).toBeNull()
  })
  it('文件读取达 maxFiles 上限未命中 → null', async () => {
    const refs = [SELF_CHAIN, { uri: 'file:///D:/w/NoMatch.lua', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } } }, LEAF_DECL]
    const result = await deriveCrossFileDeclaration({ line: 3, character: 45 }, refs, DOC, 'file:///D:/w/SubHandler.lua', { readText, maxFiles: 1 })
    expect(result).toBeNull()
  })
  it('读不到文件文本（readText 返回 null）→ null', async () => {
    const refs = [SELF_CHAIN, { uri: 'file:///D:/w/Missing.lua', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } } }]
    const result = await deriveCrossFileDeclaration({ line: 3, character: 45 }, refs, DOC, 'file:///D:/w/SubHandler.lua', { readText })
    expect(result).toBeNull()
  })
})

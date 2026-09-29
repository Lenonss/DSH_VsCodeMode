/**
 * host UI 状态镜像测试：纯函数（parse/serialize/merge）+ 文件读写（临时目录）。
 * 覆盖：损坏容错、版本失效、补丁删除语义、原子写后读一致、容量上限拒写、并发串行。
 * 作者 ddj 2026-09-28
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UI_STATE_BYTES_CAP,
  UI_STATE_VERSION,
  mergeUiStateKeys,
  parseUiState,
  readUiState,
  serializeUiState,
  writeUiState,
} from '../src/uiState.js'

const dirs: string[] = []
let dir = ''
let file = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'edrv-uistate-'))
  dirs.push(dir)
  file = join(dir, 'ui.v1.json')
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })))
})

describe('parseUiState', () => {
  it('解析合法文档并保留字符串值', () => {
    const doc = parseUiState(JSON.stringify({ version: 1, updatedAt: 'x', keys: { 'edrv.a': '1' } }))
    expect(doc).toEqual({ version: UI_STATE_VERSION, updatedAt: 'x', keys: { 'edrv.a': '1' } })
  })
  it('忽略非字符串值与空键', () => {
    const doc = parseUiState('{"version":1,"keys":{"edrv.a":"1","edrv.b":2,"":"3"}}')
    expect(doc?.keys).toEqual({ 'edrv.a': '1' })
  })
  it('损坏文本/非对象/版本不符/缺 keys → null', () => {
    expect(parseUiState('{oops')).toBeNull()
    expect(parseUiState('null')).toBeNull()
    expect(parseUiState('"str"')).toBeNull()
    expect(parseUiState('{"version":2,"keys":{}}')).toBeNull()
    expect(parseUiState('{"version":1}')).toBeNull()
    expect(parseUiState('')).toBeNull()
    expect(parseUiState(null)).toBeNull()
  })
})

describe('mergeUiStateKeys', () => {
  it('新增/覆盖/删除且不改入参', () => {
    const base = { 'edrv.a': '1', 'edrv.b': '2' }
    const merged = mergeUiStateKeys(base, { 'edrv.a': '9', 'edrv.c': '3', 'edrv.b': null, '': 'x' })
    expect(merged).toEqual({ 'edrv.a': '9', 'edrv.c': '3' })
    expect(base).toEqual({ 'edrv.a': '1', 'edrv.b': '2' })
  })
  it('删除不存在的键无副作用', () => {
    expect(mergeUiStateKeys({ 'edrv.a': '1' }, { 'edrv.z': undefined })).toEqual({ 'edrv.a': '1' })
  })
})

describe('serializeUiState', () => {
  it('序列化结果可被 parse 还原', () => {
    const keys = { 'edrv.editor.v3.ws:D:/ws': '{"tabs":[]}' }
    const doc = parseUiState(serializeUiState(keys, '2026-09-28T00:00:00.000Z'))
    expect(doc?.keys).toEqual(keys)
    expect(doc?.updatedAt).toBe('2026-09-28T00:00:00.000Z')
  })
})

describe('readUiState / writeUiState', () => {
  it('文件缺失 → 空表；写入后可读回并保留既有键', async () => {
    expect(await readUiState(file)).toEqual({})
    expect(await writeUiState(file, { 'edrv.a': '1' })).toEqual({ ok: true })
    expect(await writeUiState(file, { 'edrv.b': '2', 'edrv.a': null })).toEqual({ ok: true })
    expect(await readUiState(file)).toEqual({ 'edrv.b': '2' })
  })
  it('损坏文件 → 空表（不抛错）', async () => {
    await writeFile(file, '{oops')
    expect(await readUiState(file)).toEqual({})
    expect(await writeUiState(file, { 'edrv.a': '1' })).toEqual({ ok: true })
    expect(await readUiState(file)).toEqual({ 'edrv.a': '1' })
  })
  it('超容量上限 → 拒写且原文件不变', async () => {
    await writeUiState(file, { 'edrv.small': 'x' })
    const huge = 'y'.repeat(UI_STATE_BYTES_CAP + 1024)
    const res = await writeUiState(file, { 'edrv.huge': huge })
    expect(res.ok).toBe(false)
    expect(await readUiState(file)).toEqual({ 'edrv.small': 'x' })
    expect((await readFile(file, 'utf8')).includes('edrv.huge')).toBe(false)
  })
  it('并发写入串行化，不丢键', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeUiState(file, { ['edrv.k' + i]: String(i) })))
    const keys = await readUiState(file)
    expect(Object.keys(keys).sort()).toEqual(Array.from({ length: 8 }, (_, i) => 'edrv.k' + i).sort())
  })
})

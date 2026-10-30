/**
 * 官方记录查询的入参防御：解析结果是不透明 FsTarget 时，
 * 被误当路径传进 SQL 绑定会抛出「Unknown named parameter」这种与真实原因无关的错误。
 * @author ddj 2026年10月30号
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeArchiveDbs } from '../src/archiveDb.js'
import { hasOfficial } from '../src/reviewDb.js'

let home = ''
let previousHome: string | undefined
const cwd = '/official-guard-tests'

beforeAll(() => {
  previousHome = process.env.DSH_HOME
  home = mkdtempSync(join(tmpdir(), 'edrv-official-guard-'))
  process.env.DSH_HOME = home
})

afterAll(() => {
  closeArchiveDbs()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe('hasOfficial 入参防御', () => {
  it('把解析对象误当路径传入时按「无官方记录」处理，不抛 SQL 绑定错误', () => {
    expect(hasOfficial(cwd, { targetKey: 'opaque' } as unknown as string)).toBe(false)
  })

  it('正常字符串路径不抛错', () => {
    expect(hasOfficial(cwd, 'a.lua')).toBe(false)
  })
})

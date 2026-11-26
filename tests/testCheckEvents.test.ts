/**
 * 测试验收模式：事件排序去重、状态派生、证据判定与指纹口径。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import {
  hasEvidence,
  latestPerItem,
  subjectHashLines,
  verdictOf,
  type TestCheckEventFile,
} from '../src/shared/testCheck.js'

/** 造一条已读事件。 */
function eventFile(file: string, at: number, item: string, status: string, extra: Record<string, unknown> = {}): TestCheckEventFile {
  return {
    file,
    at,
    event: { item, status: status as never, ...extra },
  }
}

describe('latestPerItem', () => {
  it('同一 ID 取 at 最新的那条', () => {
    const latest = latestPerItem([
      eventFile('a.json', 100, 's.a.001', 'fail'),
      eventFile('b.json', 200, 's.a.001', 'pass'),
      eventFile('c.json', 150, 's.a.002', 'blocked'),
    ])
    expect(latest.get('s.a.001')?.event.status).toBe('pass')
    expect(latest.get('s.a.002')?.event.status).toBe('blocked')
  })

  it('at 相同时按文件名升序取最后一条（结果稳定可测）', () => {
    const latest = latestPerItem([
      eventFile('20261125T101203-bbbb.json', 100, 's.a.001', 'fail'),
      eventFile('20261125T101203-aaaa.json', 100, 's.a.001', 'pass'),
    ])
    expect(latest.get('s.a.001')?.file).toBe('20261125T101203-bbbb.json')
  })

  it('不打乱输入数组', () => {
    const input = [eventFile('b.json', 200, 's.a.001', 'pass'), eventFile('a.json', 100, 's.a.001', 'fail')]
    latestPerItem(input)
    expect(input[0].file).toBe('b.json')
  })
})

describe('verdictOf', () => {
  it('没有事件就是未验', () => {
    expect(verdictOf(undefined, false)).toBe('todo')
  })

  it('带证据的 pass 算通过', () => {
    const file = eventFile('a.json', 1, 's.a.001', 'pass', { evidence: { summary: 'vitest 12/12' } })
    expect(verdictOf(file, false)).toBe('pass')
  })

  it('没有证据的 pass 只算「声明通过」', () => {
    const file = eventFile('a.json', 1, 's.a.001', 'pass', { evidence: {} })
    expect(verdictOf(file, false)).toBe('claimed')
  })

  it('失效优先于原状态', () => {
    const file = eventFile('a.json', 1, 's.a.001', 'pass', { evidence: { summary: 'x' } })
    expect(verdictOf(file, true)).toBe('stale')
  })

  it('fail / blocked / skip 原样透出', () => {
    expect(verdictOf(eventFile('a.json', 1, 's.a.001', 'fail', { evidence: { summary: 'x' } }), false)).toBe('fail')
    expect(verdictOf(eventFile('a.json', 1, 's.a.001', 'blocked', { evidence: { summary: 'x' } }), false)).toBe('blocked')
    expect(verdictOf(eventFile('a.json', 1, 's.a.001', 'skip', { evidence: { summary: 'x' } }), false)).toBe('skip')
  })

  it('非法状态按未验处理（事件在校验阶段本就会进 ignored）', () => {
    expect(verdictOf(eventFile('a.json', 1, 's.a.001', 'passed', { evidence: { summary: 'x' } }), false)).toBe('todo')
  })
})

describe('hasEvidence', () => {
  it('退出码 0 也算证据（不能被假值判空）', () => {
    expect(hasEvidence({ exitCode: 0 })).toBe(true)
  })

  it('空对象、纯空白字符串不算证据', () => {
    expect(hasEvidence({})).toBe(false)
    expect(hasEvidence({ summary: '   ', command: '', path: '  ' })).toBe(false)
    expect(hasEvidence(undefined)).toBe(false)
  })

  it('路径或命令任意一项非空就算证据', () => {
    expect(hasEvidence({ path: 'logs/a.txt' })).toBe(true)
    expect(hasEvidence({ command: 'npx vitest run' })).toBe(true)
  })
})

describe('subjectHashLines', () => {
  it('按路径排序拼文本，路径与摘要都进指纹', () => {
    const text = subjectHashLines([
      { path: 'src/b.ts', sha256: 'bbb' },
      { path: 'src/a.ts', sha256: 'aaa' },
    ])
    expect(text).toBe('src/a.ts\naaa\nsrc/b.ts\nbbb\n')
  })

  it('没有文件时为空串（不做失效判定）', () => {
    expect(subjectHashLines([])).toBe('')
  })
})

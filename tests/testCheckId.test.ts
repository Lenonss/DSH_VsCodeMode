/**
 * 测试验收模式：单子 id 派生、命令输入解析、测试点 id 校验。
 * @author ddj 2026年11月25号
 */
import { describe, expect, it } from 'vitest'
import {
  TEST_CHECK_DEFAULT_ID,
  eventFileNameOf,
  idProblemOf,
  isItemId,
  isSheetId,
  parseCheckInput,
  testCheckIdOf,
} from '../src/shared/testCheck.js'

/** 默认单子 id 的短别名，避免下面每处都写长名。 */
const DEFAULT_SHEET_ID = TEST_CHECK_DEFAULT_ID

describe('/test-check 单子 id', () => {
  it('同样的任务文本总是算出同一个 id（宿主与客户端必须一致）', () => {
    const task = '把设置页的开关切换验证一遍'
    expect(testCheckIdOf(task)).toBe(testCheckIdOf(task))
    expect(testCheckIdOf('verify settings toggles')).toBe(testCheckIdOf('verify settings toggles'))
  })

  it('英文任务取前三个有意义的词做 kebab-case', () => {
    expect(testCheckIdOf('verify settings toggle behavior now')).toBe('verify-settings-toggle')
  })

  it('中文任务没有可用词时退回 check-<8 位哈希>', () => {
    const id = testCheckIdOf('把设置页验证一遍')
    expect(id).toMatch(/^check-[0-9a-f]{8}$/)
    expect(isSheetId(id)).toBe(true)
  })

  it('没有任务文本时用固定默认 id', () => {
    expect(testCheckIdOf('')).toBe(DEFAULT_SHEET_ID)
    expect(testCheckIdOf(undefined)).toBe(DEFAULT_SHEET_ID)
  })

  it('派生出来的 id 一律合法', () => {
    for (const task of ['a', 'ab', 'HTML plan mode', '中文 mixed words here', 'X'.repeat(300)]) {
      expect(isSheetId(testCheckIdOf(task))).toBe(true)
    }
  })
})

describe('/test-check 输入解析', () => {
  it('off 不区分大小写，任务为空', () => {
    expect(parseCheckInput('off')).toEqual({ action: 'off', task: '' })
    expect(parseCheckInput('  OFF  ')).toEqual({ action: 'off', task: '' })
  })

  it('其余文本原样作为任务（保留内部换行）', () => {
    expect(parseCheckInput('第一行\n第二行')).toEqual({ action: 'enter', task: '第一行\n第二行' })
  })

  it('空输入仍然是进入模式', () => {
    expect(parseCheckInput('')).toEqual({ action: 'enter', task: '' })
  })
})

describe('测试点 id 校验', () => {
  it('合法样本', () => {
    expect(isItemId('settings.claude-style.004')).toBe(true)
    expect(isItemId('a.b.001')).toBe(true)
  })

  it('非法样本逐条说明原因', () => {
    expect(idProblemOf('')).toBe('ID 为空')
    expect(idProblemOf('settings.004')).toContain('三段')
    expect(idProblemOf('settings.Claude.004')).toContain('小写')
    expect(idProblemOf('settings.claude.4')).toContain('3 位')
    expect(idProblemOf('-settings.claude.004')).toContain('小写')
    expect(idProblemOf('settings.claude-style.0004')).toContain('3 位')
  })
})

describe('结果文件名', () => {
  it('带时间戳与随机后缀，扩展名固定', () => {
    const at = new Date(Date.UTC(2026, 10, 25, 10, 12, 3))
    const name = eventFileNameOf(at, () => 0.5)
    expect(name).toMatch(/^20261125T101203-[0-9a-f]{4}\.json$/)
  })

  it('同一时刻写两次不会撞名', () => {
    const at = new Date(Date.UTC(2026, 10, 25, 10, 12, 3))
    let seed = 0
    const next = (): number => { seed += 0.13; return seed % 1 }
    const first = eventFileNameOf(at, next)
    const second = eventFileNameOf(at, next)
    expect(first).not.toBe(second)
  })
})

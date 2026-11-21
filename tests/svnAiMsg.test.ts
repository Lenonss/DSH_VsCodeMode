// @ts-nocheck
/**
 * AI 提交信息纯函数单测（22-agent-tools-and-commit）。
 * 守护：只分析提交范围、首行单行且限长、围栏/纯文本宽松解析、失败给可读错误。
 * @author ddj 2026年11月15号
 */
import { describe, expect, it } from 'vitest'
import { buildCommitPrompt, commitSystemPrompt, normalizeCommitMsg } from '../src/ai/svnCommitMsg.js'

const entries = [
  { path: 'src/a.ts', status: 'modified', versioned: true },
  { path: 'src/b.ts', status: 'added', versioned: true },
]

describe('commitSystemPrompt / buildCommitPrompt', () => {
  it('系统指令声明唯一 JSON、首行限长与范围纪律', () => {
    const plain = commitSystemPrompt('plain')
    expect(plain).toContain('subject')
    expect(plain).toContain('72')
    expect(plain).toContain('不要提到清单之外的文件')
    expect(commitSystemPrompt('conventional')).toContain('Conventional Commits')
  })

  it('数据段只包含给定范围的文件', () => {
    const prompt = buildCommitPrompt(entries, null)
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('src/b.ts')
    expect(prompt).toContain('无 diff 上下文')
    expect(prompt).not.toContain('src/c.ts')
  })

  it('带 diff 时附在数据段末尾', () => {
    const prompt = buildCommitPrompt(entries, '@@ -1 +1 @@\n-a\n+b')
    expect(prompt).toContain('diff')
    expect(prompt).toContain('+b')
  })
})

describe('normalizeCommitMsg', () => {
  it('接受对象形状并剥离围栏', () => {
    const out = normalizeCommitMsg({ subject: '```\nfix: 修正\n```', body: '正文' }, 'plain')
    expect(out).toEqual({ subject: 'fix: 修正', body: '正文' })
  })

  it('接受纯文本（首行作 subject）', () => {
    expect(normalizeCommitMsg('feat: 新增\n\n说明', 'conventional')).toEqual({ subject: 'feat: 新增', body: '说明' })
  })

  it('缺首行 / 首行超长 → 错误文案', () => {
    expect(normalizeCommitMsg({ body: '只有正文' }, 'plain').error).toContain('首行')
    expect(normalizeCommitMsg({ subject: 'x'.repeat(90) }, 'plain').error).toContain('不合规')
  })
})

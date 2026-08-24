/** devForm 开发形态管理测试：manifest 规划 / profile 发现 / 状态读取。作者 ddj 2026年08月24号 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProfileDir, planManifest, readDevForm } from '../src/devForm.js'

const MANIFEST = `{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "dsh-other": "^1.0.0",
    "dsh-vscode-mode": "link:D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review"
  }
}
`

describe('planManifest', () => {
  it('开启开发形态写入 link: 依赖并保留其他字段', () => {
    const next = planManifest(MANIFEST, true, 'D:\\Work\\repo', '0.1.16')
    const parsed = JSON.parse(next)
    expect(parsed.dependencies['dsh-vscode-mode']).toBe('link:D:/Work/repo')
    expect(parsed.dependencies['dsh-other']).toBe('^1.0.0')
    expect(parsed.name).toBe('dsh-profile-web')
    expect(next.startsWith('{')).toBe(true)
  })

  it('关闭开发形态写入版本依赖（^当前版本）', () => {
    const next = planManifest(MANIFEST, false, '', '0.1.16')
    const parsed = JSON.parse(next)
    expect(parsed.dependencies['dsh-vscode-mode']).toBe('^0.1.16')
  })

  it('容忍 UTF-8 BOM 输入且输出无 BOM', () => {
    const next = planManifest('\uFEFF' + MANIFEST, false, '', '0.1.16')
    expect(next.startsWith('\uFEFF')).toBe(false)
    expect(JSON.parse(next).dependencies['dsh-vscode-mode']).toBe('^0.1.16')
  })

  it('非法 JSON 或缺失 dependencies 时抛错', () => {
    expect(() => planManifest('not json', true, 'x', '1')).toThrow()
    expect(() => planManifest('{"name":"x"}', true, 'x', '1')).toThrow()
  })
})

describe('findProfileDir / readDevForm', () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dsh-devform-'))
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    mkdirSync(join(home, 'profiles', 'other'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), MANIFEST)
    writeFileSync(join(home, 'profiles', 'other', 'package.json'), '{"name":"x","dependencies":{"z":"^1"}}')
    vi.stubEnv('DSH_HOME', home)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('在多个 profile 中定位依赖本插件的 profile', () => {
    expect(findProfileDir()).toBe(join(home, 'profiles', 'web'))
  })

  it('link: 依赖读取为开发形态并带工作区路径', () => {
    expect(readDevForm()).toEqual({ enabled: true, path: 'D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review' })
  })

  it('版本依赖视为非开发形态', () => {
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), MANIFEST.replace('link:D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review', '^0.1.16'))
    expect(readDevForm()).toEqual({ enabled: false })
  })

  it('无 profile 时安全返回未开启', () => {
    rmSync(join(home, 'profiles'), { recursive: true, force: true })
    expect(findProfileDir()).toBeUndefined()
    expect(readDevForm()).toEqual({ enabled: false })
  })
})

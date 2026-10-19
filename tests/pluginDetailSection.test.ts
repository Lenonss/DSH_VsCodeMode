/**
 * client ui/PluginDetailSection 的 subject 形状判定测试。
 * 官方有两种 subject：内置项 {kind:'item', id} 与安装包 {kind:'bundle', pkg:{name}}。
 * @author ddj 2026年10月19号
 */
import { describe, expect, it } from 'vitest'
import { SELF_ID, isSelfSubject } from '../src/client/ui/PluginDetailSection.js'

describe('isSelfSubject', () => {
  it('内置项形状命中本插件 id', () => {
    expect(isSelfSubject({ kind: 'item', id: SELF_ID })).toBe(true)
  })

  it('安装包形状命中本插件包名', () => {
    expect(isSelfSubject({ kind: 'bundle', pkg: { name: SELF_ID } })).toBe(true)
  })

  it('其他插件的两种形状都不命中', () => {
    expect(isSelfSubject({ kind: 'item', id: 'other-plugin' })).toBe(false)
    expect(isSelfSubject({ kind: 'bundle', pkg: { name: 'other-plugin' } })).toBe(false)
  })

  it('未知 kind 不命中（官方后续新增形状时安全回落）', () => {
    expect(isSelfSubject({ kind: 'catalog', id: SELF_ID })).toBe(false)
    expect(isSelfSubject({ kind: 'bundle', pkg: { name: SELF_ID }, extra: 1 })).toBe(true)
  })

  it('畸形 subject 不抛错且不命中', () => {
    expect(isSelfSubject(null)).toBe(false)
    expect(isSelfSubject(undefined)).toBe(false)
    expect(isSelfSubject('dsh-vscode-mode')).toBe(false)
    expect(isSelfSubject({ kind: 'bundle' })).toBe(false)
    expect(isSelfSubject({ kind: 'item' })).toBe(false)
    expect(isSelfSubject({ kind: 'item', id: 42 })).toBe(false)
  })
})

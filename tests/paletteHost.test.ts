/**
 * 命令栏宿主认领（claim/release）回归测试。
 *
 * 事故回顾：`claimPaletteHost()` 曾返回 boolean，调用方自行 `{}` 造令牌；
 * 而 `releasePaletteHost` 有身份校验 `hostToken !== token → return`，两者**永不相同**：
 *   1. 卸载时释放恒失败 → hostToken 永久泄漏为「非 null」；
 *   2. 之后任何实例（EditorView / ConversationDiffDock）认领都被拒 → 一律渲染 null；
 *   3. opened=true 但无人渲染浮层 → Ctrl+Shift+P「完全没有反应」且**永不恢复**
 *      （启动期实例更替即触发，故表现为「重启后一开始就没反应」）。
 *
 * 本文件钉住：令牌身份一致、释放后他人可接管、宿主更替自愈。
 * 作者 ddj 2026-09-10
 */
import { describe, expect, it } from 'vitest'
import {
  claimPaletteHost, paletteHostRev, releasePaletteHost, subscribePalette,
} from '../src/client/commandPaletteStore.js'

describe('命令栏宿主认领（claim/release 令牌身份）', () => {
  it('认领返回的令牌可被原样释放（身份一致，杜绝泄漏）', () => {
    const token = claimPaletteHost()
    expect(token, '首个认领者应成功').not.toBeNull()
    // 身份一致的直接证据：释放后他人可再次认领
    releasePaletteHost(token)
    const again = claimPaletteHost()
    expect(again, '释放后应能被重新认领（旧实现此处永久失败）').not.toBeNull()
    releasePaletteHost(again)
  })

  it('已有宿主时第二个实例认领失败（单实例语义保持不变）', () => {
    const first = claimPaletteHost()
    expect(first).not.toBeNull()
    expect(claimPaletteHost(), '第二个实例必须认领失败').toBeNull()
    releasePaletteHost(first)
  })

  it('非持有者释放无效（null / 伪造令牌均不改变宿主状态）', () => {
    const holder = claimPaletteHost()
    expect(holder).not.toBeNull()
    // 伪造令牌与 null 都不得顶掉真实宿主
    releasePaletteHost(null)
    releasePaletteHost({})
    expect(claimPaletteHost(), '真实宿主仍在，他人不得认领').toBeNull()
    releasePaletteHost(holder)
  })

  it('释放递增宿主版本并通知订阅者（驱动其余实例重试认领 → 自愈）', () => {
    const holder = claimPaletteHost()
    let notified = 0
    const unsubscribe = subscribePalette(() => { notified += 1 })
    const revBefore = paletteHostRev()

    releasePaletteHost(holder)
    expect(notified, '释放必须通知（否则残留实例不会重试）').toBeGreaterThan(0)
    expect(paletteHostRev()).toBeGreaterThan(revBefore)
    unsubscribe()
  })

  it('宿主更替全链路：A 持有 → A 释放 → B 接管（快捷键不失效）', () => {
    // A 挂载并认领
    const tokenA = claimPaletteHost()
    expect(tokenA).not.toBeNull()
    // B 挂载但认领失败（单实例）
    expect(claimPaletteHost()).toBeNull()
    // A 卸载（会话切换/形态切换）→ 释放后 B 必须能接管
    releasePaletteHost(tokenA)
    const tokenB = claimPaletteHost()
    expect(tokenB, 'B 必须能在 A 释放后接管（否则无人渲染浮层）').not.toBeNull()
    releasePaletteHost(tokenB)
  })

  it('重复释放同一令牌幂等（不抛错、不重复通知）', () => {
    const token = claimPaletteHost()
    let notified = 0
    const unsubscribe = subscribePalette(() => { notified += 1 })
    releasePaletteHost(token)
    const afterFirst = notified
    releasePaletteHost(token)
    expect(notified).toBe(afterFirst)
    unsubscribe()
  })
})

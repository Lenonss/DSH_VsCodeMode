import type { CompatAdapter } from '../shared/compat.js'
import { SIDEBAR_PLUGIN } from './compat.js'

/** Runtime installation facts, separate from the DSH version and user intent. */
export interface ClientCompatState {
  settingsService: string
  settingsReady: boolean
  openPathReady: boolean
  remoteReady: boolean
  sidebarOpener: boolean
  legacySidebar: boolean
  officialSidebar: boolean
  fileClaim: boolean
  claimWanted: boolean
  selected: string
  officialMenus?: boolean
  forge?: boolean
  /** 模板语言（EJS/Jinja/Nunjucks/Blade/Haml/Slim/ERB）是否注册成功（v0.30.0）。 */
  templateLanguages?: boolean
  /** 是否探测到官方 composer 座位（引用接入依赖它，v0.30.0）。 */
  composerSeat?: boolean
  /** 搜索面板全局替换是否可用（v0.30.0）。 */
  searchReplace?: boolean
}

/**
 * Classify the API generation without importing the host's node-only version probe.
 * @private @author ddj 2026年10月13号
 * @param input Running DSH version from the compat RPC.
 * @param patch First supported 0.1.x patch (alpha.1).
 * @returns Whether that API generation is expected; undefined for unknown versions.
 */
function apiExpected(input: string, patch: number): boolean | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/.exec(input.trim())
  if (!match) return undefined
  const major = Number(match[1])
  const minor = Number(match[2])
  const current = Number(match[3])
  if (major !== 0) return major > 0
  if (minor !== 1) return minor > 1
  if (current !== patch) return current > patch
  const pre = match[4]
  if (!pre) return true
  const parts = pre.split('.')
  if (/^\d+$/.test(parts[0])) return false
  if (parts[0] !== 'alpha') return parts[0] > 'alpha'
  return parts.length > 1 && (/^\d+$/.test(parts[1]) ? Number(parts[1]) >= 1 : true)
}

/**
 * Build only applicable diagnostics; explicit legacy choices still expose missing capabilities.
 * @public @author ddj 2026年10月13号
 * @param state Actual client installation facts and user selection.
 * @param version Running DSH version; unknown versions retain conservative diagnostics.
 * @returns Visible adapters, without changing routing or installation.
 */
export function clientSummary(state: ClientCompatState, version = ''): CompatAdapter[] {
  const remoteExpected = apiExpected(version, 3)
  const officialExpected = apiExpected(version, 5)
  const official = state.officialSidebar
  const legacyChosen = state.selected === SIDEBAR_PLUGIN
  const items: CompatAdapter[] = [{
    name: '设置桥', active: state.settingsReady,
    note: state.settingsReady ? '使用 ' + state.settingsService + ' 桥' : '未绑定设置服务（持久化不可用，晚到重试窗口内自愈）',
  }]
  if (remoteExpected !== true && !state.remoteReady && !official) {
    items.push({ name: '文件打开路由（workspaces.openPath）', active: state.openPathReady, note: '旧版对话文件链接路由，失败回退系统打开' })
  }
  if (remoteExpected !== false || state.remoteReady) {
    items.push({ name: '会话文件链接路由（remote.session.openWorkspacePath）', active: state.remoteReady, note: state.remoteReady ? '会话文件链接走插件打开器，失败回退系统打开' : '适用路由未安装（服务缺失或补丁失败）' })
  }
  if (legacyChosen || state.sidebarOpener || (!official && officialExpected !== true)) {
    items.push({ name: '侧边栏打开器（' + SIDEBAR_PLUGIN + '）', active: state.sidebarOpener, note: state.sidebarOpener ? '已注册（优先级 80）' : '未检测到侧边栏打开能力' })
  }
  if (official || officialExpected !== false) {
    items.push({ name: '侧边栏编辑区（官方 Sidebar）', active: official, note: official ? '编辑区=官方右侧 Sidebar Tab（对话+编辑同屏）' : '官方侧边栏服务未探测到' })
  }
  if (!official && (state.legacySidebar || officialExpected !== true)) {
    items.push({ name: '侧边栏编辑区（' + SIDEBAR_PLUGIN + '，归档）', active: state.legacySidebar, note: state.legacySidebar ? '编辑区=旧版侧边栏 Tab' : '旧版侧边栏回退能力未检测到' })
  }
  if (state.fileClaim || (state.claimWanted && (official || officialExpected !== false))) {
    items.push({ name: '文件链接官方认领（dsh-resource://file）', active: state.fileClaim, note: state.fileClaim ? '聊天文件链接转发进单一编辑器页签' : '官方文件链接认领未安装' })
  }
  if (state.officialMenus !== undefined) items.push({ name: '官方右键菜单', active: state.officialMenus, note: state.officialMenus ? '插件动作接入共享菜单' : '服务缺失或装配失败，保留插件菜单' })
  if (state.forge !== undefined) items.push({ name: 'Forge 导航', active: state.forge, note: state.forge ? '导航至官方面板与本地变更；PR 保持官方审查' : '官方 Forge 未安装或未启用，不自动启用' })
  if (state.templateLanguages !== undefined) {
    items.push({ name: '模板语言高亮（EJS/ERB/Nunjucks/Jinja2/Blade/Haml/Slim）', active: state.templateLanguages, note: state.templateLanguages ? '已注册到 Monaco（编辑器打开模板文件按对应语法分色）' : 'Monaco 未就绪或注册失败，模板文件回落 plaintext' })
  }
  if (state.composerSeat !== undefined) {
    items.push({ name: '引用接入（拖文件/粘贴文件/复制行引用）', active: state.composerSeat, note: state.composerSeat ? '探测到官方对话输入区，拖入/粘贴会落成引用 chip' : '未探测到对话输入区（旧版 DSH 或未打开会话），引用接入自动不生效' })
  }
  if (state.searchReplace !== undefined) {
    items.push({ name: '搜索面板全局替换', active: state.searchReplace, note: state.searchReplace ? '先预览命中数再确认写盘；执行前自动落盘已打开页签' : '当前环境未启用' })
  }
  return items
}

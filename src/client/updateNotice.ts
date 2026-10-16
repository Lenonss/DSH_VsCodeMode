/**
 * dsh-vscode-mode client — 可用更新主动提醒：启动延迟 + 抖动后检查 registry 新版本，
 * 有更新且该版本未提醒过时经 toastDom 弹提示（每版本一次，localStorage 去重）。
 * 设计：检查失败静默（不打扰）；开发形态（link: 安装）下不提醒（应走工作区同步）。
 * 作者 ddj 2026-10-16
 */
import { rpc } from './rpc.js'
import { toastDom } from './externalOpen.js'
import { PLUGIN_NAME } from '../compat.js'

/** localStorage 去重键：值为已提醒过的最新版本号。 */
const NOTICE_KEY = 'vsm-update-notice'

/** 启动后首次检查的延迟（毫秒）。 */
const NOTICE_DELAY_MS = 30000

/** 抖动上限（毫秒）：避免多客户端同时请求 registry。 */
const NOTICE_JITTER_MS = 30000

/**
 * 读取开发形态状态（客户端侧经 RPC 查询；失败按未开启处理）。
 * @private
 * @author ddj 2026年10月16号
 * @returns devForm.enabled 是否为 true
 */
async function devFormEnabled(): Promise<boolean> {
  try {
    const result = await rpc('vscode.devFormGet', {})
    return result.ok === true && (result.devForm as { enabled?: boolean } | undefined)?.enabled === true
  } catch {
    return false
  }
}

/**
 * 执行一次可用更新检查并在需要时弹 toast 提醒（同版本只提醒一次）。
 * @private
 * @author ddj 2026年10月16号
 */
async function checkAndNotify(): Promise<void> {
  if (await devFormEnabled()) return
  const result = await rpc('vscode.updateCheck', {})
  if (result.ok !== true || result.hasUpdate !== true) return
  const latest = String(result.latest ?? '')
  if (!latest) return
  let storage: Storage | null = null
  try { storage = window.localStorage } catch { /* 隐私模式等场景静默降级 */ }
  if (storage?.getItem(NOTICE_KEY) === latest) return
  storage?.setItem(NOTICE_KEY, latest)
  toastDom(PLUGIN_NAME + ' 有可用更新：v' + latest + '（设置页「文件与安装」可一键更新）')
}

/**
 * 装配更新提醒：启动 30s + 0~30s 抖动后检查一次；失败静默。
 * @public
 * @author ddj 2026年10月16号
 * @param ctx DSH client 上下文
 * @param schedule 定时器注入（ctx.timeout），便于测试与生命周期统一
 */
export function installUpdateNotice(ctx: { timeout(fn: () => void, ms: number): unknown }, schedule: (fn: () => void, ms: number) => void): void {
  schedule(() => {
    void checkAndNotify().catch(() => { /* 检查失败静默，不打扰 */ })
  }, NOTICE_DELAY_MS + Math.floor(Math.random() * NOTICE_JITTER_MS))
}

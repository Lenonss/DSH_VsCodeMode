// @ts-nocheck
/**
 * dsh-vscode-mode client — ClaimRouter：官方 file 认领页签的中转正文。
 * 官方为每个 `dsh-resource://file/**` 地址开一个认领页签；本组件只做转发：
 * 解析地址 → 送进单一编辑器页签（文件分页由编辑器自带页签栏接管）→ 关闭本中转页签。
 * 转发失败（seat 未就绪等瞬时态）按 3 次 ×150ms 重试；仍失败则就地渲染兜底正文
 * （旧行为：每文件一套编辑器），保证退化路径不白屏。本组件自身不创建 Monaco 实例。
 * 作者 ddj 2026年09月10号
 */
import React from 'react'
import { forwardToEditor, parseOfficialFileAddress, resolveNavLine } from '../officialSidebar.js'
import { log } from '../log.js'

/** 转发尝试次数（含首次）与重试间隔。 */
const FORWARD_ATTEMPTS = 3
const FORWARD_DELAY_MS = 150

/**
 * 读 slot 框架注入的 tab 记录（hook 缺失或抛错时返回 undefined）。
 * @author ddj 2026年09月10号
 * @param props slot 框架注入的组件 props
 * @returns tab 记录（含 navigation 与 actions），或 undefined
 */
function readTab(props) {
  const useTabInfo = props?.useTabInfo
  if (typeof useTabInfo !== 'function') return undefined
  try {
    return useTabInfo()?.tab
  } catch {
    return undefined
  }
}

/**
 * 关闭本中转页签（失败仅告警：目标文件已在编辑器打开，残留页签不阻塞功能）。
 * @author ddj 2026年09月10号
 * @param tab slot 框架注入的 tab 记录
 */
function closeTab(tab) {
  try {
    tab?.actions?.close?.()
  } catch (error) {
    log.warn('中转页签关闭失败（' + String(error) + '）')
  }
}

/**
 * 组装 file 认领转发正文。
 * @author ddj 2026年09月10号
 * @param spec 装配依赖（service 官方导航服务 / schedule 延时调度 / fallback 兜底正文）
 * @returns 正文组件（注册进 keyed slot sidebar.right.pane.tab）
 */
export function createClaimRouter(spec) {
  const service = spec?.service
  const schedule = spec?.schedule
  const fallback = spec?.fallback

  /**
   * 中转正文：转发成功即关闭自身；重试耗尽后渲染兜底正文。
   * @param props slot 框架注入（useTabInfo）+ 装配依赖
   * @returns 兜底正文元素，或 null（转发中 / 已转发）
   */
  function ClaimRouter(props) {
    const tab = readTab(props)
    const navigation = tab?.navigation
    const revision = typeof navigation?.revision === 'number' ? navigation.revision : -1
    const [failed, setFailed] = React.useState(false)
    const doneRef = React.useRef(-1)

    React.useEffect(() => {
      if (revision === doneRef.current) return
      doneRef.current = revision
      const parsed = parseOfficialFileAddress(navigation?.address)
      if (!parsed) {
        setFailed(true)
        return
      }
      const line = resolveNavLine(navigation?.params)
      let left = FORWARD_ATTEMPTS
      const attempt = () => {
        if (forwardToEditor(service, parsed.path, line)) {
          closeTab(tab)
          return
        }
        left -= 1
        if (left > 0 && typeof schedule === 'function') schedule(attempt, FORWARD_DELAY_MS)
        else setFailed(true)
      }
      attempt()
    }, [revision])

    if (!failed || typeof fallback !== 'function') return null
    return React.createElement(fallback, props)
  }
  return ClaimRouter
}

// @ts-nocheck
/**
 * dsh-vscode-mode client — 官方插件管理器详情页的只读状态段。
 * 挂在 DSH 0.2.1 新增的 `plugins.detail.section`（list / root）扩展位上，
 * 只在「本插件自己」的详情页渲染，其余插件页返回 null。
 * 作者 ddj 2026年10月19号
 */
import React from 'react'
import { rpc } from '../rpc.js'

/** 本插件标识（与 package.json name / bundle 行 id 一致）。 */
export const SELF_ID = 'dsh-vscode-mode'

/**
 * 判断详情页 subject 是否指向本插件。
 * 官方有两种形状：官方内置项 `{kind:'item', id}`、安装包 `{kind:'bundle', pkg:{name}}`。
 * @author ddj 2026年10月19号
 * @param subject 详情页主题
 * @returns 是否为本插件
 */
export function isSelfSubject(subject) {
  if (!subject || typeof subject !== 'object') return false
  if (subject.kind === 'item') return subject.id === SELF_ID
  if (subject.kind === 'bundle') return subject.pkg?.name === SELF_ID
  return false
}

/**
 * 把适配项列表压成「正常 / 未生效」计数文案。
 * @author ddj 2026年10月19号
 * @param list 适配项数组
 * @returns 计数文案
 */
function countText(list) {
  const items = Array.isArray(list) ? list : []
  const ok = items.filter((item) => item?.active === true).length
  return ok + ' / ' + items.length + ' 项生效'
}

/**
 * 插件详情页的只读状态段。
 * @author ddj 2026年10月19号
 * @param props DSH 注入的 { subject }
 * @returns 状态段元素或 null（非本插件页）
 */
export function PluginDetailSection(props) {
  const subject = props?.subject
  const isSelf = isSelfSubject(subject)
  const [report, setReport] = React.useState(null)

  React.useEffect(() => {
    if (!isSelf) return undefined
    let alive = true
    rpc('compat', {}).then((result) => {
      if (!alive || !result || !result.ok) return
      setReport(result.report ?? null)
    }).catch(() => { /* 状态段属锦上添花，取不到就不显示 */ })
    return () => { alive = false }
  }, [isSelf])

  if (!isSelf) return null

  const row = (name, note) => React.createElement('div', { key: name, className: 'vsm-compat-item ok' },
    React.createElement('span', { className: 'vsm-compat-name' }, name),
    React.createElement('span', { className: 'vsm-compat-note' }, note),
  )

  const versionText = report?.dshVersion ? 'DSH ' + report.dshVersion : '未探测到 DSH 版本'
  const pluginText = report?.pluginVersion ? '插件 ' + report.pluginVersion : '插件版本未上报'
  const warnCount = Array.isArray(report?.warnings) ? report.warnings.length : 0

  return React.createElement('section', { className: 'vsm-panel', 'data-edrv-plugin-status': '1' },
    React.createElement('h3', { className: 'vsm-panel-title' }, 'VSCodeMode 运行状态'),
    React.createElement('div', { className: 'vsm-panel-body' },
      row('版本', versionText + ' · ' + pluginText),
      row('版本适配', countText(report?.adapters)),
      row('外部插件与服务', countText(report?.external)),
      row('护栏', countText(report?.guards)),
      row('兼容性警告', warnCount ? warnCount + ' 条（设置页「兼容性」可查看详情）' : '未检测到'),
    ),
  )
}

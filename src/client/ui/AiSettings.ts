// @ts-nocheck
/**
 * dsh-vscode-mode client — AI 补全设置卡片。
 * 开关 + 模型下拉（edrv.ai.models 目录，按 provider 分组，默认「自动」）+
 * 思考强度下拉（随所选模型的 efforts 元数据动态渲染：无档位隐藏；含「跟随默认」）。
 * 保存走 edrv.ai.configUpdate；保存后广播 edrv:ai-config 事件让 provider 即时生效。
 * 第二组「AI 任务模型」：非补全 AI 调用（AI 智能整理等）专用路由，独立于补全模型；
 * 留空 = 跟随补全模型配置（向后兼容）。
 * 作者 ddj
 */
import React from 'react'
import { rpc } from '../rpc.js'
import { setAiInlineEnabled } from '../ai/inlineProvider.js'
import { isDelistedModel } from '../../shared/ai.js'

/**
 * AI 补全设置卡片（设置页「AI 补全」Tab 主体）。
 * @author ddj
 */
export function AiSettings() {
  const [cfg, setCfg] = React.useState(null)
  const [dir, setDir] = React.useState(null)
  const [note, setNote] = React.useState('')
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    Promise.all([rpc('edrv.ai.configGet', {}), rpc('edrv.ai.models', {})])
      .then(([c, d]) => {
        if (c.ok) {
          setCfg({
            enabled: c.enabled, provider: c.provider, model: c.model, effort: c.effort,
            taskProvider: c.taskProvider || '', taskModel: c.taskModel || '', taskEffort: c.taskEffort || '',
          })
        } else setError(c.error || '配置读取失败')
        if (d.ok) setDir(d)
        else setError(d.error || '模型目录读取失败')
      })
      .catch((e) => setError(String(e)))
  }, [])

  /** 所选 provider 下的模型条目（自动路由时取首组供档位参考）。 */
  const modelsOf = (provider) => {
    if (!dir?.providers?.length) return []
    if (!provider) return dir.providers[0]?.models ?? []
    return dir.providers.find((p) => p.id === provider)?.models ?? []
  }

  /** 档位可选项（补全/任务两组选择器共用）：模型无 reasoning 元数据 → 空数组（隐藏）。 */
  const effortsOf = (provider, model) => {
    const models = modelsOf(provider)
    return models.find((m) => m.model === model)?.efforts ?? models[0]?.efforts ?? []
  }

  const save = async (patch) => {
    setBusy(true)
    setError('')
    try {
      const res = await rpc('edrv.ai.configUpdate', patch)
      if (!res.ok) throw new Error(res.error || '保存失败')
      setCfg({
        enabled: res.enabled, provider: res.provider, model: res.model, effort: res.effort,
        taskProvider: res.taskProvider || '', taskModel: res.taskModel || '', taskEffort: res.taskEffort || '',
      })
      setAiInlineEnabled(res.enabled)
      setNote('已保存')
      window.dispatchEvent(new CustomEvent('edrv:ai-config', { detail: { enabled: res.enabled } }))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = () => save({ enabled: !cfg.enabled })

  /** 下拉值 `provider/model` → 换模型 patch（档位不属新模型时一并清空；补全/任务两组共用）。 */
  const patchOfModel = (value, keys) => {
    if (!value) return { [keys.provider]: '', [keys.model]: '' }
    const idx = value.indexOf('/')
    const provider = value.slice(0, idx)
    const model = value.slice(idx + 1)
    const efforts = modelsOf(provider).find((m) => m.model === model)?.efforts ?? []
    const keep = efforts.some((e) => e.id === cfg[keys.effort])
    return keep ? { [keys.provider]: provider, [keys.model]: model } : { [keys.provider]: provider, [keys.model]: model, [keys.effort]: '' }
  }

  const pickModel = (value) => save(patchOfModel(value, { provider: 'provider', model: 'model', effort: 'effort' }))
  const pickTaskModel = (value) => save(patchOfModel(value, { provider: 'taskProvider', model: 'taskModel', effort: 'taskEffort' }))

  if (!cfg) return React.createElement('div', { className: 'vsm-mcp-empty' }, error || '正在读取 AI 补全配置…')

  const modelValue = cfg.provider && cfg.model ? cfg.provider + '/' + cfg.model : ''
  const taskModelValue = cfg.taskProvider && cfg.taskModel ? cfg.taskProvider + '/' + cfg.taskModel : ''
  const efforts = effortsOf(cfg.provider, cfg.model)
  const taskEfforts = effortsOf(cfg.taskProvider, cfg.taskModel)
  // G7：配置指向已从官方默认列表下架的模型（DSH 0.1.6-alpha.2 移除 V4 Flash 系列）。
  // 仅提示，不擅自改写用户已保存的配置（避免覆盖其意图）；清空即回到自动路由。
  const delisted = isDelistedModel(cfg.model)
  const taskDelisted = isDelistedModel(cfg.taskModel)
  return React.createElement('section', { className: 'vsm-lsp-card' },
    React.createElement('h3', null, 'AI 自动补全（实验）'),
    React.createElement('p', { className: 'vsm-lsp-note' }, '编辑停顿后由模型生成内联建议（ghost text），Tab 接受，Alt+\\ 手动触发。每次补全是一次模型调用；建议选择非推理模型，且思考强度选「跟随默认」或最低档以获得更快响应。'),
    (delisted
      ? React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' },
          '当前模型「' + cfg.model + '」已从 DSH 默认模型列表移除（0.1.6-alpha.2 起）。该模型可能不再可用；将「模型」改回「自动」即可使用第一个可用模型（现有配置不会被自动改动）。')
      : null),
    React.createElement('div', { className: 'vsm-lsp-row' },
      React.createElement('button', { className: cfg.enabled ? 'vsm-primary' : '', disabled: busy, onClick: toggle },
        cfg.enabled ? '已开启（点击关闭）' : '已关闭（点击开启）'),
    ),
    React.createElement('div', { className: 'vsm-lsp-row' },
      React.createElement('label', null, '模型',
        React.createElement('select', { value: modelValue, disabled: busy || !dir?.providers?.length, onChange: (e) => pickModel(e.target.value) },
          React.createElement('option', { value: '' }, dir?.providers?.length ? '自动（取第一个可用模型）' : '无可用模型'),
          (dir?.providers ?? []).flatMap((p) => p.models.map((m) => React.createElement('option', { key: p.id + '/' + m.model, value: p.id + '/' + m.model }, p.name + ' · ' + m.name)))),
      ),
      efforts.length ? React.createElement('label', null, '思考强度',
        React.createElement('select', { value: cfg.effort, disabled: busy, onChange: (e) => save({ effort: e.target.value }) },
          React.createElement('option', { value: '' }, '跟随默认'),
          efforts.map((e) => React.createElement('option', { key: e.id, value: e.id }, e.name))),
      ) : null,
    ),
    React.createElement('h3', null, 'AI 任务模型（AI 智能整理等非补全调用）'),
    React.createElement('p', { className: 'vsm-lsp-note' }, '独立于补全模型：整理分析可选推理模型 + 较高思考强度，补全仍可选快模型。留空 = 跟随补全模型配置。'),
    (taskDelisted
      ? React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' },
          '任务模型「' + cfg.taskModel + '」已从 DSH 默认模型列表移除（0.1.6-alpha.2 起）。该模型可能不再可用；将「模型」改回「自动」即可跟随补全配置（现有配置不会被自动改动）。')
      : null),
    React.createElement('div', { className: 'vsm-lsp-row' },
      React.createElement('label', null, '模型',
        React.createElement('select', { value: taskModelValue, disabled: busy || !dir?.providers?.length, onChange: (e) => pickTaskModel(e.target.value) },
          React.createElement('option', { value: '' }, '自动（跟随补全配置）'),
          (dir?.providers ?? []).flatMap((p) => p.models.map((m) => React.createElement('option', { key: p.id + '/' + m.model, value: p.id + '/' + m.model }, p.name + ' · ' + m.name)))),
      ),
      taskEfforts.length ? React.createElement('label', null, '思考强度',
        React.createElement('select', { value: cfg.taskEffort, disabled: busy, onChange: (e) => save({ taskEffort: e.target.value }) },
          React.createElement('option', { value: '' }, '跟随默认'),
          taskEfforts.map((e) => React.createElement('option', { key: e.id, value: e.id }, e.name))),
      ) : null,
    ),
    note && React.createElement('div', { className: 'vsm-compat-item ok' }, React.createElement('span', { className: 'vsm-compat-name' }, note)),
    error && React.createElement('div', { className: 'vsm-mcp-error vsm-mcp-banner' }, error),
  )
}

/**
 * dsh-vscode-mode shared — 验收单页面渲染器（纯函数，页签 iframe 与导出快照共用）。
 *
 * 渲染是固定的：标题、汇总条（通过/失败/阻塞/未验/需复验）、按分组列用例
 * （ID、标题、状态、证据摘要、时间），刻意不放任何决策控件——勾选与上报在页签工具栏里。
 *
 * 输出是完整单文件 HTML：CSS 内联、没有 `<script>`、所有动态文本转义，
 * 所以导出到 `docs/acceptance-<id>.html` 后脱离 DSH 也能直接打开。
 * @author ddj 2026年11月25号
 */

import {
  evidenceTextOf,
  TEST_CHECK_LABELS,
  type TestCheckItemView,
  type TestCheckView,
} from './testCheck.js'

//region 转义与格式化

/**
 * HTML 文本转义（含引号，属性与文本共用）。
 * @author ddj 2026年11月25号
 * @param value 任意值
 * @returns 转义后的文本
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 把 ISO 时间格式化成本地 `MM-DD HH:mm`（解析失败原样返回，不抛）。
 * @author ddj 2026年11月25号
 * @param iso ISO 时间串
 * @returns 展示文本；空输入返回空串
 */
export function timeTextOf(iso: unknown): string {
  const text = typeof iso === 'string' ? iso.trim() : ''
  if (!text) return ''
  const at = new Date(text)
  if (Number.isNaN(at.getTime())) return text
  const pad = (value: number): string => String(value).padStart(2, '0')
  return pad(at.getMonth() + 1) + '-' + pad(at.getDate()) + ' ' + pad(at.getHours()) + ':' + pad(at.getMinutes())
}

/**
 * 派生状态对应的配色类名（页签与快照共用同一套）。
 * @author ddj 2026年11月25号
 * @param item 一条验收点视图
 * @returns CSS 类名后缀
 */
export function verdictToneOf(item: TestCheckItemView): string {
  if (item.verdict === 'pass') return 'ok'
  if (item.verdict === 'fail') return 'bad'
  if (item.verdict === 'blocked') return 'warn'
  if (item.verdict === 'stale') return 'stale'
  if (item.verdict === 'claimed') return 'warn'
  return 'dim'
}

//endregion

//region 样式

/** 页面样式（内联进 `<style>`；客户端 iframe 与导出共用，不依赖外部令牌）。 */
const STYLE = [
  ':root{color-scheme:light}',
  '*{box-sizing:border-box}',
  'body{margin:0;padding:0;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1c1b19;background:#fff}',
  '.edrv-tc{padding:14px 18px 20px;max-width:1100px}',
  '.edrv-tc-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:10px;margin-bottom:10px}',
  '.edrv-tc-head h1{font-size:17px;line-height:1.3;margin:0;font-weight:650}',
  '.edrv-tc-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:#8a8578}',
  '.edrv-tc-sum{display:flex;flex-wrap:wrap;gap:14px;align-items:baseline;padding:8px 12px;border:1px solid #e6e1d5;border-radius:8px;background:#faf8f3;margin-bottom:14px;font-size:12.5px}',
  '.edrv-tc-sum b{font-size:15px;font-weight:700;margin-right:3px}',
  '.edrv-tc-sum .ok b{color:#1f7a52}.edrv-tc-sum .bad b{color:#b42318}.edrv-tc-sum .warn b{color:#b4541f}.edrv-tc-sum .stale b{color:#8a5a00}.edrv-tc-sum .dim b{color:#8a8578}',
  '.edrv-tc-group{margin:0 0 14px}',
  '.edrv-tc-group h2{font-size:12px;font-weight:650;color:#6b6659;margin:0 0 6px;padding-bottom:4px;border-bottom:1px solid #f0ece0}',
  '.edrv-tc-row{display:grid;grid-template-columns:minmax(180px,220px) 1fr auto;gap:4px 12px;align-items:baseline;padding:7px 0;border-bottom:1px solid #f6f3ea}',
  '.edrv-tc-row code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;color:#5f5a4f}',
  '.edrv-tc-title{font-size:13px;color:#1c1b19}',
  '.edrv-tc-badge{font-size:11.5px;font-weight:650;padding:1px 8px;border-radius:9px;border:1px solid currentColor;white-space:nowrap}',
  '.edrv-tc-badge.ok{color:#1f7a52}.edrv-tc-badge.bad{color:#b42318}.edrv-tc-badge.warn{color:#b4541f}.edrv-tc-badge.stale{color:#8a5a00}.edrv-tc-badge.dim{color:#8a8578}',
  '.edrv-tc-sub{grid-column:2 / -1;font-size:12px;color:#8a8578}',
  '.edrv-tc-note{margin:10px 0 0;font-size:12px;color:#8a8578}',
  '.edrv-tc-empty{padding:18px;border:1px dashed #ddd8cc;border-radius:10px;background:#fcfbf7}',
  '.edrv-tc-empty h2{font-size:14px;margin:0 0 8px}',
  '.edrv-tc-empty p{margin:0 0 8px;font-size:12.5px;color:#5f5a4f}',
  '.edrv-tc-empty pre{margin:10px 0;padding:10px 12px;border-radius:8px;background:#f6f3ea;overflow:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5}',
  '.edrv-tc-err{margin:8px 0 0;padding-left:18px;font-size:12.5px;color:#b42318}',
  '.edrv-tc-foot{margin-top:16px;padding-top:8px;border-top:1px solid #f0ece0;font-size:11.5px;color:#8a8578}',
].join('')

//endregion

//region 建单引导

/** `items.json` 模板（页签与快照的建单引导共用）。 */
export function itemsTemplateOf(id: string): string {
  return [
    '{',
    '  "id": "' + id + '",',
    '  "title": "这次要验收什么",',
    '  "version": 1,',
    '  "items": [',
    '    {',
    '      "id": "settings.claude-style.001",',
    '      "title": "开关切换后立即生效",',
    '      "group": "设置",',
    '      "files": ["src/client/ui/IntegrationSettings.ts"]',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

/**
 * 建单说明（缺定义时页签与快照都展示它）。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @returns 引导段落 HTML 片段
 */
function guideOf(view: TestCheckView): string {
  const lines: string[] = []
  lines.push('<div class="edrv-tc-empty">')
  if (view.state === 'missing') {
    lines.push('<h2>还没有验收单</h2>')
    lines.push('<p>在 <code>' + escapeHtml(view.dir + '/items.json') + '</code> 写这份定义，或者让 AI 按下面的模板建单。</p>')
  } else {
    lines.push('<h2>items.json 校验没通过</h2>')
    lines.push('<ul class="edrv-tc-err">')
    for (const line of String(view.error ?? '').split('\n').filter(Boolean)) {
      lines.push('<li>' + escapeHtml(line) + '</li>')
    }
    lines.push('</ul>')
  }
  lines.push('<p>ID 形如 <code>settings.claude-style.004</code>：<code>&lt;scope&gt;.&lt;area&gt;.&lt;3 位序号&gt;</code>，全局唯一、只增不改号；删条目把 <code>retired</code> 置 true。</p>')
  lines.push('<pre>' + escapeHtml(itemsTemplateOf(view.id)) + '</pre>')
  lines.push('<p>结果不用写进定义：每次验证往 <code>' + escapeHtml(view.eventsDir) + '/</code> 写一个 JSON 文件，'
    + '必填只有 <code>item</code> 与 <code>status</code>（pass / fail / blocked / skip）。页签工具栏可以复制各语言的上报片段。</p>')
  lines.push('</div>')
  return lines.join('')
}

//endregion

//region 汇总与列表

/**
 * 汇总条（固定五格 + 总数）。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @returns HTML 片段
 */
function summaryOf(view: TestCheckView): string {
  const cells: Array<[string, number, string]> = [
    ['通过', view.counts.pass, 'ok'],
    ['失败', view.counts.fail, 'bad'],
    ['阻塞', view.counts.blocked, 'warn'],
    ['需复验', view.counts.stale, 'stale'],
    ['未验', view.counts.todo, 'dim'],
  ]
  const body = cells
    .map(([label, count, tone]) => '<span class="' + tone + '"><b>' + String(count) + '</b>' + escapeHtml(label) + '</span>')
    .join('')
  return '<div class="edrv-tc-sum">' + body + '<span class="dim">共 <b>' + String(view.counts.total) + '</b>条</span></div>'
}

/**
 * 一行验收点。
 * @author ddj 2026年11月25号
 * @param item 验收点视图
 * @returns HTML 片段
 */
function rowOf(item: TestCheckItemView): string {
  const tone = verdictToneOf(item)
  const when = timeTextOf(item.at)
  const evidence = evidenceTextOf(item.evidence)
  const detail: string[] = []
  if (item.stale) detail.push('被验文件在验过之后又变了')
  if (item.verdict === 'claimed') detail.push('AI 声明通过，无证据，不计入通过数')
  if (evidence) detail.push(escapeHtml(evidence))
  if (when) detail.push(escapeHtml(when))
  return '<div class="edrv-tc-row" data-item="' + escapeHtml(item.id) + '" data-verdict="' + item.verdict + '">'
    + '<code>' + escapeHtml(item.id) + '</code>'
    + '<span class="edrv-tc-title">' + escapeHtml(item.title) + '</span>'
    + '<span class="edrv-tc-badge ' + tone + '">' + escapeHtml(TEST_CHECK_LABELS[item.verdict]) + '</span>'
    + (detail.length ? '<span class="edrv-tc-sub">' + detail.join(' · ') + '</span>' : '')
    + '</div>'
}

/**
 * 分组列表。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @returns HTML 片段
 */
function groupsOf(view: TestCheckView): string {
  if (!view.groups.length) {
    return '<div class="edrv-tc-note">这个单子还没有验收点。</div>'
  }
  return view.groups.map((group) => '<section class="edrv-tc-group">'
    + '<h2>' + escapeHtml(group.name) + '</h2>'
    + group.items.map(rowOf).join('')
    + '</section>').join('')
}

//endregion

//region 渲染入口

/** 渲染选项。 */
export interface TestCheckHtmlOptions {
  /** 导出快照时附一行页脚（页签里不需要）。 */
  exported?: boolean
  /** 导出时间（默认当下）。 */
  at?: Date
}

/**
 * 渲染完整验收单页面。
 *
 * 数据没变（同一 `stamp`）时输出逐字节相同，页签据此决定不重绘 iframe。
 * @author ddj 2026年11月25号
 * @param view 派生视图
 * @param options 导出标记与时间
 * @returns 完整 HTML 文档
 */
export function renderSheetHtml(view: TestCheckView, options: TestCheckHtmlOptions = {}): string {
  const title = view.title || view.id
  const lines: string[] = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="dsh-vscode-mode /test-check">',
    '<title>' + escapeHtml(title) + ' · 验收单</title>',
    '<style>' + STYLE + '</style>',
    '</head>',
    '<body>',
    '<div class="edrv-tc" data-test-check="' + escapeHtml(view.id) + '" data-state="' + view.state + '">',
    '<div class="edrv-tc-head">',
    '<h1>' + escapeHtml(title) + '</h1>',
    '<span class="edrv-tc-id">' + escapeHtml(view.id) + '</span>',
    '</div>',
  ]

  if (view.state === 'ready') {
    lines.push(summaryOf(view), groupsOf(view))
  } else {
    lines.push(guideOf(view))
  }

  if (view.ignored.length) {
    const head = view.ignored.slice(0, 5)
      .map((entry) => entry.file + '：' + entry.reason)
      .join('；')
    lines.push('<div class="edrv-tc-note">已忽略 ' + String(view.ignored.length) + ' 个事件文件（' + escapeHtml(head) + '）</div>')
  }

  if (options.exported) {
    const at = options.at ?? new Date()
    lines.push('<div class="edrv-tc-foot">导出快照 · ' + escapeHtml(at.toISOString()) + ' · 由 dsh-vscode-mode 的 /test-check 生成</div>')
  }

  lines.push('</div>', '</body>', '</html>')
  return lines.join('\n')
}

//endregion

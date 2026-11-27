#!/usr/bin/env node
/**
 * ui-kit build：spec + runtime → 单文件 HTML。
 *
 *   node build.mjs --spec <spec.json> --out <plan.html> [--lib <库根>]… [--check] [--quiet]
 *   node build.mjs --selftest
 *
 * 规则：有错就不写文件；写之前先算 hash；素材一律内联成 data URI。
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, resolve, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const CSS_DIR = join(HERE, 'css')
const JS_DIR = join(HERE, 'js')

export const RUNTIME_VERSION = '1.2.0'
const KINDS = new Set(['group', 'text', 'image', 'sprite', 'button', 'list', 'prefab'])
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
}
const MAX_IMAGE = 6 * 1024 * 1024
const MAX_PAGE = 12 * 1024 * 1024

/* ── 规范化与 hash ───────────────────────────────────────────── */

export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

export function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function hashSpec(spec) {
  const { hash, ...rest } = spec
  return fnv1a(canonical(rest))
}

/* ── 校验 ───────────────────────────────────────────────────── */

export function validateSpec(spec, specDir) {
  const errors = []
  const warnings = []
  if (!spec || typeof spec !== 'object') return { errors: ['spec 不是对象'], warnings }

  if (spec.v !== 1) errors.push(`spec.v 必须是 1，当前 ${JSON.stringify(spec.v)}`)
  const page = spec.page || 'design'
  if (page !== 'design' && page !== 'library') errors.push('page 只能是 design 或 library')

  const screen = spec.screen || {}
  if (!(screen.w > 0 && screen.h > 0)) errors.push('screen.w / screen.h 必须是正数')

  if (page === 'library') return { errors, warnings }

  const nodes = Array.isArray(spec.nodes) ? spec.nodes : []
  if (!nodes.length) warnings.push('nodes 为空，页面只有效果图')

  const byId = new Map()
  nodes.forEach((n, i) => {
    const at = `nodes[${i}]${n && n.id ? ` ${n.id}` : ''}`
    if (!n || typeof n !== 'object') { errors.push(`${at}: 不是对象`); return }
    if (!n.id || typeof n.id !== 'string') { errors.push(`${at}: 缺 id`); return }
    if (byId.has(n.id)) errors.push(`${at}: id 重复`)
    byId.set(n.id, n)
    if (!KINDS.has(n.kind)) errors.push(`${at}: kind 未知（${n.kind}）`)
    if (!Array.isArray(n.rect) || n.rect.length !== 4 ||
        n.rect.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`${at}: rect 必须是 4 个数字`)
    } else if (n.rect[2] <= 0 || n.rect[3] <= 0) {
      errors.push(`${at}: rect 的 w / h 必须大于 0`)
    }
    if (n.kind === 'text' && (!n.text || typeof n.text.s !== 'string')) {
      errors.push(`${at}: text 节点缺 text.s`)
    }
    if (n.opaque && n.kind !== 'prefab') errors.push(`${at}: opaque 只能用在 kind:"prefab"`)
    if (n.ref && typeof n.ref === 'string' && !/^lib:/.test(n.ref)) {
      errors.push(`${at}: ref 必须以 lib: 开头`)
    }
  })

  nodes.forEach((n) => {
    if (!n || typeof n !== 'object' || n.parent == null) return
    if (!byId.has(n.parent)) errors.push(`${n.id}: parent 不存在（${n.parent}）`)
  })

  for (const n of nodes) {
    if (!n || typeof n !== 'object' || !n.id) continue
    let p = n.parent
    let depth = 0
    while (p != null) {
      if (p === n.id) { errors.push(`${n.id}: parent 链成环`); break }
      const pn = byId.get(p)
      if (!pn) break
      p = pn.parent
      if (++depth > 64) { errors.push(`${n.id}: parent 链过深`); break }
    }
  }

  for (const n of nodes) {
    if (!n || typeof n !== 'object' || !n.opaque) continue
    const kids = nodes.filter((k) => k && k.parent === n.id)
    if (kids.length) errors.push(`${n.id}: opaque 节点内不能有子节点（${kids.map((k) => k.id).join(', ')}）`)
  }

  if (spec.mock && spec.mock.src && !/^data:/.test(spec.mock.src) && specDir) {
    const p = resolve(specDir, spec.mock.src)
    if (!existsSync(p)) errors.push(`mock.src 找不到：${spec.mock.src}`)
  }

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    if (typeof n.src === 'string' && n.src && !/^data:/.test(n.src) && specDir) {
      if (!existsSync(resolve(specDir, n.src))) errors.push(`${n.id}: src 找不到（${n.src}）`)
    }
    if (n.ref && !n.libOk) warnings.push(`${n.id}: 引用了库条目 ${n.ref}，未提供库根，按未知处理`)
  }

  return { errors, warnings }
}

/* ── 素材内联 ───────────────────────────────────────────────── */

function toDataUri(absPath, label, warnings) {
  if (!existsSync(absPath)) return null
  const size = statSync(absPath).size
  if (size > MAX_IMAGE) warnings.push(`${label} 体积 ${(size / 1048576).toFixed(1)}MB，超过 6MB 内联上限，先压图`)
  const mime = MIME[extname(absPath).toLowerCase()] || 'application/octet-stream'
  return `data:${mime};base64,${readFileSync(absPath).toString('base64')}`
}

export function inlineAssets(spec, specDir, warnings = []) {
  const out = JSON.parse(JSON.stringify(spec))
  if (out.mock && typeof out.mock.src === 'string' && out.mock.src && !/^data:/.test(out.mock.src)) {
    const uri = toDataUri(resolve(specDir, out.mock.src), 'mock 图', warnings)
    if (uri) out.mock.src = uri
  }
  for (const n of out.nodes || []) {
    if (typeof n.src === 'string' && n.src && !/^data:/.test(n.src)) {
      const uri = toDataUri(resolve(specDir, n.src), `${n.id} 的图`, warnings)
      if (uri) n.src = uri
    }
  }
  return out
}

/* ── 页面壳 ─────────────────────────────────────────────────── */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function specJsonForPage(spec) {
  return JSON.stringify(spec).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function readRuntime() {
  const read = (dir, ext, sep) => {
    if (!existsSync(dir)) return ''
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join(sep)
  }
  // JS 用 ";\n" 拼，避免上一个文件的结尾跟下一个文件开头的 (function(){}) 粘连
  return { css: read(CSS_DIR, '.css', '\n'), js: read(JS_DIR, '.js', '\n;\n') }
}

export function renderHtml({ spec, css, js }) {
  const screen = spec.screen || {}
  const title = `${screen.name || 'untitled'} · ui-kit`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style data-htmlplan>${css}</style>
</head>
<body>
<script id="ui-spec" type="application/json">${specJsonForPage(spec)}</script>
<div id="app"></div>
<script data-htmlplan>${js}</script>
</body>
</html>
`
}

/* ── 构建 ───────────────────────────────────────────────────── */

export function build(specPath, opts = {}) {
  const abs = resolve(specPath)
  if (!existsSync(abs)) throw new Error(`spec 不存在：${specPath}`)
  const specDir = dirname(abs)
  const raw = JSON.parse(readFileSync(abs, 'utf8'))

  const warnings = []
  const { errors } = validateSpec(raw, specDir)
  const hash = hashSpec(raw)
  const spec = inlineAssets({ ...raw, hash }, specDir, warnings)
  const { css, js } = readRuntime()
  if (!css) errors.push('runtime/css 为空')
  if (!js) errors.push('runtime/js 为空')

  if (errors.length) {
    const err = new Error(errors.join('\n'))
    err.errors = errors
    err.warnings = warnings
    throw err
  }

  const html = renderHtml({ spec, css, js })
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > (opts.maxBytes || MAX_PAGE)) {
    warnings.push(`页面 ${(bytes / 1048576).toFixed(2)}MB，超过上限 ${(MAX_PAGE / 1048576).toFixed(0)}MB，压图或改局部图`)
  }
  return { html, bytes, hash, warnings, spec }
}

/* ── 自检 ───────────────────────────────────────────────────── */

export function selftest(opts = {}) {
  const specPath = join(SKILL_ROOT, 'fixtures', 'selftest', 'spec.json')
  const outPath = join(SKILL_ROOT, 'fixtures', 'selftest', 'plan.selftest.html')
  const checks = []
  const add = (name, ok, detail = '') => checks.push({ name, ok, detail })

  let built
  try {
    built = build(specPath, { maxBytes: 2 * 1024 * 1024 })
  } catch (e) {
    if (!opts.quiet) {
      console.error('❌ 自检构建失败：')
      for (const line of e.errors || [e.message]) console.error('  ✖ ' + line)
    }
    return { ok: false, checks: [{ name: '构建', ok: false, detail: e.message }] }
  }

  const { html, hash, spec } = built
  writeFileSync(outPath, html, 'utf8')

  add('产物有 ui-spec 数据块', /<script id="ui-spec" type="application\/json">/.test(html))
  add('没有外链样式', !/<link\b[^>]*href=/i.test(html))
  add('没有外链脚本', !/<script\b[^>]*\bsrc=/i.test(html))
  add('没有 doc- 标签', !/<doc-[a-z]+/i.test(html))
  add('没有 http(s) 外链', !/\b(src|href)\s*=\s*["']https?:/i.test(html))
  add('带计划签通行标记', /<style data-htmlplan>/.test(html) && /<script data-htmlplan>/.test(html))

  let parsed = null
  try {
    const m = html.match(/<script id="ui-spec" type="application\/json">([\s\S]*?)<\/script>/)
    parsed = JSON.parse(m[1].replace(/\\u003c/g, '<'))
    add('ui-spec 能被 JSON.parse', true)
  } catch (e) {
    add('ui-spec 能被 JSON.parse', false, e.message)
  }
  if (parsed) {
    add('页面里的 hash 与重新计算一致', parsed.hash === hashSpec(parsed), `page=${parsed.hash} calc=${hashSpec(parsed)}`)
    add('节点数与 spec 一致', (parsed.nodes || []).length === (spec.nodes || []).length)
  }

  add('体积在 2MB 内', built.bytes < 2 * 1024 * 1024, `${(built.bytes / 1024).toFixed(0)}KB`)
  add('渲染器与样式都在页内', html.includes('ui-tree') && html.includes('ui-canvas'))
  add('hash 是 8 位十六进制', /^[0-9a-f]{8}$/.test(hash), hash)

  const ok = checks.every((c) => c.ok)
  if (!opts.quiet) {
    for (const c of checks) console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`)
    console.log(ok ? `\n自检通过。产物：${outPath}` : '\n自检未通过。')
  }
  return { ok, checks, outPath, bytes: built.bytes }
}

/* ── CLI ────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const a = { libs: [] }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v == null) throw new Error(`${k} 缺参数`)
      return v
    }
    if (k === '--spec') a.spec = next()
    else if (k === '--out') a.out = next()
    else if (k === '--lib') a.libs.push(next())
    else if (k === '--check') a.check = true
    else if (k === '--selftest') a.selftest = true
    else if (k === '--quiet') a.quiet = true
    else if (k === '--max-bytes') a.maxBytes = Number(next())
    else if (k === '-h' || k === '--help') a.help = true
    else throw new Error(`未知参数：${k}`)
  }
  return a
}

function usage() {
  console.log(`ui-kit build ${RUNTIME_VERSION}
  --spec <spec.json> --out <plan.html> [--lib <库根>]… [--check] [--quiet] [--max-bytes N]
  --selftest   用 fixtures/selftest 生成一页并断言
  没有 --out 时只打印检查结果，不写文件。`)
}

function main() {
  let a
  try {
    a = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  if (a.help) return usage()
  if (a.selftest) return void (selftest({ quiet: a.quiet }).ok ? process.exit(0) : process.exit(1))
  if (!a.spec) return void (usage(), process.exit(2))

  let built
  try {
    built = build(a.spec, { maxBytes: a.maxBytes })
  } catch (e) {
    console.error('构建失败：')
    for (const line of (e.errors || [e.message])) console.error('  ✖ ' + line)
    for (const w of e.warnings || []) console.error('  ⚠ ' + w)
    process.exit(1)
  }

  if (a.out && !a.check) {
    writeFileSync(resolve(a.out), built.html, 'utf8')
    if (!a.quiet) console.log(`写出 ${a.out} · ${(built.bytes / 1024).toFixed(0)}KB · hash ${built.hash}`)
  } else if (!a.quiet) {
    console.log(`校验通过 · hash ${built.hash} · ${(built.bytes / 1024).toFixed(0)}KB（未写文件）`)
  }
  for (const w of built.warnings) console.error('⚠ ' + w)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()

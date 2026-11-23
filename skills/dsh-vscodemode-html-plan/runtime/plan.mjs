#!/usr/bin/env node
// plan.mjs — one command to turn plans/<slug>/plan.html into plan.packed.html.
//   node plan.mjs <slug> [--root <dir>] [--check] [--keep]
// Copies the runtime next to the page, runs pack.mjs, then removes runtime/ and the
// unpacked plan.html so only the single packed page stays in the repo.
// @author ddj 2026年11月23号
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : '' }
const slug = argv.find((arg, i) => !arg.startsWith('-') && (i === 0 || !['--root'].includes(argv[i - 1])))
const root = resolve(opt('--root') || process.cwd())

/** 打印错误并按失败退出（不做任何后续步骤）。 */
function die(message) {
  console.error('✗ ' + message)
  process.exit(1)
}

if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) die('用法：node plan.mjs <slug> [--root <dir>] [--check] [--keep]\n   slug 用小写 kebab-case，例如 html-plan-own-answer')

const dir = join(root, 'plans', slug)
const pagePath = join(dir, 'plan.html')
const packedPath = join(dir, 'plan.packed.html')

// --check：只确认打包产物在位且运行时已内联，供提交计划前自检
if (flag('--check')) {
  if (!existsSync(packedPath)) die(`plan.packed.html 不存在：${packedPath}（先写 plan.html 再跑本脚本）`)
  if (!flag('--keep') && existsSync(pagePath)) die(`plan.html 还在：上次打包没成功或没清理，先重跑 plan.mjs ${slug}`)
  const text = readFileSync(packedPath, 'utf8')
  if (/<(?:link|script)\b[^>]*?\s(?:href|src)\s*=\s*["'][^"']*htmlplan\.(?:css|js)/i.test(text)) die(`plan.packed.html 仍引用运行时文件，没打包干净：${packedPath}`)
  if (!/<style[^>]*data-htmlplan/i.test(text) || !/<script[^>]*data-htmlplan/i.test(text)) die(`plan.packed.html 里没有内联样式/脚本，可能不是 pack.mjs 的产物：${packedPath}`)
  console.log(`✓ ${packedPath}  ${(statSync(packedPath).size / 1024).toFixed(0)} KB`)
  process.exit(0)
}

if (!existsSync(pagePath)) die(`plan.html 不存在：${pagePath}（先写页面，再跑本脚本）`)

// 1) 运行时放到页面旁边，pack 才能按相对路径找到 css/js
const runtimeDir = join(dir, 'runtime')
mkdirSync(runtimeDir, { recursive: true })
for (const file of ['htmlplan.css', 'htmlplan.js', 'pack.mjs']) {
  copyFileSync(join(here, file), join(runtimeDir, file))
}

// 2) 打包（pack 自己会做 lint；有 error 时退出码非 0，此时保留现场便于修）
let packed = false
try {
  execFileSync(process.execPath, [join(runtimeDir, 'pack.mjs'), pagePath, '--root', root], { stdio: 'inherit' })
  packed = true
} catch {
  console.error('✗ 打包失败：修完页面再跑一次（runtime/ 与 plan.html 已保留）')
  if (existsSync(packedPath)) console.error('⚠ 现有的 plan.packed.html 是上一版，没跟着这次改动更新——别拿它去提交')
}
if (!packed || !existsSync(packedPath)) process.exit(1)

// 3) 清理：只留打包好的单文件
if (!flag('--keep')) {
  rmSync(runtimeDir, { recursive: true, force: true })
  rmSync(pagePath, { force: true })
} else {
  console.log('· --keep：保留 runtime/ 与 plan.html')
}
console.log(`✓ ${packedPath}  ${(statSync(packedPath).size / 1024).toFixed(0)} KB`)
console.log(`下一步：计划正文单独一行写「HTML 计划页：plans/${slug}/plan.packed.html」，再调 exit_plan_mode`)

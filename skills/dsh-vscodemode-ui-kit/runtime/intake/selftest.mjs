#!/usr/bin/env node
/**
 * 材料服务 HTTP 回归：临时项目里启动真实服务，验证草稿、乱序、原始图片、
 * 正式清单、无效输入与关闭。只写系统临时目录，退出时清理。
 * @author ddj 2026年11月26号
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startIntakeServer, stopIntakeService, writeServicePage } from './server.mjs'

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3l9wAAAABJRU5ErkJggg==', 'base64'))

/** 发 multipart。 */
async function post(base, path, fields, files = []) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.append(key, String(value))
  for (const [field, name, bytes] of files) body.append(field, new File([bytes], name, { type: 'image/png' }))
  const response = await fetch(base + path, { method: 'POST', body })
  return { status: response.status, json: await response.json() }
}

/** 读 JSON。 */
async function get(base, path) {
  const response = await fetch(base + path)
  return { status: response.status, json: await response.json() }
}

/** 主回归。 */
export async function runHttpSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'ui-intake-http-'))
  let passed = 0
  let run = null
  const check = (condition, message) => {
    if (!condition) throw new Error(message)
    passed += 1
  }
  try {
    mkdirSync(join(root, '.dsh', 'ui-kit'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'ui-kit', 'config.json'), JSON.stringify({
      ui: { system: 'ugui', refResolution: [1080, 2400], matchMode: 'width', bindStyle: 'componentName', commonDir: 'Assets/UI/Common' },
      assets: { inProject: 'Assets/GameData' },
      pages: { dir: 'plans/ui' },
    }), 'utf8')
    const pagePath = 'plans/ui/check/intake/materials.html'
    run = await startIntakeServer({ projectRoot: root, slug: 'check', pagePath, port: 0, ui: { system: 'ugui', bindStyle: 'componentName', commonDir: 'Assets/UI/Common', matchMode: 'width' }, assets: { inProject: 'Assets/GameData' }, screen: { w: 1080, h: 2400 }, title: '检查' })
    writeServicePage({ projectRoot: root, slug: 'check', pagesDir: 'plans/ui', token: run.token, endpoint: 'http://127.0.0.1:' + run.port, pagePath, taskId: run.taskId, title: '检查', screen: { w: 1080, h: 2400 }, ui: { system: 'ugui' }, assets: { inProject: 'Assets/GameData' } })
    const base = 'http://127.0.0.1:' + run.port + '/t/' + run.token
    const empty = await get(base, '/draft')
    check(empty.status === 200 && empty.json.draft.assets.length === 0, '空草稿读取失败')

    const fields = { title: '', width: '1080', height: '2400', notes: '草稿一', targetPrefab: '', mockPath: '', assetPaths: '', sprites: '' }
    const first = await post(base, '/draft', { ...fields, textRevision: 1, assetRevision: 1, replaceAssets: 1 }, [['mock', '效果图 中文.png', PNG]])
    check(first.status === 200 && first.json.accepted.assets && first.json.draft.assets[0].originalName === '效果图 中文.png', '图片草稿保存失败')
    const assetResponse = await fetch(base + '/asset/' + first.json.draft.assets[0].file)
    check(assetResponse.status === 200 && (await assetResponse.arrayBuffer()).byteLength === PNG.byteLength, '原始图片读取失败')

    const text = await post(base, '/draft', { ...fields, notes: '新文字', textRevision: 3, assetRevision: 1, replaceAssets: 0 })
    check(text.status === 200 && text.json.accepted.text, '文字草稿保存失败')
    const stale = await post(base, '/draft', { ...fields, notes: '旧文字', textRevision: 2, assetRevision: 2, replaceAssets: 1 }, [['materials', '素材.png', PNG]])
    check(stale.status === 200 && stale.json.accepted.text === false && stale.json.accepted.assets === true, '乱序请求未按字段版本处理')
    const merged = await get(base, '/draft')
    check(merged.json.draft.fields.notes === '新文字' && merged.json.draft.assets[0].role === 'materials', '旧文字覆盖了新文字')

    const valid = await post(base, '/draft', { ...fields, title: '检查弹窗', notes: '新文字', textRevision: 4, assetRevision: 2, replaceAssets: 0 })
    check(valid.status === 200, '正式提交前文字草稿失败')
    const submitted = await post(base, '/submit', { textRevision: 4, assetRevision: 2, submissionId: 'check-submit-001' })
    check(submitted.status === 200 && submitted.json.ok && submitted.json.text.includes('/ui-builder 继续设计'), '正式提交失败')
    const manifest = JSON.parse(readFileSync(submitted.json.requestPath, 'utf8'))
    check(manifest.assets.length === 1 && manifest.assets[0].originalName === '素材.png', '清单未保留原始文件名')
    const saved = readFileSync(manifest.assets[0].absolutePath)
    check(Buffer.compare(saved, Buffer.from(PNG)) === 0, '清单图片不是原始字节')
    const again = await post(base, '/submit', { textRevision: 4, assetRevision: 2, submissionId: 'check-submit-001' })
    check(again.status === 200 && again.json.duplicate === true, '同一提交编号未幂等复用')

    const badToken = await fetch('http://127.0.0.1:' + run.port + '/t/bad/draft')
    check(badToken.status === 403, '错误令牌未被拒绝')
    const badForm = await post(base, '/draft', { ...fields, title: '坏尺寸', width: '0', height: '2400', textRevision: 5, assetRevision: 2, replaceAssets: 0 })
    check(badForm.status === 200, '草稿应允许未完成尺寸')
    const badSubmit = await post(base, '/submit', { textRevision: 5, assetRevision: 2, submissionId: 'check-submit-002' })
    check(badSubmit.status === 400, '无效尺寸提交未被拒绝')

    const stopped = await stopIntakeService(root, 'check', 'plans/ui')
    check(stopped.ok === true, '服务停止失败')
    await run.closed
    check(true, '服务关闭')
    console.log('UI intake HTTP selftest: ' + passed + ' checks passed')
  } finally {
    if (run) {
      try { await stopIntakeService(root, 'check', 'plans/ui') } catch { /* 已停止 */ }
      try { run.server.close() } catch { /* 已关闭 */ }
      await Promise.race([run.closed, new Promise((resolveWait) => setTimeout(resolveWait, 1000))])
    }
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').slice(-2).join('/'))) {
  runHttpSelftest().catch((error) => {
    console.error('UI intake HTTP selftest failed: ' + (error && error.message ? error.message : String(error)))
    process.exitCode = 1
  })
}

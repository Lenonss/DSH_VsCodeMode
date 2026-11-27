#!/usr/bin/env node
/**
 * UI 材料页的本机接收服务。
 *
 * 只监听 127.0.0.1，所有接口都要求 URL 中的随机令牌；草稿与正式提交写在
 * `<项目>/<pagesDir>/<slug>/intake/` 下，不覆盖 `plan.html`。服务可由
 * `intake.mjs --serve` 启动，`--stop` 关闭，状态记录在 `service.json`。
 *
 * 该文件随母版 runtime 分发，项目侧不需要临时写接收器。
 * @author ddj 2026年11月26号
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import {
  buildPageConfig,
  defaultsOf,
  limitsOf,
  normalizeRel,
  projectRootOf,
  readPageConfig,
  renderIntakePage,
} from '../intake.mjs'
import { buildMessage, draftFieldsOf, formOf, imageInfoOf, normalizeMediaType, savedNameOf, sha256Of, SUBMISSION_RE } from './shared.mjs'

export const MAX_BODY = 32 * 1024 * 1024
export const MAX_FIELD = 16384
const TEMPLATE = new URL('./materials.html', import.meta.url)

/** 规范化路径（/ 分隔）。 */
function slash(value) {
  return String(value ?? '').replace(/\\/gu, '/')
}

/** 判断 child 是否在 parent 下。 */
function under(parent, child) {
  const a = slash(parent).replace(/\/+$/u, '')
  const b = slash(child).replace(/\/+$/u, '')
  const fold = (value) => (/^[a-z]:\//iu.test(value) ? value.toLowerCase() : value)
  return fold(b) === fold(a) || fold(b).startsWith(fold(a) + '/')
}

/** 项目内路径。 */
export function pathsOf(projectRoot, slug, pagesDir = 'plans/ui') {
  const dir = normalizeRel(pagesDir) ?? 'plans/ui'
  const intake = join(projectRoot, ...(dir + '/' + slug + '/intake').split('/'))
  return {
    pagesDir: dir,
    intake,
    page: join(intake, 'materials.html'),
    draft: join(intake, 'draft'),
    draftFile: join(intake, 'draft', 'draft.json'),
    draftAssets: join(intake, 'draft', 'assets'),
    submissions: join(intake, 'submissions'),
    service: join(intake, 'service.json'),
    plan: join(projectRoot, ...(dir + '/' + slug + '/plan.html').split('/')),
  }
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** Windows 杀软/索引器偶尔让 rename 返回 EPERM；短暂重试后仍失败再抛。 */
function renameRetry(from, to) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = error && error.code
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt === 4) throw error
      sleepSync(40 + attempt * 40)
    }
  }
}

/** 原子写文件。 */
function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp-' + randomBytes(6).toString('hex')
  try {
    writeFileSync(tmp, data)
    renameRetry(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** 读 JSON；失败返回 null。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 新随机令牌（64 位十六进制）。 */
export function newToken() {
  return randomBytes(32).toString('hex')
}

/** 新任务编号。 */
export function newTaskId() {
  return 'ui-' + Date.now().toString(36) + '-' + randomBytes(3).toString('hex')
}

/** 令牌比较（定长，避免明显时序差异）。 */
function tokenOk(expected, actual) {
  const a = Buffer.from(String(expected ?? ''))
  const b = Buffer.from(String(actual ?? ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/** 空草稿。 */
function emptyDraft(projectRoot, slug, pagePath) {
  return {
    v: 1,
    kind: 'ui-builder-intake-draft',
    projectRoot: slash(projectRoot),
    slug,
    pagePath,
    textRevision: 0,
    assetRevision: 0,
    fields: draftFieldsOf({}),
    assets: [],
    updatedAt: new Date().toISOString(),
  }
}

/** 读草稿；不存在返回空草稿，损坏时抛错（不覆盖原文件）。 */
export function readDraft(paths, projectRoot, slug, pagePath) {
  if (!existsSync(paths.draftFile)) return emptyDraft(projectRoot, slug, pagePath)
  const raw = readJson(paths.draftFile)
  if (!raw || typeof raw !== 'object') throw new Error('草稿文件无法解析，已保留原文件；请先修复或移走 draft.json')
  return {
    ...emptyDraft(projectRoot, slug, pagePath),
    ...raw,
    fields: draftFieldsOf(raw.fields),
    assets: Array.isArray(raw.assets) ? raw.assets : [],
  }
}

/** 写草稿。 */
function writeDraft(paths, draft) {
  writeAtomic(paths.draftFile, JSON.stringify(draft, null, 2) + '\n')
}

/** 校验一张上传图片，生成草稿资产记录。 */
function assetRecord(upload, index, limits) {
  const role = upload.field === 'mock' ? 'mock' : upload.field === 'materials' ? 'materials' : ''
  if (!role) throw new Error('附件字段无效')
  const bytes = Buffer.from(upload.bytes)
  if (bytes.byteLength > limits.maxFileBytes) throw new Error('每张图片最多 ' + Math.round(limits.maxFileBytes / 1024 / 1024) + ' MB。')
  const check = imageInfoOf(bytes, upload.type)
  if (!check.ok) throw new Error(check.error + '：' + upload.name)
  if (check.info.width * check.info.height > limits.maxPixels) throw new Error('图片像素过大：' + upload.name)
  if (check.info.width > limits.maxSide || check.info.height > limits.maxSide) throw new Error('图片边长过大：' + upload.name)
  const sha = sha256Of(bytes)
  const ext = check.info.mediaType.slice('image/'.length) === 'jpeg' ? 'jpg' : check.info.mediaType.slice('image/'.length)
  return {
    role,
    originalName: upload.name,
    file: sha.slice(0, 16) + '-' + index + '.' + ext,
    mediaType: check.info.mediaType,
    width: check.info.width,
    height: check.info.height,
    bytes: bytes.byteLength,
    sha256: sha,
    buffer: bytes,
  }
}

/** 校验整组上传；数量、总大小、字段、内容都在这里。 */
function recordsOf(uploads, limits) {
  if (uploads.length > limits.maxFiles) throw new Error('一次最多提交 ' + limits.maxFiles + ' 张图片。')
  let total = 0
  const records = uploads.map((upload, index) => {
    const record = assetRecord(upload, index, limits)
    total += record.bytes
    return record
  })
  if (total > limits.maxTotalBytes) throw new Error('图片合计超过 ' + Math.round(limits.maxTotalBytes / 1024 / 1024) + ' MB。')
  return records
}

/** 保存草稿：文字和图片分别按版本号接受。 */
export function saveDraftRecord(paths, projectRoot, slug, pagePath, input, limits) {
  const previous = readDraft(paths, projectRoot, slug, pagePath)
  const textRevision = Math.max(0, Number(input.textRevision) || 0)
  const assetRevision = Math.max(0, Number(input.assetRevision) || 0)
  const replaceAssets = input.replaceAssets === true || input.replaceAssets === '1'
  const accepted = { text: false, assets: false }
  let draft = { ...previous, fields: { ...previous.fields }, assets: previous.assets }

  if (replaceAssets && assetRevision > previous.assetRevision) {
    const records = recordsOf(input.uploads ?? [], limits)
    mkdirSync(paths.draftAssets, { recursive: true })
    for (const record of records) writeFileSync(join(paths.draftAssets, record.file), record.buffer)
    const keep = new Set(records.map((record) => record.file))
    for (const asset of previous.assets) {
      if (asset?.file && !keep.has(asset.file)) rmSync(join(paths.draftAssets, asset.file), { force: true })
    }
    draft.assets = records.map(({ buffer, ...record }) => record)
    draft.assetRevision = assetRevision
    accepted.assets = true
  }
  if (textRevision > previous.textRevision) {
    draft.fields = draftFieldsOf(input.fields)
    draft.textRevision = textRevision
    accepted.text = true
  }
  if (accepted.text || accepted.assets) {
    draft.updatedAt = new Date().toISOString()
    delete draft.submitted
    writeDraft(paths, draft)
  }
  return { draft, accepted, stale: !accepted.text && !accepted.assets }
}

/** 清单对象。 */
function manifestOf({ projectRoot, pagesDir, slug, pagePath, token, submissionId, createdAt, form, assets, message, contentKey }) {
  return {
    v: 2,
    kind: 'ui-builder-intake',
    schema: 'ui-builder-intake/2',
    projectRoot: slash(projectRoot),
    pagesDir,
    slug,
    submissionId,
    createdAt,
    page: { path: pagePath, tokenHash: sha256Of(token) },
    title: form.title,
    screen: { w: form.width, h: form.height },
    notes: form.notes,
    targetPrefab: form.targetPrefab,
    mockPath: form.mockPath,
    assetPaths: form.assetPaths,
    sprites: form.sprites,
    project: {
      uiSystem: form.uiSystem,
      bindStyle: form.bindStyle,
      commonDir: form.commonDir,
      matchMode: form.matchMode,
      assets: { inProject: form.inProject, artRoot: form.artRoot },
    },
    assets,
    message,
    contentKey,
  }
}

/** 由草稿生成正式提交（复制原始字节，不改草稿资产）。 */
export function submitDraftRecord(paths, projectRoot, slug, pagePath, token, input, limits) {
  const draft = readDraft(paths, projectRoot, slug, pagePath)
  const textRevision = Math.max(0, Number(input.textRevision) || 0)
  const assetRevision = Math.max(0, Number(input.assetRevision) || 0)
  if (textRevision < draft.textRevision || assetRevision < draft.assetRevision) {
    return { ok: false, stale: true, status: 409, error: '页面内容已更新，请刷新草稿后重试', draft }
  }
  const formCheck = formOf(draft.fields)
  if (!formCheck.ok) return { ok: false, status: 400, error: formCheck.error }
  const form = formCheck.form
  const submissionId = String(input.submissionId ?? '')
  if (!SUBMISSION_RE.test(submissionId)) return { ok: false, status: 400, error: '提交编号无效' }

  const finalDir = join(paths.submissions, submissionId)
  const existingManifest = readJson(join(finalDir, 'request.json'))
  if (existingManifest) {
    return {
      ok: true,
      duplicate: true,
      manifest: existingManifest,
      submissionId,
      manifestPath: paths.pagesDir + '/' + slug + '/intake/submissions/' + submissionId + '/request.json',
      requestPath: slash(join(finalDir, 'request.json')),
    }
  }

  const used = new Set()
  const assetsOut = []
  const copies = []
  for (const asset of draft.assets) {
    const source = join(paths.draftAssets, asset.file)
    if (!existsSync(source)) return { ok: false, status: 500, error: '草稿图片丢失：' + asset.originalName }
    const bytes = readFileSync(source)
    if (sha256Of(bytes) !== asset.sha256) return { ok: false, status: 500, error: '草稿图片校验失败：' + asset.originalName }
    const savedName = savedNameOf(asset.originalName, asset.mediaType, used)
    const relativePath = paths.pagesDir + '/' + slug + '/intake/submissions/' + submissionId + '/original/' + savedName
    assetsOut.push({
      role: asset.role,
      originalName: asset.originalName,
      savedName,
      relativePath,
      absolutePath: slash(join(projectRoot, ...relativePath.split('/'))),
      mediaType: asset.mediaType,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      sha256: asset.sha256,
    })
    copies.push([bytes, savedName])
  }
  const createdAt = new Date().toISOString()
  const message = buildMessage({
    pagesDir: paths.pagesDir,
    slug,
    manifestPath: paths.pagesDir + '/' + slug + '/intake/submissions/' + submissionId + '/request.json',
    title: form.title,
    screen: { w: form.width, h: form.height },
    assets: assetsOut,
    hasMockPath: Boolean(form.mockPath),
  })
  const contentKey = sha256Of(JSON.stringify({
    pagePath,
    form: { ...form, width: form.width, height: form.height },
    assets: assetsOut.map((asset) => [asset.role, asset.originalName, asset.sha256]),
  }))
  const ui = input.ui ?? {}
  const assets = input.assets ?? {}
  const manifest = manifestOf({
    projectRoot,
    pagesDir: paths.pagesDir,
    slug,
    pagePath,
    token,
    submissionId,
    createdAt,
    form: {
      ...form,
      uiSystem: ui.system ?? 'other',
      bindStyle: ui.bindStyle ?? 'componentName',
      commonDir: ui.commonDir ?? 'Assets/UI/Common',
      matchMode: ui.matchMode ?? 'width',
      inProject: assets.inProject ?? '',
      artRoot: assets.artRoot ?? '',
    },
    assets: assetsOut,
    message,
    contentKey,
  })

  mkdirSync(paths.submissions, { recursive: true })
  const tmpDir = join(paths.submissions, '.tmp-' + submissionId + '-' + randomBytes(4).toString('hex'))
  try {
    mkdirSync(join(tmpDir, 'original'), { recursive: true })
    for (const [bytes, name] of copies) writeFileSync(join(tmpDir, 'original', name), bytes)
    writeFileSync(join(tmpDir, 'request.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    renameRetry(tmpDir, finalDir)
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    const raced = readJson(join(finalDir, 'request.json'))
    if (raced) return { ok: true, duplicate: true, manifest: raced, submissionId, requestPath: slash(join(finalDir, 'request.json')) }
    return { ok: false, status: 500, error: '材料保存失败：' + String(error && error.message ? error.message : error) }
  }

  const result = {
    ok: true,
    text: message,
    requestPath: slash(join(finalDir, 'request.json')),
    manifestPath: paths.pagesDir + '/' + slug + '/intake/submissions/' + submissionId + '/request.json',
    submissionId,
    assets: assetsOut,
  }
  const next = { ...draft, submitted: result, updatedAt: new Date().toISOString() }
  writeDraft(paths, next)
  return result
}

/** 读取 multipart 请求；不把文件名当路径。 */
async function readMultipart(req) {
  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.startsWith('multipart/form-data;')) throw Object.assign(new Error('请选择图片后通过页面提交。'), { status: 400 })
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('本次材料最多 32 MB，请减少图片。'), { status: 413 })
    chunks.push(chunk)
  }
  const request = new Request('http://127.0.0.1/', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: new Uint8Array(Buffer.concat(chunks)),
  })
  let form
  try {
    form = await request.formData()
  } catch {
    throw Object.assign(new Error('表单格式无效，请重新选择文件。'), { status: 400 })
  }
  const fields = {}
  const uploads = []
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      if (value.length > MAX_FIELD) throw Object.assign(new Error('填写内容过长，请缩短后提交。'), { status: 400 })
      fields[name] = value
    } else {
      if (!['mock', 'materials'].includes(name)) throw Object.assign(new Error('附件字段无效。'), { status: 400 })
      const bytes = Buffer.from(await value.arrayBuffer())
      uploads.push({ field: name, name: String(value.name || 'image.png'), type: normalizeMediaType(value.type), bytes })
    }
  }
  return { fields, uploads }
}

/** 收集请求正文。 */
function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data))
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
  res.end(body)
}

/** 服务状态写盘。 */
function writeState(paths, state) {
  writeAtomic(paths.service, JSON.stringify(state, null, 2) + '\n')
}

/** 读取服务状态。 */
export function readServiceState(projectRoot, slug, pagesDir) {
  const paths = pathsOf(projectRoot, slug, pagesDir)
  const state = readJson(paths.service)
  return state && typeof state === 'object' ? state : null
}

/**
 * 启动本机材料服务。
 * @param {{projectRoot:string,slug:string,pagesDir?:string,token?:string,port?:number,taskId?:string,ui?:object,assets?:object,screen?:object,title?:string,pagePath?:string}} options
 * @returns {Promise<{server:import('node:http').Server,port:number,token:string,url:string,paths:object,taskId:string}>}
 */
export async function startIntakeServer(options) {
  const projectRoot = resolve(options.projectRoot || projectRootOf(process.cwd()))
  const pagesDir = normalizeRel(options.pagesDir) ?? 'plans/ui'
  const slug = String(options.slug ?? '')
  if (!/^[a-z0-9](?:[a-z0-9-]{0,63})$/u.test(slug)) throw new Error('slug 只能使用小写字母、数字和短横线')
  const paths = pathsOf(projectRoot, slug, pagesDir)
  if (!under(projectRoot, paths.page) || !under(projectRoot, paths.plan)) throw new Error('材料页路径越界')
  const token = options.token || newToken()
  const taskId = options.taskId || newTaskId()
  const port = Number.isInteger(Number(options.port)) ? Number(options.port) : 0
  const limits = limitsOf()
  let lock = Promise.resolve()
  const serial = (fn) => {
    const run = lock.then(fn, fn)
    lock = run.catch(() => {})
    return run
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Content-Length': '0' })
      res.end()
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'ui-intake' })
      return
    }
    const prefix = '/t/' + token
    if (!url.pathname.startsWith(prefix)) {
      sendJson(res, 403, { ok: false, message: '材料服务令牌无效。' })
      return
    }
    const rest = url.pathname.slice(prefix.length) || '/'
    try {
      if (req.method === 'GET' && (rest === '/' || rest === '')) {
        if (!existsSync(paths.page)) throw Object.assign(new Error('材料页尚未生成。'), { status: 500 })
        const body = readFileSync(paths.page)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length })
        res.end(body)
        return
      }
      if (req.method === 'GET' && rest === '/draft') {
        const draft = await serial(() => readDraft(paths, projectRoot, slug, options.pagePath || paths.page))
        sendJson(res, 200, { ok: true, draft, limits })
        return
      }
      if (req.method === 'GET' && rest.startsWith('/asset/')) {
        const file = decodeURIComponent(rest.slice('/asset/'.length))
        const draft = await serial(() => readDraft(paths, projectRoot, slug, options.pagePath || paths.page))
        if (!draft.assets.some((asset) => asset.file === file)) throw Object.assign(new Error('图片不存在。'), { status: 404 })
        const path = join(paths.draftAssets, file)
        if (!existsSync(path)) throw Object.assign(new Error('图片文件丢失。'), { status: 404 })
        const body = readFileSync(path)
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length })
        res.end(body)
        return
      }
      if (req.method === 'POST' && rest === '/draft') {
        const { fields, uploads } = await readMultipart(req)
        const result = await serial(() => saveDraftRecord(paths, projectRoot, slug, options.pagePath || paths.page, {
          textRevision: fields.textRevision,
          assetRevision: fields.assetRevision,
          replaceAssets: fields.replaceAssets === '1',
          fields,
          uploads,
        }, limits))
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (req.method === 'POST' && rest === '/submit') {
        const { fields } = await readMultipart(req)
        const result = await serial(() => submitDraftRecord(paths, projectRoot, slug, options.pagePath || paths.page, token, {
          textRevision: fields.textRevision,
          assetRevision: fields.assetRevision,
          submissionId: fields.submissionId,
          ui: options.ui,
          assets: options.assets,
        }, limits))
        if (!result.ok) {
          sendJson(res, result.status || 400, { ok: false, message: result.error, ...(result.stale ? { stale: true, draft: result.draft } : {}) })
          return
        }
        sendJson(res, 200, result)
        return
      }
      if (req.method === 'POST' && rest === '/shutdown') {
        sendJson(res, 200, { ok: true })
        setTimeout(() => {
          server.close()
          server.closeAllConnections?.()
        }, 30).unref()
        return
      }
      sendJson(res, 404, { ok: false, message: '接口不存在。' })
    } catch (error) {
      const status = Number(error && error.status) || 400
      sendJson(res, status, { ok: false, message: error && error.message ? error.message : String(error) })
    }
  })

  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolveListen())
  })
  const actualPort = server.address().port
  const url = 'http://127.0.0.1:' + actualPort + '/t/' + token + '/'
  const state = {
    v: 1,
    kind: 'ui-builder-intake-service',
    taskId,
    pid: process.pid,
    port: actualPort,
    token,
    pagePath: slash(options.pagePath || paths.page),
    url,
    startedAt: new Date().toISOString(),
    status: 'running',
  }
  writeState(paths, state)
  const close = () => {
    try {
      const current = readServiceState(projectRoot, slug, pagesDir)
      if (current && current.taskId === taskId) writeState(paths, { ...current, status: 'stopped', stoppedAt: new Date().toISOString() })
    } catch {
      // 状态写失败不阻止关闭
    }
  }
  let resolveClosed
  const closed = new Promise((resolvePromise) => { resolveClosed = resolvePromise })
  server.on('close', () => { close(); resolveClosed() })
  return { server, port: actualPort, token, url, paths, taskId, limits, close, closed }
}

/** 停止同一材料页的服务；只认 service.json 里的端口与令牌。 */
export async function stopIntakeService(projectRoot, slug, pagesDir) {
  const state = readServiceState(projectRoot, slug, pagesDir)
  if (!state) return { ok: false, error: '没有找到运行中的材料服务。' }
  if (state.status !== 'running') return { ok: true, stopped: false, message: '服务已停止。' }
  try {
    const response = await fetch('http://127.0.0.1:' + state.port + '/t/' + state.token + '/shutdown', { method: 'POST' })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const paths = pathsOf(projectRoot, slug, pagesDir)
    writeState(paths, { ...state, status: 'stopped', stoppedAt: new Date().toISOString() })
    return { ok: true, stopped: true }
  } catch (error) {
    return { ok: false, error: '停止材料服务失败：' + String(error && error.message ? error.message : error) }
  }
}

/** 生成/更新材料页；不写 plan.html。 */
export function writeServicePage({ projectRoot, slug, pagesDir, token, endpoint, pagePath, taskId, title, targetPrefab, screen, ui, assets, previous }) {
  const template = readFileSync(TEMPLATE, 'utf8')
  const absolute = join(projectRoot, ...String(pagePath).split('/'))
  const config = buildPageConfig({
    token,
    pagePath,
    slug,
    pagesDir,
    projectRoot,
    title: title ?? previous?.title ?? '',
    targetPrefab: targetPrefab ?? previous?.targetPrefab ?? '',
    screen: screen ?? previous?.screen ?? { w: 1080, h: 1920 },
    ui: ui ?? previous?.ui ?? {},
    assets: assets ?? previous?.assets ?? {},
    limits: limitsOf(),
    createdAt: previous?.createdAt || new Date().toISOString(),
    transport: 'local',
    endpoint,
    taskId,
  })
  writeAtomic(absolute, renderIntakePage(template, config))
  return config
}

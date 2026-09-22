/**
 * dsh-vscode-mode host — 调试 RPC（edrv.dap.*）装配。
 * 单例 DapSession + 适配器发现（扩展清单驱动，通用不限定语言）+ 进程枚举 +
 * launch.json 读取（全量透传）+ findFile 反向匹配（chunkname → ripgrep 定向查找源文件）。
 * 作者 ddj 2026年09月29号 / 2026年09月21号
 */
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { Ctx } from '../store.js'
import type { RpcHandlerMap } from '../shared/rpc.js'
import { DAP_ACTIONS, DAP_LAUNCH_REL, DAP_LEGACY_LAUNCH_REL, requestOfConfig, type DapAction, type DapDebugConfig } from '../shared/dap.js'
import { normalizeSourcePath, rankSourceCandidates } from './sourcePath.js'
import { findFilesByChunk } from '../search/ripgrep.js'
import { hasCmdPlaceholder, parseLaunchConfigs } from './launchConfig.js'
import { dapConfigSnippets, annotateSnippets } from './configSnippets.js'
import { filterProcesses, listProcesses } from './processList.js'
import { resolveAdapterSpec } from './provider.js'
import { debuggerDecls } from './discovery.js'
import { DapSession } from './manager.js'
import { debugRecord } from '../debugLog.js'
import { log } from '../log.js'

/**
 * 解析工作区根为 subprocess 执行世界可见的真实路径。
 * DAP 会话无 DSH Session 对象，不能让 fs.resolve('.') 落回 host 进程目录，
 * 因此显式以 cwd 为基准解析 `.`（= cwd 本身）。
 * @author ddj 2026年09月21号
 * @param ctx DSH 上下文
 * @param workspacePath 工作区绝对路径
 * @returns 可交给 rg 的根路径；fs 不可用或解析失败返回空串
 */
async function rootPathOf(ctx: Ctx, workspacePath: string): Promise<string> {
  const fs = ctx.get('fs')
  if (!fs || !workspacePath) return ''
  try {
    const target = await fs.resolve('.', { cwd: workspacePath })
    return fs.processPath(target) || ''
  } catch (error) {
    return ''
  }
}

/**
 * 创建调试 RPC（单例会话随插件装配创建，ctx.effect 里调 disposeDap 清理）。
 * @author ddj 2026年09月29号
 * @param ctx DSH 上下文
 */
export function createDapRpc(ctx: Ctx): { handlers: Partial<RpcHandlerMap>; dispose: () => void } {
  const session = new DapSession({
    findFiles: async (workspacePath, chunk) => {
      const clean = normalizeSourcePath(chunk)
      if (!clean) return []
      // 工作区根需转换成 subprocess 执行世界可见的真实路径，再交给 rg 定向查找
      const root = await rootPathOf(ctx, workspacePath)
      if (!root) {
        debugRecord(ctx, workspacePath, '[DEBUG findFiles] chunk=' + clean + ' root=(无法解析) candidates=0', 'debug')
        return []
      }
      const candidates = await findFilesByChunk(ctx, root, clean)
      const ranked = rankSourceCandidates(clean, candidates, workspacePath)
      log.debug('[dap-trace] findFiles chunk=' + clean + ' cwd=' + workspacePath + ' root=' + root + ' candidates=' + ranked.length + ' first=' + (ranked[0] ?? ''))
      debugRecord(ctx, workspacePath, '[DEBUG findFiles] chunk=' + clean + ' root=' + root + ' candidates=' + ranked.length + ' first=' + (ranked[0] ?? ''), 'debug')
      return ranked
    },
    trace: (workspacePath, message) => debugRecord(ctx, workspacePath, message, 'debug'),
  })

  const handlers: Partial<RpcHandlerMap> = {
    'edrv.dap.configs': async (args) => {
      const configs = await readLaunchConfigs(ctx, args.workspacePath)
      const adapters = debuggerDecls().map((d) => ({ type: d.type, label: d.label, available: d.available, reason: d.reason }))
      return { ok: true, configs, adapters, source: configs.length ? 'launchjson' : 'none' }
    },
    'edrv.dap.snippets': async () => ({
      ok: true,
      // 与工具条同源裁决：不可用适配器的模板带 reason，client 下拉过滤
      snippets: annotateSnippets(dapConfigSnippets(), debuggerDecls()),
    }),
    'edrv.dap.processes': async (args) => {
      const items = filterProcesses(await listProcesses(), args.processName)
      return { ok: true, items }
    },
    'edrv.dap.start': async (args) => {
      const config = args.config
      if (hasCmdPlaceholder(config)) {
        return { ok: false, error: '配置含 ${command:...} 占位（VS Code 命令），本插件无法解析，请在 launch.json 中改为具体值' }
      }
      const spec = resolveAdapterSpec(config.type)
      if (!spec) return { ok: false, error: unknownTypeMessage(config.type) }
      let pid = args.pid && args.pid > 0 ? args.pid : undefined
      if (requestOfConfig(config) === 'attach' && !pid && !config.processId) {
        const resolved = await resolvePid(config.processName)
        if (typeof resolved === 'string') return { ok: false, error: resolved }
        pid = resolved
      }
      session.start(spec, config, args.workspacePath, pid)
      return { ok: true, phase: 'starting' }
    },
    'edrv.dap.stop': async () => {
      session.stop()
      return { ok: true }
    },
    'edrv.dap.poll': async (args) => ({ ok: true, ...session.poll(args.since) }),
    'edrv.dap.setBreakpoints': async (args) => {
      const abs = join(args.workspacePath, args.file.replace(/\\/g, '/'))
      return { ok: true, breakpoints: await session.setBreakpoints(abs, args.points) }
    },
    'edrv.dap.stackTrace': async () => ({ ok: true, frames: await session.stackTrace() }),
    'edrv.dap.scopes': async (args) => ({ ok: true, scopes: await session.scopes(args.frameId) }),
    'edrv.dap.variables': async (args) => ({ ok: true, variables: await session.variables(args.ref) }),
    'edrv.dap.evaluate': async (args) => ({ ok: true, ...(await session.evaluate(args.expression, args.frameId)) }),
    'edrv.dap.command': async (args) => {
      if (!DAP_ACTIONS.includes(args.action as DapAction)) return { ok: false, error: '未知动作：' + args.action }
      if (args.action === 'disconnect') session.stop()
      else session.action(args.action as DapAction)
      return { ok: true }
    },
  }

  return { handlers, dispose: () => session.dispose() }
}

/**
 * processName → pid：唯一命中直用；0 命中或多命中返回错误文案（客户端引导用 processes 列表选择）。
 * @author ddj 2026年09月29号
 * @param processName 进程名（标题/文件名包含匹配）
 */
async function resolvePid(processName?: string): Promise<number | string> {
  const items = filterProcesses(await listProcesses(), processName)
  if (items.length === 1) return items[0].pid
  if (items.length === 0) return '未找到匹配进程：' + (processName || '(空)')
  return '匹配到 ' + items.length + ' 个进程，请先在进程列表中选择（edrv.dap.processes）'
}

/**
 * 读工作区调试配置：优先 `.dsh/launch.json`（插件专属）；缺失时从旧共用
 * `.vscode/launch.json` 一次性迁移（只读 legacy 源、永不回写；复制失败当次
 * 仍用 legacy 内容响应不丢配置，下次读重试）；都缺失 → 空表。
 * @author ddj 2026年09月22号
 * @param ctx DSH 上下文
 * @param workspacePath 工作区绝对路径
 * @returns 解析后的配置列表
 */
async function readLaunchConfigs(ctx: Ctx, workspacePath: string): Promise<DapDebugConfig[]> {
  const fs = ctx.get('fs')
  if (!fs || !workspacePath) return []
  try {
    const target = await fs.resolve(DAP_LAUNCH_REL, { cwd: workspacePath })
    let text = ''
    let exists = true
    try {
      text = String(await fs.readText(target) ?? '')
    } catch {
      exists = false
    }
    if (exists) return parseLaunchConfigs(text, workspacePath)
    // 新文件缺失 → 读旧共用源：命中则本次以内存内容响应（写入失败不丢配置，下次读重试）
    let legacy = ''
    let legacyExists = true
    try {
      const source = await fs.resolve(DAP_LEGACY_LAUNCH_REL, { cwd: workspacePath })
      legacy = String(await fs.readText(source) ?? '')
    } catch {
      legacyExists = false
    }
    if (!legacyExists) return []
    try {
      const realPath = fs.processPath(target)
      await mkdir(join(realPath, '..'), { recursive: true })
      await writeFile(realPath, legacy, 'utf8')
      log.debug('[dap] 已迁移 ' + DAP_LEGACY_LAUNCH_REL + ' → ' + DAP_LAUNCH_REL + '（' + workspacePath + '）')
    } catch (error) {
      log.debug('[dap] launch.json 迁移失败（下次读重试，本次以旧源响应）：' + String(error))
    }
    return parseLaunchConfigs(legacy, workspacePath)
  } catch (error) {
    log.debug('[dap] launch.json 读取失败（视为无配置）：' + String(error))
    return []
  }
}

/**
 * 未知调试类型的错误文案：列出已识别类型（含不可用原因），引导用户安装/排查。
 * @author ddj 2026年09月21号
 * @param type launch.json 中的调试类型
 */
function unknownTypeMessage(type: string): string {
  const known = debuggerDecls()
    .map((d) => d.type + (d.available ? '' : '（' + (d.reason ?? '不可用') + '）'))
    .join(' / ')
  return '未发现调试类型「' + type + '」的适配器（已识别：' + (known || '无，请安装带调试器的扩展') + '）'
}

/**
 * dsh-vscode-mode client — 侧栏「测试验收」面板的取数与动作。
 *
 * 面板组件只管摆位置，状态、轮询、错误分区与三个动作都在这里：
 * - `usePolicyDraft`：规范正文的读写（保存空内容＝恢复默认）。
 * - `useSheetSnapshot`：全部单列表 + 当前单视图（2.5 秒轮询只读当前单）。
 * - `useSheetActions`：打开页签 / 打开快照 / 移除一张单。
 *
 * 当前单优先取 `SidebarCtx.testCheckId`（编辑器里正开着的验收单页签），
 * 没有时退回列表里最近更新的一张，避免多单项目里「当前项」指错单。
 * @author ddj 2026年11月26号
 */
import React from 'react'
import { openOriginal } from '../../remoteOpenRouter.js'
import { requestOpen } from '../../openReceipt.js'
import { rpc } from '../../rpc.js'
import { TEST_CHECK_CHIP_MS } from '../../../shared/testCheck.js'
import type { TestCheckSheetSummary, TestCheckView } from '../../../shared/testCheck.js'
import type { SidebarCtx } from '../types.js'
import { mergeSheetCounts, removeConfirmText, type PolicyView } from '../../testCheckPanelState.js'

//region 类型

/** 取数结果：成功带值，失败带可读原因。 */
type Fetched<T> = { value: T } | { error: string }

/** 面板要用的全部数据与动作。 */
export interface TestCheckData {
  /** 规范状态（null = 还没读到）。 */
  policy: PolicyView | null
  /** 编辑框草稿。 */
  draft: string
  /** 规范读写错误。 */
  policyError: string
  /** 是否正在保存。 */
  saving: boolean
  /** 改草稿。 */
  setDraft: (text: string) => void
  /** 保存（空内容＝恢复默认）。 */
  savePolicy: () => Promise<void>
  /** 恢复默认。 */
  resetPolicy: () => Promise<void>
  /** 当前单视图。 */
  view: TestCheckView | null
  /** 当前单读取错误（与列表错误分开显示）。 */
  currentError: string
  /** 全部单。 */
  rows: readonly TestCheckSheetSummary[]
  /** 列表读取错误。 */
  sheetsError: string
  /** 列表是否正在重扫。 */
  sheetsBusy: boolean
  /** 重扫列表与当前单（force 跳过列表缓存）。 */
  refreshAll: (force?: boolean) => Promise<void>
  /** 打开验收单页签。 */
  openSheetTab: () => Promise<void>
  /** 用系统默认程序打开快照。 */
  openSnapshot: (row: TestCheckSheetSummary) => Promise<void>
  /** 移除一张单（已确认）。 */
  removeRow: (row: TestCheckSheetSummary) => Promise<void>
}

//endregion

//region 取数

/**
 * 取异常的展示文案。
 * @author ddj 2026年11月26号
 * @param error 捕获值
 * @returns 可读文本
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知错误')
}

/**
 * 读项目测试规范。
 * @author ddj 2026年11月26号
 * @param sessionId 会话
 * @returns 规范或错误
 */
async function fetchPolicy(sessionId: string): Promise<Fetched<PolicyView>> {
  const raw = await rpc('edrv.testCheck.policy.get', { sessionId })
  if (!raw.ok) return { error: raw.error }
  return { value: { path: raw.path, text: raw.text, isDefault: raw.isDefault } }
}

/**
 * 读全部验收单列表。
 * @author ddj 2026年11月26号
 * @param sessionId 会话
 * @returns 行列表或错误
 */
async function fetchSheets(sessionId: string, force = false): Promise<Fetched<readonly TestCheckSheetSummary[]>> {
  const raw = await rpc('edrv.testCheck.sheets', force ? { sessionId, force: true } : { sessionId })
  if (!raw.ok) return { error: raw.error }
  return { value: raw.sheets }
}

/**
 * 读一张单的派生视图（id 为空时由宿主按目录认领）。
 * @author ddj 2026年11月26号
 * @param sessionId 会话
 * @param id 单子 id
 * @returns 视图或错误
 */
async function fetchView(sessionId: string, id: string): Promise<Fetched<TestCheckView>> {
  const raw = await rpc('edrv.testCheck.get', id ? { sessionId, id } : { sessionId })
  if (!raw.ok) return { error: raw.error }
  return { value: raw.view }
}

//endregion

//region 规范

/**
 * 规范编辑状态与读写动作。
 * @author ddj 2026年11月26号
 * @param sessionId 会话（空串表示没有活动会话）
 * @param notify 动作反馈
 * @returns 规范状态与三个动作
 */
export function usePolicyDraft(sessionId: string, notify?: (message: string) => void) {
  const [policy, setPolicy] = React.useState<PolicyView | null>(null)
  const [draft, setDraft] = React.useState('')
  const [policyError, setPolicyError] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const aliveRef = React.useRef(true)

  /** 读一次规范（会话变化时重读）。 */
  async function loadPolicy(): Promise<void> {
    if (!sessionId) {
      setPolicy(null)
      setDraft('')
      setPolicyError('')
      return
    }
    try {
      const fetched = await fetchPolicy(sessionId)
      if (!aliveRef.current) return
      if ('error' in fetched) { setPolicyError(fetched.error); return }
      setPolicy(fetched.value)
      setDraft(fetched.value.text)
      setPolicyError('')
    } catch (error) {
      if (aliveRef.current) setPolicyError('读取项目测试规范失败：' + messageOf(error))
    }
  }

  /**
   * 写规范：传 null 表示恢复默认（删文件），传文本表示保存。
   * @param text 要保存的正文；null = 恢复默认
   */
  async function writePolicy(text: string | null): Promise<void> {
    if (!sessionId || saving) return
    setSaving(true)
    setPolicyError('')
    try {
      const raw = text === null
        ? await rpc('edrv.testCheck.policy.reset', { sessionId })
        : await rpc('edrv.testCheck.policy.save', { sessionId, text })
      if (!aliveRef.current) return
      if (!raw.ok) { setPolicyError(raw.error); return }
      const next: PolicyView = { path: raw.path, text: raw.text, isDefault: raw.isDefault }
      setPolicy(next)
      setDraft(next.text)
      notify?.(next.isDefault ? '已恢复默认规则，下一条消息生效' : '项目测试规范已保存，下一条消息生效')
    } catch (error) {
      if (aliveRef.current) setPolicyError('保存失败：' + messageOf(error))
    } finally {
      if (aliveRef.current) setSaving(false)
    }
  }

  React.useEffect(() => {
    aliveRef.current = true
    void loadPolicy()
    return () => { aliveRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return {
    policy,
    draft,
    policyError,
    saving,
    setDraft,
    savePolicy: () => writePolicy(draft),
    resetPolicy: () => writePolicy(null),
  }
}

//endregion

//region 验收单

/**
 * 全部单列表 + 当前单视图（轮询只读当前单）。
 * @author ddj 2026年11月26号
 * @param sessionId 会话
 * @param preferredId 编辑器里正开着的验收单 id（可空）
 * @returns 两个列表、两处错误与刷新动作
 */
export function useSheetSnapshot(sessionId: string, preferredId: string) {
  const [view, setView] = React.useState<TestCheckView | null>(null)
  const [rows, setRows] = React.useState<readonly TestCheckSheetSummary[]>([])
  const [currentError, setCurrentError] = React.useState('')
  const [sheetsError, setSheetsError] = React.useState('')
  const [sheetsBusy, setSheetsBusy] = React.useState(false)
  const currentRef = React.useRef('')
  const aliveRef = React.useRef(true)

  /** 轮询：只读当前单，并把计数合并回列表那一行（不再请求列表）。 */
  async function pollCurrent(): Promise<void> {
    const id = currentRef.current || preferredId
    const fetched = await fetchView(sessionId, id)
    if (!aliveRef.current) return
    if ('error' in fetched) { setCurrentError(fetched.error); return }
    setCurrentError('')
    setView(fetched.value)
    currentRef.current = fetched.value.id
    setRows((prev) => mergeSheetCounts(prev, fetched.value))
  }

  /** 重扫列表与当前单：两路并发；没有首选单时按列表第一张补读一次。 */
  async function refreshAll(force = false): Promise<void> {
    if (!sessionId) { setRows([]); setView(null); return }
    setSheetsBusy(true)
    try {
      const prefer = currentRef.current || preferredId
      const [listed, first] = await Promise.all([fetchSheets(sessionId, force), fetchView(sessionId, prefer)])
      if (!aliveRef.current) return

      const nextRows = 'error' in listed ? [] : listed.value
      setSheetsError('error' in listed ? listed.error : '')
      setRows(nextRows)

      let current: TestCheckView | null = 'error' in first ? null : first.value
      setCurrentError('error' in first ? first.error : '')
      if (!prefer && current && current.state === 'missing' && nextRows.length) {
        const retry = await fetchView(sessionId, nextRows[0].id)
        if (!('error' in retry)) { current = retry.value; setCurrentError('') }
      }
      setView(current)
      currentRef.current = current?.id ?? ''
    } catch (error) {
      if (!aliveRef.current) return
      setSheetsError('读取验收单失败：' + messageOf(error))
    } finally {
      if (aliveRef.current) setSheetsBusy(false)
    }
  }

  React.useEffect(() => {
    aliveRef.current = true
    currentRef.current = ''
    setView(null)
    void refreshAll()
    return () => { aliveRef.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, preferredId])

  React.useEffect(() => {
    if (!sessionId) return undefined
    const timer = window.setInterval(() => { void pollCurrent() }, TEST_CHECK_CHIP_MS)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, preferredId])

  return { view, rows, currentError, sheetsError, sheetsBusy, currentRef, refreshAll }
}

/** 三个列表动作的入参。 */
interface SheetActionInput {
  /** 会话。 */
  sessionId: string
  /** 会话工作区（打开快照时定位）。 */
  cwd: string | null
  /** 确认弹窗（缺省用 window.confirm）。 */
  confirm?: (message: string) => boolean
  /** 动作反馈。 */
  notify?: (message: string) => void
  /** 当前视图（打开页签要用标题）。 */
  view: TestCheckView | null
  /** 当前单 id（引用，轮询会更新）。 */
  currentRef: { current: string }
  /** 重扫列表与当前单（force 跳过列表缓存）。 */
  refreshAll: (force?: boolean) => Promise<void>
}

/**
 * 打开验收单页签 / 打开快照 / 移除一张单。
 * @author ddj 2026年11月26号
 * @param input 会话、确认与反馈
 * @returns 三个动作
 */
export function useSheetActions(input: SheetActionInput) {
  const { sessionId, cwd, confirm, notify, view, currentRef, refreshAll } = input

  /**
   * 问一句再做（优先用注入的 confirm，便于测试注入）。
   * @param message 确认文案
   * @returns 用户是否同意
   */
  function askConfirm(message: string): boolean {
    if (typeof confirm === 'function') return confirm(message)
    return typeof window === 'undefined' ? false : window.confirm(message)
  }

  /** 打开验收单页签（虚拟页签，与底部 chip 同一入口）。 */
  async function openSheetTab(): Promise<void> {
    const id = currentRef.current || view?.id || ''
    if (!sessionId) { notify?.('当前没有活动会话'); return }
    if (!id) { notify?.('还没有验收单可以打开'); return }
    try {
      const ok = await requestOpen(null, undefined, undefined, sessionId, {
        preview: true,
        sheet: { id, title: view?.title ?? id },
        timeoutMs: 4000,
      })
      if (!ok) notify?.('打开验收单失败：编辑器没有回执，请重试')
    } catch (error) {
      notify?.('打开验收单失败：' + messageOf(error))
    }
  }

  /**
   * 用系统默认程序打开快照；缺失时提示可移除。
   * @param row 列表行
   */
  async function openSnapshot(row: TestCheckSheetSummary): Promise<void> {
    if (!row.hasSnapshot) {
      notify?.('这张单还没有导出快照：先导出，或直接移除这一条（' + row.snapshotPath + '）')
      return
    }
    try {
      await openOriginal({ path: row.snapshotPath }, cwd ?? undefined)
    } catch (error) {
      notify?.('打开快照失败：' + messageOf(error))
    }
  }

  /**
   * 移除一张单：确认后删目录与快照，再重扫列表。
   * @param row 列表行
   */
  async function removeRow(row: TestCheckSheetSummary): Promise<void> {
    if (!sessionId) { notify?.('当前没有活动会话'); return }
    const dir = row.itemsPath.replace(/\/items\.json$/, '')
    if (!askConfirm(removeConfirmText(row.title, dir, row.snapshotPath))) return
    try {
      const raw = await rpc('edrv.testCheck.remove', { sessionId, id: row.id })
      if (!raw.ok) { notify?.(raw.error); return }
      notify?.(raw.removed.length ? '已移除 ' + String(raw.removed.length) + ' 项' : '这张单已经不在了')
      if (currentRef.current === row.id) currentRef.current = ''
      await refreshAll(true)
    } catch (error) {
      notify?.('移除失败：' + messageOf(error))
    }
  }

  return { openSheetTab, openSnapshot, removeRow }
}

//endregion

//region 组合

/**
 * 面板数据总入口：组合规范、列表与三个动作。
 * @author ddj 2026年11月26号
 * @param ctx 侧栏共享上下文
 * @returns 面板要用的全部数据与动作
 */
export function useTestCheckData(ctx?: SidebarCtx): TestCheckData {
  const sessionId = ctx?.sessionId ?? ''
  const cwd = ctx?.cwd ?? null
  const preferredId = typeof ctx?.testCheckId === 'string' ? ctx.testCheckId : ''
  const notify = ctx?.notify
  const confirm = ctx?.confirm

  const policy = usePolicyDraft(sessionId, notify)
  const snapshot = useSheetSnapshot(sessionId, preferredId)
  const actions = useSheetActions({
    sessionId,
    cwd,
    confirm,
    notify,
    view: snapshot.view,
    currentRef: snapshot.currentRef,
    refreshAll: snapshot.refreshAll,
  })

  return {
    policy: policy.policy,
    draft: policy.draft,
    policyError: policy.policyError,
    saving: policy.saving,
    setDraft: policy.setDraft,
    savePolicy: policy.savePolicy,
    resetPolicy: policy.resetPolicy,
    view: snapshot.view,
    currentError: snapshot.currentError,
    rows: snapshot.rows,
    sheetsError: snapshot.sheetsError,
    sheetsBusy: snapshot.sheetsBusy,
    refreshAll: snapshot.refreshAll,
    ...actions,
  }
}

//endregion

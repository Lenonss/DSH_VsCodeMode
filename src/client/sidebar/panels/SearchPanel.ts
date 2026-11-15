// @ts-nocheck
/**
 * dsh-vscode-mode client — 侧边栏「搜索」面板（VSCode 搜索视图形态）。
 * 内容搜索：edrv.searchContent RPC；结果按文件分组展示命中行（行号 + 高亮 + 文件计数），
 * 点击经 ctx.openFileAt 打开文件并跳转行列。
 * 选项：大小写/全词/正则；折叠区（⚙ 齿轮展开）：包含的文件（📖 toggle = 仅当前打开文件）
 * 与排除的文件（⚙ toggle = 启用排除），模式为逗号分隔 rg glob；无搜索按钮，防抖 + 回车触发。
 * 替换（v0.30.0）：搜索框右侧 chevron 展开替换行，先 dryRun 预览命中数再确认写盘；
 * 执行前经 edrv:flush-all 让所有编辑器落盘，执行后派发 edrv:refresh 让面板与页签看到新内容。
 * 作者 ddj 2026-08-26 / 2026-11-15
 */
import React from 'react'
import { rpc } from '../../rpc.js'
import type { SidebarCtx } from '../types.js'
import { CACHE_KEY } from '../../paths.js'
import { workspaceScopeOf } from '../../state/scopeStore.js'
import { takeSearchSeed, takeSearchScope } from '../../searchSeed.js'
import { ModalShell } from '../../ui/ModalShell.js'
import { flushEditors } from '../../editorFlush.js'
import { emitRefresh } from '../../events.js'
import { featurePrefs, watchFeaturePrefs } from '../../featurePrefs.js'

const DEBOUNCE_MS = 250
/** 文件变更后的重搜去抖：合并一次写盘的 refresh+file-changed 双事件与批量保存。 */
const REFRESH_DEBOUNCE_MS = 300
const INCLUDE_PLACEHOLDER = '例如 *.ts, src/**/include'

/**
 * 逗号切分 glob 列表（trim + 去空）。
 * @param text 用户输入的逗号分隔模式
 * @returns glob 数组
 */
export function splitGlobs(text) {
  return String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean)
}

/**
 * 计算包含文件范围；仅当前文件已开启但无活动文件时返回 null，禁止退化为全工作区搜索。
 * @author ddj 2026年09月29号
 * @param onlyActive 是否仅搜索当前文件
 * @param activePath 当前文件路径
 * @param includeText 用户输入的包含模式
 * @returns 包含 glob；null 表示当前搜索范围不可用
 */
export function searchIncludes(onlyActive: boolean, activePath: string | null, includeText: string): string[] | null {
  if (!onlyActive) return splitGlobs(includeText)
  return activePath ? [activePath] : null
}

/**
 * 读取按作用域持久化的搜索条件（损坏/缺失返回 null）。
 * 抽成函数而非内联：恢复 effect 内有两处消费者（填状态、同步 requestRef），
 * 且解析必须只做一次（JSON.parse 重复调用既慢又可能两次结果不一致）。
 * @author ddj 2026年09月18号
 * @param key 作用域缓存键
 * @returns 已解析的搜索条件对象；无/损坏返回 null
 */
export function savedSearchOf(key: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (e) {
    return null
  }
}

/**
 * 判断文件变化通知是否属于本面板作用域。
 * @author ddj 2026年10月14号
 * @param detail 事件 detail（scope 可缺省）
 * @param scope 本面板作用域
 * @returns 是否触发重搜
 */
export function noticeInScope(detail: any, scope: string): boolean {
  const changed = detail?.scope
  return !changed || changed === scope
}

/**
 * 判断文件变化通知是否可能改变内容搜索命中。
 * 文件增删改名（structure）会增删命中，一并重搜；SVN 状态刷新（svn）不代表内容变化，跳过以免无谓全库扫描。
 * @author ddj 2026年10月14号
 * @param detail 事件 detail（kind 可缺省）
 * @returns 是否触发重搜
 */
export function noticeTouchesContent(detail: any): boolean {
  const kind = detail?.kind
  return !kind || kind === 'text' || kind === 'structure'
}

/**
 * 命中行文本三段切分（before/命中/after，列为 1-based UTF-16）。
 * @param text 行文本
 * @param start 起始列
 * @param end 结束列
 * @returns 三段文本
 */
function splitHit(text, start, end) {
  const s = Math.max(0, (start | 0) - 1)
  const e = Math.max(s, end | 0)
  return { before: String(text).slice(0, s), hit: String(text).slice(s, e), after: String(text).slice(e) }
}

/**
 * 替换结果的用户可读摘要（纯函数，可单测）。
 * @author ddj 2026年11月15号
 * @param result edrv.replaceContent 响应
 * @returns 一句话摘要
 */
export function replaceSummary(result) {
  if (!result) return ''
  const total = Number(result.totalReplaced ?? 0)
  const files = Number(result.totalFiles ?? 0)
  const parts = [(result.dryRun === true ? '预览：' : '已替换 ') + total + ' 处 · ' + files + ' 个文件']
  if (result.truncated === true) parts.push('超出单次上限已截断')
  if (Number(result.skipped ?? 0) > 0) parts.push('跳过 ' + result.skipped + ' 个文件')
  const failed = Array.isArray(result.failed) ? result.failed : []
  if (failed.length > 0) parts.push('失败 ' + failed.length + ' 个（' + String(failed[0]?.reason ?? '') + '）')
  if (result.warning) parts.push(String(result.warning))
  return parts.join(' · ')
}

/**
 * 搜索面板主体。
 * @param props.ctx 面板共享上下文（sessionId/openFileAt/activePath）
 */
export function SearchPanel(props) {
  const ctx = props?.ctx
  const sessionId = ctx?.sessionId
  // 搜索条件按工作区作用域记忆（同工作区切对话恢复同一份），无 cwd 回退会话
  const scope = ctx?.scope ?? workspaceScopeOf(null, sessionId)
  const openFileAt = ctx?.openFileAt ?? (() => {})
  const activePath = ctx?.activePath ?? null
  const [query, setQuery] = React.useState('')
  const [matchCase, setMatchCase] = React.useState(false)
  const [wholeWord, setWholeWord] = React.useState(false)
  const [regex, setRegex] = React.useState(false)
  const [includeText, setIncludeText] = React.useState('')
  const [excludeText, setExcludeText] = React.useState('')
  const [onlyActive, setOnlyActive] = React.useState(false)
  const [excludeOn, setExcludeOn] = React.useState(false)
  const [sectionOpen, setSectionOpen] = React.useState(false)
  const [status, setStatus] = React.useState('idle') // idle | searching | done | error
  const [error, setError] = React.useState('')
  const [warning, setWarning] = React.useState('') // rg 遍历错误时的部分结果提示（结果照常展示）
  const [matches, setMatches] = React.useState(null)
  const [truncated, setTruncated] = React.useState(false)
  const [collapsed, setCollapsed] = React.useState({})
  // 替换行状态：replaceOpen 由 chevron 控制；replaceText 按作用域记忆
  const [replaceOpen, setReplaceOpen] = React.useState(false)
  const [replaceText, setReplaceText] = React.useState('')
  const [replaceBusy, setReplaceBusy] = React.useState(false)
  const [replaceNotice, setReplaceNotice] = React.useState('')
  const [replaceError, setReplaceError] = React.useState('')
  /** 待确认的替换动作：{ scope:'all'|'file', path?, preview } */
  const [replaceConfirm, setReplaceConfirm] = React.useState(null)
  const [replaceEnabled, setReplaceEnabled] = React.useState(() => featurePrefs().searchReplace)
  const replaceTextRef = React.useRef('')
  replaceTextRef.current = replaceText
  const seqRef = React.useRef(0)
  const timerRef = React.useRef(null)
  const inputRef = React.useRef(null)
  const [focusTick, setFocusTick] = React.useState(0)
  const queryRef = React.useRef('')
  queryRef.current = query
  const activePathRef = React.useRef(activePath)
  activePathRef.current = activePath
  // 文件变化后的重搜定时器（与输入防抖分开：两者互不取消对方）
  const refreshTimerRef = React.useRef(null)
  // 请求参数 ref：防抖/立即重搜闭包统一读最新值，避免陈旧选项
  const requestRef = React.useRef({ matchCase, wholeWord, regex, include: [], exclude: [] })
  requestRef.current = {
    matchCase, wholeWord, regex,
    include: searchIncludes(onlyActive, activePath, includeText),
    exclude: excludeOn ? splitGlobs(excludeText) : [],
  }

  // 按作用域恢复上次查询、选项与过滤模式（VSCode 记忆搜索词）
  React.useEffect(() => {
    if (!scope) return
    const saved = savedSearchOf(CACHE_KEY.search + String(scope))
    if (saved) {
      if (typeof saved.query === 'string') setQuery(saved.query)
      if (typeof saved.matchCase === 'boolean') setMatchCase(saved.matchCase)
      if (typeof saved.wholeWord === 'boolean') setWholeWord(saved.wholeWord)
      if (typeof saved.regex === 'boolean') setRegex(saved.regex)
      if (typeof saved.includeText === 'string') setIncludeText(saved.includeText)
      if (typeof saved.excludeText === 'string') setExcludeText(saved.excludeText)
      if (typeof saved.onlyActive === 'boolean') setOnlyActive(saved.onlyActive)
      if (typeof saved.excludeOn === 'boolean') setExcludeOn(saved.excludeOn)
      if (typeof saved.sectionOpen === 'boolean') setSectionOpen(saved.sectionOpen)
      if (typeof saved.replaceText === 'string') setReplaceText(saved.replaceText)
      if (typeof saved.replaceOpen === 'boolean') setReplaceOpen(saved.replaceOpen)
      // 显式把恢复后的选项同步进 requestRef：render 期的同步要等下一次渲染才生效，
      // 而紧随其后的「选区种子」effect 会在本次 commit 内立即搜索，读到的会是陈旧选项。
      requestRef.current = {
        matchCase: saved.matchCase === true,
        wholeWord: saved.wholeWord === true,
        regex: saved.regex === true,
        include: searchIncludes(saved.onlyActive === true, activePathRef.current,
          typeof saved.includeText === 'string' ? saved.includeText : ''),
        exclude: saved.excludeOn === true
          ? splitGlobs(typeof saved.excludeText === 'string' ? saved.excludeText : '')
          : [],
      }
    }
  }, [scope])

  // 查询/选项/过滤变化 → 持久化
  React.useEffect(() => {
    if (!scope) return
    try {
      localStorage.setItem(CACHE_KEY.search + String(scope), JSON.stringify({
        query, matchCase, wholeWord, regex, includeText, excludeText, onlyActive, excludeOn, sectionOpen,
        replaceText, replaceOpen,
      }))
    } catch (e) { /* 忽略 */ }
  }, [scope, query, matchCase, wholeWord, regex, includeText, excludeText, onlyActive, excludeOn, sectionOpen, replaceText, replaceOpen])

  // 替换能力开关（设置 → 通用）：关闭时收起替换行，已展开的确认弹窗一并撤销
  React.useEffect(() => watchFeaturePrefs((prefs) => {
    setReplaceEnabled(prefs.searchReplace)
    if (!prefs.searchReplace) { setReplaceOpen(false); setReplaceConfirm(null) }
  }), [])

  /**
   * 执行内容搜索（请求参数从 ref 读最新值）。
   * @author ddj 2026年10月14号
   * @param text 搜索词
   * @param force 是否强制绕过 host 短期缓存（文件变更后的重搜必须读最新磁盘内容）
   */
  const runSearch = (text, force) => {
    const s = ++seqRef.current
    const clean = String(text ?? '').trim()
    if (clean.length < 2) { setMatches(null); setStatus('idle'); return }
    const req = requestRef.current
    if (req.include === null) {
      setMatches([])
      setTruncated(false)
      setError('')
      setWarning('')
      setStatus('done')
      return
    }
    setStatus('searching')
    setError('')
    setWarning('')
    rpc('edrv.searchContent', {
      sessionId, query: clean,
      matchCase: req.matchCase, wholeWord: req.wholeWord, regex: req.regex,
      include: req.include, exclude: req.exclude,
      // 仅重搜路径带上 force：普通搜索的请求载荷与修复前保持完全一致。
      ...(force === true ? { force: true } : {}),
    }).then((res) => {
      if (s !== seqRef.current) return
      if (res && res.ok) {
        setMatches(Array.isArray(res.matches) ? res.matches : [])
        setTruncated(res.truncated === true)
        setWarning(res?.warning ? String(res.warning) : '')
        setStatus('done')
      } else {
        setError(res?.error ? String(res.error) : '搜索失败')
        setMatches(null)
        setStatus('error')
      }
    }).catch((e) => {
      if (s !== seqRef.current) return
      setError('搜索异常:' + String(e))
      setMatches(null)
      setStatus('error')
    })
  }

  // 事件监听闭包经 ref 取最新搜索实现与最新查询词（事件注册只做一次）
  const runSearchRef = React.useRef(runSearch)
  runSearchRef.current = runSearch

  /**
   * 输入变化：防抖触发搜索。
   * @param value 新输入
   */
  const onChange = (value) => {
    setQuery(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => runSearch(value), DEBOUNCE_MS)
  }

  /**
   * 输入框通用防抖重搜（包含/排除模式输入）。
   * @param setter 状态写入函数
   * @param value 新值
   */
  const onChangeDebounced = (setter, value) => {
    setter(value)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => runSearch(queryRef.current), DEBOUNCE_MS)
  }

  /**
   * 立即刷新搜索（短查询清空旧结果）；先同步 ref 避免本次调用读到旧请求参数。
   * @param next 新的请求参数字段
   */
  const rerun = (next) => {
    requestRef.current = Object.assign({}, requestRef.current, next)
    if (timerRef.current) clearTimeout(timerRef.current)
    runSearch(queryRef.current)
  }

  /** 选项开关切换（大小写/全词/正则/书本/设置）：更新状态 + 立即重搜。 */
  const toggleOpt = (key, value) => {
    if (key === 'matchCase') setMatchCase(value)
    if (key === 'wholeWord') setWholeWord(value)
    if (key === 'regex') setRegex(value)
    if (key === 'onlyActive') setOnlyActive(value)
    if (key === 'excludeOn') setExcludeOn(value)
    const base = { matchCase, wholeWord, regex, onlyActive, excludeOn }
    base[key] = value
    rerun({
      matchCase: base.matchCase, wholeWord: base.wholeWord, regex: base.regex,
      include: searchIncludes(base.onlyActive, activePathRef.current, includeText),
      exclude: base.excludeOn ? splitGlobs(excludeText) : [],
    })
  }

  /**
   * 替换请求的公共字段（与内容搜索严格同口径：选项 + 包含/排除 + 查询词）。
   * @author ddj 2026年11月15号
   * @returns 不含 replacement/paths/dryRun 的请求字段
   */
  const replaceBaseOf = () => {
    const req = requestRef.current
    return {
      sessionId,
      query: String(queryRef.current ?? '').trim(),
      matchCase: req.matchCase === true,
      wholeWord: req.wholeWord === true,
      regex: req.regex === true,
      include: req.include ?? [],
      exclude: req.exclude ?? [],
    }
  }

  /**
   * 调替换 RPC（失败转异常，成功返回响应）。
   * @author ddj 2026年11月15号
   * @param options.paths 只处理这些文件（单文件替换）；缺省 = 全部候选
   * @param options.dryRun 只统计不写盘
   * @returns RPC 响应
   */
  const callReplace = async ({ paths, dryRun }) => {
    const base = replaceBaseOf()
    if (base.query.length < 2) throw new Error('请先输入至少 2 个字符的查找内容')
    const body = Object.assign({}, base, { replacement: replaceTextRef.current })
    if (dryRun === true) body.dryRun = true
    if (Array.isArray(paths) && paths.length > 0) body.paths = paths
    const res = await rpc('edrv.replaceContent', body)
    if (!res || res.ok !== true) throw new Error(res?.error ? String(res.error) : '替换失败')
    return res
  }

  /**
   * 先预览命中数，再打开确认弹窗（破坏性写盘不在预览阶段发生）。
   * @author ddj 2026年11月15号
   * @param targetScope 'all' 全部候选 | 'file' 单个文件
   * @param path targetScope='file' 时的相对路径
   * @returns 无（状态经 setState 反映）
   * @sideEffects 只读（dryRun）
   */
  const previewReplace = async (targetScope, path) => {
    if (replaceBusy || !replaceEnabled) return
    setReplaceBusy(true)
    setReplaceError('')
    setReplaceNotice('')
    try {
      const preview = await callReplace({ paths: targetScope === 'file' ? [path] : undefined, dryRun: true })
      if (Number(preview.totalReplaced ?? 0) === 0) {
        setReplaceNotice('没有可替换的命中')
        return
      }
      setReplaceConfirm({ scope: targetScope, path, preview })
    } catch (error) {
      setReplaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setReplaceBusy(false)
    }
  }

  /**
   * 确认后执行替换：先让所有编辑器落盘（否则旧缓冲会被写回覆盖用户改动），再写盘并广播刷新。
   * @author ddj 2026年11月15号
   * @returns 无（状态经 setState 反映）
   * @sideEffects 写盘 + edrv:refresh 事件
   */
  const applyReplace = async () => {
    const target = replaceConfirm
    if (!target) return
    setReplaceConfirm(null)
    setReplaceBusy(true)
    setReplaceError('')
    setReplaceNotice('')
    try {
      const flushed = await flushEditors()
      if (flushed.timedOut) {
        setReplaceError('部分页签未能在 3 秒内落盘，已中止替换；请先手动保存后重试')
        return
      }
      if (Array.isArray(flushed.failures) && flushed.failures.length > 0) {
        setReplaceError('有页签保存失败（' + flushed.failures.join('、') + '），已中止替换；请先手动保存后重试')
        return
      }
      const result = await callReplace({ paths: target.scope === 'file' ? [target.path] : undefined })
      setReplaceNotice(replaceSummary(result))
      if (Array.isArray(result.files) && result.files.length > 0) {
        emitRefresh({ scope, paths: result.files.map((file) => file.path), kind: 'text' })
      }
      rerun({})
    } catch (error) {
      setReplaceError(error instanceof Error ? error.message : String(error))
    } finally {
      setReplaceBusy(false)
    }
  }

  // 仅当前文件模式下切换/关闭活动文件，立即更新搜索范围并作废旧请求。
  const previousPathRef = React.useRef(activePath)
  React.useEffect(() => {
    if (previousPathRef.current === activePath) return
    previousPathRef.current = activePath
    if (onlyActive) rerun({ include: searchIncludes(true, activePath, includeText) })
  }, [activePath])

  /**
   * 取用一次性选区种子（需求 1：Ctrl+Shift+F 时把编辑器选中文本填入搜索框）。
   * 有种子即填入并立即搜索（不再等 250ms 防抖），同时全选便于直接改写；无种子为 no-op。
   * @author ddj 2026年09月18号
   * @returns 是否消费到种子
   */
  const applySeed = () => {
    const seed = takeSearchSeed()
    if (!seed) return false
    if (timerRef.current) clearTimeout(timerRef.current)
    queryRef.current = seed
    setQuery(seed)
    runSearch(seed)
    return true
  }

  /**
   * 取用一次性目录过滤种子（资源管理器右键「在文件夹中查找…」）。
   * 有种子即覆盖「包含」过滤为该目录、关闭「仅当前文件」并展开过滤区（让用户看到限定范围）；
   * 已有可用搜索词时按新范围立即重搜。无种子为 no-op。
   * @author ddj 2026年09月22号
   * @returns 是否消费到种子
   */
  const applyScopeSeed = () => {
    const dir = takeSearchScope()
    if (!dir) return false
    const glob = dir + '/**'
    if (timerRef.current) clearTimeout(timerRef.current)
    setIncludeText(glob)
    setOnlyActive(false)
    setSectionOpen(true)
    requestRef.current = Object.assign({}, requestRef.current, { include: splitGlobs(glob) })
    if (String(queryRef.current).trim().length >= 2) runSearch(queryRef.current)
    return true
  }

  // 挂载时消费种子：侧栏原本收起 → 派发 edrv:search-focus 时本面板尚未挂载，
  // 事件无人接收，故必须由挂载路径兜底。
  // ⚠️ 声明在「按作用域恢复」effect 之后：React 按声明序执行 effect，恢复值先落地，
  // 种子再覆盖，避免被记忆的旧查询词盖掉用户刚选中的内容。
  React.useEffect(() => { applyScopeSeed(); applySeed(); setFocusTick((tick) => tick + 1) }, [])

  // Ctrl+Shift+F / 「在文件夹中查找…」：先提交恢复值/种子，再全选新内容。
  React.useEffect(() => {
    /** @private @author ddj 2026年10月14号 @description 消费种子并请求提交后聚焦全选；不额外发起搜索。 */
    const onFocus = () => {
      applyScopeSeed()
      applySeed()
      setFocusTick((tick) => tick + 1)
    }
    window.addEventListener('edrv:search-focus', onFocus)
    return () => window.removeEventListener('edrv:search-focus', onFocus)
  }, [])

  // 文件内容变化（保存/外部写盘/文件增删改名）→ 去抖强制重搜，避免面板残留已失效的旧命中。
  // 两种事件都监听：编辑器内保存只发 edrv:refresh，外部写盘只发 edrv:file-changed。
  React.useEffect(() => {
    /** @private @author ddj 2026年10月14号 @description 合并同一次写盘的多条通知后强制重搜 */
    const onChanged = (event) => {
      const detail = event?.detail ?? {}
      if (!noticeInScope(detail, scope)) return
      if (!noticeTouchesContent(detail)) return
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => runSearchRef.current(queryRef.current, true), REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener('edrv:file-changed', onChanged)
    window.addEventListener('edrv:refresh', onChanged)
    return () => {
      window.removeEventListener('edrv:file-changed', onChanged)
      window.removeEventListener('edrv:refresh', onChanged)
      if (refreshTimerRef.current) { clearTimeout(refreshTimerRef.current); refreshTimerRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 一次意图对应一次提交后选区；无需定时回调，卸载后不会抢焦点。
  React.useLayoutEffect(() => {
    if (!focusTick) return
    inputRef.current?.focus?.()
    inputRef.current?.select?.()
  }, [focusTick])

  // 结果按文件分组（保持 rg 输出顺序）
  const groups = React.useMemo(() => {
    if (!Array.isArray(matches)) return []
    const map = new Map()
    for (const m of matches) {
      let list = map.get(m.path)
      if (!list) { list = []; map.set(m.path, list) }
      list.push(m)
    }
    return [...map.entries()].map(([path, list]) => ({ path, count: list.length, matches: list }))
  }, [matches])

  const totalFiles = groups.length
  const totalMatches = Array.isArray(matches) ? matches.length : 0
  const toggleGroup = (path) => setCollapsed((prev) => Object.assign({}, prev, { [path]: prev[path] === true ? false : true }))

  const optsBar = React.createElement('div', { className: 'edrv-search-opts' },
    React.createElement('button', { className: 'edrv-search-opt' + (matchCase ? ' on' : ''), title: '区分大小写', 'aria-pressed': matchCase, onClick: () => toggleOpt('matchCase', !matchCase) }, 'Aa'),
    React.createElement('button', { className: 'edrv-search-opt' + (wholeWord ? ' on' : ''), title: '全字匹配', 'aria-pressed': wholeWord, onClick: () => toggleOpt('wholeWord', !wholeWord) }, 'Ab'),
    React.createElement('button', { className: 'edrv-search-opt' + (regex ? ' on' : ''), title: '使用正则表达式', 'aria-pressed': regex, onClick: () => toggleOpt('regex', !regex) }, '.*'),
    React.createElement('span', { className: 'edrv-search-spacer' }),
    React.createElement('button', { className: 'edrv-search-opt' + (sectionOpen ? ' on' : ''), title: sectionOpen ? '收起文件过滤' : '文件过滤（包含/排除）', 'aria-pressed': sectionOpen, onClick: () => setSectionOpen((v) => !v) }, '⚙'))

  const filterRows = sectionOpen
    ? React.createElement('div', { className: 'edrv-search-rows' },
        React.createElement('div', { className: 'edrv-search-row' },
          React.createElement('input', {
            className: 'edrv-search-field' + (onlyActive ? ' dim' : ''), placeholder: INCLUDE_PLACEHOLDER,
            value: includeText, disabled: onlyActive,
            title: onlyActive ? '已启用「仅当前打开文件」，忽略此输入' : '',
            onChange: (e) => onChangeDebounced(setIncludeText, e.target.value),
          }),
          React.createElement('button', {
            className: 'edrv-search-toggle' + (onlyActive ? ' on' : ''), title: activePath ? '仅在当前打开的文件中搜索' : onlyActive ? '无打开的文件（点击退出仅当前文件）' : '无打开的文件（需先打开文件）',
            'aria-pressed': onlyActive, disabled: !activePath && !onlyActive,
            onClick: () => toggleOpt('onlyActive', !onlyActive),
          }, '📖')),
        React.createElement('div', { className: 'edrv-search-row' },
          React.createElement('input', {
            className: 'edrv-search-field' + (excludeOn ? '' : ' dim'), placeholder: INCLUDE_PLACEHOLDER,
            value: excludeText, disabled: !excludeOn,
            title: excludeOn ? '' : '排除功能未启用，先点击右侧按钮开启',
            onChange: (e) => onChangeDebounced(setExcludeText, e.target.value),
          }),
          React.createElement('button', {
            className: 'edrv-search-toggle' + (excludeOn ? ' on' : ''), title: '启用排除文件（忽略下方模式的命中）',
            'aria-pressed': excludeOn,
            onClick: () => toggleOpt('excludeOn', !excludeOn),
          }, '⚙')))
    : null

  const summary = status === 'done'
    ? React.createElement('div', { className: 'edrv-search-summary' },
        totalFiles > 0
          ? totalFiles + ' 个文件 · ' + totalMatches + ' 处匹配' + (truncated ? '（已截断）' : '')
          : '无匹配结果')
    : null

  const warnBanner = warning
    ? React.createElement('div', { className: 'edrv-search-warn', title: warning }, warning)
    : null

  const replaceErrorBanner = replaceError
    ? React.createElement('div', { className: 'edrv-search-error' }, replaceError)
    : null

  const replaceNoticeBanner = replaceNotice
    ? React.createElement('div', { className: 'edrv-search-notice' }, replaceNotice)
    : null

  // 替换行：仅开关打开时渲染（VS Code 形态，chevron 在搜索框右侧）
  const replaceRows = replaceEnabled && replaceOpen
    ? React.createElement('div', { className: 'edrv-search-replace-row' },
        React.createElement('input', {
          className: 'edrv-search-replace', autoComplete: 'off', spellCheck: false,
          placeholder: '替换为',
          value: replaceText,
          onChange: (e) => setReplaceText(e.target.value),
          onKeyDown: (e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            void previewReplace('all')
          },
        }),
        React.createElement('button', {
          className: 'edrv-search-replace-btn danger',
          disabled: replaceBusy || !String(query).trim() || totalFiles === 0,
          title: totalFiles === 0 ? '先搜索到命中再替换' : '预览后确认，把当前范围内的全部命中替换为上方文本',
          onClick: () => void previewReplace('all'),
        }, replaceBusy ? '处理中…' : '全部替换'))
    : null

  const confirmDialog = replaceConfirm
    ? React.createElement(ModalShell, { onClose: () => setReplaceConfirm(null) },
        React.createElement('h3', null, replaceConfirm.scope === 'file' ? '确认替换此文件' : '确认全部替换'),
        React.createElement('ul', { className: 'edrv-search-confirm-list' },
          React.createElement('li', null, '命中：' + Number(replaceConfirm.preview.totalReplaced ?? 0) + ' 处 · ' + Number(replaceConfirm.preview.totalFiles ?? 0) + ' 个文件'),
          replaceConfirm.scope === 'file'
            ? React.createElement('li', null, '范围：' + String(replaceConfirm.path ?? ''))
            : React.createElement('li', null, '范围：当前搜索条件与包含/排除过滤'),
          Number(replaceConfirm.preview.skipped ?? 0) > 0
            ? React.createElement('li', null, '将跳过 ' + replaceConfirm.preview.skipped + ' 个文件（过大/二进制/非普通文件）')
            : null),
        React.createElement('p', { className: 'edrv-search-confirm-note' },
          '替换会直接改写磁盘，编辑器撤销无法撤回；执行前会先把已打开页签的未保存内容落盘。'),
        React.createElement('div', { className: 'edrv-search-confirm-actions' },
          React.createElement('button', { className: 'edrv-search-replace-btn', onClick: () => setReplaceConfirm(null), autoFocus: true }, '取消'),
          React.createElement('button', { className: 'edrv-search-replace-btn danger', onClick: () => void applyReplace() }, '确认替换')))
    : null

  const body = (() => {
    if (status === 'searching') return React.createElement('div', { className: 'edrv-search-empty' }, '搜索中…')
    if (status === 'error') return React.createElement('div', { className: 'edrv-search-error' }, error)
    if (status === 'done' && !groups.length) return React.createElement('div', { className: 'edrv-search-empty' }, '无匹配结果')
    if (status !== 'done') return React.createElement('div', { className: 'edrv-search-empty' }, '输入至少 2 个字符开始搜索')
    return React.createElement('div', { className: 'edrv-search-results' },
      groups.map((group) => {
        const open = collapsed[group.path] !== true
        return React.createElement('div', { key: group.path, className: 'edrv-search-group' },
          React.createElement('div', { className: 'edrv-search-file', title: group.path, onClick: () => toggleGroup(group.path) },
            React.createElement('span', { className: 'edrv-search-chev' }, open ? '▾' : '▸'),
            React.createElement('span', { className: 'edrv-search-fname' }, String(group.path).split(/[\\/]/).pop() || group.path),
            React.createElement('span', { className: 'edrv-search-fdir' }, String(group.path).split(/[\\/]/).slice(0, -1).join('/')),
            replaceEnabled
              ? React.createElement('button', {
                  className: 'edrv-search-file-replace', title: '替换此文件中的全部命中',
                  onClick: (event) => { event.stopPropagation(); void previewReplace('file', group.path) },
                }, '✎')
              : null,
            React.createElement('span', { className: 'edrv-search-fcount' }, group.count)),
          open ? group.matches.map((m, i) => {
            const parts = splitHit(m.text, m.startColumn, m.endColumn)
            return React.createElement('div', { key: m.path + ':' + m.line + ':' + i, className: 'edrv-search-line' + (i % 2 ? ' alt' : ''), title: group.path + ':' + m.line, onClick: () => openFileAt(m.path, m.line, m.startColumn) },
              React.createElement('span', { className: 'edrv-search-ln' }, m.line),
              React.createElement('span', { className: 'edrv-search-text' },
                React.createElement('span', null, parts.before),
                React.createElement('mark', { className: 'edrv-search-hit' }, parts.hit),
                React.createElement('span', null, parts.after)))
          }) : null)
      }))
  })()

  return React.createElement('div', { className: 'edrv-search-panel' },
    React.createElement('div', { className: 'edrv-search-qrow' },
      React.createElement('input', {
        ref: inputRef, className: 'edrv-search-input', autoFocus: true, autoComplete: 'off', spellCheck: false,
        placeholder: '搜索',
        value: query,
        onChange: (e) => onChange(e.target.value),
        onKeyDown: (e) => {
          if (e.key === 'Enter') { if (timerRef.current) clearTimeout(timerRef.current); runSearch(queryRef.current) }
          if (e.key === 'Escape') inputRef.current?.blur?.()
        },
      }),
      replaceEnabled
        ? React.createElement('button', {
            className: 'edrv-search-toggle' + (replaceOpen ? ' on' : ''),
            title: replaceOpen ? '收起替换' : '显示替换',
            'aria-pressed': replaceOpen,
            onClick: () => setReplaceOpen((value) => !value),
          }, '⇄')
        : null),
    replaceRows,
    optsBar,
    filterRows,
    summary,
    warnBanner,
    replaceErrorBanner,
    replaceNoticeBanner,
    body,
    confirmDialog)
}

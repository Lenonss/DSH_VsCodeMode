/**
 * dsh-vscode-mode client — 编辑器导航历史（后退/前进）纯逻辑。
 * 对齐 VSCode Go Back / Go Forward（navigation history）：记录「文件 + 焦点位置」访问轨迹，
 * 后退回到上一处焦点，前进回到下一处，跨文件生效。
 * 数据模型：past（末位 = 当前）+ future 两个栈；record 压栈并清空 future；
 * 与栈顶同 path+line+column 视为同一位置：仅刷新 viewState 快照，不压栈、不清 future。
 * 纯逻辑无 DOM 依赖，可单测。
 * 作者 ddj 2026年09月04号
 */

/** 导航历史单条记录：文件 + 焦点位置（+ 可选的 viewState 快照用于恢复滚动/折叠）。 */
export interface NavEntry {
  /** 工作区相对路径 */
  path: string
  /** 焦点行（1-based） */
  line?: number
  /** 焦点列（1-based） */
  column?: number
  /** 该位置保存的 Monaco viewState（恢复滚动/折叠） */
  viewState?: unknown
}

/** 导航历史接口。 */
export interface NavHistory {
  /** 记录当前位置（压栈 + 清空 future；与栈顶同位置时仅更新 viewState）。 */
  record(entry: NavEntry): void
  /** 后退：返回将要恢复的前一条目；历史不足 2 条 → null。 */
  back(): NavEntry | null
  /** 前进：返回将要恢复的条目；future 空 → null。 */
  forward(): NavEntry | null
  /** 是否可后退。 */
  canBack(): boolean
  /** 是否可前进。 */
  canForward(): boolean
  /** 后退目标条目（不改变状态；不可退 → null）。 */
  peekBack(): NavEntry | null
  /** 前进目标条目（不改变状态；不可进 → null）。 */
  peekForward(): NavEntry | null
}

/** 后退栈默认容量上限（超出逐出最旧）。 */
export const NAV_HISTORY_CAP = 200

/** 路径一致（容忍相对路径大小写差异，对齐既有 sameFile 语义常用写法）。 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true
  return String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase()
}

/** 位置一致（无焦点时按 null 归一，`undefined`/`null` 视为相等）。 */
function samePos(a: NavEntry, b: NavEntry): boolean {
  if (!samePath(a.path, b.path)) return false
  return (a.line ?? null) === (b.line ?? null) && (a.column ?? null) === (b.column ?? null)
}

/**
 * 创建导航历史实例（容量裁剪到 cap）。
 * @author ddj 2026年09月04号
 * @param cap 后退栈容量上限（默认 NAV_HISTORY_CAP）
 * @returns 导航历史实例
 */
export function createNavHistory(cap = NAV_HISTORY_CAP): NavHistory {
  const past: NavEntry[] = []
  const future: NavEntry[] = []
  return {
    record(entry: NavEntry): void {
      if (!entry || !entry.path) return
      const top = past[past.length - 1]
      if (top && samePos(top, entry)) {
        // 同一位置：只更新 viewState 快照（滚动/折叠可能变化），栈与 future 不动
        if (top.viewState !== undefined || entry.viewState !== undefined) top.viewState = entry.viewState
        return
      }
      past.push({ path: entry.path, line: entry.line, column: entry.column, viewState: entry.viewState })
      if (past.length > cap) past.splice(0, past.length - cap)
      future.length = 0
    },
    back(): NavEntry | null {
      if (past.length < 2) return null
      const current = past.pop()
      if (!current) return null
      future.push(current)
      return past[past.length - 1]
    },
    forward(): NavEntry | null {
      const entry = future.pop()
      if (!entry) return null
      past.push(entry)
      return entry
    },
    canBack(): boolean {
      return past.length >= 2
    },
    canForward(): boolean {
      return future.length > 0
    },
    peekBack(): NavEntry | null {
      return past.length >= 2 ? past[past.length - 2] : null
    },
    peekForward(): NavEntry | null {
      return future.length ? future[future.length - 1] : null
    },
  }
}

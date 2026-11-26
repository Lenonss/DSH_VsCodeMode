/**
 * dsh-vscode-mode client — 侧栏「测试验收」面板。
 *
 * 五块内容（自上而下）：使用说明、专属技能、项目测试规范、当前验收项、全部验收单。
 * 取数、轮询与三个动作在 `useTestCheckData` 里；本文件只负责摆位置、两处浮窗与文案。
 * 侧栏很窄，所以两张列表都给固定最大高度 + 内部滚动，不把整页撑长。
 * @author ddj 2026年11月26号
 */
import React from 'react'
import { copyText } from '../../copyText.js'
import { rpc } from '../../rpc.js'
import type { TestCheckSheetSummary, TestCheckView } from '../../../shared/testCheck.js'
import type { SidebarCtx, SidebarPanelDef } from '../types.js'
import { ModalShell } from '../../ui/ModalShell.js'
import { useTestCheckData } from './useTestCheckData.js'
import {
  canSavePolicy,
  isPolicyOversize,
  policyBytesOf,
  policySaveLabel,
  policySizeText,
  policyStatusText,
  sheetRowHint,
  sheetTallyOf,
  type PolicyView,
} from '../../testCheckPanelState.js'

//region 常量

/** 随包技能名（与 `skills/` 下的目录、frontmatter 的 name 一致）。 */
const SKILL_NAME = 'dsh-vscodemode-test-check'

/** 「使用说明」浮窗正文（写死在客户端；改文案只动这里）。 */
const HELP_LINES: readonly string[] = [
  '1. 用 /test-check <任务> 进入测试验收模式；任务文本会派生出验收单 id，同一句话再进模式回到同一张单。',
  '2. 底部栏出现「验收 x/y」chip，点它在文件编辑里打开验收单页签；页签里能看条目、手动上报、导出快照。',
  '3. AI 每验一条必须调用 test_check_report，参数 item / status / summary 都必填；summary 就是证据（测试名+通过数、命令+退出码、日志路径）。',
  '4. 状态取 pass / fail / blocked / skip。没有证据的 pass 只显示「无证据」，不计入通过；被验文件改过会变成「需复验」。',
  '5. 全部验完调用 test_check_finish：导出 docs/acceptance-<id>.html 并退出模式；还要补验就带 stay: true。',
  '6. 手动退出用 /test-check off（底部栏 chip 旁提示等价）。退出后不要再上报。',
  '7. 项目验收要求就在这个面板的「项目测试规范」里改：保存后下一条消息生效，不用重构建插件。',
]

//endregion

//region 图标

/**
 * 「测试验收」活动栏图标：清单行 + 勾（16×16，跟随 currentColor）。
 * @author ddj 2026年11月26号
 * @param props 尺寸与类名
 * @returns 图标元素
 */
export function IconTestCheck16(props: { size?: number; className?: string }): React.ReactElement {
  const size = props?.size ?? 16
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: props?.className,
    'aria-hidden': true,
    focusable: false,
  },
    React.createElement('path', { d: 'M2.6 3.9h3.6M2.6 8h3.6M2.6 12.1h3.6' }),
    React.createElement('path', { d: 'M9 8.2l2.1 2.1 3.3-3.6' }))
}

//endregion

//region 子组件

/** 说明与技能入口的 props。 */
interface GuideProps {
  /** 打开「使用说明」浮窗。 */
  onHelp: () => void
  /** 打开「专属技能」浮窗。 */
  onSkill: () => void
}

/**
 * 前两块：使用说明（「!」按钮进浮窗）与专属技能（只读查看）。
 * @author ddj 2026年11月26号
 * @param props 两个入口回调
 * @returns 区块元素
 */
function GuideSection(props: GuideProps): React.ReactElement {
  return React.createElement('div', { className: 'edrv-tc-block' },
    React.createElement('div', { className: 'edrv-tc-row' },
      React.createElement('span', { className: 'edrv-tc-label' }, '使用说明'),
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-icon-btn',
        title: '测试验收怎么用（Esc 或点遮罩关闭）',
        'aria-label': '打开使用说明',
        onClick: props.onHelp,
      }, '!')),
    React.createElement('div', { className: 'edrv-tc-row' },
      React.createElement('span', { className: 'edrv-tc-label' }, '专属技能'),
      React.createElement('span', { className: 'edrv-tc-dim' }, SKILL_NAME + ' · 只读'),
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-btn',
        title: '查看随插件发布的技能正文',
        onClick: props.onSkill,
      }, '查看')))
}

/** 规范编辑区的 props。 */
interface PolicyProps {
  /** 当前披露的规范状态（没有会话时为 null）。 */
  policy: PolicyView | null
  /** 编辑框草稿。 */
  draft: string
  /** 读取或保存的错误。 */
  error: string
  /** 是否正在保存。 */
  saving: boolean
  /** 会话工作区（没有时禁用编辑）。 */
  cwd: string | null
  /** 草稿变更。 */
  onDraft: (text: string) => void
  /** 保存。 */
  onSave: () => void
  /** 恢复默认。 */
  onReset: () => void
}

/**
 * 项目测试规范：等宽编辑框 + 状态行 + 体积提示 + 保存/重置。
 * @author ddj 2026年11月26号
 * @param props 数据与回调
 * @returns 区块元素
 */
function PolicySection(props: PolicyProps): React.ReactElement {
  const policy = props.policy
  const disabled = !props.cwd || !policy
  const savable = policy !== null && canSavePolicy({
    cwd: props.cwd,
    draft: props.draft,
    savedText: policy.text,
    isDefault: policy.isDefault,
  })
  const status = policy
    ? policyStatusText(policy)
    : '还没读到项目规则：先打开一个带工作区的会话'
  const bytes = policyBytesOf(props.draft)
  const oversize = isPolicyOversize(bytes)

  return React.createElement('div', { className: 'edrv-tc-block' },
    React.createElement('div', { className: 'edrv-tc-row' },
      React.createElement('span', { className: 'edrv-tc-label' }, '项目测试规范'),
      React.createElement('span', { className: 'edrv-tc-dim' }, '保存后下一条消息生效')),
    React.createElement('textarea', {
      className: 'edrv-tc-editor',
      spellCheck: false,
      value: props.draft,
      disabled,
      placeholder: '写本项目自己的验收要求：必须跑的用例、证据放哪、哪些条不许口头过……',
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => props.onDraft(event.target.value),
    }),
    React.createElement('div', { className: 'edrv-tc-status', title: policy?.path ?? '' }, status),
    React.createElement('div', { className: 'edrv-tc-hint' },
      '保存空内容 = 删除自定义规则、回到默认；.dsh/test-check/.gitignore 默认忽略本文件，团队共享需加一行 !policy.md'),
    oversize
      ? React.createElement('div', { className: 'edrv-tc-hint warn' },
        '当前 ' + policySizeText(bytes) + '：超出的部分不会进入规则段，请精简后再保存')
      : null,
    props.error ? React.createElement('div', { className: 'edrv-tc-error' }, props.error) : null,
    React.createElement('div', { className: 'edrv-tc-actions' },
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-btn primary',
        disabled: disabled || props.saving || !savable,
        title: savable ? '' : '没有改动或没有工作区',
        onClick: props.onSave,
      }, props.saving ? '保存中…' : policySaveLabel(props.draft)),
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-btn',
        disabled,
        onClick: props.onReset,
      }, '重置')))
}

/** 当前验收项的 props。 */
interface CurrentProps {
  /** 当前单的派生视图（没有时为 null）。 */
  view: TestCheckView | null
  /** 当前单读取错误。 */
  error: string
  /** 打开验收单页签。 */
  onOpen: () => void
}

/**
 * 当前验收项：一行一条（状态点 + 标题 + 状态标签），点行打开验收单页签。
 * @author ddj 2026年11月26号
 * @param props 视图、错误与打开回调
 * @returns 区块元素
 */
function CurrentSection(props: CurrentProps): React.ReactElement {
  const view = props.view
  const items = view ? view.groups.flatMap((group) => group.items) : []
  const head = React.createElement('div', { className: 'edrv-tc-row' },
    React.createElement('span', { className: 'edrv-tc-label' }, '当前验收项'),
    React.createElement('span', { className: 'edrv-tc-dim', title: view?.title ?? '' }, view ? sheetTallyOf(view.counts) : '—'),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-tc-btn',
      title: '在文件编辑里打开验收单页签',
      onClick: props.onOpen,
    }, '打开'))

  if (!items.length) {
    const empty = props.error
      ? props.error
      : (view?.state === 'invalid' ? 'items.json 有错：' + String(view.error ?? '') : '还没有验收单（进入模式后让 AI 建单）')
    return React.createElement('div', { className: 'edrv-tc-block' }, head,
      React.createElement('div', { className: 'edrv-tc-empty' }, empty))
  }

  return React.createElement('div', { className: 'edrv-tc-block' }, head,
    React.createElement('div', { className: 'edrv-tc-list' },
      items.map((item) => React.createElement('div', {
        key: item.id,
        className: 'edrv-tc-item',
        role: 'button',
        tabIndex: 0,
        title: item.id + ' · ' + (item.evidence ? '有证据' : '无证据'),
        onClick: props.onOpen,
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') props.onOpen()
        },
      },
        React.createElement('span', { className: 'edrv-tc-dot is-' + item.verdict, 'aria-hidden': true }, '●'),
        React.createElement('span', { className: 'edrv-tc-name' }, item.title),
        React.createElement('span', { className: 'edrv-tc-tag' }, item.label)))))
}

/** 全部验收单的 props。 */
interface SheetsProps {
  /** 行列表。 */
  rows: readonly TestCheckSheetSummary[]
  /** 是否正在刷新。 */
  busy: boolean
  /** 读取错误。 */
  error: string
  /** 刷新。 */
  onRefresh: () => void
  /** 打开快照。 */
  onOpen: (row: TestCheckSheetSummary) => void
  /** 移除（已确认）。 */
  onRemove: (row: TestCheckSheetSummary) => void
}

/**
 * 全部验收单：一行一张，点行打开快照；快照缺失的行只留「移除」。
 * @author ddj 2026年11月26号
 * @param props 行数据与三个回调
 * @returns 区块元素
 */
function SheetsSection(props: SheetsProps): React.ReactElement {
  const head = React.createElement('div', { className: 'edrv-tc-row' },
    React.createElement('span', { className: 'edrv-tc-label' }, '全部验收单'),
    React.createElement('span', { className: 'edrv-tc-dim' }, String(props.rows.length) + ' 张'),
    React.createElement('button', {
      type: 'button',
      className: 'edrv-tc-btn',
      disabled: props.busy,
      title: '重新扫描 .dsh/test-check 与 docs',
      onClick: props.onRefresh,
    }, props.busy ? '刷新中…' : '刷新'))

  if (!props.rows.length) {
    return React.createElement('div', { className: 'edrv-tc-block' }, head,
      React.createElement('div', { className: 'edrv-tc-empty' }, props.error || '项目里还没有验收单'))
  }

  return React.createElement('div', { className: 'edrv-tc-block' }, head,
    props.error ? React.createElement('div', { className: 'edrv-tc-error' }, props.error) : null,
    React.createElement('div', { className: 'edrv-tc-list' },
      props.rows.map((row) => React.createElement('div', {
        key: row.id,
        className: 'edrv-tc-sheet' + (row.hasSnapshot ? '' : ' is-missing'),
        role: 'button',
        tabIndex: 0,
        title: sheetRowHint(row.hasSnapshot) + '\n' + row.snapshotPath,
        onClick: () => props.onOpen(row),
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') props.onOpen(row)
        },
      },
        React.createElement('span', { className: 'edrv-tc-name' }, row.title),
        React.createElement('span', { className: 'edrv-tc-dim' }, sheetTallyOf(row.counts)),
        row.hasSnapshot
          ? React.createElement('span', { className: 'edrv-tc-tag' }, '打开')
          : React.createElement('span', { className: 'edrv-tc-tag warn' }, '快照缺失'),
        React.createElement('button', {
          type: 'button',
          className: 'edrv-tc-btn danger',
          title: '删除这张验收单与它的快照',
          onClick: (event: React.MouseEvent) => {
            event.stopPropagation()
            props.onRemove(row)
          },
        }, '移除')))))
}

/** 说明浮窗的 props。 */
interface HelpProps {
  /** 关闭。 */
  onClose: () => void
}

/**
 * 使用说明浮窗（ModalShell 外壳：Esc 与点遮罩都能关）。
 * @author ddj 2026年11月26号
 * @param props 关闭回调
 * @returns 浮窗元素
 */
function HelpModal(props: HelpProps): React.ReactElement {
  return React.createElement(ModalShell, {
    dialogClass: 'edrv-tc-dialog',
    width: 'min(760px, calc(100vw - 40px))',
    onClose: props.onClose,
  },
    React.createElement('div', { className: 'edrv-tc-dialog-head' },
      React.createElement('span', { className: 'edrv-tc-dialog-title' }, '测试验收怎么用'),
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-icon-btn',
        title: '关闭（Esc）',
        onClick: props.onClose,
      }, '✕')),
    React.createElement('div', { className: 'edrv-tc-dialog-body' },
      HELP_LINES.map((line) => React.createElement('p', { key: line }, line))))
}

/** 技能浮窗的 props。 */
interface SkillProps {
  /** 技能全文（未加载时为 null）。 */
  skill: { name: string; path: string; content: string } | null
  /** 读取错误。 */
  error: string
  /** 复制正文。 */
  onCopy: () => void
  /** 关闭。 */
  onClose: () => void
}

/**
 * 专属技能浮窗：只读 `<pre>` 全文（含 frontmatter），提供复制。
 * @author ddj 2026年11月26号
 * @param props 正文、错误与回调
 * @returns 浮窗元素
 */
function SkillModal(props: SkillProps): React.ReactElement {
  return React.createElement(ModalShell, {
    dialogClass: 'edrv-tc-dialog',
    width: 'min(860px, calc(100vw - 40px))',
    onClose: props.onClose,
  },
    React.createElement('div', { className: 'edrv-tc-dialog-head' },
      React.createElement('span', { className: 'edrv-tc-dialog-title' }, '专属技能 · ' + SKILL_NAME),
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-btn',
        disabled: !props.skill,
        onClick: props.onCopy,
      }, '复制'),
      React.createElement('button', {
        type: 'button',
        className: 'edrv-tc-icon-btn',
        title: '关闭（Esc）',
        onClick: props.onClose,
      }, '✕')),
    React.createElement('div', { className: 'edrv-tc-dialog-sub', title: props.skill?.path ?? '' },
      props.skill ? '随插件版本更新：' + props.skill.path : '正在读取…'),
    props.error
      ? React.createElement('div', { className: 'edrv-tc-dialog-body' }, React.createElement('div', { className: 'edrv-tc-error' }, props.error))
      : React.createElement('div', { className: 'edrv-tc-dialog-body' },
        React.createElement('pre', { className: 'edrv-tc-pre' }, props.skill?.content ?? '正在读取…')))
}

//endregion

//region 面板

/**
 * 面板主体：取数交给 `useTestCheckData`，这里只管浮窗状态与拼装。
 * @author ddj 2026年11月26号
 * @param props 侧栏共享上下文
 * @returns 面板元素
 */
export function TestCheckPanel(props: { ctx?: SidebarCtx }): React.ReactElement {
  const ctx = props?.ctx
  const notify = ctx?.notify
  const data = useTestCheckData(ctx)
  const [modal, setModal] = React.useState<'help' | 'skill' | null>(null)
  const [skill, setSkill] = React.useState<{ name: string; path: string; content: string } | null>(null)
  const [skillError, setSkillError] = React.useState('')
  const aliveRef = React.useRef(true)

  /** 每次打开都重读技能（插件升级后不会停在旧文）。 */
  async function loadSkill(): Promise<void> {
    setSkillError('')
    try {
      const raw = await rpc('edrv.testCheck.skill', {})
      if (!aliveRef.current) return
      if (!raw.ok) { setSkillError(raw.error); return }
      setSkill({ name: raw.name, path: raw.path, content: raw.content })
    } catch (error) {
      if (aliveRef.current) setSkillError('读取技能失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }

  React.useEffect(() => () => { aliveRef.current = false }, [])

  return React.createElement('div', { className: 'edrv-tc-panel' },
    React.createElement(GuideSection, {
      onHelp: () => setModal('help'),
      onSkill: () => {
        setModal('skill')
        void loadSkill()
      },
    }),
    React.createElement(PolicySection, {
      policy: data.policy,
      draft: data.draft,
      error: data.policyError,
      saving: data.saving,
      cwd: ctx?.cwd ?? null,
      onDraft: data.setDraft,
      onSave: () => { void data.savePolicy() },
      onReset: () => { void data.resetPolicy() },
    }),
    React.createElement(CurrentSection, {
      view: data.view,
      error: data.currentError,
      onOpen: () => { void data.openSheetTab() },
    }),
    React.createElement(SheetsSection, {
      rows: data.rows,
      busy: data.sheetsBusy,
      error: data.sheetsError,
      onRefresh: () => { void data.refreshAll(true) },
      onOpen: (row) => { void data.openSnapshot(row) },
      onRemove: (row) => { void data.removeRow(row) },
    }),
    modal === 'help' ? React.createElement(HelpModal, { onClose: () => setModal(null) }) : null,
    modal === 'skill'
      ? React.createElement(SkillModal, {
        skill,
        error: skillError,
        onCopy: () => { if (skill) void copyText(skill.content, '技能正文已复制', notify) },
        onClose: () => setModal(null),
      })
      : null)
}

//endregion

//region 注册

/**
 * 构造「测试验收」侧栏面板定义。
 * @author ddj 2026年11月26号
 * @returns 面板定义（常驻可见；无工作区时面板内提示）
 */
export function createTestCheckPanel(): SidebarPanelDef {
  return {
    id: 'testcheck',
    title: '测试验收',
    icon: IconTestCheck16,
    order: 21,
    render: (ctx: SidebarCtx) => React.createElement(TestCheckPanel, { ctx }),
  }
}

//endregion

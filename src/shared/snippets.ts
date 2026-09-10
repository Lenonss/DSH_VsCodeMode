/**
 * dsh-vscode-mode 代码片段共享数据契约（VS Code 兼容 .code-snippets 文件）。
 * 纯类型模块：禁 node/react 导入（与 shared/rules.ts 同约束）。
 * 文件格式与 VS Code 一致：顶层对象 { "<片段名>": { prefix, body, description?, scope? } }，
 * body 可为字符串或字符串数组（数组按行拼接）；scope 为语言 id 或语言 id 数组。
 * 作者 ddj 2026年09月10号
 */

/** 片段作用域：全局片段（~/.dsh/snippets）或项目片段（<工作区>/.dsh/snippets）。 */
export type SnippetScope = 'user' | 'project'

/** 一个 .code-snippets 文件的元信息（列表行展示 + 补全索引所需的最小集）。 */
export interface SnippetInfo {
  scope: SnippetScope
  /** 文件名（含 .code-snippets 后缀，不含路径）。 */
  file: string
  /** 绝对路径（host 解析，供展示与在编辑界面打开）。 */
  absPath: string
  /** 相对提示（用户层 snippets/ 或项目层 .dsh/snippets/）。 */
  relHint: string
  /** 由文件名推导的语言 id（`global`/无法识别为空串 = 全语言生效）。 */
  language: string
  /** 文件内片段条目数（解析失败为 0）。 */
  count: number
  /** 文件字节数（列表排序/超大提示用）。 */
  size: number
  /** 修改时间毫秒。 */
  mtime: number
  /** JSON 解析失败文案（仅 UI 提示，不影响其他文件）。 */
  error?: string
}

/** 一个工作区的项目片段聚合（snippets.list 的 projects 项）。 */
export interface SnippetProject {
  workspacePath: string
  title: string
  files: SnippetInfo[]
  /** 工作区目录不存在或无片段目录时为 true（UI 显示空态而非报错）。 */
  missingDir?: boolean
}

/** 片段文件读取/删除入参公共字段。 */
export interface SnippetRefInput {
  scope: SnippetScope
  /** project 必填：目标工作区绝对路径（须为 DSH 已注册 workspace）。 */
  workspacePath?: string
  file: string
}

/** 片段文件保存入参：content 为完整 JSON 文本（host 原样写盘）。 */
export interface SnippetSaveInput {
  scope: SnippetScope
  workspacePath?: string
  file: string
  content: string
}

/** 一条已展开的片段条目（补全 provider 与插入命令共用）。 */
export interface SnippetEntry {
  /** 片段名（对象键，补全候选的 label）。 */
  key: string
  /** 触发前缀（VS Code prefix；空串表示仅靠描述/手动插入）。 */
  prefix: string
  /** 展开正文（已按数组形式拼接为含换行的字符串）。 */
  body: string
  /** 片段描述（补全候选的说明，缺省为空串）。 */
  description: string
  scope: SnippetScope
  /** 来源文件名（补全候选 detail 展示）。 */
  file: string
  /** 生效语言 id（空串 = 全语言）。 */
  language: string
}

// --region 文件名与模板（纯函数：host 与 client 共用，避免两处漂移）
/** 全语言生效的文件名（无语言前缀）。 */
export const SNIPPET_GLOBAL_FILE = 'global.code-snippets'
/** 片段文件后缀。 */
export const SNIPPET_EXT = '.code-snippets'

/**
 * 语言 id → 默认片段文件名（空语言回退 global）。
 * @author ddj 2026年09月10号
 * @param language 语言 id
 * @returns 文件名（如 `lua.code-snippets`）
 */
export function snippetFileNameFor(language: string): string {
  const lang = String(language ?? '').trim().toLowerCase()
  return (lang || 'global') + SNIPPET_EXT
}

/**
 * 归一化新建文件名：用户输入可为裸语言名（补后缀）或完整文件名；空输入为空串。
 * @author ddj 2026年09月10号
 * @param raw 用户输入
 * @returns 归一化后的文件名
 */
export function normalizeSnippetFileName(raw: string): string {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  return text.toLowerCase().endsWith(SNIPPET_EXT) ? text : text + SNIPPET_EXT
}

/**
 * 新建片段文件模板（一条示例，改 body 即可用）。
 * @author ddj 2026年09月10号
 * @param language 目标语言 id（空串 = 全局）
 * @returns JSON 文本（带尾换行）
 */
export function snippetFileTemplate(language: string): string {
  const lang = String(language ?? '').trim().toLowerCase()
  const sample = (lang || 'global') + ' 示例片段'
  return JSON.stringify({
    [sample]: {
      prefix: 'hello',
      body: ['// ' + (lang || 'global') + ' 片段示例', '$1'],
      description: '示例：输入 hello 后 Tab 展开',
    },
  }, null, 2) + '\n'
}

/**
 * 可绑定语言目录（新建片段时的语言下拉来源；与 client/monaco/loader 的 LANG_BY_EXT
 * 取值集合保持一致）。此处冗余一份纯数据，使本模块不依赖浏览器端 Monaco
 * （shared 禁 import client 侧模块）；一致性由 tests/snippetLanguage.test.ts 断言兜底。
 */
export const SNIPPET_LANGUAGES: readonly string[] = [
  'c', 'cpp', 'csharp', 'css', 'dart', 'dockerfile', 'go', 'html', 'ini', 'java',
  'javascript', 'json', 'jsonc', 'kotlin', 'less', 'lua', 'markdown', 'mdx', 'php',
  'plaintext', 'powershell', 'python', 'ruby', 'rust', 'scss', 'shell', 'sql',
  'swift', 'typescript', 'xml', 'yaml',
]

/** 语言 id → 展示名（仅收录写法与 id 明显不同的；未收录的原样返回）。 */
const LANGUAGE_LABELS: Record<string, string> = {
  cpp: 'C++',
  csharp: 'C#',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsonc: 'JSON with Comments',
  powershell: 'PowerShell',
  plaintext: '纯文本',
}

/**
 * 语言 id 的人类可读名（用于下拉与「新建 xx 代码片段文件」文案）。
 * @author ddj 2026年09月10号
 * @param id 语言 id（空串表示全语言）
 * @returns 展示名
 */
export function languageLabelOf(id: string): string {
  const key = String(id ?? '').trim().toLowerCase()
  if (!key) return '全语言'
  return LANGUAGE_LABELS[key] ?? key
}
// --endregion

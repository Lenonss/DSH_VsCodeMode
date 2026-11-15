// @ts-nocheck
/**
 * dsh-vscode-mode client — Monaco 模板语言注册（EJS / Eta、ERB、Nunjucks、Jinja2、Blade、Haml、Slim）。
 *
 * 背景：随包分发的 Monaco（AMD basic-languages）已内置 handlebars / mustache / pug / twig /
 * liquid / razor / freemarker2，但没有 EJS、ERB、Nunjucks/Jinja2、Laravel Blade、Haml、Slim。
 * 这些模板在 Web/后端项目里很常见，缺注册时会被 `langOf` 落到 plaintext（或错误地落到 php），
 * 表现为「打开模板文件一片白」。
 *
 * 约定：
 * 1. **注册时机必须在 `loadMonaco()` 解析之前/之内**（见 loader.ts 的 editor.main 回调）：
 *    `createModel` 只接受 `getLanguages()` 里已存在的 id，晚注册会静默回落 plaintext。
 * 2. 只提供词法分色与括号/注释配置，**不提供语义服务**（模板语言的语义交给各项目的 LSP/扩展）。
 * 3. 注册幂等：同一页面重复调用只生效一次；单个语言失败不影响其他语言。
 * 4. 规则以纯数据 + 小函数表达，便于单测检查「分隔符成对 / 必填字段」而不需浏览器环境。
 *
 * @author ddj 2026年11月15号
 */

/** 注册是否已执行（模块级幂等标记）。 */
let registered = false

/** 各语言的自定义 id（供映射审计与兼容性报告使用）。 */
export const TEMPLATE_LANGUAGE_IDS = ['ejs', 'erb', 'nunjucks', 'jinja', 'blade', 'haml', 'slim']

/** 共享 HTML 词法规则：文档类型、注释、标签、属性名/值、实体。 */
export function htmlRules() {
  return [
    [/<!DOCTYPE[^>]*>/i, 'metatag'],
    [/<!--/, 'comment', '@htmlComment'],
    [/<\/?[\w:.-]+/, 'tag'],
    [/\b[\w:.-]+(?=\s*=)/, 'attribute.name'],
    [/"[^"]*"/, 'attribute.value'],
    [/'[^']*'/, 'attribute.value'],
    [/&[a-zA-Z#0-9]+;/, 'string.escape'],
  ]
}

/** HTML 注释状态（`<!--` 之后到 `-->`）。 */
export function htmlCommentState() {
  return [
    [/-->/, 'comment', '@pop'],
    [/[^-]+/, 'comment'],
    [/-/, 'comment'],
  ]
}

/**
 * 分隔符内代码状态：遇到 closeRe 出栈，字符串/数字按语言给色。
 * @author ddj 2026年11月15号
 * @param closeRe 结束分隔符正则
 * @param lineCommentRes 该语言的行注释正则数组（可为空）
 * @returns Monarch 状态规则数组
 */
export function codeState(closeRe, lineCommentRes = []) {
  const rules = [[closeRe, 'delimiter', '@pop']]
  for (const pattern of lineCommentRes) rules.push([pattern, 'comment'])
  rules.push(
    [/'(?:[^'\\]|\\.)*'/, 'string'],
    [/"(?:[^"\\]|\\.)*"/, 'string'],
    [/\b\d+(?:\.\d+)?\b/, 'number'],
    [/\b(?:true|false|null|nil|undefined|None|True|False)\b/, 'keyword'],
    [/\b(?:if|else|elseif|endif|for|endforeach|endfor|in|end|let|const|var|function|return|match|case|block|extends|include|import|from|class|with|and|or|not|is)\b/, 'keyword'],
  )
  return rules
}

/** 模板分隔符注释状态（`<%#`、`{#`、`{{--` 等）。 */
export function commentState(closeRe) {
  return [
    [closeRe, 'comment', '@pop'],
    [/./, 'comment'],
  ]
}

/** EJS / Eta：`<% %>`（`<%# %>` 注释，`<%=`/`<%-` 输出）。 */
function ejsSpec() {
  return {
    id: 'ejs',
    extensions: ['.ejs', '.eta'],
    aliases: ['EJS', 'Eta', 'Embedded JavaScript'],
    tokenizer: {
      defaultToken: '',
      tokenPostfix: '.ejs',
      tokenizer: {
        root: [
          [/<%#/, 'comment', '@comment'],
          [/<%[=-]?/, 'delimiter', '@code'],
          ...htmlRules(),
          [/[^<]+/, ''],
        ],
        code: codeState(/%>/, [/\/\/.*$/]),
        comment: commentState(/%>/),
        htmlComment: htmlCommentState(),
      },
    },
    configuration: { blockComment: ['<%#', '%>'], brackets: [['{', '}'], ['[', ']'], ['(', ')']] },
  }
}

/** ERB：与 EJS 同形，但内嵌 Ruby 语法（行注释用 `#`）。 */
function erbSpec() {
  return {
    id: 'erb',
    extensions: ['.erb'],
    aliases: ['ERB', 'Embedded Ruby'],
    tokenizer: {
      defaultToken: '',
      tokenPostfix: '.erb',
      tokenizer: {
        root: [
          [/<%#/, 'comment', '@comment'],
          [/<%[=-]?/, 'delimiter', '@code'],
          ...htmlRules(),
          [/[^<]+/, ''],
        ],
        code: codeState(/%>/, [/#.*$/]),
        comment: commentState(/%>/),
        htmlComment: htmlCommentState(),
      },
    },
    configuration: { blockComment: ['<%#', '%>'], brackets: [['{', '}'], ['[', ']'], ['(', ')']] },
  }
}

/**
 * Nunjucks / Jinja2：`{% %}` 语句、`{{ }}` 输出、`{# #}` 注释。
 * @author ddj 2026年11月15号
 * @param id 语言 id
 * @param aliases 别名列表
 * @param extensions 扩展名列表
 * @returns 语言规则描述
 */
function jinjaSpec(id, aliases, extensions) {
  return {
    id,
    extensions,
    aliases,
    tokenizer: {
      defaultToken: '',
      tokenPostfix: '.' + id,
      tokenizer: {
        root: [
          [/\{#/, 'comment', '@comment'],
          [/\{%/, 'delimiter', '@statement'],
          [/\{\{/, 'delimiter', '@code'],
          ...htmlRules(),
          [/[^{<]+/, ''],
        ],
        code: codeState(/\}\}/),
        statement: codeState(/%\}/),
        comment: commentState(/#\}/),
        htmlComment: htmlCommentState(),
      },
    },
    configuration: { blockComment: ['{#', '#}'], brackets: [['{', '}'], ['[', ']'], ['(', ')']] },
  }
}

/** Laravel Blade：`{{ }}`、`{!! !!}`、`{{-- --}}` 注释、`@directive`。 */
function bladeSpec() {
  return {
    id: 'blade',
    extensions: ['.blade.php'],
    aliases: ['Blade', 'Laravel Blade'],
    tokenizer: {
      defaultToken: '',
      tokenPostfix: '.blade',
      tokenizer: {
        root: [
          [/\{\{--/, 'comment', '@comment'],
          [/\{!!/, 'delimiter', '@raw'],
          [/\{\{/, 'delimiter', '@code'],
          [/@[\w:]+/, 'keyword.directive'],
          ...htmlRules(),
          [/[^{<@]+/, ''],
        ],
        code: codeState(/\}\}/),
        raw: codeState(/!!\}/),
        comment: commentState(/--\}\}/),
        htmlComment: htmlCommentState(),
      },
    },
    configuration: { blockComment: ['{{--', '--}}'], brackets: [['{', '}'], ['[', ']'], ['(', ')']] },
  }
}

/**
 * Haml / Slim：缩进式模板（`%tag`、`.class`、`#id`、`-` 代码行、`=` 输出行、`/` 注释行、`:filter`）。
 * @author ddj 2026年11月15号
 * @param id 语言 id
 * @param aliases 别名列表
 * @param extensions 扩展名列表
 * @returns 语言规则描述
 */
function indentedSpec(id, aliases, extensions) {
  return {
    id,
    extensions,
    aliases,
    tokenizer: {
      defaultToken: '',
      tokenPostfix: '.' + id,
      tokenizer: {
        root: [
          [/^\s*!!!.*$/, 'metatag'],
          [/^\s*\/[^\n]*$/, 'comment'],
          [/^\s*:[\w-]+/, 'metatag'],
          [/^\s*[-=]/, 'delimiter'],
          [/%[\w:-]+/, 'tag'],
          [/[.#][\w-]+/, 'attribute.name'],
          [/[{}()[\],]/, 'delimiter.bracket'],
          [/"[^"]*"/, 'string'],
          [/'[^']*'/, 'string'],
          [/\b\d+(?:\.\d+)?\b/, 'number'],
          [/@[\w-]+/, 'variable'],
          [/[^\s%.#=@\[\]{}()]+/, ''],
        ],
        htmlComment: htmlCommentState(),
      },
    },
    configuration: { lineComment: '/', brackets: [['{', '}'], ['[', ']'], ['(', ')']] },
  }
}

/** 全部模板语言规则（注册与单测共用同一份数据）。 */
export const TEMPLATE_SPECS = [
  ejsSpec(),
  erbSpec(),
  jinjaSpec('nunjucks', ['Nunjucks', 'njk'], ['.njk', '.nunjucks']),
  jinjaSpec('jinja', ['Jinja', 'Jinja2'], ['.jinja', '.jinja2', '.j2']),
  bladeSpec(),
  indentedSpec('haml', ['Haml'], ['.haml']),
  indentedSpec('slim', ['Slim'], ['.slim']),
]

/**
 * 由规则描述生成 Monaco language configuration（注释符缺失时不写空注释）。
 * @author ddj 2026年11月15号
 * @param spec 语言规则描述
 * @returns language configuration
 */
export function configurationOf(spec) {
  const source = spec.configuration ?? {}
  const configuration = { brackets: source.brackets }
  if (Array.isArray(source.blockComment)) configuration.comments = { blockComment: source.blockComment }
  if (typeof source.lineComment === 'string' && source.lineComment !== '') configuration.comments = { lineComment: source.lineComment }
  configuration.autoClosingPairs = [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ]
  configuration.surroundingPairs = [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ]
  return configuration
}

/**
 * 注册全部模板语言到 Monaco（幂等；单个语言失败不影响其他语言）。
 * @author ddj 2026年11月15号
 * @param monaco window.monaco（AMD 构建，editor.main 加载完成后才有 languages）
 * @returns 是否执行过注册（幂等重复调用返回 true，但不会重复注册）
 */
export function registerTemplates(monaco) {
  if (!monaco?.languages?.register || !monaco.languages.setMonarchTokensProvider) return false
  if (registered) return true
  registered = true
  for (const spec of TEMPLATE_SPECS) {
    try {
      monaco.languages.register({ id: spec.id, extensions: spec.extensions, aliases: spec.aliases })
      monaco.languages.setMonarchTokensProvider(spec.id, spec.tokenizer)
      monaco.languages.setLanguageConfiguration(spec.id, configurationOf(spec))
    } catch (error) {
      // 单个语言注册失败（Monaco 版本差异/重复 id）不影响其他语言的可用性
    }
  }
  return true
}

/**
 * 是否为本文档注册的模板语言 id（兼容性报告/片段语言下拉用）。
 * @author ddj 2026年11月15号
 * @param id 语言 id
 * @returns 是否属于模板语言
 */
export function isTemplateLang(id) {
  return TEMPLATE_LANGUAGE_IDS.includes(String(id ?? ''))
}

/** 仅供单测复位幂等标记（生产代码不调用）。 */
export function resetTemplates() {
  registered = false
}

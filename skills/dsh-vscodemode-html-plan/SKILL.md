---
name: dsh-vscodemode-html-plan
description: 把实施计划写成一份单文件交互式 HTML 计划页（主张树：为什么 › 能做什么 › 怎么做 › 在哪；每条主张配一个图示；需要用户拍板的决策挂在它影响的主张上），并接入 DSH 计划模式的状态、审批与退出流程。
whenToUse: 用户输入 /html-plan；或 plan 模式下要求给出可逐项作答的 HTML 计划/方案/设计稿/RFC；或计划里有 2~5 个必须用户拍板的岔口时。
---

# html-plan（DSH 版）

本技能包含上游 anthropics/claude-plugins-community 的 html-plan 运行时与规则（MIT，作者 Thariq Shihipar），
按 DSH 计划模式改写：页面在 dsh-vscode-mode 的计划页签中渲染，审批与退出仍走官方计划模式。

## 0. 快捷入口

- 用户输入 `/html-plan <任务>`：宿主命令会进入计划模式，并把「用本技能产出 HTML 计划页」的指令作为用户消息发出。
- 只输入 `/html-plan`：同样进入计划模式，但指令要求先问清要规划的任务。
- 用户已 `/plan`：按本技能正常产出即可，插件在 `exit_plan_mode` 时渲染 HTML 计划页。

## 1. 何时用

- 当前处于 plan 模式（/plan），或用户明确要求「先出计划/方案/设计稿/RFC」。
- 计划里存在必须用户拍板的岔口（2~5 个）：范围、取舍、默认值。

## 2. 产出约定（DSH 特有，必读）

1. 位置：plans/<slug>/plan.html。slug 用 kebab-case，例如 plans/html-plan/plan.html。
2. 复制运行时：把本技能目录的 runtime/htmlplan.css、runtime/htmlplan.js、runtime/pack.mjs
   复制到 plans/<slug>/runtime/。
3. 页面引用（相对路径）：
   <link rel="stylesheet" href="runtime/htmlplan.css">
   <script src="runtime/htmlplan.js" defer></script>
4. 打包：node plans/<slug>/runtime/pack.mjs plans/<slug>/plan.html --root <工作区绝对路径>。
   产物为 plans/<slug>/plan.packed.html（单文件、可离线）。按 pack 报告逐条修错误与警告。
5. 清理：打包成功后删除 plans/<slug>/runtime/ 与未打包的 plan.html，只留 packed 单文件，避免仓库噪声。
6. 提交审批：调用 exit_plan_mode。plan 正文第一行必须是「# 计划：<标题>」，并且**必须包含一行**：

   HTML 计划页：plans/<slug>/plan.packed.html

   插件据这一行在计划页签渲染 HTML；缺少该行则回落 Markdown 计划预览。
7. 正文同时写 3~6 行摘要与决策清单：官方审批卡片只显示标题与两行纯文本摘要，
   正文是官方「查看全文」与历史卡片的内容来源。

## 3. 主张树（沿用上游）

每一层回答一个问题，问题决定配什么图示。

| 层级 | 回答 | 主张 | 图示 |
|---|---|---|---|
| h1 | 这是什么？ | 3~7 个词的标题 | 无 |
| details.thread | 为什么？ | — | 用户自己的话（封闭引用） |
| 1 | 用户现在能做什么/看到什么？ | 一个行为 | doc-mock；有生命周期用 doc-machine |
| 2 | 它怎么工作？ | 一个入口、规则或记录 | doc-calls、doc-schema 或短 doc-code |
| 3 | 在哪？ | file:line | doc-code |

HTML 骨架（可复制后改写）：

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>计划标题</title>
<link rel="stylesheet" href="runtime/htmlplan.css">
<script src="runtime/htmlplan.js" defer></script>
<body>
<header>
  <h1>计划标题（3~7 词）</h1>
  <doc-changes new="5" changed="4"></doc-changes>
  <details class="thread"><summary>为什么</summary>…doc-quote…</details>
</header>
<main>
<doc-plan>
  <doc-claim>
    <p>用户现在能选择发送时间。</p>
    <doc-mock frame="none" w="440">…</doc-mock>
    <doc-claim>
      <p>「稍后发送」只保存时间，不发送。</p>
      <doc-calls …>…</doc-calls>
      <doc-claim at="src/routes.ts:18">
        <p><b>routes.ts:18</b> · createScheduled()</p>
        <doc-code …>…</doc-code>
      </doc-claim>
    </doc-claim>
    <doc-claim>
      <p>每个用户最多保留 50 条待发消息。</p>
      <doc-code …>…</doc-code>
      <doc-ask id="limit">…</doc-ask>
    </doc-claim>
  </doc-claim>
  <doc-claim aux="shared"><p>共用：一张新表。</p><doc-schema lang="sql" …>…</doc-schema></doc-claim>
  <doc-claim aux="scope"><p>不改：普通发送、草稿、邮件服务商。</p><ul>…</ul></doc-claim>
</doc-plan>
</main>
</body></html>
```

规则（pack.mjs 检查 2、3、5、6、7、11；其余自查）：

1. 顶层按行为拆，不按文件、层或工作顺序拆。
2. 1/2 层每条主张都必须是可真可假的句子（约 12 词内）；3 层只写位置 file:line · symbol。
3. 一条主张只配一个图示；第二个图示就是第二条主张。
4. 收起状态就是摘要：只读 1 层主张，必须讲清整个改动。不要 TL;DR、不要章节、不要步骤清单。
5. 每层最多 5 个孩子，最多 3 层。
6. 决策挂在它改变的那条主张上（图示之后、子主张之前），默认勾选你会选的；
   如果某个选项会删掉一条主张，写明「主张 4 移除」。只问会改变实现的岔口，2~5 个。
7. 结尾必须有 aux="shared"（共用记录，可省略）与 aux="scope"（明确不改什么）。
8. 真实优先：已存在的代码给真实路径与行号，用 src="path" lines="a-b"；
   尚不存在的代码在标题里标注「草图」。引用用户原话，不改写。
9. Schema 用项目自身语言（TypeScript/SQL/protobuf），不要自造表格或符号。
10. 状态机会改变用户所见时，每个状态都要画屏幕，摆在网格上。
11. 页面以标题开头：h1 命名「改动 + 位置」，3~7 词，不是句子，上面不放任何标签行。

## 4. 写作

图示才是计划，文字只负责命名。

- 中文正文：短句；一句一个主题；主动语态；术语全文一致；「必须」表示规则，「可以」表示可能；
  不用「应该/也许」；不用缩略语与玩笑。
- 英文正文：沿用上游 ASD-STE100 简化技术英语规则；不确定的词用最常见短词。
- 标题一句话说明「注意什么」；pin 是短语；选项说明（small）不超过 12 词。
- 主张与图示之间不写解释段落；需要解释就换一个更好的图示。

## 5. 决策与答复

- 页面底部按钮「N 个待回答」跳到下一个未展开的决策；每个决策有编号（如「决策 2 / 4」）。
- 用户点 Respond 后出现一份 markdown 答复；点「回复」直接发送给 agent（等同把答复发回对话）。
- 发送失败时插件会恢复按钮并提示原因；此时可用 Copy response 或计划页签顶部「填入对话输入框」。
- 有待审批卡片时，「回复」= 先「同意执行」再发送答复（agent 从下一步开始执行）；要改计划请先点页签「继续规划」，再回复反馈。

## 6. DSH 计划页签与状态

- 计划页签显示状态：计划中 / 待审批 / 已批准（已退出计划模式）/ 继续规划 / 已退出计划模式。
-「同意执行」「继续规划」等价于官方审批卡片的同名操作，走官方问答通道；
  「退出计划模式」等价于 composer 计划徽标的 /plan off；官方审批卡片仍是权威通道。
- 任一官方客户端服务缺失时按钮降级为提示，不会伪造批准。

## 7. 委派写页（可选）

- 默认自己写。满足任一条件时，先按 Agent 协作规则征求同意再委派：预计页 >12 KB、主张/图示 ≥4、上下文紧张。
- 用户写 `/html-plan --delegate` 视为本任务已授权；`--no-delegate` 明确不委派。
- 用 subagent_fork（cwd = 工作区），父级先定稿主张树，再交固定摘要（模板见 references/subagent-brief.md）。
- 子级只写页并 pack，返回 packed 路径、lint 结果、主张/决策计数；父级只验 lint、计数与三处抽查，不读全文。
- 子级失败（不能写文件 / 缺 pack / lint 错）时父级自己写，不中断计划。

## 8. 上游资产与许可

runtime/、references/blocks.md、examples/scheduled-send.html 来自上游 html-plan
（仓库 anthropics/claude-plugins-community，MIT，作者 Thariq Shihipar），未修改。
本目录 LICENSE 保留上游许可原文；改写部分（本 SKILL.md 的 DSH 约定）同样以 MIT 提供。
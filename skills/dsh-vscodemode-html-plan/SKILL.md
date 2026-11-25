---
name: dsh-vscodemode-html-plan
description: 把实施计划写成一份单文件交互式 HTML 计划页（主张树：为什么 › 能做什么 › 怎么做 › 在哪；每条主张配一个图示；需要用户拍板的决策挂在它影响的主张上），用于 DSH 的 HTML 计划模式（独立模式，规则由插件每请求注入，页面由插件打包或兜底渲染）。
whenToUse: 用户输入 /html-plan；或处于 HTML 计划模式；或计划里有 2~5 个必须用户拍板的岔口、用户想要可逐项作答的 HTML 计划/方案/设计稿/RFC 时。
---

# html-plan（DSH 版）

本技能包含上游 anthropics/claude-plugins-community 的 html-plan 运行时与规则（MIT，作者 Thariq Shihipar），
按 DSH 的 HTML 计划模式改写：模式由 dsh-vscode-mode 提供（独立投影 + 系统提示规则 + 退出工具 + 底部栏 chip），
页面在计划签里渲染；审批与退出走官方 `userQuestions` 的 `plan-review` 通道。

## 0. 快捷入口

- `/html-plan <任务>`：进入 **HTML 计划模式**，任务作为普通用户消息送进会话；规则由插件注入。
- `/html-plan`：只进入模式；没有任务时先用一句话问清要规划什么。
- `/html-plan off` 或批准计划：离开模式；底部栏 chip 与这里等价。
- `/plan`：切回官方计划模式（两个模式互斥）。

## 1. 何时用

- 当前处于 HTML 计划模式，或用户明确要求「先出计划/方案/设计稿/RFC」。
- 计划里存在必须用户拍板的岔口（2~5 个）：范围、取舍、默认值。

## 2. 产出约定（DSH 特有，必读）

**先落盘，再提交。** 模式规则允许写 `plans/<slug>/plan.html`（本模式唯一允许的写操作），
不需要用户退出模式。**绝不要**要求用户「点退出计划模式 / 点同意执行」才能生成页面。

1. 位置：plans/<slug>/plan.html（可选；不写也能交付，插件会用计划正文渲染兜底页）。
2. 页面引用（相对路径；插件打包时会自动找到运行时）：
   <link rel="stylesheet" href="runtime/htmlplan.css">
   <script src="runtime/htmlplan.js" defer></script>
3. **不需要你自己打包**：计划签打开时插件自动调用 `pack.mjs`，输出到系统临时文件再读回；
   不删你的 `plan.html` 与 `assets/`。不要为页面跑 `plan.mjs` 或任何 node 命令。
   只有在没有插件、要手动看文件时，才按旧流程跑
   `node <本技能目录>/runtime/plan.mjs <slug> --root <工作区绝对路径>`。
4. 提交（HTML 计划模式）：调用 **exit_html_plan_mode**；plan 正文第一行必须是「# 计划：<标题>」，
   有作者页时再单独一行：

   HTML 计划页：plans/<slug>/plan.html

   （指向未打包的 `.html` 也可以；插件会自动打包。页面缺失或打包失败时插件用正文渲染兜底页。）
5. 提交（官方 `/plan` 模式）：调用 `exit_plan_mode`；有作者页同样加「HTML 计划页：…」一行，
   插件会自动打包后渲染。
6. 不要调用另一个模式的退出工具：HTML 计划模式里不要用 `exit_plan_mode`，普通计划模式里不要用 `exit_html_plan_mode`。
7. 正文同时写 3~6 行摘要与决策清单：官方审批卡片只显示标题与两行纯文本摘要，
   正文是官方「查看全文」与历史卡片的内容来源。
8. 顺序：写 plan.html（可选）→ 调对应退出工具。计划签的「重新解析 / ⟳」只重新解析，不会再让 agent 写页。
   页面确实生成失败时说清原因即可，不要为了页面退出模式。

### 2.1 附件（图片与文件）

用户把图片/文件拖进对话输入框、连 `/html-plan <任务>` 一起发时，命令会先把它们复制到
`plans/<slug>/assets/`，并把固定 slug 与文件清单写进送给你的任务消息：

- slug 已由命令定好：页面写到 `plans/<slug>/plan.html`，不要另起目录。
- 图片先用 `read_image` 看清内容再写主张；文档、日志用 `read` 读原文。
- 页面里用附件块引用（`src` 相对页面目录）：

  ```html
  <doc-attach label="随附材料" caption="打包后内联，离线也能看">
    <doc-file src="assets/login-mock.png">登录页设计稿</doc-file>
    <doc-file src="assets/api-v3.pdf">接口文档 v3</doc-file>
  </doc-attach>
  ```

- 插件自动打包时把每个 `doc-file` 内联成 data URI，并补 `data-mime` / `data-bytes`；
  图片出缩略图（点开看原图），文件出卡片（带下载）。单文件 >4 MB 不内联，
  卡片显示「未内联」；全页附件 >12 MB 会警告——大文件先裁小或改成文字引用。
- 自动打包**不会删除** `plans/<slug>/assets/`；旧的手动 `plan.mjs` 流程打包成功后会删除该目录。
- 页面只引用工作区里的文件：打包时只读工作区与页面目录，围栏与密钥过滤对附件同样生效。


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
- 有待审批卡片时，「回复」= 先把答复送进 agent 当前回合（steer），再结算为「同意执行」：批准结果和答复落在同一次模型请求里，agent 带着答复开始执行；要改计划请先点页签「继续规划」，再回复反馈。
- 带单选或复选的决策末尾自带「自己写一条」输入框（运行时注入，不用自己写 `<textarea>`）：写了文字就清掉上面的单选，答复里是 `_(no selection)_` 加 `custom:` 行，这个决策也算已变更。
- 只有文本框、刻度或排序的决策不加这个输入框。
- 收到带 `custom:` 的答复时，把自定义内容当作读者的实际选择，按它重规划；要在某条决策上关掉输入框，给 `<doc-ask custom="off">`。

## 6. DSH 计划页签与状态

- HTML 计划模式下，计划页签显示：HTML 计划模式中 / 待审批 / 已批准（已退出模式）/ 继续规划 / 已退出模式；
  页面来源徽标会标出「作者页 / 已打包 / 自动页」。
- 「同意执行」「继续规划」等价于官方审批卡片的同名操作，走官方问答通道；
  「退出计划模式」在 HTML 计划模式下等价于 `/html-plan off`，在普通计划模式下等价于 `/plan off`；
  输入框底部工具行的「HTML 计划模式」chip 也执行 `/html-plan off`。官方审批卡片仍是权威通道。
- 任一官方客户端服务缺失时按钮降级为提示，不会伪造批准。

## 7. 委派写页（可选）

- 默认自己写。HTML 计划模式不再提供 `--delegate` 开关；只有用户明确要求、且页规模大（>12 KB）或主张 ≥4 时，
  才按 Agent 协作规则征求同意后委派。
- 用 subagent_fork（cwd = 工作区），父级先定稿主张树，再交固定摘要（模板见 references/subagent-brief.md）。
- 子级只写 `plans/<slug>/plan.html`，不要跑打包命令：插件打开计划签时会自动打包。
- 子级返回页路径与主张/决策计数；父级只验计数与三处抽查，不读全文。
- 子级失败（不能写文件 / 结构错误）时父级自己写；页面最终写不出来也不影响交付——插件会用计划正文渲染兜底页。

## 8. 上游资产与许可

runtime/、references/blocks.md、examples/scheduled-send.html 来自上游 html-plan
（仓库 anthropics/claude-plugins-community，MIT，作者 Thariq Shihipar），未修改。
本目录 LICENSE 保留上游许可原文；改写部分（本 SKILL.md 的 DSH 约定）同样以 MIT 提供。
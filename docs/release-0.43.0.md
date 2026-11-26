# dsh-vscode-mode v0.43.0 — HTML 计划页不再依赖模型写 HTML

日期：2026-11-26　上一版：v0.41.0（0.42.0 只在工作区里改过版本号、未发布，直接跳过）

## 背景

HTML 计划模式的页面质量取决于模型能不能写 HTML。弱模型（GPT 系列常见）交上来的东西有两种：
一种是干脆不写页，插件把计划正文排成一篇文档——没有主张树、没有决策，看着像 README；
另一种是手写一整页自定义 HTML + CSS，卡片自己画、TOC 自己造，进计划签后排版是坏的。

这次把「页面长什么样」从模型手里收回到插件：只要交计划正文，就得到同一张标准计划页。

## 形态

```
计划正文（Markdown）
  # 计划：<标题>
  ## 为什么            → 折叠条「为什么 · N 个诉求」
  ## <一句话主张>       → doc-claim（编号 1、2、3…）
  ## 决策清单           → doc-claim 里挂 doc-ask（问题 | 选项A | 选项B 出单选，没选项给填写框）
  ## 不改什么           → doc-claim aux="scope"（编号画成破折号）
        │
        ▼
  插件渲染标准计划页（运行时样式/脚本内联，单文件 ~220 KB）
```

- 解析容错优先：标题里带 `计划：`、`1. `、`1.1 `、`**加粗**` 都会剥掉；第一个标题直接以 `###` 开头也能当标题；列表按缩进成嵌套项；表格、代码块、引用照原样进正文。
- 小节分类只认标题开头：`不改/不做/范围外`、`待决策/拍板/待确认`、`为什么/背景/诉求/目标`，其余都算主张。原来的子串匹配会把「文字按效果图选择 TMP 样式」误判成决策小节，这次一并修掉。
- 一个有决策的计划才打开页面自带的答复条（`data-feedback="on"`），没有决策就不显示 `Respond`。

## 作者页护栏

手写页仍然是可选增强，但不再无条件相信：

- 判合规看两条：页面标记里有 `doc-plan` / `doc-claim`，且引用了 `htmlplan.css` / `htmlplan.js`（打包页运行时已内联，不再查这条）。
- 不合规就默认显示标准页，提示条写清原因（没有计划结构 / 没有引用运行时 / 打包失败），页签多一个「看作者页 ⇄ 用标准页」按钮，随手切回。
- 判定只读标记：先剥掉 `<script>`、`<style>`、注释，避免运行时脚本里本来就有的 `doc-plan` 字样把自造页面判成合规。

## 规则文案

`htmlPlanGuidance` 与技能 `SKILL.md` 的默认路径改成「只交 Markdown，插件出页」，把写 `plan.html` 降级为「需要界面稿/流程图时才做」，并写明三条硬约束：引用运行时、只用 `doc-*` 排版、不要自带布局 CSS。

## 改动文件

| 文件 | 改了什么 |
| --- | --- |
| `src/planAutoPage.ts` | 404 → 700 行：Markdown 结构化解析 + 标准计划页生成；原文档式渲染保留为兜底 |
| `src/client/htmlPlan/planPage.ts` | 新增 `hasPlanStructure` / `hasPlanRuntime` 两个纯函数判定 |
| `src/client/htmlPlan/HtmlPlanPanel.ts` | 页面收口 `applyPage`：护栏、提示文案、作者页/标准页切换 |
| `src/htmlPlanGuidance.ts` | 规则文本改为「默认 Markdown」+ 正文约定 |
| `skills/dsh-vscodemode-html-plan/SKILL.md` | 产出约定同步（默认交正文、手写页的三条硬约束） |
| `tests/htmlPlanAutoPage.test.ts` | 结构化页、决策、作用域、转义、兜底 |
| `tests/htmlPlanPage.test.ts` | 两个判定的正反例 |
| `tests/htmlPlanGptCompat.test.ts` | 新增：弱模型乱格式正文、自造样式页、假 doc-* 页、正文注入 HTML 四类回归 |

## 验收

1. `npx vitest run tests/htmlPlan*.test.ts tests/plan*.test.ts` → 7 个文件、128 用例通过。
2. `npx tsc -p tsconfig.json --noEmit` → 0 error。
3. `npm run build` → `lib/index.js` / `lib/client.js` 含新代码（`<doc-plan>`、`hasPlanRuntime`）。
4. headless Chrome 打开生成的页面（1600×1000、940×900、展开态三张）：标题、为什么折叠条、编号主张、决策徽标、`N to answer ↓ / Respond` 与图 3 一致；窄宽度下 TOC 收成 ☰。
5. 弱模型样例（`## 1. 计划：…` + `### 1.1 为什么` + 4 空格列表 + 混排代码）同样排出标准页。

## 已测与缺口

- 本地全量门禁数字见发布记录。
- 缺口：没在真实 HTML 计划模式会话里让 GPT 模型跑一轮端到端（本机子代理只有 DeepSeek 模型），
  弱模型行为用契约级回归用例 + 人工构造的典型输出覆盖；真机验收仍建议开一次 `/html-plan` 看页面。
- 缺口：作者页「有 `doc-claim` 但 CSS 自己改坏了排版」这类不在护栏范围内，需要手动点「用标准页」。

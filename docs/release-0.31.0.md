# v0.31.0：SVN 工具与原生提交、HTML 网页预览与计划模式

## 新增

- **SVN agent 工具**（19 个 `svn_*`）：`status/info/diff/log/blame/list/cat/propget/proplist` 只读，
  `add/delete/revert/commit/update/resolve/cleanup/propset/propdel/changelist` 走同一执行核心；
  会话绑定、路径白名单、只读门禁、位置参数拒 `-` 前缀、无损 JSON 输出（避免 0.2.x 快照失败）。
- **原生提交**：提交计划（changelist / 勾选 / 自动 add·delete）、单块提交不分片、UTF-8 日志、
  冲突不自动 resolve；超限拒绝而不是半提交。
- **AI 提交信息**：只分析勾选路径，产出 subject/body 草稿；永不自动提交；风格可选 plain/conventional。
- **提交对话框**：分组三态勾选、ignore-on-commit 与未版本控制默认不勾、页脚主按钮带数量、
  提交前单次确认；AI 结果只回填文本框。
- **HTML 网页预览**：委托官方 HTML 渲染器，路径栏「预览网页」/ `Ctrl+Alt+V`；
  官方渲染器缺失时入口禁用并保留文本编辑，不新增 HTTP 路由。
- **HTML 计划模式**：`/html-plan <任务>` 进入计划模式并产出单文件交互式计划页；
  `--delegate` 可把写页委派给子 agent（默认不委派）；计划页签提供官方审批/继续规划/退出；
  答复面板「回复」直接发送，有待审批时先「同意执行」。

## 改进

- AI 调用统一到 `llmTask`：流式汇聚、超时、失败分类与可操作文案只有一份实现。
- 兼容报告与设置 schema 跟随新增的 SVN 执行/提交与 AI 提交风格字段（22 个顶层字段）。
- 编辑区 SVN 菜单随原生提交上线隐藏 Tortoise 提交项，保留未被覆盖的追溯入口。

## 实现边界

- HTML 预览不自建渲染器、不新增路由；静态模式无脚本、相对图片不内联；交互模式需开启开发者工具。
- 计划页缺标记/文件缺失/未打包时回退 Markdown 计划预览；委派失败回退父级写页。
- SVN 提交不自动解决冲突、不分块；AI 只产草稿，不自动提交。

## 验证

- `npm run typecheck`：0 error。
- `npm run test`：vitest **327 文件通过 + 2 跳过**，**4086 通过 / 22 跳过（4108）**，36.07s；
  `node --test` **9/9** 通过。
- `npm run build`：host `index.js` 1,215,428 B，client `client.js` 1,024,039 B；
  `check-client-artifacts` 通过。
- 发布前修正 `settingsAdaptive`/`compat`（17→22 字段）与 `svn`（原生提交动作、统一错误文案）四处陈旧断言。

## 已知缺口

- SVN 提交对话框仅做过静态夹具验收（见 `docs/gui-acceptance.md` v0.31.0 节），未在真实 SVN 工作副本点过。
- HTML 预览、计划页、答复「回复并执行」未在发布前实机复验；本轮按用户要求直接推送，发布后需刷新 GUI 冒烟。
- 计划模式答复在「待审批」时的同意链路依赖 `uiSession` 服务；若该版本未暴露，答复仍会发送但不会自动审批。

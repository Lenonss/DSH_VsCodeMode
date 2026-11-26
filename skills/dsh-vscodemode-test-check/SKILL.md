---
name: dsh-vscodemode-test-check
description: 用 /test-check 测试验收模式把一次任务逐条验收并留证：建验收单（items.json）、写带证据的结果、导出可交付验收快照。项目自己的验收要求在左侧「测试验收」面板里改，不写进本技能。
whenToUse: 当前处于测试验收模式，或用户要求「逐条验收 / 出验收单 / 这次改动验一下 / 把验收结果导出」
---

# 测试验收模式（`/test-check`）

一句话：**一项一条、每条带证据、人和 AI 看同一张单**。模式规则每请求由插件注入；这里讲怎么把单子填好。

## 1. 落盘位置（都在项目根）

```
.dsh/test-check/            # 不进版本库（自带 .gitignore 内容为 *）
  policy.md                 # 可选：项目自己的验收要求，写进规则段
  <id>/items.json           # 验收点定义（没有就先建单）
  <id>/snippets.md          # 各语言上报片段（插件生成，可重生成）
  <id>/events/*.json        # 每条结果一个文件
docs/acceptance-<id>.html   # test_check_finish 导出的交付快照（进库）
```

`<id>` 由命令文本派生（同一句话再进模式回到同一张单）。不知道当前 id 时先看命令回执里那行「验收单 id」。

## 2. `items.json`

```json
{
  "id": "settings-claude-style",
  "title": "设置页 · Claude 风格",
  "version": 1,
  "items": [
    { "id": "settings.claude-style.001", "title": "开关切换后立即生效", "group": "设置",
      "files": ["src/client/ui/IntegrationSettings.ts"] }
  ]
}
```

- `id` 形状 `<scope>.<area>.<3 位序号>`（如 `settings.claude-style.004`）：小写、段首字母、序号 3 位、全局唯一、**只增不改号**。
- 删条目改成 `"retired": true`，编号保留但不计分。
- `files` 可写多个路径（相对项目根）：决定「改动后需复验」怎么比；不写就不做失效判定。
- `title` 写成可真可假的句子（「重置按钮恢复默认」），别写「测试设置页」这种主题词。

## 3. 上报

优先级：`test_check_report`（AI 用）> 脚本写 `events/*.json`（项目用）。

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `item` | 是 | `items.json` 里的 id，写错会被拒绝并列出候选范围 |
| `status` | 是 | `pass` / `fail` / `blocked` / `skip` |
| `summary` | 是 | 证据本身：测试名+通过数、命令、日志路径。空着会被拒绝 |
| `command` / `exitCode` / `path` / `kind` | 否 | 命令、退出码、证据文件、`test` 或 `manual` |

脚本上报直接写文件（一条一个）：

```json
{ "item": "settings.claude-style.001", "status": "pass",
  "evidence": { "kind": "test", "summary": "npx vitest run tests/a.test.ts 3/3" },
  "subject": { "hash": "sha256:…" } }
```

`subject.hash` 可以省略——`test_check_report` 与插件会按 `files` 现场补；脚本自己算用
「`files` 排序后拼 `路径+换行+内容 sha256+换行`，整体再 sha256」。

## 4. 状态口径

- 取该条**最新**事件；`pass` 没有 `evidence` → 显示「无证据」，**不计入通过**。
- `subject.hash` 与当前文件不一致 → 「需复验」，从通过/失败里剔除，改回去会自动恢复。
- 汇总条固定五格：通过 / 失败 / 阻塞 / 未验 / 需复验。

## 5. 收尾

- `test_check_finish`：导出 `docs/acceptance-<id>.html` 并**退出模式**；还要补验就带 `stay: true`。
- 手动退出 `/test-check off`（底部栏 chip 等价）。
- 导出页是单文件、无脚本，脱离 DSH 也能打开；能进版本库给评审看。

## 6. 常见错误

- 「定义里没有这个测试点」：id 打错或还是 `retired`；先读 `items.json`。
- 「还没有 items.json」：先建单，再上报。
- 报了 `pass` 但页签显示「无证据」：漏了 `summary`，或证据字段全空。
- 写完事件页签没变：确认写的是 `.dsh/test-check/<当前 id>/events/`，不是别的单子。

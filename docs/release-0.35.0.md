# 0.35.0 — HTML 计划页支持附件（图片 / 文件）

日期：2026-11-24　基线：`@deepseek-ai/dsh@0.2.3-alpha.2`（Web）／`@deepseek-ai/dsh-desktop@0.2.2-rc.5`（桌面端）
上一版：v0.34.0（`b729ee8`）

## 背景

`/html-plan` 之前收不了附件：命令没声明 `input.attachments`，DSH 会直接拒绝带附件的调用；
计划页也只能内联 `<img>` / `doc-shot`，图片和文件没有统一的"附件"表达。

用户原话：「完善html计划模式。需要支持附件，如图片、文件这些」。

## 决策

1. 附件由命令收下，复制到 `plans/<slug>/assets/`，路径写进给 agent 的指令。
2. 单个附件超过 4 MB 不内联（页面通常 8 MB 以内）。
3. 打包成功后 `assets/` 默认删除；要重打包先加 `--keep-assets`。
4. 计划页签不加附件入口；iframe 放开 `allow-downloads`，附件没内联时出告警条。

## 改动

### 一、命令收附件（host）

| 文件 | 改动 |
| --- | --- |
| `src/htmlPlanCommand.ts` | `input` 声明 `attachments: true`；handler 读 `invocation.attachments`，取会话工作区与附件存储，落盘后把固定 slug 与附件清单交给指令；`/plan` 失败回滚本次写入；附件读写失败只降级为说明文字 |
| `src/htmlPlanAttachments.ts` | 新增：slug 派生（ASCII 词不足时时间戳兜底）、文件名清洗与去重、按序落盘、附件指令片段 |
| `src/htmlPlanAttachments.ts` | 单文件 25 MB / 单次 12 个上限；同 `attachmentId` 去重；逐项失败进 `skipped` |

### 二、计划页附件块（技能运行时）

| 文件 | 改动 |
| --- | --- |
| `skills/dsh-vscodemode-html-plan/runtime/htmlplan.js` | 新增 `doc-attach` / `doc-file`：图片出缩略图（点开看原图），文件出卡片（扩展名徽标、大小、下载）；未内联时给虚线占位与提示 |
| `skills/dsh-vscodemode-html-plan/runtime/htmlplan.css` | 附件网格与卡片样式 |
| `skills/dsh-vscodemode-html-plan/runtime/pack.mjs` | 白名单与 lint；把 `doc-file` 的源文件内联成 data URI 并补 `data-mime` / `data-bytes`；单文件 4 MB、全页 12 MB 预算；`doc-attach` 计入主张的图示与字数预算 |
| `skills/dsh-vscodemode-html-plan/runtime/plan.mjs` | 打包成功后默认删除 `assets/`，`--keep-assets` 保留；`--check` 拒绝仍有未内联附件的页面 |

### 三、计划页签（client）

| 文件 | 改动 |
| --- | --- |
| `src/client/htmlPlan/planPage.ts` | 新增 `planAttachInfoOf`（总数 / 未内联数）；修复指令补「附件必须内联、目录会删除」 |
| `src/client/htmlPlan/HtmlPlanPanel.ts` | iframe 沙箱补 `allow-downloads`；附件没内联时出告警条并给「重新打包」 |

### 四、文档与测试

| 文件 | 改动 |
| --- | --- |
| `skills/dsh-vscodemode-html-plan/SKILL.md` | 新增「2.1 附件」：怎么附、落在哪、页面怎么写、体积上限、目录生命周期 |
| `skills/dsh-vscodemode-html-plan/references/blocks.md` | 新增 `doc-attach` 小节 |
| `README.md` | HTML 计划模式条目补附件说明；安装示例与版本表更新 |
| `tests/htmlPlanAttachments.test.ts` | 新增：slug / 文件名 / 去重 / 上限 / 指令片段 |
| `tests/htmlPlanCommand.test.ts` | 附件声明、固定 slug、准备失败降级、`/plan` 失败回滚、只给附件的裸调用 |
| `tests/htmlPlanPage.test.ts` | 附件解析三态 |
| `tests/htmlPlanPack.test.ts` | 新增：真实 `plan.mjs` 端到端（data URI、`data-bytes`、目录默认删除、`--keep-assets`、缺失附件报错、`--check` 拦截） |

## 验证

- `npm run typecheck`：0 error。
- `npm run test`：vitest 340 个文件通过 / 2 跳过（342），用例 4246 通过 / 22 跳过（4268），23.52s；
  `node --test tests/nativeOpen.test.mjs` 9/9，10.5s。本轮无抖动用例。
- `npm run build`：`lib/index.js` 1,283,041 B、`lib/client.js` 1,289,459 B；rules/debug/excel/excelcodec
  产物齐全，client 产物校验通过。
- 浏览器冒烟：打包一页含 1 张 png + 1 个 txt，确认图片缩略图、TXT 徽标、`data:` 下载链接与
  `download` 属性、点开看原图都正常。
- 缺口：真实 composer 拖附件 → `/html-plan` 的端到端没有在本机 GUI 复验（需重载 host 插件），
  按用户要求发布；本地开发形态下重载插件即可验证。

## 升级

- `npm i dsh-vscode-mode@0.35.0` 或按 README 的三种安装方式升级，装完重启 DSH。
- 计划页产物格式不变；老计划页照常打开。
- 附件目录默认不留在仓库里；要保留原图给 `plan.mjs` 加 `--keep-assets`。

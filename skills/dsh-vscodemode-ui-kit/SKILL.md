---
name: dsh-vscodemode-ui-kit
description: UI 预制体搭建母版技能。装到项目里会按项目事实生成项目侧技能与结构库；创建 UI 时先生成材料页（可接 DSH 宿主，也可用带令牌的本机服务保存草稿），收到材料清单后再把一屏设计渲染成单文件 HTML 设计页（三栏、可拖、可改文字、回传 patch）。当用户要做界面、弹窗、列表、活动页的拼装设计，把效果图变成节点树与 rect，提取通用结构条目，浏览或校验结构库，或把 spec 落地成预制体时使用。
whenToUse: 用户提到 UI 预制体、界面拼装、弹窗设计、节点树、锚点、九宫格、效果图对坐标、结构库、通用条目、设计页、plan.html、材料页、intake、提交材料、ui_builder_intake、材料草稿、本机材料服务时。
---

# ui-kit — UI 预制体搭建母版技能

随 `dsh-vscode-mode` 插件分发：装了插件就能用，不需要手工放进 `~/.dsh/skills`。
`references/`、`runtime/`、`fixtures/` 都在**本技能目录**下（加载本技能时给出的 base directory），下文用 `<技能目录>` 指它。

| 入口 | 什么时候用 | 产物 |
|---|---|---|
| 安装 / 升级 | 项目第一次装，或本技能 runtime 升版本 | `<项目>/.dsh/skills/ui-builder`、`<项目>/.dsh/ui-kit/config.json`、空库 |
| 创建 UI（默认） | 用户说「创建 UI / 做一屏界面」且还没给材料 | 空白材料页、`plans/ui/<slug>/intake/materials.html`、材料清单 `request.json` |
| 设计 | 材料已提交，或直接改已有设计 | `plans/ui/<slug>/spec.json` + `plan.html` |
| 库 | 提取、浏览、校验通用结构 | `lib/entries/<id>/`、库页 |

## 硬约束（先读，会踩）

1. **项目根取「含 `.git` 的最近祖先」**，纯 svn 工程没有 `.git` 会退化成会话当前目录。安装第一步必须把解析出的项目根回显给用户，装错地方等于没装。
2. **设计页必须单文件自包含**：计划签的 iframe 不给 same-origin（`sandbox="allow-scripts allow-forms allow-popups allow-downloads"`），`localStorage`、`fetch`、相对路径素材全部不可用。
3. 设计页进计划签时，打包器只认同名 `htmlplan.css` / `htmlplan.js`，自包含页要用 `<style data-htmlplan>` 与 `<script data-htmlplan>` 两个标记才过得去外链检查。
4. **自定义标签不能用 `doc-` 前缀**：打包器遇到未知 `doc-*` 直接报错；本框架的组件统一 `ui-` 前缀。
5. **设计页不落盘交互状态**：页面只改内存副本，退出时输出 patch，agent 改 spec 再重新生成页面。agent 永远不改页面结构。
6. **数据只在 `ui-spec` 块里**：渲染器只读它；同一份 spec 渲染出同一份字节（`hash` 是 FNV-1a/8 位十六进制，build 与页面算法一致）。
7. **材料页不是计划页**：材料页可以用普通文件预览、DSH 官方 HTML 预览或外部浏览器打开；设计页才受计划页 iframe 的单文件约束。普通文件预览没有同源权限，材料页不能依赖 `localStorage`。
8. **材料页允许使用带令牌的本机服务**：`runtime/intake/server.mjs` 只监听 `127.0.0.1`，用随机令牌和 CORS 保存草稿/正式材料；服务随母版分发，安装/升级时复制到项目，不要求 Agent 临时手写接收器。没有宿主对话时，页面必须展示可复制的继续指令；不得用 HTTP 200 冒充“对话已收到”。
9. **材料页提交不依赖原生表单**：按钮必须是 `type="button"` 并直接调用保存逻辑；不要用 `requestSubmit()` 或表单导航，确保没有 `allow-forms` 的 iframe 仍可提交。

## 安装流程

```
1 探测 → 2 三轮问卷（每轮 4~5 题）→ 3 回显 config 摘要 → 4 用户确认 → 5 落盘 → 6 自检
```

- 探测清单、命令与回显格式：`<技能目录>/references/detect.md`
- 16 道题、默认值、题目到 config 字段的映射：`<技能目录>/references/questions.md`
- 材料页、提交链路与清单格式：`<技能目录>/references/intake.md`
- 答不出来的题一律走默认值，并在回显里标「默认，之后能改」。不要卡在第 8 题上。
- 用户确认前不写任何文件。落盘都写进项目内（`.dsh/`），碰不到用户目录；项目目录写不进去时报告路径和原因，不要换地方装。

生成的目录：

```
<项目>/.dsh/skills/ui-builder/SKILL.md             项目约定，短，指向 config 与库
<项目>/.dsh/skills/ui-builder/runtime/             本技能 runtime 的副本（含 intake.mjs、intake/ 服务与模板），版本号写进 config\n<项目>/.dsh/skills/ui-builder/fixtures/selftest/  build 自检样例（随母版复制，不写设计稿）
<项目>/.dsh/ui-kit/config.json                     项目事实，唯一入口
<项目>/.dsh/ui-kit/lib/index.json                  正文库清单（初始为空）
```

`runtime/` 从 `<技能目录>/runtime/` 整目录拷过去，不手抄。

### 生成的项目技能必须包含

项目侧 `SKILL.md` 只保留项目差异，不复制母版全文。至少要写清：

1. 项目根/版本库/Unity 版本、UI 体系、参考分辨率与适配、通用控件目录、绑定风格、素材目录、Unity 落地方式（来自 `config.json`）。
2. 创建 UI 的默认入口：有宿主工具时调 `ui_builder_intake`；需要草稿恢复、受限 iframe 或外部浏览器时，用 `runtime/intake.mjs --serve` 启动本机服务并把页面交给用户。两种入口都只生成材料页，不要求用户先贴图。
3. 提交后当前会话会收到材料清单消息；先读清单和 `assets[].absolutePath` 的实际图片，再建 spec，本阶段不搭建预制体。
4. 宿主不支持自动发送时如何降级：本机服务明确显示“材料已保存”，页面保留可复制的继续指令；不得把 HTTP 200 说成“对话已收到”，不得启动第二个临时接收器。
5. 升级只覆盖 `runtime/`，保留 `config.json`、结构库、设计稿、`intake/draft/`、`intake/submissions/` 用户材料；升级后跑：
   `node .dsh/skills/ui-builder/runtime/build.mjs --selftest`、
   `node .dsh/skills/ui-builder/runtime/intake.mjs --selftest` 与
   `node .dsh/skills/ui-builder/runtime/intake.mjs --selftest-http`。

## 创建 UI：默认先收材料

用户输入 `/ui-builder 创建ui`、`/ui-builder 创建 UI`，或只说“创建界面”且尚未提交材料时，**先生成并打开空白材料页**，不要求先在对话里整理图片和路径。

1. 读 `config.json`，为本次设计选独立 slug（小写英文、数字、短横线），检查 `plans/ui/<slug>/plan.html` 尚不存在。已存在就换 slug，不覆盖已有设计。
2. 选材料页入口：
   - **DSH 内快速通道**：调 `ui_builder_intake`，参数 `slug`，可选 `title` / `overwrite`。工具生成 `plans/ui/<slug>/intake/materials.html`，客户端在官方 HTML 预览里自动打开；这条路径由宿主保存和投递，不保存草稿。
   - **本机服务通道（推荐给需要草稿/受限 iframe/外部浏览器）**：

     ```bash
     node .dsh/skills/ui-builder/runtime/intake.mjs --serve --slug <slug> --title <名字>
     ```

     输出 `UI_INTAKE_URL`、`UI_INTAKE_PAGE`、`UI_INTAKE_TASK`、`UI_INTAKE_STATE`。服务只监听 `127.0.0.1`，材料页通过带令牌的 CORS 接口保存草稿和正式材料。把 `UI_INTAKE_URL` 给用户在浏览器打开；在 DSH 里可从文件树打开 `UI_INTAKE_PAGE`，页面会尝试连宿主对话。结束收集后执行 `--stop --slug <slug>`，保留草稿和 submissions。
3. 材料页字段：界面名称、宽高、设计说明、目标 Prefab、效果图路径、素材目录、Sprite 名称；支持选择/拖入、预览、移除。效果图和素材图都可以不传；尺寸/名称/素材目录来自 `config.json` 或命令参数，不写死项目。
4. 等用户点「提交并继续设计」。页面会分别显示“材料已保存”“正在发送给对话”“对话已确认收到”；没有宿主或发送失败时，显示可复制的继续指令。**不要把 HTTP 200 当成对话已收到**。
5. 当前会话收到清单后，消息形如：
   `/ui-builder 继续设计` + 材料清单路径 + “本阶段只生成 HTML 设计页，不搭建 Unity 预制体”。
6. 没有收到清单就说明还没提交；不要凭用户口述的文件名编造材料。

旧版插件没有 `ui_builder_intake` 时，用项目内 runtime 生成页面（无本机服务）：

```bash
node .dsh/skills/ui-builder/runtime/intake.mjs --slug <slug>
```

页面无法自动发送（旧宿主、未开启交互式 HTML 预览、外部浏览器）时，**必须如实说明**“材料已保存，但当前没有对话连接”，让用户复制继续指令或回 DSH 内打开；不得假装提交成功。

## 设计流程

```
1 读材料清单 → 2 看实际图片 → 3 建 spec → 4 build 出页 → 5 人对账 → 6 回传 patch → 7 改 spec 重出 → 8 落地与对账
```

1. 读 `plans/ui/<slug>/intake/submissions/<id>/request.json`；核对 `projectRoot` 与当前项目一致，`slug` 与设计目录一致。清单格式见 `references/intake.md`。
2. 用当前环境可用的识图方式逐张读 `assets[].absolutePath`（`read_image` 优先），不要只凭文件名推断内容；效果图缺失时按 `notes` 与素材继续。读不到图片就明说缺哪张，不要编造。
3. 素材需要复制/压缩时，放进 `plans/ui/<slug>/assets/`，记录原图尺寸；超过 1600px 宽先压。`intake/submissions/` 是用户原始材料，**只读，不删不改**。
4. 按 `references/spec.md` 写 `spec.json`（节点树 + rect + 锚点），`mock.src` 指向素材。
5. `node .dsh/skills/ui-builder/runtime/build.mjs --spec plans/ui/<slug>/spec.json --out plans/ui/<slug>/plan.html`
   （还没装项目技能时，先用 `<技能目录>/runtime/build.mjs` 出页，装完再切）
6. 用户在设计页里拖 rect、拉画布验锚点、改文字、框选范围、右键存库。
7. 页面输出 patch（`set/add/del/use/extract/scope`）；agent 先比 `spec.hash`，再按 ops 改 spec。
8. 重新 build，贴出新页。
9. 落地：按 `config.editor.way` 决定写 YAML、出 Editor 脚本还是只留规格；能回读就出差异表（`references/verify.md`）。本阶段仍不搭预制体时，明确告诉用户“设计页已生成，预制体等确认后再搭”。

## 材料页与设计页边界

- 材料页：单文件 HTML，允许 `fetch` 到带随机令牌、正确 CORS 的 `127.0.0.1` 材料服务；允许表单、文件选择、拖放、草稿；不写 `localStorage` 作为唯一存储。
- 设计页：继续单文件自包含，**不** `fetch`、不 `localStorage`、不依赖相对路径素材；交互只产出 patch，Agent 改 `spec.json` 后重建。
- 普通文件预览、正式 DSH HTML 预览、计划页 iframe 的差异见 `references/intake.md`；不要用一个容器的限制套到另一个容器。

## 数据契约

spec、patch、库条目的完整字段与校验规则：`<技能目录>/references/spec.md`。库的解析、版本、去重、校验：`<技能目录>/references/lib.md`。材料页与清单：`<技能目录>/references/intake.md`。

## runtime 命令

```bash
# 设计页：装完后用项目内的副本；未装时用 <技能目录>/runtime/build.mjs
node .dsh/skills/ui-builder/runtime/build.mjs --spec <spec.json> --out <plan.html> [--lib <库根>]… [--check] [--quiet]
node .dsh/skills/ui-builder/runtime/build.mjs --selftest

# 材料页：本机服务（带草稿/恢复/关闭）
node .dsh/skills/ui-builder/runtime/intake.mjs --serve --slug <slug> [--title <名字>] [--prefab <路径>] [--project <项目根>] [--port <端口>]
node .dsh/skills/ui-builder/runtime/intake.mjs --resume --slug <slug> [--project <项目根>]
node .dsh/skills/ui-builder/runtime/intake.mjs --stop --slug <slug> [--project <项目根>]
node .dsh/skills/ui-builder/runtime/intake.mjs --status --slug <slug> [--project <项目根>]
# 材料页：只生成静态页（宿主工具不可用时的兜底）
node .dsh/skills/ui-builder/runtime/intake.mjs --slug <slug> [--title <名字>] [--project <项目根>] [--overwrite]
node .dsh/skills/ui-builder/runtime/intake.mjs --selftest
node .dsh/skills/ui-builder/runtime/intake.mjs --selftest-http
```

`--check` 只校验不生成：节点 id 唯一、parent 存在、无环、rect 是数字、素材存在、库引用能解析、体积在限内。

`intake.mjs` 与宿主工具 `ui_builder_intake` 使用同一模板、同一项目 `config.json`、同一限制文件；已存在的材料页默认复用原令牌，不会把正在填写的页面换掉（需要重建时传 `overwrite`，且永不覆盖 `plan.html`）。`--serve` 的草稿写入 `intake/draft/`，正式材料写入 `intake/submissions/`，两者都不依赖 iframe 的 `localStorage`。

回读对账（`verify`）在 M6 才提供脚本；现在只有 `references/verify.md` 里的手工对账口径，不要假装已经跑过。

## 升级

本技能随插件升级（`dsh-vscode-mode` 发版即生效）。项目侧照旧：

1. 只覆盖 `<项目>/.dsh/skills/ui-builder/runtime/`（含 `intake.mjs`、`intake/server.mjs`、`intake/shared.mjs`、`intake/selftest.mjs`、`intake/materials.html`、`intake/limits.json`），**不动** `config.json`、库、`plans/`、`plans/ui/*/intake/draft/` 与 `plans/ui/*/intake/submissions/`。
2. 核对 `build.mjs` 里的 `RUNTIME_VERSION`（本版 1.2.0）与 `config.runtime` 对齐；只改版本号，不重写项目差异。
3. 覆盖后跑三个自检：
   `node .dsh/skills/ui-builder/runtime/build.mjs --selftest`
   `node .dsh/skills/ui-builder/runtime/intake.mjs --selftest`
   `node .dsh/skills/ui-builder/runtime/intake.mjs --selftest-http`
4. `--serve` 新页面默认拒绝覆盖已有材料页；`--resume` 复用原令牌/端口/草稿；`--stop` 关闭服务；服务状态在 `intake/service.json`，不要手删草稿或用户材料。
5. 自检生成的临时页面与服务在验证后清理；不要删用户材料。

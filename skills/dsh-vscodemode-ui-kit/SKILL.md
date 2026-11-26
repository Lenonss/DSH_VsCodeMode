---
name: dsh-vscodemode-ui-kit
description: UI 预制体搭建母版技能。装到项目里会按项目事实生成项目侧技能与结构库，并把一屏设计渲染成单文件 HTML 设计页（三栏、可拖、可改文字、回传 patch）。当用户要做界面、弹窗、列表、活动页的拼装设计，把效果图变成节点树与 rect，提取通用结构条目，浏览或校验结构库，或把 spec 落地成预制体时使用。
whenToUse: 用户提到 UI 预制体、界面拼装、弹窗设计、节点树、锚点、九宫格、效果图对坐标、结构库、通用条目、设计页、plan.html 时。
---

# ui-kit — UI 预制体搭建母版技能

随 `dsh-vscode-mode` 插件分发：装了插件就能用，不需要手工放进 `~/.dsh/skills`。
`references/`、`runtime/`、`fixtures/` 都在**本技能目录**下（加载本技能时给出的 base directory），下文用 `<技能目录>` 指它。

三个入口，别混着用：

| 入口 | 什么时候用 | 产物 |
|---|---|---|
| 安装 / 升级 | 项目第一次装，或本技能 runtime 升版本 | `<项目>/.dsh/skills/ui-builder`、`<项目>/.dsh/ui-kit/config.json`、空库 |
| 设计 | 做一屏界面 | `plans/ui/<slug>/spec.json` + `plan.html` |
| 库 | 提取、浏览、校验通用结构 | `lib/entries/<id>/`、库页 |

## 硬约束（先读，会踩）

1. **项目根取「含 `.git` 的最近祖先」**，纯 svn 工程没有 `.git` 会退化成会话当前目录。安装第一步必须把解析出的项目根回显给用户，装错地方等于没装。
2. **页面必须单文件自包含**：计划签的 iframe 不给 same-origin（`sandbox="allow-scripts allow-forms allow-popups allow-downloads"`），`localStorage`、`fetch`、相对路径素材全部不可用。
3. 页面进计划签时，打包器只认同名 `htmlplan.css` / `htmlplan.js`，自包含页要用 `<style data-htmlplan>` 与 `<script data-htmlplan>` 两个标记才过得去外链检查。
4. **自定义标签不能用 `doc-` 前缀**：打包器遇到未知 `doc-*` 直接报错；本框架的组件统一 `ui-` 前缀。
5. **页面不落盘**：交互只改内存副本，退出时输出 patch，agent 改 spec 再重新生成页面。agent 永远不改页面结构。
6. **数据只在 `ui-spec` 块里**：渲染器只读它；同一份 spec 渲染出同一份字节（`hash` 是 FNV-1a/8 位十六进制，build 与页面算法一致）。

## 安装流程

```
1 探测 → 2 三轮问卷（每轮 4~5 题）→ 3 回显 config 摘要 → 4 用户确认 → 5 落盘 → 6 自检
```

- 探测清单、命令与回显格式：`<技能目录>/references/detect.md`
- 16 道题、默认值、题目到 config 字段的映射：`<技能目录>/references/questions.md`
- 答不出来的题一律走默认值，并在回显里标「默认，之后能改」。不要卡在第 8 题上。
- 用户确认前不写任何文件。落盘都写进项目内（`.dsh/`），碰不到用户目录；项目目录写不进去时报告路径和原因，不要换地方装。

生成的目录：

```
<项目>/.dsh/skills/ui-builder/SKILL.md   项目约定，短，指向 config 与库
<项目>/.dsh/skills/ui-builder/runtime/   本技能 runtime 的副本，版本号写进 config
<项目>/.dsh/ui-kit/config.json           项目事实，唯一入口
<项目>/.dsh/ui-kit/lib/index.json        正文库清单（初始为空）
```

`runtime/` 从 `<技能目录>/runtime/` 整目录拷过去，不手抄。

## 设计流程

```
1 收素材 → 2 建 spec → 3 build 出页 → 4 人对账 → 5 回传 patch → 6 改 spec 重出 → 7 落地与对账
```

1. 效果图拷进 `plans/ui/<slug>/assets/`，记原图尺寸；超过 1600px 宽先压。
2. agent 按视觉写 `spec.json`（节点树 + rect + 锚点），`mock.src` 指向素材。
3. `node .dsh/skills/ui-builder/runtime/build.mjs --spec plans/ui/<slug>/spec.json --out plans/ui/<slug>/plan.html`
   （还没装项目技能时，先用 `<技能目录>/runtime/build.mjs` 出页，装完再切）
4. 用户在设计页里拖 rect、拉画布验锚点、改文字、框选范围、右键存库。
5. 页面输出 patch（`set/add/del/use/extract/scope`）；agent 先比 `spec.hash`，再按 ops 改 spec。
6. 重新 build，贴出新页。
7. 落地：按 `config.editor.way` 决定写 YAML、出 Editor 脚本还是只留规格；能回读就出差异表（`references/verify.md`）。

## 数据契约

spec、patch、库条目的完整字段与校验规则：`<技能目录>/references/spec.md`。库的解析、版本、去重、校验：`<技能目录>/references/lib.md`。

## runtime 命令

```bash
# 装完后用项目内的副本；未装时用 <技能目录>/runtime/build.mjs
node .dsh/skills/ui-builder/runtime/build.mjs --spec <spec.json> --out <plan.html> [--lib <库根>]… [--check] [--quiet]
node .dsh/skills/ui-builder/runtime/build.mjs --selftest     # 用 fixtures/selftest 生成一页并断言
```

`--check` 只校验不生成：节点 id 唯一、parent 存在、无环、rect 是数字、素材存在、库引用能解析、体积在限内。

回读对账（`verify`）在 M6 才提供脚本；现在只有 `references/verify.md` 里的手工对账口径，不要假装已经跑过。

## 升级

本技能随插件升级（`dsh-vscode-mode` 发版即生效）。项目侧照旧：只覆盖 `<项目>/.dsh/skills/ui-builder/runtime/`，不动 `config.json`、库、`plans/`；`config.runtime` 与 `build.mjs` 里的 `RUNTIME_VERSION` 对齐，覆盖后跑 `--selftest`。

# UI 预制体搭建技能：设计说明（开发交底）

这份文档是三轮讨论的结论，交给新会话直接开工用。里面的事实都在本机核实过，不是推测；标了「实测」的部分可以直接采信，不用重新验证。

> 实现现状：母版已作为插件自带技能随包分发，落在 `skills/dsh-vscodemode-ui-kit/`。
> 本文第 4、5 节写的 `~/.dsh/skills/ui-kit` 是设计当时的安装口径，读到按新路径折算；
> 其余结论（三个入口、数据契约、单文件约束、分阶段）仍然有效。

---

## 0. 一句话

做一份母版技能，装到项目里生成项目技能；配一套单文件 HTML 框架，用来设计界面、提取通用结构、浏览跨项目共享的结构库。

## 1. 做什么，不做什么

要做三件事：母版技能（含问卷与生成步骤）、HTML 框架（设计页 + 库页）、跨项目共享的虚拟结构库。

第一版不做：解析真实预制体文件（只记录路径，不解剖）；Unity 以外的适配器；多人同时编辑同一个库。

## 2. 已确认的决策

| 编号 | 决策 | 记一句为什么 |
|---|---|---|
| D1 | 母版技能 + 按项目生成技能 | 各项目 UI 体系不同，一套技能硬套会错 |
| D2 | 安装前给提问清单，答完再生成 | 猜错环境的代价比问几句大得多 |
| D3 | 库允许跨项目共享 | 通用弹窗、列表条目在多个项目里长得一样 |
| D4 | 库只存虚拟结构 | 真实预制体格式各异，第一版不啃解析 |
| D5 | 真实与虚拟允许混用 | 一屏里既有项目现成预制体，也有新拼的结构 |
| D6 | 页面单文件自包含，源码分模块 | 沙箱限制决定产物必须内联，但源码不能写成一坨 |
| D7 | 三个产物：屏幕规格、库条目、页面 | 页面是视图，规格和库才是能复用的东西 |

## 3. 整体形状

```
母版技能 ──问卷──> 项目技能 + 项目配置 + 空库
                        │
   设计页(design)  <────┘ 读 spec，画三栏
        │ 右键存库 / 框选范围 / 调数值
        └──回传 patch──> agent 改 spec、写库条目、生成页面
                              │
   库页(library)  <──────────┘ 浏览、校验、跨项目共享
```

## 4. 安装位（实测事实）

技能就是磁盘上的目录，不需要打成插件包。发现路径按优先级：

| 优先级 | 位置 | 放什么 |
|---|---|---|
| 100 | `<项目根>/.dsh/skills` | 生成的项目技能 |
| 200 | `<项目根>/.agents/skills` | 给别的 agent 工具用，本项目不用 |
| 400 | `~/.dsh/skills` | 母版技能 |

技能包结构是 `<名字>/SKILL.md` 加任意子目录（`references/`、`scripts/`、`assets/` 都会被一起带走）。改完下一次对话就生效，不用重启。

一个坑：项目根取的是「含 `.git` 的最近祖先」。纯 svn 的 Unity 工程没有 `.git`，会退化成会话当前目录。安装第一步必须确认并回显这个路径，装错地方就等于没装。

依据：DSH 安装目录下的 `node_modules/@deepseek-ai/dsh-skill-filesystem/README.zh.md`

## 5. 目录结构

母版：

```
~/.dsh/skills/ui-kit/
  SKILL.md                 安装、升级、门禁（只在没装或要升级时用）
  references/detect.md     项目探测清单
  references/questions.md  安装问卷（第 9 节）
  references/verify.md     规格校验与预制体回读
  runtime/css/*.css        框架样式，分模块
  runtime/js/*.js          框架逻辑，分模块
  runtime/build.mjs        spec + 素材 → 单文件页面
  runtime/spec.schema.json 数据契约
  fixtures/selftest/       假数据 + 占位图，装完自检用
```

项目里（生成物）：

```
<项目>/.dsh/skills/ui-builder/
  SKILL.md                 项目约定（短，指向下面这些）
  runtime/                 母版 runtime 的副本，版本号写进 config
<项目>/.dsh/ui-kit/
  config.json              项目事实（第 6.1 节）
  lib/index.json           正文库清单
  lib/entries/<id>/        条目：meta.json、spec.json、assets/、thumb.png、notes.md
plans/ui/<slug>/           一次设计的产物：spec.json、assets/、plan.html
```

共享库（跨项目）：

```
<共享库根>/                index.json + entries/<id>/，结构同项目库
```

## 6. 数据契约

### 6.1 config.json

```json
{
  "v": 1, "runtime": "1.0.0", "installedAt": "2026-11-26",
  "project": { "root": "<项目根>", "vcs": "svn" },
  "ui": { "system": "ugui", "refResolution": [1920, 1080], "matchMode": "height",
          "commonDir": "Assets/UI/Common", "bindStyle": "componentName" },
  "assets": { "artRoot": "<美术盘>/Art/UI", "inProject": "Assets/Art/UI", "sliced": true },
  "editor": { "mcp": false, "way": "editor-script" },
  "pages": { "dir": "plans/ui" },
  "lib": { "roots": ["./.dsh/ui-kit/lib", "<共享库根>"] }
}
```

`ui.system`、`bindStyle`、`editor.way` 决定设计页用什么说法、预制体怎么落地、回读能读到什么。

### 6.2 spec（一屏设计）

```json
{
  "v": 1, "page": "design", "hash": "a3f1c2",
  "screen": { "name": "邮件弹窗", "w": 1920, "h": 1080 },
  "mock": { "src": "data:image/jpeg;base64,…", "w": 1920, "h": 1080, "scale": 1.0 },
  "nodes": [
    { "id": "Popup/Root", "parent": null, "kind": "group", "rect": [520, 240, 880, 600],
      "anchor": { "min": [0.5, 0.5], "max": [0.5, 0.5], "pivot": [0.5, 0.5] } },
    { "id": "Popup/Root/Title", "parent": "Popup/Root", "kind": "text", "rect": [560, 270, 300, 48],
      "text": { "s": "邮件", "size": 32, "color": "#4a3b2a" }, "bind": "UI.Mail.Title" },
    { "id": "Popup/Root/List", "parent": "Popup/Root", "kind": "list", "rect": [540, 330, 840, 480],
      "ref": "lib:list-cell-basic@1", "params": { "count": 5, "gap": 12 } },
    { "id": "Popup/Root/Close", "parent": "Popup/Root", "kind": "prefab", "rect": [1352, 252, 32, 32],
      "prefab": "Assets/UI/Common/CloseBtn.prefab", "opaque": true }
  ]
}
```

字段规则：

- `id` 用语义路径，不用数组下标，否则每轮改页面都对不上。
- `rect` 是原图坐标系的像素，`mock.scale` 只影响显示。
- 只有 `kind:"prefab"` 且 `opaque:true` 的节点允许不写子节点，它的内部结构未知。
- `ref` 指向库条目，构建时展开成子节点；`@版本` 可省略，省略时用库里的当前版本并记录。
- 不在 `opaque` 节点内部插入虚拟结构。

### 6.3 库条目（只做虚拟）

```json
{
  "id": "list-cell-basic", "name": "基础列表条目", "kind": "list-cell",
  "source": "virtual", "version": 1,
  "desc": "左侧方形图标，中间标题，右侧数量。选中时换底图。",
  "when": "列表里的一行，宽度撑满容器",
  "whenNot": "需要多列排布或带操作按钮时别用",
  "tags": ["列表", "条目", "图标"],
  "tree": { "id": "Cell", "rect": [0, 0, 720, 96], "children": [] },
  "slots": [
    { "id": "icon", "kind": "sprite", "note": "方形图标，64×64" },
    { "id": "title", "kind": "text" },
    { "id": "count", "kind": "text" }
  ],
  "assets": { "bg": "assets/cell-bg.png", "bgSel": "assets/cell-bg-sel.png" },
  "requires": { "parentKind": "list", "minW": 600 },
  "origin": { "by": "user", "at": "2026-11-26", "from": "邮件弹窗" },
  "used": 0,
  "thumb": "thumb.png"
}
```

`desc`、`when`、`whenNot`、`tags` 四段是检索的依据，不是装饰。缺了 `whenNot`，下次 agent 会在不该用的地方硬套。

### 6.4 页面回传的 patch

页面不落盘，退出时输出一段 JSON，agent 按 ops 改文件：

```json
{
  "v": 1, "page": "design", "base": "a3f1c2",
  "ops": [
    { "op": "set", "id": "Popup/Root/Title", "field": "rect", "value": [560, 270, 300, 48] },
    { "op": "add", "parent": "Popup/Root", "node": { "id": "Popup/Root/Desc", "kind": "text" } },
    { "op": "del", "id": "Popup/Root/Old" },
    { "op": "use", "node": "Popup/Root/List", "lib": "list-cell-basic", "version": 1 },
    { "op": "extract", "node": "Popup/Root/List/Cell",
      "meta": { "name": "基础列表条目", "desc": "", "slots": ["icon", "title"], "keep": ["bg"] } },
    { "op": "scope", "ids": ["Popup/Root/List"] },
    { "op": "ask", "id": "q1", "answer": "列表用现有 UIScrollList" }
  ],
  "note": "标题下移 8px，列表换成库里的条目"
}
```

`base` 用来发现页面过期：agent 拿到 patch 先比 spec 的 hash，不一致就提示重开页面，不要盲改。

## 7. HTML 框架

### 7.1 为什么必须单文件

页面跑在不给 same-origin 的沙箱 iframe 里：`sandbox="allow-scripts allow-forms allow-popups allow-downloads"`。脚本能跑，但 localStorage、fetch、相对路径的图片和脚本全部失效。

打包器只会内联 `htmlplan.css` 和 `htmlplan.js` 这两个名字，别的 `<script src>` 原样留着，加载不到。单图内联上限 6MB，附件 4MB，全页超 12MB 会明显卡。

依据：`src/client/htmlPlan/HtmlPlanPanel.ts:526`、`skills/dsh-vscodemode-html-plan/runtime/pack.mjs:284`

结论：页面里所有 CSS、JS、图片都内联；自定义标签不要用 `doc-` 前缀（打包器遇到未知 `doc-*` 直接报错）。

### 7.2 骨架

```html
<!doctype html><meta charset="utf-8"><title>邮件弹窗</title>
<style>/* 变量 → 三栏 → 组件 */</style>
<script id="ui-spec" type="application/json">
{ "v":1, "page":"design", "screen":{…}, "mock":{…}, "nodes":[…] }
</script>
<div id="app"></div>
<script>/* 渲染器：读 ui-spec → 树 / 画布 / 属性 → 输出 patch */</script>
```

三条约定：

- 数据只在 `ui-spec` 块里，渲染器只读它；agent 永远不改页面结构。
- 渲染幂等：同一份 spec 出同一份字节，不写时间戳，方便比对和提交。
- 交互只改内存副本，提交时输出 patch，不是整份 spec。

### 7.3 两个壳

`page:"design"` 是三栏设计页；`page:"library"` 是卡片墙加详情。两者共用同一套渲染器和同一套节点渲染逻辑，只是外壳不同。

### 7.4 六个组件

| 组件 | 数据来源 | 关键行为 |
|---|---|---|
| 树 | `nodes` | 折叠、键盘上下、点选、右键存库 |
| 画布 | `mock` + `nodes[].rect` | 缩放平移、热区高亮、框选、拖边改 rect |
| 属性 | 选中节点 | 改 rect、锚点、图、九宫格、文本、绑定 |
| 差异 | patch 草稿 | 列出新增/修改/删除，提交前能逐条撤 |
| 范围 | 框选或勾选 | 生成本次改动范围，只影响这些节点 |
| 回复 | patch | 组装 JSON，送出去 |

库页复用树、画布、属性三块，额外多一块「条目卡片」。

### 7.5 两个交互值得单独做

拉伸模拟：拖画布边框改分辨率，按节点锚点重算位置。锚点写成文字没人看得懂，拉一下就知道对不对。这是验证 spec 里 `anchor` 的唯一便宜办法。

像素量尺：图上显示十字线和坐标，拖框出精确 px，回传到原图坐标系。模型目测坐标不准，人拖一次就准。

### 7.6 体积预算

框架 40KB 以内，效果图压到 1600px 宽（约 300KB 到 2MB），缩略图 320px 宽（约 20KB 一张）。库页 30 条约 1MB。超了就压图或改成局部图，不要塞原图。

### 7.7 回复通道

设计页的「回复」按钮发 `postMessage({source:'edrv-htmlplan', type:'respond', text})` 给父窗口，宿主会把它填进输入框发给 agent。这条协议是现成的，不用改插件。

`text` 的内容是「一句人话摘要 + ```json 代码块（patch）」，让人和 agent 都能读。

浏览器直接打开时没有父窗口，退化成复制到剪贴板，粘贴进对话即可。

## 8. 脚本

`build.mjs` 参数：`--spec`、`--out`、`--page design|library`、`--assets`。做的事：读 spec、内联素材、套壳、写单文件、报告体积。

`build.mjs --selftest`：用 `fixtures/selftest/` 生成一页，断言四件事——有 `ui-spec` 块、没有外链脚本和样式、没有 `doc-` 标签、JSON 能解析、体积在限内。全过才算框架可用。

`build.mjs --check`：只校验不生成。检查节点 id 唯一、parent 存在、无环、rect 是数字、素材文件存在、库引用能解析、总字节数。

`verify.mjs --prefab <path> --spec <spec>`：落地后回读预制体，比对锚点、尺寸、位置，输出「设计 vs 实际」差异表。第一版只在有 Editor 通道或预制体是手写 YAML 时可用。

## 9. 安装问卷

规则：分三轮问，每轮 4 到 5 题，一次甩十几题没人愿意答。答不出来的用默认值，并标注「默认，之后能改」。答完把答案写成 config 摘要回显一遍，用户确认后再生成。

第一轮，项目与落地：

| # | 问题 | 可选项 | 默认 |
|---|---|---|---|
| 1 | 项目根目录在哪 | 路径 | 当前会话目录 |
| 2 | 版本库是什么 | git / svn / 其他 / 无 | 无 |
| 3 | Unity 版本 | 版本号 / 不是 Unity 项目 | — |
| 4 | 这些会话能操作 Unity Editor 吗 | 有 MCP / 只能改文件 | 只能改文件 |
| 5 | 预制体由谁生成 | agent 写 YAML / 生成 Editor 脚本你跑 / 只出规格手工搭 | 生成 Editor 脚本 |

第二轮，UI 与素材：

| # | 问题 | 可选项 | 默认 |
|---|---|---|---|
| 6 | UI 体系 | uGUI / FairyGUI / 自研 | uGUI |
| 7 | 参考分辨率与适配 | 如 1920×1080，按高或按宽 | 1920×1080，按高 |
| 8 | 通用控件目录与命名 | 路径 + 规则 | `Assets/UI/Common` |
| 9 | 界面与代码怎么绑定 | 组件名 / 完整路径 / Lua 表 | 组件名 |
| 10 | 美术图在哪 | 项目内目录 / 美术盘路径 | 项目内 |
| 11 | 图是单图、图集还是九宫格 | 三者可多选 | 九宫格 |
| 12 | 效果图规格 | 几倍图、有没有分层源文件 | 1 倍合成图 |

第三轮，协作与库：

| # | 问题 | 可选项 | 默认 |
|---|---|---|---|
| 13 | 看这页面的只有你，还是美术策划也看 | 只有我 / 多人 | 只有我 |
| 14 | 库放哪 | 项目内 / 共享目录路径 | 项目内 |
| 15 | 谁能改库 | 只有我 / 团队随意 / 改动要评审 | 只有我 |
| 16 | 引用库条目锁版本吗 | 锁 / 跟最新 | 锁 |

第 4 题决定落地路径，第 5 题决定是否要写 Editor 脚本，第 6、9 题决定设计页用什么说法，第 14 到 16 题决定库怎么写。

## 10. 一次设计的流程

1. 收素材：把效果图拷进 `plans/ui/<slug>/assets/`，记下原图尺寸；图太大就压到 1600px 宽。
2. 建 spec：agent 按视觉给初版节点树和 rect，图片放 `mock`。
3. 生成设计页：`node build.mjs --spec spec.json --out plan.html`，在计划签里打开。
4. 人对账：拖 rect、拉画布验证锚点、右键把节点存成库条目、框选本次范围。
5. 回传 patch：页面输出 JSON，agent 改 spec 和库，重新生成页面。
6. 落地：按 config 决定写 YAML、出 Editor 脚本还是只留规格。
7. 对账：能回读就出差异表，贴回下一页；不能回读就人工核一遍关键数值。

## 11. 跨项目共享库

解析顺序：项目库优先，其次共享库；同 id 两级都有时，项目级覆盖共享级，库页显示两个来源的徽标。

写入默认落到项目库。存到共享库要在提取面板里勾一下，避免把一屏专用结构污染成公共资产。

条目自包含：素材拷进条目自己的 `assets/`，不引用外部路径。这是跨项目能搬动的前提。

版本锁定：spec 里记 `lib:<id>@<版本>`。共享库升级后，老项目的 spec 仍然解析到老版本；老版本被删掉时给出警告，让你选升级还是保留副本。

去重：同 id 或者结构哈希相同，提示更新已有条目，不新建。

校验：`validate` 扫全部条目，素材缺失、树结构和缩略图对不上，标成待复核。agent 引用前先跳过待复核条目，库页显示 ⚠️。

## 12. 分阶段

| 阶段 | 交付 | 验收 |
|---|---|---|
| M1 | 母版骨架、问卷、config、build.mjs、自检页 | 自检通过，页面在计划签和浏览器都能开 |
| M2 | 设计页三栏联动、缩放平移、热区 | 20 节点样例：点树高亮图，点图选中树，改数值能回写 |
| M3 | 右键存库、参数化面板、库写入 | 提取一个条目，重新生成页面后能引用它 |
| M4 | 库页（卡片 + 详情 + 校验标记） | 30 条条目页面小于 2MB，待复核能显示 |
| M5 | 跨项目库（多根解析、优先级、版本锁） | 两个项目共享同一库，互不干扰 |
| M6 | 落地与对账（虚拟展开、预制体回读差异表） | 一屏 spec 落地后差异表为空 |

## 13. 风险

生成物要能升级。config 记 runtime 版本，母版提供 upgrade，只覆盖 runtime，不动 config 和库。否则改一次框架，所有项目重装一遍。

页面会膨胀。框架超 40KB 或组件超 8 个就该拆；库页超 2MB 就该分页或按需生成。

库会烂。条目没人用、结构变了、素材没了，都会悄悄失效。`used` 字段和 `validate` 是唯一防线。

问卷会问错。每题都要能把「答不出来」变成默认值，别让用户卡在第 8 题上。

虚拟结构和真实预制体会打架。一个真实列表的 content 已经固定，再往里塞虚拟条目就冲突。约束要在 `requires` 里写清楚，页面插入前先校验。

## 14. 待定

- 设计页要不要英文版（取决于项目是不是有外籍同事）。
- 安全区模拟要不要做（刘海屏、挖孔屏）。
- 库条目要不要缩略图外的「使用示例」截图。
- Editor 脚本生成预制体，是每次生成一个临时脚本，还是往项目里放一个通用的 builder。
- 页面里能不能直接编辑文本内容（现在只能改属性，文本要回 agent 改）。

## 15. 新会话怎么开工

把这份文档的路径交给新会话，先说清楚三件事：要开发的是母版技能不是插件、先只做 M1、开工前让用户答完第 9 节的问卷。

M1 验收过了再往下做，别一次把六个阶段全排进去。

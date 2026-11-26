# dsh-vscode-mode v0.41.0 — 插件自带技能：UI 预制体搭建（dsh-vscodemode-ui-kit）

日期：2026-11-26　基线：与 0.40.0 相同
上一版：v0.40.0

## 背景

一屏界面的拼装现在靠人肉量坐标：效果图在聊天里，坐标在预制体里，中间没有可回传的产物。
新技能把这段流程落成三段——项目探测、可拖的设计页、patch 回传——agent 只改 spec，不重做页面。

## 形态

```
skills/dsh-vscodemode-ui-kit/     ← 第四项插件自带技能，装插件即用
  SKILL.md            三个入口（安装 / 设计 / 库）、六条硬约束、设计七步、升级口径
  references/         项目探测清单、16 题安装问卷与字段映射、spec/patch/库条目契约、库规则、落地对账
  runtime/            build.mjs（素材内联单文件页、--check、--selftest）+ 设计页框架（css + 8 个 js）
  fixtures/selftest/  自检假 spec

spec.json + 效果图 ──build──▶ plan.html（单文件，可进计划签）
       ▲                          │ 拖 rect / 改文字 / 存库条目
       └──── patch（set / add / del / use / extract / scope）────┘
```

## 设计页

- 三栏：树 / 画布 / 属性。滚轮缩放、空白拖动平移、八向拖边改 rect、方向键微调（Shift ×10）。
- 属性面板可改类型、绑定、rect、锚点（九宫格）、文本（内容 / 字号 / 颜色）、预制体路径与 `opaque`。
- 交互记成 ops，抽屉里逐条可见可撤；提交输出 patch，带 `base` hash（对不上就停下让你重开页面，不盲改）。
- 页面不落盘：只改内存副本；同一份 spec 渲染同一份字节（FNV-1a，8 位十六进制）。

## 为什么放在插件里

- 设计页要进计划签：沙箱 iframe 不给 same-origin，CSS / JS / 素材全部内联，并带 `<style data-htmlplan>` 与 `<script data-htmlplan>` 两个标记过打包检查；自定义标签统一 `ui-` 前缀（`doc-*` 会被打包器直接判错）。
- 技能组只认 `dsh-vscodemode-` 前缀，名字带前缀才能被插件 provider 装载，也才随包发布。

## 同时修正

- README §12「插件自带技能组」原来写「当前收录两个技能」（实际已有三个），改为四个并补齐清单（mcp / html-plan / test-check / ui-kit）。
- README 安装示例的版本号同步到 0.41.0。
- `.gitignore` 忽略 `--selftest` 生成的单文件页，避免 53 KB 产物入库。

## 验收

1. `node skills/dsh-vscodemode-ui-kit/runtime/build.mjs --selftest` → 12 项断言全绿：无外链脚本/样式、无 `doc-` 标签、带计划签标记、页面 hash 可复算、53 KB 在 2 MB 限内。
2. `--check` 校验示例 spec 通过；同一份 spec 连续 build 两次 hash 不变（`bd0567a0`）。
3. Chrome 打开生成的页面：点树选中联动属性、拖节点产出 `set rect`、改文字产出 `set text.s`、存成库条目产出 `extract`、抽屉里 patch 带 `base` 与 ops、撤销逐条生效。
4. 技能目录出现 `dsh-vscodemode-ui-kit`（provider 装载成功）。

## 已测与缺口

- 本地：`npm run typecheck` 0 error（6.1s）；`npx vitest run` 366 文件通过 + 2 跳过（4539 通过 / 22 跳过，29.58s）；`node --test` 9/9；`npm run build` 通过，`index.js` 1,604,385 B、`client.js` 1,366,671 B。
- 缺口：库里没有条目（`lib/entries/` 为空），`lib:<id>@<版本>` 目前只有占位语义；M3（库页与提取落盘）、M5（跨项目库）、M6（预制体落地与回读对账）未实现。
- 缺口：设计页只在浏览器里验过，未在 DSH 计划签内实际打开（打包检查的两个标记已由自检覆盖）。

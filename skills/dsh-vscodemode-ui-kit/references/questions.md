# 安装问卷

三轮，每轮 4~5 题。探测能答的直接带默认值，答不出来的用默认值并标「默认，之后能改」。答完整理成 config 摘要回显，用户确认后才写文件。

## 第一轮 · 项目与落地

| # | 问题 | 可选项 | 默认 | 映射 |
|---|---|---|---|---|
| 1 | 项目根目录在哪 | 路径 | 探测值（最近 `.git` 祖先，否则会话目录） | `project.root` |
| 2 | 版本库是什么 | git / svn / 其他 / 无 | 探测：有 `.svn` 则 svn | `project.vcs` |
| 3 | Unity 版本 | 版本号 / 不是 Unity 项目 | 探测 `ProjectVersion.txt` | `project.unity` |
| 4 | 这些会话能操作 Unity Editor 吗 | 有 MCP / 只能改文件 | 只能改文件 | `editor.mcp` |
| 5 | 预制体由谁生成 | agent 写 YAML / 生成 Editor 脚本你跑 / 只出规格手工搭 | 生成 Editor 脚本 | `editor.way` |

## 第二轮 · UI 与素材

| # | 问题 | 可选项 | 默认 | 映射 |
|---|---|---|---|---|
| 6 | UI 体系 | uGUI / FairyGUI / 自研 | 探测 | `ui.system` |
| 7 | 参考分辨率与适配 | 如 1080×1920，按高或按宽 | 探测 CanvasScaler | `ui.refResolution`、`ui.matchMode` |
| 8 | 通用控件目录与命名 | 路径 + 规则 | `Assets/UI/Common` | `ui.commonDir` |
| 9 | 界面与代码怎么绑定 | 组件名 / 完整路径 / Lua 表 | 组件名 | `ui.bindStyle` |
| 10 | 美术图在哪 | 项目内目录 / 美术盘路径 | 探测 | `assets.inProject`、`assets.artRoot` |
| 11 | 图是单图、图集还是九宫格 | 可多选 | 九宫格 | `assets.sliced`、`assets.atlas` |
| 12 | 效果图规格 | 几倍图 / 有没有分层源文件 | 1 倍合成图 | `assets.mockScale` |

## 第三轮 · 协作与库

| # | 问题 | 可选项 | 默认 | 映射 |
|---|---|---|---|---|
| 13 | 看这页面的只有你，还是美术策划也看 | 只有我 / 多人 | 只有我 | `pages.audience` |
| 14 | 库放哪 | 项目内 / 共享目录路径 | 项目内 | `lib.roots` |
| 15 | 谁能改库 | 只有我 / 团队随意 / 改动要评审 | 只有我 | `lib.writePolicy` |
| 16 | 引用库条目锁版本吗 | 锁 / 跟最新 | 锁 | `lib.pinVersion` |

## 题目到 config 的完整映射

```json
{
  "v": 1, "runtime": "1.0.0", "installedAt": "YYYY-MM-DD",
  "project": { "root": "<1>", "vcs": "<2>", "unity": "<3>" },
  "ui": { "system": "<6>", "refResolution": [<7W>, <7H>], "matchMode": "<7>",
          "commonDir": "<8>", "bindStyle": "<9>" },
  "assets": { "artRoot": "<10>", "inProject": "<10>", "sliced": <11>, "atlas": <11>, "mockScale": <12> },
  "editor": { "mcp": <4>, "way": "<5>" },
  "pages": { "dir": "plans/ui", "audience": "<13>" },
  "lib": { "roots": ["<14>"], "writePolicy": "<15>", "pinVersion": <16> }
}
```

## 三个决定性的题

- 第 1 题错了 = 技能装到没人看的地方，安装第一步必须回显。
- 第 7 题错了 = 画布方向反了，整屏 rect 全废；竖屏项目特别容易抄成横屏默认值。
- 第 5 题错了 = 落地路径不存在，后面每一步都在等一个不会出现的预制体。

## 回显格式

```
项目根：<root>（来源：.git）
技能目录：<root>/.dsh/skills/ui-builder/    库：<root>/.dsh/ui-kit/lib/
UI：uGUI · 1080×1920 · 按宽 · 通用控件 <commonDir> · 绑定 <bindStyle>
素材：<inProject>（<artRoot>）· 九宫格
落地：editor-script（生成脚本你跑）        库：项目内 · 锁版本
默认项：通用控件目录、图是九宫格
```

回显后问一句「按这个装？有要改的直接说」，得到确认再落盘。

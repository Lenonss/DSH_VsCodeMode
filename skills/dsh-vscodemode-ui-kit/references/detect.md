# 项目探测

安装第一步只做探测，不写文件。每条都记下「从哪读到的」，回显时一起给。

## 1 项目根（最容易错）

```bash
git -C <会话目录> rev-parse --show-toplevel   # 有 .git 时用这个
```

- 有 `.git`：项目根 = 该命令输出。
- 没有 `.git`：项目根 = 会话当前目录，**并在回显里明确写「未找到 .git，按会话目录处理」**。
- 工作副本常同时有 `.git` 与 `.svn`（DSH 工程习惯），此时仍按 `.git` 祖先。

回显示例：

```
项目根：D:/Work/PopIsland/IslandSplash_ZDev2（来源：.git）
技能会落到：D:/Work/PopIsland/IslandSplash_ZDev2/.dsh/skills/ui-builder/
```

## 2 Unity 版本

```bash
cat ProjectSettings/ProjectVersion.txt      # m_EditorVersion: 2022.3.62f2
```

不是 Unity 工程时 `ui.system` 改成 `other`，并在 config 里记 `ui.note`。

## 3 参考分辨率与适配（别抄默认值）

在第一个 Canvas 上读 CanvasScaler：

```bash
grep -n "m_ReferenceResolution\|m_MatchWidthOrHeight\|m_ScreenMatchMode" Assets/Scenes/*.unity | head -20
```

- `m_ReferenceResolution: {x: W, y: H}` → `ui.refResolution`
- 宽 < 高 = 竖屏，宽 > 高 = 横屏；这两个值决定设计页的默认画布尺寸，抄错方向所有 rect 全废。
- `m_MatchWidthOrHeight: 0` + `m_ScreenMatchMode: 0` → 按宽（`matchMode: "width"`）；`1` → 按高。

## 4 UI 体系

| 现象 | `ui.system` |
|---|---|
| `Assets/**` 里有 Canvas / RectTransform / `.prefab` 里 `m_AnchoredPosition` | `ugui` |
| `Assets/**/FairyGUI` 或 `.fui` 包 | `fairygui` |
| 自己画的渲染层 | `custom` |

## 5 通用控件目录

```bash
ls -d Assets/*/Common Assets/*/*/Common 2>/dev/null
find Assets -type d -name "*Common*" -maxdepth 4 | head -20
```

取用户确认的那个；没有就以 `Assets/UI/Common` 作为**默认值**并标注「之后能改」。

## 6 界面与代码绑定风格

看 Lua/C# 侧怎么取节点：

| 证据 | `bindStyle` |
|---|---|
| Lua `Comps` / 生成文件按节点名取值 | `componentName` |
| 代码里写完整路径字符串 `"Root/Title"` | `fullPath` |
| 有一个名字→节点 的表 | `table` |

## 7 素材位置

```bash
ls -d Assets/PsdFolder Assets/Art Assets/UI 2>/dev/null
```

- 项目内：记 `assets.inProject`
- 美术盘：记 `assets.artRoot`（如 `Z:/Art/UI`），并在回显里确认盘符可访问
- 是否切图/九宫格：看 `.png.meta` 的 `spriteBorder`，或直接问（第 11 题）

## 8 Editor 通道

```bash
# 会话里有没有 Unity MCP：看工具列表里是否有 unityMCP；有且能连 = true
```

- 有 MCP：`editor.way = "mcp"`，能回读预制体。
- 只有文件：`editor.way = "editor-script"`（默认）或 `"spec-only"`。

## 9 汇总

把探测结果直接映射成 `config.json` 草稿（见 `questions.md` 的映射表），回显给用户确认，再落盘。

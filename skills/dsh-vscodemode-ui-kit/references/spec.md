# 数据契约：spec / patch / 库条目

## 1 spec（一屏设计）

```json
{
  "v": 1,
  "page": "design",
  "hash": "a3f1c2de",
  "screen": { "name": "邮件弹窗", "w": 1080, "h": 1920 },
  "mock": { "src": "assets/mock.jpg", "w": 1080, "h": 1920, "scale": 1.0 },
  "nodes": [
    { "id": "Popup/Root", "parent": null, "kind": "group", "rect": [470, 640, 140, 640],
      "anchor": { "min": [0.5, 0.5], "max": [0.5, 0.5], "pivot": [0.5, 0.5] } },
    { "id": "Popup/Root/Title", "parent": "Popup/Root", "kind": "text", "rect": [12, 20, 116, 44],
      "text": { "s": "邮件", "size": 32, "color": "#4a3b2a" }, "bind": "UI.Mail.Title" },
    { "id": "Popup/Root/List", "parent": "Popup/Root", "kind": "list", "rect": [10, 80, 120, 420],
      "ref": "lib:list-cell-basic@1", "params": { "count": 5, "gap": 12 } },
    { "id": "Popup/Root/Close", "parent": "Popup/Root", "kind": "prefab", "rect": [104, 12, 32, 32],
      "prefab": "Assets/UI/Common/CloseBtn.prefab", "opaque": true }
  ]
}
```

### 字段规则

| 字段 | 规则 |
|---|---|
| `id` | 语义路径，不用数组下标；全局唯一；空格换成 `_` |
| `parent` | `null` 或另一个已存在的 `id`；禁止成环 |
| `kind` | `group` / `text` / `image` / `sprite` / `button` / `list` / `prefab` |
| `rect` | `[x, y, w, h]`，原图坐标系的**相对父节点**像素；`w`/`h` > 0 |
| `anchor` | `min`/`max`/`pivot` 各两个 0~1 的数；省略时默认满铺父节点 |
| `text` | 只有 `kind:"text"` 有；`s` 原文，`size` 像素，`color` `#rrggbb` |
| `bind` | 可选，Lua/C# 侧的绑定名，风格由 `config.ui.bindStyle` 决定 |
| `ref` | `lib:<id>` 或 `lib:<id>@<版本>`；指向库条目，构建时展开 |
| `params` | `list` 的 `count`/`gap` 等参数，只影响示意，不影响结构 |
| `prefab` + `opaque` | 真实预制体节点；`opaque:true` 时内部结构未知，**禁止在内部插虚拟结构** |

### hash

`hash` = spec 去掉 `hash` 字段后的规范化 JSON（键排序、无空白）的 FNV-1a 32 位，8 位小写十六进制。`build.mjs` 与页面用同一算法，patch 的 `base` 与之相等才允许改。

## 2 patch（页面回传）

```json
{
  "v": 1, "page": "design", "base": "a3f1c2de",
  "ops": [
    { "op": "set",     "id": "Popup/Root/Title", "field": "rect", "value": [560, 270, 300, 48] },
    { "op": "set",     "id": "Popup/Root/Title", "field": "text.s", "value": "邮件中心" },
    { "op": "add",     "parent": "Popup/Root", "node": { "id": "Popup/Root/Desc", "kind": "text", "rect": [0,0,100,30] } },
    { "op": "del",     "id": "Popup/Root/Old" },
    { "op": "use",     "node": "Popup/Root/List", "lib": "list-cell-basic", "version": 1 },
    { "op": "extract", "node": "Popup/Root/List/Cell",
      "meta": { "name": "基础列表条目", "desc": "", "whenNot": "", "slots": ["icon","title"], "keep": ["bg"] } },
    { "op": "scope",   "ids": ["Popup/Root/List"] },
    { "op": "ask",     "id": "q1", "answer": "列表用现有 UIScrollList" }
  ],
  "note": "标题下移 8px，列表换成库里的条目"
}
```

| op | 含义 | agent 的动作 |
|---|---|---|
| `set` | 改字段，`field` 支持点路径（`text.s`、`anchor.min.0`） | 改 spec 对应字段 |
| `add` | 挂一个新节点到 `parent` | 追加节点，补齐默认 anchor |
| `del` | 删节点 | 连同所有子节点一起删 |
| `use` | 节点改用库条目 | 写 `ref`，删手写子节点 |
| `extract` | 把节点子树提成库条目 | 写 `lib/entries/<id>/`，节点改成 `ref` |
| `scope` | 本次改动范围 | 只对这个子树做下一步，避免整屏重排 |
| `ask` | 页面里的问答回答 | 按文本处理，不改结构 |

### 处理顺序（必须）

1. 读 spec，算 hash，和 `base` 比：不一致就**停下**，让用户重开页面，不要盲改。
2. 按 ops 顺序应用（`extract` 先落库再改引用）。
3. 重新 build 出页，把新 `hash` 和改动摘要贴回去。

## 3 库条目

```json
{
  "id": "list-cell-basic", "name": "基础列表条目", "kind": "list-cell",
  "source": "virtual", "version": 1,
  "desc": "左侧方形图标，中间标题，右侧数量。选中时换底图。",
  "when": "列表里的一行，宽度撑满容器",
  "whenNot": "需要多列排布或带操作按钮时别用",
  "tags": ["列表", "条目", "图标"],
  "tree": { "id": "Cell", "rect": [0, 0, 720, 96], "children": [] },
  "slots": [{ "id": "icon", "kind": "sprite", "note": "方形图标，64×64" }, { "id": "title", "kind": "text" }],
  "assets": { "bg": "assets/cell-bg.png", "bgSel": "assets/cell-bg-sel.png" },
  "requires": { "parentKind": "list", "minW": 600 },
  "origin": { "by": "user", "at": "2026-11-26", "from": "邮件弹窗" },
  "used": 0, "thumb": "thumb.png"
}
```

`desc`、`when`、`whenNot`、`tags` 是检索依据，不是装饰。缺 `whenNot`，下次会在不该用的地方硬套。

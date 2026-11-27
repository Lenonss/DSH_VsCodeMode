# 材料页、草稿与本机服务

材料页只负责收集“做这屏界面需要的东西”，正式设计页在收到清单后生成。两者约束不同：材料页可以访问带令牌的本机服务、可以保存草稿；设计页仍然单文件自包含。

## 两种入口

| 入口 | 适用 | 保存/投递 | 草稿 |
|---|---|---|---|
| `ui_builder_intake` 宿主工具 | DSH 内、不需要草稿恢复 | 宿主 RPC 保存，客户端把清单发到当前会话 | 无 |
| `intake.mjs --serve` 本机服务 | 普通浏览器、受限 iframe、需要草稿/重开 | 页面直接 `fetch` 本机服务；有 DSH 宿主时再通知宿主发送 | 有 |

本机服务入口：

```bash
node .dsh/skills/ui-builder/runtime/intake.mjs --serve --slug <slug> --title <名字>
node .dsh/skills/ui-builder/runtime/intake.mjs --resume --slug <slug>
node .dsh/skills/ui-builder/runtime/intake.mjs --stop --slug <slug>
node .dsh/skills/ui-builder/runtime/intake.mjs --status --slug <slug>
```

`--serve` 输出 `UI_INTAKE_URL`、`UI_INTAKE_PAGE`、`UI_INTAKE_TASK`、`UI_INTAKE_STATE`。服务只监听 `127.0.0.1`，随机令牌放在 URL 路径里；关闭服务不会删草稿或提交。

## 页面字段

- 界面名称（必填，1~120 字）
- 设计宽度/高度（100~10000 的整数；默认来自 `config.json`）
- 设计说明、目标 Prefab 路径（本阶段只记录，不搭建）
- 效果图路径（只记录路径，不读外部文件）
- 素材目录、Sprite 名称
- 效果图：选择或拖入、预览、移除，最多 1 张
- 素材图：多选/多次拖入、预览、移除，最多 50 张、单张 8 MB、合计 32 MB
- 仅接受 PNG/JPEG/WebP/GIF，单图最多 4000 万像素、边长最多 10000

文件名只作为数据清洗：保留原名给清单，落盘名去掉路径和控制字符；任何文件名、路径或文本都不作为命令执行。

## 提交与状态

- 提交按钮必须是 `type="button"`，直接调用保存函数；不要用原生表单导航，也不要依赖 `requestSubmit()`。这样 `sandbox="allow-scripts"`、没有 `allow-forms` 的 iframe 也能提交。
- 先校验名称和尺寸，再等待草稿（尤其图片）保存完成；草稿没落盘不能进入正式提交。
- 页面分别显示：
  - 材料：未保存 / 保存中 / 已保存 / 保存失败
  - 草稿：文字保存中 / 图片保存中 / 已保存，可以离开 / 失败待重试
  - 对话：连接中 / 未连接 / 正在发送 / 已确认收到 / 未确认
- 正式提交成功只代表“材料已保存到项目”。有宿主时再发 `saved` 通知，收到宿主 `accepted` 才能显示“对话已确认收到”；没有宿主或发送失败时显示可复制的继续指令。
- 保存失败或超时：显示具体原因，保留表单和已选图片，按钮恢复可重试；同一 `submissionId` 重试由服务幂等复用，编辑内容后才换新编号。
- 不允许用 HTTP 200、脚本语法通过或“页面看起来正常”代替按钮可用的证据。

## 草稿

草稿固定写在：

```
plans/ui/<slug>/intake/draft/draft.json
plans/ui/<slug>/intake/draft/assets/<hash>.png|jpg|webp|gif
```

`draft.json` 的核心字段：

```json
{
  "v": 1,
  "projectRoot": "D:/Project",
  "slug": "gift-popup",
  "pagePath": "plans/ui/gift-popup/intake/materials.html",
  "textRevision": 12,
  "assetRevision": 4,
  "fields": { "title": "…", "width": "1080", "height": "2400", "notes": "…", "targetPrefab": "…", "mockPath": "…", "assetPaths": "…", "sprites": "…" },
  "assets": [
    { "role": "mock", "originalName": "效果图 中文.png", "file": "ab12…-0.png", "mediaType": "image/png", "width": 360, "height": 640, "bytes": 3664, "sha256": "…" }
  ],
  "submitted": { "ok": true, "text": "/ui-builder 继续设计…", "manifestPath": "plans/ui/gift-popup/intake/submissions/…/request.json" }
}
```

规则：

1. 文字变化只递增 `textRevision`，不重复上传图片；图片变化递增 `assetRevision`，保存时提交当前完整图片快照。
2. 服务分别比较两个版本；旧文字请求不能覆盖新文字，旧图片快照不能覆盖新图片；被旧请求拒绝时返回当前草稿，页面不改本地内容。
3. 文字或图片任何一项变化都清除 `submitted`，页面同时隐藏旧清单；旧提交结果不能继续显示。
4. 移除图片时保存新的完整快照；重新打开只恢复当前 `assets` 列表，已移除的图片不会复活。
5. 草稿读取失败时表单保持不可用、提交禁用，显示“重试读取草稿”；禁止用空白内容覆盖原 `draft.json`。
6. 图片保存完成前不能提示“可以离开”；只有完整图片快照落盘后才显示可以离开，`beforeunload` 在有未保存/保存中内容时拦截。
7. 恢复时用服务返回的原始字节重新构造 `File`，写回文件选择、预览和提交结果；不依赖 `localStorage`。

## 正式提交

`POST /t/<token>/submit` 只接受当前草稿的字段和版本，复制草稿图片到：

```
plans/ui/<slug>/intake/submissions/<submissionId>/request.json
plans/ui/<slug>/intake/submissions/<submissionId>/original/<原始文件名>
```

清单是 v2：`v`、`kind`、`schema`、`projectRoot`、`pagesDir`、`slug`、`submissionId`、`createdAt`、`page`、`title`、`screen`、`notes`、`targetPrefab`、`mockPath`、`assetPaths`、`sprites`、`project`、`assets`、`message`。`assets[]` 同时带 `originalName`、`savedName`、`relativePath`、`absolutePath`、`mediaType`、`width`、`height`、`bytes`、`sha256`。

- 同一 `submissionId` 重复提交返回已有清单，不新建目录。
- `intake/submissions/` 只增不改；用户原图与历史清单不能被草稿、升级或重新提交删除。
- 服务不覆盖 `plan.html`；新 slug 发现已有正式设计稿时拒绝，恢复材料页也绝不写设计稿。

## 本机服务

- 只监听 `127.0.0.1`；所有业务路由形如 `/t/<token>/draft`、`/asset/<file>`、`/submit`，令牌错误返回 403。
- CORS 允许 `*`、`POST` 和 `Content-Type`，并带 `Access-Control-Allow-Private-Network: true`；不使用浏览器登录凭据。
- 请求体上限 32 MB；每个文件 8 MB；字段长度有限制；只允许 `mock` / `materials` 附件字段。
- 端口默认随机；`--resume` 优先复用原端口和令牌，端口被占用时换随机端口并更新页面，草稿仍保留。
- 状态写在 `plans/ui/<slug>/intake/service.json`：`taskId`、`pid`、`port`、`token`、`url`、`pagePath`、`startedAt`、`status`。`--stop` 只调用该端口/令牌的关闭接口，不按进程名杀进程。
- 收集结束由 Agent 执行 `--stop`；不要删除草稿或 submissions。

## 容器差异

| 容器 | 能做什么 | 不能做什么 |
|---|---|---|
| 普通浏览器打开 `UI_INTAKE_URL` | 完整草稿、预览、提交；HTTP 保存后复制指令 | 无 DSH 对话时不能自动投递 |
| DSH 官方 HTML 预览（文件页） | 页面可 `fetch` 本机服务；若宿主桥在，提交后自动发到当前会话 | 没有宿主桥时仍需复制指令 |
| 计划页 iframe（`sandbox="allow-scripts"`，无 same-origin） | 本机服务页可保存、提交；不能读父页 DOM、不能依赖同源 | 不能把 `localStorage` 当唯一存储 |
| 外部浏览器 | 与普通浏览器相同 | 不能用项目内相对路径读文件 |

## 收到清单后

1. 先读 `request.json`，核对 `projectRoot` 是当前项目、`slug` 与设计目录一致。
2. 用 `read_image` 逐张读 `assets[].absolutePath`（或 `relativePath`）实际看内容；不要只凭文件名猜。
3. 按 `references/spec.md` 建 `spec.json`，沿用同一 slug 生成 `plans/ui/<slug>/plan.html`。
4. 本阶段不搭建 Unity 预制体，不修改项目已有资源。
5. 需要用户调整时，走“改 spec → 重新 build”的原流程。

## 回归

```bash
node .dsh/skills/ui-builder/runtime/intake.mjs --selftest
node .dsh/skills/ui-builder/runtime/intake.mjs --selftest-http
```

HTTP 自检覆盖：空草稿、图片原始字节、文字/图片乱序、正式清单原名与字节、同一提交编号幂等、错误令牌、无效尺寸、服务停止。浏览器/iframe 验收另见 `references/verify.md`；不能用 `--selftest-http` 代替按钮点击证据。

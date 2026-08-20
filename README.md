# @dsh-external/dsh-edit-review

仿 VSCode 的 **Agent 文件编辑器 + 差异审查**插件：

- **中央「文件编辑」页签**（`conversation.view`，会话中间顶部，VSCode 式）：点击后中间区域变成
  VSCode 风格编辑区——**顶部只有文件页签 + 搜索框**（页签带脏点/关闭/「+」输入路径打开任意工作区文件，
  localStorage v2 记忆；`Ctrl+P` 快速打开搜索框）。编辑器本体 = **Monaco Editor**（语法高亮/行号/minimap/
  `Ctrl+F` 查找/`Ctrl+G` 跳行/`Ctrl+S` 保存/700ms 防抖自动保存），底部状态栏（路径/语言/Ln,Col/保存状态）。
- **差异 UI 收敛为圆角悬浮框**（交修要求）：
  - **DiffBox**：每个已打开且有差异的文件**底部**挂一个圆角矩形悬浮框——per-file hunk 列表
    （L 范围 + `-n/+n` + 采纳/不采纳 + 点击跳转）+ 全部采纳/全部不采纳 + 回滚 + 可选「◈ 对比」
    （Monaco DiffEditor 全文件对比，`edrv.original` 重建"修改前"内容）+ 「其他差异文件」小节
    （点击手动打开并跳到差异）。
  - **DiffLauncher**：全局差异总览（所有待处理差异文件，点击打开并跳转）+ 归档浏览/批次回滚，
    圆角下拉，由状态栏「⚠ 差异 N 文件」chip 或 header 角标触发。
  - **仅在当前工作区存在差异时显示**：header 差异角标（`conversation.session.header.utilities`，id
    `edrv-diff-badge`）与状态栏差异 chip 都以 `edrv.list` 非空为前提，全部处理完后自动隐藏；无差异时
    编辑器是纯净的文件编辑器（只留页签+搜索框）。
  - **不再自动打开全部差异文件**：差异文件仅在用户手动操作（搜索框、DiffBox「其他差异文件」、
    Launcher、header 角标）时作为页签打开并定位；`edrv:refresh` 从不自动补页签。

## 源码结构 / 构建（本机无 DSH checkout）

```
src/index.ts         Host 半（ESM 命名导出 name/inject/apply）
src/client/index.ts  Client 半（TS 源）
lib/index.js         Host 产物（tsc 编译）
lib/client.js        Client 产物（tsdown 打包）
assets/vendor/monaco Monaco Editor AMD 构建（随包分发，离线可用，/edrv/vendor/* 提供）
```

本机桌面版无 DSH 源码 checkout，构建走两条本地命令：

```bash
# Host：tsc（typescript + @types/node 装在 .tmp-build/，typeRoots 指向它）
node .tmp-build/node_modules/typescript/lib/tsc.js -p tsconfig.json --typeRoots ".../.tmp-build/node_modules/@types"

# Client：tsdown（D:\temp\edrv-build 内的 tsdown 运行时）
node D:\temp\edrv-build\node_modules\tsdown\dist\run.mjs
```

Client 半保存即生效：`dsh-client-hmr` 轮询 lib/client.js，浏览器自动重载模块（无需刷新页面）。
**Host 半（src/index.ts → lib/index.js）改动需重启 DSH 应用**（Node ESM 模块缓存）。

## 安装 / 更新 / 卸载

- 安装：`dev_install_package {dir: packages/dsh-edit-review}`（写 profile package.json link 依赖 +
  `dsh.profile.bundles` 条目 + node_modules junction + loader.create 热装配；重启后由 bundles 自动装配）
- 更新代码后：同步 src/lib → `dev_reload_package {packageName: "dsh-edit-review"}`（热重载）
- 卸载：`dev_uninject_plugin {match: "dsh-edit-review"}`

## 架构要点

- **捕获**：Host 监听 `tools/result`，对 `edit`/`write` 取 `result.value`（完整 before/after）+
  `result.meta.diffs`（hunk 级），落记录。
- **持久化**：工作区旁车 `.dsh-edit-review.json`（version 2，按工作区 cwd 分桶，写前合并，
  重启/换会话不丢；v1 自动迁移）。决策/`superseded`（手动编辑覆盖）均持久化。
- **RPC**：静态包无 `harness.handle`，Host 注册 webServer 精确路由 `/edrv/rpc`
  （方法 `edrv.list/accept/reject/read/original/save/archiveList/archiveRead/rollback/searchFiles`），
  Client 同源 `fetch('/edrv/rpc')`。
  `edrv.original` = 重建"本批次修改前"内容（pending 块按新→旧反解，失败回退最早 before），供「◈ 对比」原始侧。
  `edrv.searchFiles` = 快速打开搜索：工作区文件清单（subprocess 扫描，缓存 TTL 60s，排除
  node_modules/.git/dist/build/vendor/.tmp/.cache/coverage 等，上限 6000）按 query 包含匹配
  （basename 命中优先），恒并入活跃差异路径（差异文件保证可搜到），上限 50 条。
- **Monaco 分发**：`assets/vendor/monaco/vs` 为官方 AMD 构建（min 版，nls 仅保留 zh-cn），
  Host 注册前缀路由 `/edrv/vendor/*`（路径穿越防护 + 按扩展名 MIME）。Client 动态注入 loader.js →
  `require.config({paths:{vs:'/edrv/vendor/monaco/vs'}})` → `require(['vs/editor/editor.main'])`，
  全离线可用（worker 经同一路由加载）。
- **图标**：header 差异角标经 `/edrv/assets/compare-idle.png`、`/edrv/assets/compare-select.png` 提供
  （`no-cache`）。默认读插件包内 `assets/`；需要自定义换图时，profile 的 `cordis.patch.yml` 覆盖
  `config.imageDir`。
- **回滚**：edit 单 hunk 用 `callHunk`（old/new 精确串）经 fs.editText 反替换；write/整调用用
  `before` 整文件恢复；新建文件拒绝 = subprocess 删除（路径先经 fs.contains 校验工作区边界）。
- **Client 挂点**：
  - `conversation.view`（id `edrv-editor`，order 5，label「文件编辑」）——**中央编辑区页签**：仅激活视图
    挂载；顶部=文件页签+搜索框，差异 UI=文件底部圆角悬浮框（DiffBox）+ 全局差异下拉（DiffLauncher）。
  - `conversation.session.header.utilities`（id `edrv-diff-badge`，差异角标，仅工作区有差异时显示，
    点击打开编辑区并拉起 DiffLauncher）。
  - 已移除：`conversation.chat.turnTail`（回合内联审查条）与 `details`（右侧整文件差异列）——差异 UI
    统一收敛到编辑区圆角悬浮框（官方内建 details 列回归）。
- **事件**：`edrv:refresh`（差异状态变化，触发角标/DiffBox 重拉）、`edrv:open-editor`（带 path 直达打开
  页签）、`edrv:show-launcher`（打开 DiffLauncher）。编辑区与角标各自 5s 轮询 `edrv.list`（卸载即清）。
- **批次 / 融合 / 归档**：每个文件有批次号（batch），每次新 edit/write 该文件 batch 递增到最新；
  文件被再次修改时（batch 递增），早于最新批次的未归档差异一律"融合"归档（内容已含其效果 / 已被新修改取代），
  审查只关注最新批次。每条差异在操作完成（采纳/拒绝/被覆盖）后**立即单条归档**到工作区旁车
  `.dsh-edit-review-archive.json`（按 path+batch 合并批次，含每 hunk 决策与 before）。
  「归档」页（DiffLauncher 内 tab）按批次浏览（RPC `edrv.archiveList` / `edrv.archiveRead`）。
- **内置回滚**：DiffBox「⟲ 回滚」把当前文件恢复到修改前状态（活跃差异归档）；DiffLauncher「归档」页
  每条目「回滚」把文件恢复到此批次之前；回滚本身也写入归档（reason=已回滚）。
  ⚠️ 批次/归档/回滚逻辑与 RPC 依赖 host 重启生效（Node ESM 模块缓存，进程内无法热换主机模块）。

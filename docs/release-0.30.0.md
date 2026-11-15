# v0.30.0：模板语言高亮、搜索面板全局替换、会话引用接入

## 新增

- **模板语言高亮**：`src/client/monaco/templateLanguages.ts` 向 Monaco 注册 7 个模板语言
  （`ejs`、`erb`、`nunjucks`、`jinja`、`blade`、`haml`、`slim`），每个语言带 Monarch 词法规则与
  language configuration（注释符/括号/自动闭合）。注册时机在 `editor.main` 加载完成、
  任何 `createModel` 之前（`loader.ts` 的 ready 回调），幂等且单语言失败不影响其他语言。
  内置已支持的 handlebars/mustache/pug/twig/liquid/razor/freemarker2 直接映射到 Monaco 原生 id。
- **扩展名与点文件映射**：`langOf` 改为「点文件 → 复合后缀 → 末段扩展名」三级解析。
  `.blade.php` 不再落到 php；`.eslintrc` / `.babelrc` / `.gitconfig` / `.editorconfig` /
  `.env*` 等无扩展名点文件按 JSON/INI/shell 等高亮。
- **映射审计测试**：`tests/langMap.test.ts` 解析随包 Monaco 的语言贡献表，断言
  「每个映射值都真实存在」「自定义 id 不与内置冲突」「覆盖官方映射必须显式登记」，
  防止升级 Monaco 后出现「静默回落 plaintext」。
- **搜索面板全局替换**：`edrv.replaceContent` host 能力 + 搜索面板替换行（chevron 展开）。
  先 `dryRun` 预览命中数，确认后逐文件执行；支持「全部替换」与结果分组里的单文件替换。
  - 语义与搜索严格同口径：大小写 / 全词 / 正则 / 包含 / 排除；
  - 按行替换，保留 CRLF 与 BOM，只改写命中行；
  - 字面量模式 `$` 不被解释，正则模式支持 `$1`；可匹配空串的模式（如 `a*`）直接拒绝；
  - 每个文件按 `stat.version` 做 `replaceIfVersion` 守卫写入，冲突记为该文件失败并继续；
  - 单次上限 200 个文件、单文件 8MB，二进制/非普通文件计入 skipped。
- **会话引用接入**：`src/client/refIntake.ts` + `src/client/refCopy.ts`。
  - 资源管理器把文件行拖进对话输入框 → 引用 chip（内部 `text/x-edrv-path` MIME）；
  - 在编辑器里跨行（或整行单行）复制 → 剪贴板写成 `@相对路径 Lx-Ly`，粘贴回输入框落成 chip；
  - 粘贴系统文件（非图片）到输入框 → 按文件名解析成引用；
  - 三条通道都只在官方 `[data-composer-seat]` 内生效，解析多义时提示而不是瞎猜；
  - 新增 host `edrv.resolveRef`（绝对路径 → 相对路径 → 文件名检索三级解析，多义给候选）。

## 改进

- **替换前落盘桥**：`src/client/editorFlush.ts` 派发 `edrv:flush-all`，`EditorView` 注册
  「提交全部待保存」的 promise；搜索面板在写盘前等待（3s 上限，超时中止替换），
  避免用磁盘旧内容覆盖用户未保存的编辑。
- **交互特性开关**：设置 schema 新增 `refIntake` / `searchReplace`（默认开），
  设置页「通用 → 交互」区提供两个勾选项，值经 `src/client/featurePrefs.ts` 推到客户端模块级缓存；
  关闭后完全回到旧行为（复制恢复普通文本、搜索面板隐藏替换入口）。
- **兼容性报告**新增三条探针：模板语言是否注册、是否探测到 composer 座位、替换是否可用。
- **文档**：新增 [工程坑位清单](pitfalls.md) 与 [真机验收清单](gui-acceptance.md)。

## 实现边界

- 不引入新运行时依赖，不移植第三方源码；模板语言只做词法分色，不提供语义/LSP 能力。
- 替换只处理文本文件，不做跨工作区/目录递归替换，不修改二进制与大文件。
- 引用接入依赖官方 composer 座位选择器；旧版 DSH 或无会话时整体静默不生效（兼容性报告可见）。
- 未改差异审查数据层、SVN 集成、LSP/DAP 链路。

## 验证与已知缺口

- `tsc --noEmit` 0 error。
- 目标用例（7 个文件 112 例）全部通过：`tests/langMap.test.ts`（29）、
  `tests/templateLanguages.test.ts`（8）、`tests/refSyntax.test.ts`（11）、
  `tests/refIntake.test.ts`（7）、`tests/refPointer.test.ts`（9）、
  `tests/replacePlan.test.ts`（19）、`tests/content-search.test.ts`（29）；
  另跑 `addToConversation`（85）、`compatSummary`（26）、`client-compat`（28）、
  `clientArtifacts`（12+2 跳过）、`overlayScope`/`overlayZOrder` 相关回归。
- `pnpm build` + `node scripts/check-client-artifacts.mjs lib` 通过。
- **真机 GUI 已按 [gui-acceptance.md](gui-acceptance.md) 走过一轮**（Web 端，2026-11-15）：
  模板语言 7 个 id 与真分色、`.blade.php`/`.njk`/`.haml`/`.eslintrc` 映射、跨行/整行/半行复制、
  拖入与粘贴成引用 chip、替换的预览/确认/取消/单文件/正则分组/字面量 `$`/空匹配拒绝/CRLF 保真/
  脏页签落盘、两个设置开关的双向效果，均通过。
- **验收中发现并已修复两个缺陷**（同版本内）：
  1. **BOM 被吞**：读文本通道会剥掉 UTF-8 BOM，替换后文件从带 BOM 变为无 BOM；
     改为按原始字节判定并在写回时补回（`isBom` + `replaceRun` 写回前补前缀）。
  2. **同名多义静默选最近**：粘贴 `index.ts` 会被悄悄插成 `src/index.ts`；
     改为「只有唯一候选、或活动文件目录下恰好一个同名候选才自动插入，否则提示多义不插」
     （`ambiguityOf`，见 `tests/refPointer.test.ts`）。
- 未覆盖/待补：真实鼠标拖拽手势（验收用同 payload 的合成事件走完整链路）、
  多实例（侧栏 + 浮窗）重复粘贴、图片附件放行（逻辑由单测覆盖）、
  替换「读→写」窗口内的并发改文件冲突（版本守卫只在窗口内生效，未构造确定性并发）。
- 发布不自动部署：升级后重启 DSH 并刷新页面，Host 侧新 RPC 才会生效。

## 同期并入

- **Univer Office 联动**随本版一并进入包内（`src/client/univer/*`、`src/shared/univer.ts`、
  `src/univerBridge.ts`、`src/univerCache.ts`、`src/univerRpc.ts` 及其 5 个测试，另带
  `officialSidebar` / `openPathRouter` / `sidebar/menuItems` / `DiffLauncher` / `paths` 的联动改动）。
  该部分由并行工作产出，本次发布只做了全量测试与构建验证，**未做本会话的真机 GUI 验收**；
  使用前请以编辑器/文件树里的 Univer 入口实际表现为准，问题单独反馈。

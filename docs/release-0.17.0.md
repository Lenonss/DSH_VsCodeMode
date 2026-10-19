# Release 0.17.0 — DSH 0.2.1 吸收与运行期优化

> 日期：2026-10-19 · 作者：ddj · 基线：v0.16.0 @ `8b79f8f`

## 背景

本轮基线为 Web profile 运行的 `@deepseek-ai/dsh@0.2.1-rc.2`。逐条比对
`0.2.1-alpha.1` → `alpha.5` → `rc.1` → `rc.2` 七个预发布版本的 release notes，
并在 `D:\Application\Tools\DeepSeekHarness\node_modules` 与 profile 的
`node_modules` 内核对真实产物（而不是只信公告），得到四类可落地项：

1. **插件元数据其实一直没生效**：`dsh-app-boot` 的 `dictionariesOf` 只读
   `<specifier>/locale/<lang>.json` 里的 `meta.title` / `meta.description`，
   本插件的两个 locale 文件是顶层字段、且 `exports` 未导出 `./locale/*.json`。
   结果是插件管理器标题长期回退到 `package.json.name`。
2. **会话 `cd` 后目录不跟随**：0.2.1-alpha.2 引入 `workingDirectory` 服务与同名
   session projection，`header.cwd` 是会话**原始**目录，`cd` 之后只有投影是当前目录。
   本插件此前 13 处读 `header.cwd`，差异桶、文件树范围、SVG/SVN 根都不跟随。
3. **同一会话的 `edrv.list` 被拉四次/5 秒**：差异角标、输入区 dock、编辑器、
   体积角标各自 `setInterval(load, 5000)`，逻辑完全重复。
4. **兼容性只靠宽容而非声明**：六个 DSH peer 是 `*`，npm 默认语义下 `*` 排除预发布，
   当前能装全靠官方 gate 用 `includePrerelease: true`；0.2.1-alpha.4 起
   `engines.dsh` 可独立决定兼容性，值得显式化。

顺带吸纳：`ctx.locale` 早已在 inject 里却零调用；`plugins.detail.section`
（list/root）可用于把兼容报告摘要挂进插件管理器详情页。

## 改动

| 文件 | 改动 |
|---|---|
| `package.json` | `exports` 补 `"./locale/*.json"`；`engines` 补 `dsh: ">=0.1.0-rc.1 <0.3.0-0"`（官方 gate 以 `includePrerelease:true` 求值，声明后 peer 分支被忽略、区间写错会阻断安装，故一次性放行 0.1/0.2 全线、拒绝 0.3 起） |
| `locale/en.json`、`locale/zh.json` | 包进 `{"meta":{"title","description"}}`，成为 `dsh-app-boot` 真正读得到的结构 |
| `src/store.ts` | 新增 `cwdOfSession(ctx, session)`：先探 `ctx.get('workingDirectory')?.get(session)`，服务缺失/抛错/返回非绝对路径时回落 `header.cwd`；`resolveTarget` 改用它 |
| `src/registry.ts` | 移除本地 `cwdOf` 实现，改为从 `store.ts` 重导出（避免 registry ↔ store 循环依赖）；保留纯 header 版 `cwdOf` 供无 ctx 的会话销毁路径使用 |
| `src/rpc.ts`、`src/lsp/rpc.ts`、`src/capture.ts`、`src/fileVersions.ts`、`src/svn.ts`、`src/search/ripgrep.ts`、`src/search/fallback.ts`、`src/rules.ts`、`src/mcpRuntime.ts` | 9 个文件 13 处 cwd 读取切到 `cwdOfSession`；`src/index.ts:76`（`onDisposed`，无 ctx）与 `src/revert.ts` 的两处日志文案保持原样 |
| `src/client/state/recordsFeed.ts` | **新增**：会话级 `edrv.list` 共享订阅。按 `sessionId` 分桶、订阅者三集合（records / tick / errors）、单 interval、`edrv:refresh` 立即拉取、`seq` 防陈旧、退订到 0 才释放定时器与监听；失败只分发错误并保留旧快照 |
| `src/client/ui/DiffBadge.ts`、`ConversationDiffDock.ts`、`PerfSizeBadge.ts` | 删除各自 `setInterval` 与本地的 `rpc('edrv.list')` + `summarize` 逻辑，改 `subscribeRecords` / `subscribeTick` |
| `src/client/ui/EditorView.ts` | 新增 `applyRecords`（内建内容比对，未变化时返回原引用避免重渲染）；`refreshRecords` 改走 `refreshFeed`；挂载改订阅 `records` + `errors`，1.5s LSP 状态轮询保持不变 |
| `src/client/localeClient.ts` | **新增**：`ctx.locale.register` 中英词典（仅界面壳层 6 个键）+ `bind` 包装；`register` / `bind` 各自独立降级，一侧失败不拉黑另一侧；服务全程可选探测 |
| `src/client/compat.ts` | `SlotSpec.label` 放宽为 `string \| (() => string)`，与官方 `SlotLabel` 一致 |
| `src/client/index.ts` | 5 处 slot label 与官方页签标题、引导文案改 thunk 走 locale；新增 `plugins.detail.section` 注册（`edrv-plugin-status`，order 40） |
| `src/client/officialSidebar.ts` | `installOfficial` 新增可选 `title?: () => string`，缺省仍用 `OFFICIAL_TAB_TITLE` |
| `src/client/ui/PluginDetailSection.ts` | **新增**：插件详情页只读段，渲染版本 / 版本适配 / 外部插件与服务 / 护栏 / 兼容性警告；`isSelfSubject` 同时支持 `{kind:'item',id}` 与 `{kind:'bundle',pkg:{name}}` 两种 subject 形状，未知形状返回 `null` |
| `src/dshVersion.ts` | `familyLabel` 插入 `0.2.1-rc.2` 精确分支与 `0.2.1` 线分支（放在 `0.2.0` 分支之前） |
| `tests/pluginMeta.test.ts` | **新增**：locale `meta` 结构、无顶层残留、`exports` 可解析 `dsh-vscode-mode/locale/<lang>.json` 且落在包内 `locale/` 下、`files` 覆盖、`icon` 为相对路径 |
| `tests/peerDeps.test.ts` | 补 `engines.dsh`：12 个应接受版本（含 `0.2.1-rc.2` / `0.2.1`）/ 6 个应拒绝版本（`0.0.1`、`0.3.0-alpha.1`、`0.3.0`、`1.0.0-rc.1`、`9.0.0-alpha.1`），按 `includePrerelease:true` 断言 |
| `tests/cwdOfSession.test.ts` | **新增**：投影命中 / 服务缺失 / `get` 非函数 / 投影为 null 或空串 / `get` 抛错 / session 为 undefined / 无 ctx 共 9 例 |
| `tests/recordsFeed.test.ts` | **新增**：首订阅立即拉取、3 订阅者 1 轮只 RPC 1 次、不同会话分桶、缓存命中不重拉、退订到 0 释放、`edrv:refresh` 立即拉取且退订后移除监听、失败分发错误并保留旧快照、心跳订阅 0 RPC、单订阅者抛错不影响他人、`disposeFeed` 清理 |
| `tests/localeClient.test.ts` | **新增**：中英键集合一致、中文缺省回退、未知语言/键回退、服务可用时 register+bind、服务缺失、register 抛错不影响 bind、bind 抛错回落、`ctx.get` 抛错回落、bind 每次重问（语言热切换） |
| `tests/pluginDetailSection.test.ts` | **新增**：两种 subject 形状命中、其他插件不命中、未知 kind 不命中、畸形 subject 不抛错 |
| `tests/dshVersion.test.ts` | 补 0.2.1 断言：rc.2 单列且含 `workingDirectory`，同线其他版本不冒充 rc.2、不回落到 0.1.7 / 0.2.0 文案 |
| `docs/version-adaptation.md` | 修订第 4 节已失效的 `TESTED_DSH_MAX` 表述；新增第 11 节「0.17.0 对 DSH 0.2.1 的吸纳」，含吸收项表与不吸纳理由 |

## 验证

- `npm run typecheck`：0 error
- `npm run test`：3029 passed + 15 skipped（225 个文件通过、2 个跳过；
  `node --test tests/nativeOpen.test.mjs` 另 9 passed）
- `npm run build`：tsdown host + client 双 ✔（`lib/client.js` 1,718,766 B、
  `lib/index.js` 847,975 B）

## 已知缺口

- **未做真机 GUI 冒烟**：locale 元数据要在插件管理器里看到中文标题、`cd` 后根目录
  跟随、`plugins.detail.section` 的实际渲染，都需重启 Host 后人工确认。
- 构建中 `src/client/monaco/lsp/providers.ts:86` 与 `:252` 的
  `[INVALID_ANNOTATION]` 是本轮之前既有的 Rolldown 告警，非本次引入，未处理。
- 本次发布**未自动安装或重启当前运行实例**；新版本需按 README 的安装方式更新后
  重启 DSH Host 才生效。

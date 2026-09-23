# DSH 0.1.7-alpha.1 适配批次 发布说明

> 对应 DSH `0.1.7-alpha.1`（2026-09-22 发布，`alpha` 标签已指向）。
> 两项 P0 修复 + 设置体系迁移 + 六项新能力采纳。插件版本随本批次递增。

## P0：不修则插件废掉

- **client 停等修复**：0.1.7 移除 `settingsScope` 服务，原 `inject` 含该名会让整个
  client 半边永不激活 → 移出 inject；设置桥改 `compat.settingsBridge` 四级探测
  （`configForms` 0.1.7+ → `webUiSettings` → `settingsScope` → 无）+ **15×2s 晚到
  有界重试**（桥服务不进 inject 后失去时序保证，命中后 `mountSettingsSyncs` 重挂
  fileOpenTool/快捷键两条同步 effect）。
- **host 设置策略**：0.1.7 移除 `settings.installSection` → `runSettingsInstall`
  新增第四策略 **`forms`**（describe+update 在场即成立）：不装 section，改订阅
  `settings/document-updated` 推送 hooks（disposer 经 ctx.effect 随 fiber 卸载）；
  兼容性报告 `forms` 记为 active。
- **UI 图标全灭修复（双树比对新发现）**：0.1.7 图标命名重构
  `Icon<Name>16` → `Icon<Name>Regular/Medium`（旧名在 0.1.7 全树不存在，整树 grep
  实证）——侧栏文件树/搜索/规则/SVN/大纲活动栏图标会渲染 undefined → 新增
  `src/client/ui/icons.ts` 跨版本出口（namespace 探测：旧名 → 新名 → 通用占位，
  导出名保持旧名），4 个消费文件改从该出口引入；`FileTypeIcon/classifyFileType/
  Markdown*` 两代同名存活直通。

## 设置体系迁移（0.1.7 主线）

- 插件新增 **`export const Config = buildSettingsSchema(z)`**（src/index.ts）：
  设置值 = profile 插件 Config，0.1.7 设置页按 schema 自动生成表单。
  字段集与旧 section schema **同源**（`buildSettingsSchema` 提取共用，11 字段全默认
  值）——实测 schemastery `validate(undefined)` 自动填充，rc/alpha 两代 cordis 启动
  校验必过；解析经插件自身 node_modules（link/dev/npm 安装三形态均命中）。
- 读写统一工具：`sectionOf`（ns + 形状双校验，防 0.1.7 ns=profile entry id 与旧
  自装 section 同名误命中）；`updateSection`（`SettingsConflictError` 冲突重读
  revision 重试一次，永不抛未捕获异常）。host rpc 两处设置 handler 与
  `setupOpenSettings` 全部换用。
- `familyLabel` 新增 `0.1.7-alpha.1` 版本线；`TESTED_DSH_MAX = '0.1.7-alpha.1'`。

## 新能力采纳

- **`package.json icon`**：`assets/icon.svg`（669B，0.1.7 插件管理页展示；
  locale 标题/描述 follow-up——metaOf 读取源待定位）。
- **CSV/TSV 决策**：官方 0.1.7 新增侧栏表格预览（含 CSV/TSV），本插件**不让位**
  ——编辑器可编辑性优先（同 `avif` 例外先例），注释 + 测试落码。
- **二进制预览通道**：新增 `edrv.readBinary`（同端点 octet-stream + `x-edrv-mime/
  size/version` 头直出字节，省 ~33% base64 体积）；任何失败自动回退既有 base64
  JSON 路径（未接线态本页只探测一次）；`routes.ts` 已接线；图片/PDF 读取点已切换。
- **官方归档双轨对齐**：实证官方 `archiveSession` 只写 `archivedSessionIds` 持久
  标志（不搬目录），与插件 sessions-archive 搬移是双轨 → perf 恢复后
  `unarchiveOfficial` 幂等清官方标志（best-effort，失败静默不阻断）；运行中会话
  守卫复用既有 active 检查。
- **免重载配置字段**：实证机制为 Config schema 字段级 `.volatile()`
  （非 patch 文件字段）；本插件无自定义 config 字段 → `cordis.patch.yml` 注释
  预留写法，不发明字段。
- **`--dump-config-schema`**：`audit-dsh-compat.mjs` 新增子命令（flag 预检防旧版
  误启 profile；schema 缺失优雅跳过 exit 0）；`--help` 一并补上。

## 验证

- `npx tsc --noEmit` 0 error（全模块汇合后复验）。
- 新增/扩展单测：settingsAdaptive（forms 分派/订阅推送/形状读取/冲突重写/schema
  字段全集）、dshVersion（0.1.7 线）、client-compat（configForms 桥 + settingsBridge
  晚到重试）、binaryRead（7）、pdfSave（+5）、perf（+3）、officialSidebar（csv/tsv）。
- `scripts/audit-dsh-compat.mjs <0.1.6树> <0.1.7树>` 双树比对（见交付记录）。
- E2E（用户重启后）：兼容性页应显示 `0.1.7-alpha.1 · forms`、设置桥 `configForms`、
  无「设置 section 安装」警告；文件链接/侧栏/差异审查/图片 PDF 预览冒烟。

## Follow-up

- ~~title/description locale 声明~~ → **已落地**（见下「补完批次」）。
- ~~perf 面板展示官方 archived/pinned 状态~~ → **已落地**（见下「补完批次」）。
- 真实浏览器冒烟（二进制通道 + 回退 + 缺文件错误面板）。

---

# 补完批次（4 项 follow-up + 文件树原生打开）

> 同日第二轮。全量验证：tsc 0 error · vitest **1843/1843 绿**（11 skipped，较首轮基线净增 23 用例）。

## 新能力：文件树原生打开（范围可配置）

- 新设置字段 **`nativeOpenExts`**（逗号分隔后缀，进 `buildSettingsSchema` → `Config` 同源，
  设置页「编辑器」组新增输入行，空 = 恢复默认）：**默认 = 让位清单并集**（Office 11 + 不可预览
  二进制 52；csv/tsv 仍刻意不含，需显式加入才让位）。
- 单一事实源 **`src/shared/nativeOpen.ts`**（双面契约）：清单/解析/命中判定；host schema 默认值
  与 client 判定共用；`officialSidebar` 清单改 re-export（旧 import 路径与既有 41 用例不破）。
- 消费双点：① 文件树 `openFile` 命中 → `tryNativeOpen` 走官方 `openResource`（`focusDiff` 跳过——
  差异审查优先；handler 缺失/失败回退现状页签）；② claim **`canOpen` 同步让位**命中后缀——否则
  认领会把地址又转发回本插件（原生打开失效）。G4 卸载收尾 `resetNativeOpen`。
- 设置值链路：`mountSettingsSyncs` 每拍推送 → `nativeOpenStore` 解析缓存（值变化广播）。

## C 项评估结论：差异分栏对齐——不改（用户已确认）

插件审查是「编辑器行内标注 + Keep/Undo 栏」形态（SVN 历史对比**已并排**），不存在「默认单栏的
审阅面板」可对齐；官方分栏是其 deliverables 面板形态，与本插件调用级行内审查互补而非先后关系。
改成并排 = 重写采纳/拒绝语义（立项级），评估后不改，结论固化于适配矩阵。

## A. locale 多语言声明（实证 readPluginMeta/dictionariesOf）

- 包根 **`locale/en.json`（必须）+ `locale/zh.json`**，平面键 `title/description`；
  `package.json files` 已含 `locale`。插件管理页将显示「VSCodeMode」+ 双语简介
  （缺省回退 package.json name/description，旧版 DSH 无该读取链零影响）。

## B. perf 面板官方归档/置顶徽标

- host `registryFlags` / `markOfficialFlags`（一次读 `workspaceRegistry.archivedSessionIds/
  pinnedSessionIds` 摊到各行；缺服务/缺字段/非数组 → 静默降级绝不抛错，id 编码双向匹配）；
  行按需渲染「已归档」「已置顶」徽标（旧 host 不回传 → 零额外 DOM）。测试 +6。
- 样式暂复用 `vsm-perf-active`（独立配色待放开 mcp.css，见遗留）。

## D. 图片/PDF 缩放对齐官方「统一缩放」

- 图片新增：**适应宽度默认** + −／＋（10%/档，clamp 25%–400%）+ 百分比指示 +
  **每页签记忆**（会话+路径键、模块 Map、EditorView 卸载清空不持久化）。
- PDF 补百分比指示（`updateZoomLabel`，scalechanging/pagesinit 事件），与图片同款；
  初始 page-width 与按钮样式本已一致，最小改动。

## Follow-up（遗留）

- perf 徽标独立配色（需放开 `src/client/styles/mcp.css` 写权限）。
- `edrv.perf.movePlan` 确认弹窗行不带标志（类型无字段，按范围只改 inventory 行）。
- 真实浏览器冒烟：文件树点 Office 落官方预览 / 配置 csv 让位回退链 / 图片缩放页签记忆。
- 重启 E2E（含 link junction 覆盖坑复验）。

# DSH 版本适配机制（dsh-vscode-mode）

> 更新于 2026-10-12；第 1～7 节记录插件 0.13.0 对 DSH `0.1.7-rc.2` 的历史基线，
> 第 8 节另列插件 0.14.1 对 Web DSH `0.2.0-rc.1`，第 9 节记录 0.14.4 对 Desktop `0.2.0-rc.2` 的限定适配。
> API 能力探测、包版本范围、自动化测试和真实应用验收分别记录；其中任何一项都不能替代其他项。

## 1. 适配入口与证据来源

| 位置 | 职责 |
|---|---|
| [dshVersion.ts](../src/dshVersion.ts) | 从运行中 Host 安装树探测版本，比较版本先后与内部适配区间 |
| [hostImport.ts](../src/hostImport.ts) | 动态加载优先锚定 `process.argv[1]`，避免开发目录中的旧副本抢先命中 |
| [fileOpenSettings.ts](../src/fileOpenSettings.ts) | `legacy / service / forms / none` 设置策略与状态观测 |
| [compat.ts](../src/compat.ts) | 汇总能力、版本与配置诊断；维护报告告警上界 `TESTED_DSH_MAX` |
| [httpGuard.ts](../src/httpGuard.ts)、[appUrl.ts](../src/shared/appUrl.ts) | 官方 HTTP 认证、请求体限制与应用基址解析 |
| [mcpRuntime.ts](../src/mcpRuntime.ts)、[mcpIsolation.ts](../src/mcpIsolation.ts) | 项目 MCP 的 agent 生命周期，以及工具、资源、指令隔离 |
| [devForm.ts](../src/devForm.ts) | 当前运行 profile 定位与开发形态切换事务 |
| [audit-dsh-compat.mjs](../scripts/audit-dsh-compat.mjs) | 已安装目录的导出面、服务名、UI 原语候选比对；可选配置 schema 检查 |

以实际安装树的包元数据和实现为依据；有类型声明时同时核对声明。发行包缺少某些
声明文件时，不把本插件的旧 devDependency 类型当成当前 Host 契约。

动态加载优先从 Host 入口解析；只有解析失败才回退普通包名。**已成功解析的模块
执行失败不会被回退到旧副本所掩盖**。本轮实际 Host 模块锚定为 `0.1.7-rc.2`；
这是本轮环境事实，不表示任意用户环境都运行该版本。

## 2. 0.13.0 当前适配面

以下接口在已安装的 `0.1.7-rc.2` 实现中完成核对；表格不主张它们都首次出现于该版本。

| 接口或边界 | 本插件处理 | 验证/能力边界 |
|---|---|---|
| `connection.requestRejection(req)` | `/edrv` 路由在读取请求体及派发前使用官方认证；认证服务缺失或失败时拒绝请求 | 不再支持未鉴权裸 curl；不能把 loopback 地址本身当作身份 |
| RPC 请求体 | 校验方法、JSON content-type、envelope、对象参数；同时限制 Content-Length 与实际流式字节数，响应 `no-store` | 限额包含文本 JSON 转义与二进制 base64 开销；不是无限制上传接口 |
| 应用 URL | RPC、资产和 vendor 路径根据应用 document base 解析，保留反向代理子路径，支持 HTTP(S) 与 `dsh-app:` | 任意外部 URL 不能作为插件内部资源路径；不拼接固定端口 |
| 官方 MCP scope | 使用 `agent.ctx.plugin(officialMcp, config)`，启动前移除旧全局项目 entry；等待串行 `agent/created`，并挂载已存在 agent | 每个活动 agent/server 一份实例；无 agent 时仅 configured；更新/禁用/删除/卸载释放实例 |
| scope 继承 | 限制继承的外项目工具；共享资源工具按 `arguments.server` 检查归属；为外项目指令注册空 scope section，过滤实际查看 scope 的资源列表 | 保留全局和独立 agent preset 的资源；不修改 parent 链；官方资源列表格式无法识别时安全隐藏该提示列表 |
| MCP 状态 | `instanceCount`、`configured`、`unverified`；读取失败保留最后有效配置，尊重 disabled | `failOnStartupError=false` 时 ACTIVE 不证明连接成功；零工具允许为纯资源服务 |
| `profileContext` | 优先读取真实 `dir` 与 `packageManager`；旧宿主仅允许唯一 profile 候选回退 | 无效/歧义时拒绝猜测；安装失败恢复 manifest、lockfile 和原入口；恢复失败保留备份位置 |
| shortcuts | 对齐官方返回的 normalized 绑定，保留物理 Control/Meta 区别；录制前后正确切换 recording；命令首开使用当前会话 scope | 0.12 已引入官方接管；0.13 修正转换和生命周期。Web 搜索绑定以当前官方平台目录为准 |
| 外部打开 | 本机私有、按 profile 隔离的 OPEN 请求与 lease/ACK；各 launcher 和 Unity 共用 producer | 只有目标实际 model/预览内容加载完成才确认成功；旧 URL 深链仅作兼容入口 |
| Unity bridge | 内嵌包 0.3.1，首次安装自动准备 profile bridge 并写项目 UserSettings hint；UI 覆盖优先；桌面 profile 开机自动 provisioning 独立 bridge；Unity 外部工具面板可显式选择打开目标（自动/DSH Web/DSH 桌面端） | 不依赖 OS 菜单注册；没有真实 Unity EditMode 验证，不能据编译桩声称完整 Unity 运行通过 |
| 子进程 | 共用 `childEnv` 清理隐式凭据/DSH 环境，显式配置保留；LSP/DAP 按平台回收进程树/进程组 | 清理依赖变量名规则，进程树回收是 best effort；Linux/macOS 本轮未现场验证 |

### 设置策略仍按能力选择

| 策略 | 触发条件 | 行为 |
|---|---|---|
| `legacy` | `dsh-settings` 仍导出 `installSettingsSection` | 使用旧 free function 安装 section |
| `service` | free function 已移除，但 provider 有 `installSection` | 使用服务方法安装 section |
| `forms` | 无 installSection，存在 `describe + update` | 设置来自 loader entry Config；订阅文档更新并跟随 fiber 清理 |
| `none` | 上述能力均不可用 | 记录诊断，按配置值降级；不产生未处理的异步 rejection |

0.1.7 的 Config 表单要求 volatile 字段。插件 Config 与旧 section schema 共用字段定义，
但仅 Config 侧按能力标记 `.volatile()`，读取时解引用 Cordis volatile 值。client 设置桥
继续做 `configForms → webUiSettings → settingsScope` 能力探测，不把互斥的可选服务
写成硬注入依赖。

## 3. 历史版本线

此表保留适配来源，**不代表 0.13 在每一条旧版本线上重新完成了现场回归**。

| DSH 版本线 | 当时核对的变化 | 插件处理历史 |
|---|---|---|
| `0.1.0/0.1.1` rc | 旧 `installSettingsSection`；客户端 runtime 提供基础服务 | legacy 设置策略，插件早期基线 |
| `0.1.2-alpha.1` 起 | 设置安装转为 provider 方法；客户端服务提供包拆分 | 0.1.43 增加 service 策略，调整装载兼容 |
| `0.1.2-alpha.3/.4` | 可选 SQLite 后端变化、Session 事件 API 调整 | 当时插件未依赖相应接口；未来新增依赖须重新检查 |
| `0.1.5-alpha.1` 起 | 官方右侧 Sidebar 与文件资源打开入口 | 官方侧栏优先，旧形态保留回退 |
| `0.1.5` 安装树 | vendored schema 包迁到 `@deepseek-ai/schemastery` | 新旧包名候选解析，避免 npm 安装态缺裸包 |
| `0.1.6-alpha.1` | MCP SDK v2、文件链接与终端能力变化 | Host 入口锚点解析，避免命中开发副本 |
| `0.1.6-alpha.2` | 客户端会话多实例、list.current 移除、官方 Office 预览等 | `uiSession.current` 优先的会话取值链；Office 等类型让位；卸载清理复核 |
| `0.1.7-alpha.1` | 设置转为 profile Config / SettingsForms；client configForms；二进制与预览能力变化 | forms 策略、可选设置桥、二进制读取通道与图标候选兼容 |
| `0.1.7-alpha.2` 核对 | Config 无 volatile 字段会导致表单不可用；该门槛 alpha.1 已存在 | Config volatile、读取解引用、schema 依赖钉定及诊断；不误归因为 alpha.2 首次引入 |
| `0.1.7-rc.2` 本轮基线 | 官方认证、profile、shortcut、scope/资源/指令等实际契约 | 0.13 增量见第二节，现场完成范围见第五节 |

## 4. 版本与依赖范围不能混为一谈

- **版本探测**：优先从运行 Host 入口解析 `dsh-settings` 元数据，再按
  `dsh-web-app → dsh-base → dsh` 候选回退；全部失败报告未知并使用能力探测。
- **运行时告警**：`TESTED_DSH_MAX` 已于 `0.14.10` 移除（见第 10 节），不再有「高于已实测
  版本」告警。自 `0.17.0` 起改由 `engines.dsh` 显式声明支持区间
  `>=0.1.0-rc.1 <0.3.0-0`，配合逐项能力探测；声明区间只表达「允许安装」，
  不表达「已逐功能验收」。有限现场通过不意味着所有功能或平台都通过。
- **npm SemVer**：默认排除未明确纳入对应版本元组的预发布版本。
  例如单独的 `>=0.1.0-rc.1 <0.2.0-0` 不自动覆盖 `0.1.7-rc.2`，需要相应
  `>=0.1.7-0` 分支。历史 `0.13.0` 的上界 `<0.2.0-0` 排除 0.2.0 预发布和正式版；
  `0.14.1` 仅以独立 `=0.2.0-rc.1` 分支额外放行该精确版本，不放行 rc.2 或正式版。
- **DSH gate**：其 `includePrerelease` 行为与 npm 默认检查分别验证；
  [peerDeps.test.ts](../tests/peerDeps.test.ts) 使用真实 semver 包测试两个判据，
  不用自写字符串比较代替 npm 的范围语义。
- **本轮 lockfile**：变更包含 schema/cosmokit 去重与开发测试依赖 `semver@7.8.5`，
  并未把已锁定的 DSH 包统一升级到 rc.2。旧开发依赖混线产生的 peer warnings 是既有
  依赖树现象；既不能据此断言当前 Host 运行旧版，也不能把扩展 peer 声明当成升级完成。

审计脚本扫描已安装包的导出/服务/UI 原语，不计算 npm peer 范围，也不是安全或完整
运行验收工具；其输出“审计通过”只针对脚本检查的项目。本轮无需修改该脚本。

## 5. 本轮验证记录与未完成项

已记录的现场范围为 **Windows 官方已签名打包 Desktop 的隔离启动、插件侧栏挂载，
以及已鉴权同源 MCP/devForm 接口访问**。这不是替代 Desktop 的开发服务器验证。

| 项目 | 本轮记录 |
|---|---|
| 官方安装树 | Host 模块锚点 `0.1.7-rc.2`；与插件旧 devDependencies 区分 |
| Desktop 启动、侧栏、同源接口 | 已进行上述限定范围的真实应用检查 |
| 最终保存、预览、设置读写 | **待发布维护者完成现场验收并补结果** |
| 最终编译/定向回归/build/打包统计 | **待发布维护者在最终合并树补充命令、范围、数量、结果和耗时** |
| Unity | 证据限于 C# 编译桩与 9 项 hint 探针；**未运行真实 Unity EditMode** |
| Linux/macOS | **本轮未进行现场验收**，不能宣称全平台实测 |
| 0.12 发布基线 | `v0.12.0`，tag 对应 `618fcbb`；该基线的 CI 与 GitHub Release 已确认通过 |

最终状态集中记录于 [0.13.0 发布说明](release-0.13.0.md)，不要把历史通过数挪作本版
统计，也不要把部署、同源 RPC 成功或一次编译扩大解释为完整用户流程成功。

## 6. 后续版本适配流程

1. 阅读官方发布说明并核对实际安装树，区分新增 API 与已经存在但此前遗漏的能力。
2. 运行 `node scripts/audit-dsh-compat.mjs <旧树> <新树>`；这里的目录直接包含
   `dsh-settings` 等包，通常是安装根下的 `node_modules/@deepseek-ai`。
3. 按影响面检查认证、URL、profile、设置、shortcuts、MCP scope、生命周期等契约，
   为命中的分支补最小回归；无需跑全量测试来替代影响面分析。
4. 运行类型检查、明确指定文件的定向测试，以及受影响产物构建/打包检查；可通过
   `--dump-config-schema <包目录> [profile]` 做可选 schema 检查，跳过不等于验证通过。
5. 重启或刷新**原应用入口**验证对应流程，记录操作、数据状态与错误日志。
   只有对应 watcher 和 HMR 均工作时才依赖客户端自动更新。
6. 更新本矩阵、告警上界与发布说明；声明尚未现场覆盖的版本和平台。

真实官方 MCP 集成用例使用 `DSH_MCP_HOST_ROOT` 指向 **harness 根目录**，与审计脚本
的 `node_modules/@deepseek-ai` 参数层级不同；未提供该环境变量时会跳过该集成用例。

## 7. 部署与回滚

0.13 升级、profile 备份、项目 MCP 迁移、launcher/Unity 更新及回退 0.12 的步骤见
[发布说明中的迁移和回滚](release-0.13.0.md#迁移与部署)。Host 代码变更需要重启 DSH；
回退代码不能自动撤销外部配置和桥接文件变化，须按所选 profile 与备份恢复，不能
把历史 0.1.43 的临时备份路径当成当前机器可用的恢复点。

## 8. 0.14.1 对 Web DSH 0.2.0-rc.1 的限定适配（2026-09-29）

- 实际运行的 Web 入口为 `@deepseek-ai/dsh@0.2.0-rc.1`；六个受本插件 peer
  约束的官方包同版。Desktop 打包树仍为 `0.1.7-rc.2`，本轮不改动 Desktop。
- 双树审计中，插件消费的 10 个官方 UI 原语均可找到，`sessions/fs/webServer/tools/
  workspaceRegistry/agents` 等硬注入服务及客户端侧栏、会话、设置、快捷键候选面
  均存在；`dsh-settings` 的 `describe/update`、`configForms` 的读写面、侧栏
  `register/openTab`、`uiSession.current`、`connection.requestRejection` 在新树均可核对。
  `codeRuntime` 服务消失但本插件未使用；新增的 otel / productAnalytics /
  productTelemetry 非本插件硬依赖。这是静态/API 审计，不代替逐功能现场验收。
- `package.json` 六个 DSH peer 均保留原 0.1.x 范围，另以 `|| =0.2.0-rc.1`
  精确纳入新版；`pnpm-lock.yaml` importer 同步，锁定的旧开发依赖**没有升级**。
  [peerDeps.test.ts](../tests/peerDeps.test.ts) 对 npm 默认与 DSH `includePrerelease`
  两种规则分别断言：接受 rc.1，拒绝 alpha.1、rc.2、正式版和 1.0.0。
- `familyLabel` 将 0.2.0-rc.1 单列，未来 0.2 版本不再误标成 0.1.7；
  `TESTED_DSH_MAX` 暂保留 `0.1.7-rc.2`：已验证 Web 安装与基础挂载，但未
  逐项验收全部能力，报告仍应提醒高于完整实测上界的版本。
- 打包、Web 安装与原页面冒烟的证据/限制见 [0.14.1 适配与发布说明](release-0.14.1.md)。
  `v0.14.1` 的发布须以 GitHub Actions 和 npm 注册表的实际结果为准；旧版
  `0.14.0` 的 peer 仍会被 Web DSH `0.2.0-rc.1` 拒绝。

## 9. 0.14.4 对 Desktop DSH 0.2.0-rc.2 的精确放行（2026-10-08）

- 正在运行的桌面入口为 `GFDeepSeekHarness` 打包树 `@deepseek-ai/dsh@0.2.0-rc.2`，六个声明的 DSH peer 均为 `0.2.0-rc.2`；实际 profile 为 `C:\Users\1\.dsh\profiles\desktop`，不是 Web profile 或旧的 `.dsh-desktop`。当时 npm 已有 0.14.3，故本地候选包递增至 0.14.4；该次安装未发布 npm。最终合并版的发布范围和验证边界见 [0.14.4 发布说明](release-0.14.4.md)。
- 从 Electron ASAR 读取 rc.2 实际包，对照 Web rc.1：`dsh-settings`、`dsh-client-ui-settings`、`dsh-client-ui-session`、`dsh-client-connection`、`dsh-tools`、`dsh-client-ui-slots` 对应入口内容一致；侧栏服务仍提供 `sidebarRightTabs` / `sidebarRight`、`openTabIn` / `openResource`，10 个消费的原语及 Markdown 原语在 rc.2 保留。此为静态接口审计，**不等于 Desktop 全功能验收**。
- 六个 peer 原有区间和 `=0.2.0-rc.1` 均保留，仅追加 `|| =0.2.0-rc.2`；锁文件 importer 对齐，未升级开发期旧依赖。定向 semver 测试同时覆盖 npm 默认与 DSH `includePrerelease`：应接受 rc.2，仍拒绝 alpha.1 / rc.3 / 0.2.0 正式版。
- `familyLabel` 单列 rc.2；完整实测上界 `TESTED_DSH_MAX` 仍保留 0.1.7-rc.2，避免把静态审计/安装冒烟误当全功能覆盖。定向测试 `peerDeps` / `dshVersion` / `compat`：103/103 通过，类型检查和 Host/Client 构建通过；构建中的 `INVALID_ANNOTATION` 为现存 Rolldown 告警。
- 从桌面安装目录的 `@deepseek-ai/dsh-desktop-host/lib/cli.js` 调用 Desktop 专属 `plugin --profile desktop add <tgz>`：退出码 0，profile manifest 新增 `dsh-vscode-mode` 依赖与 bundle，安装目录读回 `0.14.4` 和双面产物。保留安装源于 `C:\Users\1\.dsh\plugin-archives\dsh-vscode-mode-0.14.4-desktop-rc2.tgz`（SHA256 `5274B4B97601CB10F098570CA67A961B3E4422B9B6C0D48CA72309DFB4B8D717`）；profile 原始五文件备份于 `C:\Users\1\.dsh\profiles\desktop\backup-dsh-vscode-mode-0.14.4-20261008-110914`。原 `cordis.yml` / `cordis.patch.yml` / `pnpm-workspace.yaml` 哈希不变，manifest 原依赖保留，未使用风险豁免。
- Desktop 专属 CLI 的 pnpm `peers check` 仍报告缺少内置 DSH peer、react、cordis 等（其他插件也受影响）；这是 profile 包管理器视角，官方包实际在打包 ASAR 内，不能据此判为全部运行时功能正常或异常。桌面应用当时仍运行，本次**不自动退出或重启**，新 Host 挂载/侧栏 UI 待用户自行重启后验收。回退时先记录重启后的新改动，在 Desktop 专属 CLI 运行 `plugin --profile desktop remove dsh-vscode-mode`，再比对备份而非直接覆盖用户新配置；保留 tgz 直至确认无需重装。

## 10. 0.14.10 宽松版本政策（2026-10-13）

- 六项 `@deepseek-ai/dsh-*` peerDependencies 统一改为 `*`，取消逐版白名单和版本上界；Node、React、Cordis、schema 约束不变。
- DSH 的 `includePrerelease` 检查接受旧版、未来 alpha/rc、正式版及未来主版本；npm 默认 semver 的 `*` 仍排除预发布，可能产生 peer 不匹配提示。测试分别验证两种规则，不再枚举未来版本来绕过 npm 的默认语义。
- 六项 DSH 开发依赖显式固定原有版本，与发布 peer 分离：primitives 为 `0.1.6-alpha.1`，ui-settings / settings 为 `0.1.0-rc.8`，slots / llm / tools 为 `0.0.1-rc.1`。避免 `*` 自动解析造成依赖漂移及 frozen-lockfile 失败；锁文件仅移动 importer 项，不升级解析版本。
- 移除 `TESTED_DSH_MAX` 及「高于已实测版本」告警，保留版本探测、实际能力检查、设置依赖/volatile 标记不完整和路由/重复装配诊断。
- 允许安装不等于已验证未来 DSH 的所有 API；此为源码政策调整，不是发布、部署或跨版本全功能验收。此前章节保留当时的适配证据，不代表当前源码仍有精确放行限制。

## 11. 0.17.0 对 DSH 0.2.1 的吸纳（2026-10-19）

本轮基线为 Web profile 运行的 `@deepseek-ai/dsh@0.2.1-rc.2`（`0.2.1` 线最新预发布）。
调研覆盖 `0.2.1-alpha.1` → `alpha.5` → `rc.1` → `rc.2` 全部 7 个预发布版本，逐条比对
`D:\Application\Tools\DeepSeekHarness\node_modules` 内的实际产物，而非只读 release notes。

| 吸纳项 | 官方来源 | 本插件落点 | 边界 |
| --- | --- | --- | --- |
| 显式兼容区间 | `dsh-app-boot` 兼容闸门支持 `engines.dsh` | `package.json` 的 `engines.dsh = >=0.1.0-rc.1 <0.3.0-0` | 声明后 peer 分支被忽略（官方注释：`An own engines.dsh range decides alone and peerDependencies are ignored`），区间写错会**阻断安装**，故一次性放行 0.1/0.2 全线、拒绝 0.3 起 |
| 插件元数据可读 | `dsh-app-boot` 的 `dictionariesOf` 只读 `meta.title` / `meta.description` | `locale/{en,zh}.json` 改 `{"meta":{...}}`；`exports` 补 `./locale/*.json` | 结构性修复：修改前两个文件是顶层字段、且未导出，插件管理器一直回退到 `package.json.name`。`icon` 走 manifest 相对路径，不受 `exports` 影响 |
| 跟随会话当前目录 | `dsh-working-directory` 的 `workingDirectory` 服务 + `sessionProjections` 的 `workingDirectory` 投影 | 新增 `cwdOfSession(ctx, session)`（`src/store.ts`），13 处 `header.cwd` 直读改为走投影 | **服务一律可选探测**：不得写入模块 `inject`，否则旧版 DSH 会停等一个不存在的服务；服务缺失/抛错/返回非绝对路径时回落 `header.cwd`。`header.cwd` 是会话原始目录，`cd` 之后只有投影是当前目录 |
| 轮询收敛 | 官方无此能力，属自身演进 | 新增 `src/client/state/recordsFeed.ts`，`edrv.list` 由 3 个组件各 5s 轮询收敛为会话级单轮询 | 同一会话原本被差异角标 / 输入区 dock / 编辑器各自 5s 拉一次，现共享一份快照；退订到 0 才释放定时器与 `edrv:refresh` 监听 |
| 界面文案 locale 化 | `dsh-client-locale` 的 `ctx.locale.register` / `bind`，`SlotLabel` 支持 thunk | 新增 `src/client/localeClient.ts`；5 处 slot label 与官方页签标题、引导改为 `() => t(key)` | 与官方一致地走 `common` 回退与键名回退；`register` 与 `bind` 各自独立降级，避免一侧失败拉黑另一侧。界面壳层（slot 名/页签标题）双语，面板内部正文仍为中文 |
| 插件详情页扩展位 | `dsh-client-ui-plugin-manager` 的 `plugins.detail.section`（list/root） | 新增 `src/client/ui/PluginDetailSection.ts`，仅在本插件详情页渲染兼容报告摘要 | subject 有两种形状：内置项 `{kind:'item', id}`、安装包 `{kind:'bundle', pkg:{name}}`；两种都判，未知形状安全返回 null |

**未吸纳并记录理由**：

- `dsh.client.inject` / `external`：官方 60+ 包声明是因为自身有服务就绪需求；本插件的
  React / primitives 走 bundle 内 `CLIENT_EXTERNALS`，加载器对未 materialize 的依赖会递归
  materialize，无需 `external` 排序。误声明会触发 `module graph cycle ... factory-form CJS
  cannot deliver partial exports` 或 `a row must not declare its own package` 直接加载失败，
  故**不盲加**。
- Session 插件记录接口（`appendPluginRecord` / `pluginRecordOf`）：仍是 experimental，
  且需 Host 侧持有 session 对象；现有 `workspace/<hash>/ui.v1.json` 镜像已满足需求，
  迁移收益不足以承担实验 API 的变动风险。
- `DSH_AGENTS_HOME` 共享 agents 目录：本项目规则实际走 `.dsh/rules` 机制，接入会形成
  两套并存的指令来源，留待有明确共享需求时再评估。

**验证范围**：`npx tsc -p tsconfig.json --noEmit` 0 error；`npx vitest run` 3029 passed /
15 skipped（225 个文件通过、2 个跳过）；`node --test tests/nativeOpen.test.mjs` 9 passed；
`npm run build` 成功。构建中 `src/client/monaco/lsp/providers.ts` 的
`INVALID_ANNOTATION` 是本轮之前就存在的 Rolldown 告警，非本次引入。
以上为源码与自动化验证，**不等于** 0.2.1 全功能现场验收。

## 12. 0.32.0 对 DSH 0.2.3 的吸纳（2026-11-23）

本轮基线为 Web profile 运行的 `@deepseek-ai/dsh@0.2.3-alpha.2`（`cordis` 4.2.0-alpha.1），
证据来自安装树 `D:\Application\Tools\DeepSeekHarness\node_modules` 与运行中 host 的实测，
不只看 release notes。

| 吸纳项 | 官方来源 | 本插件落点 | 边界 |
| --- | --- | --- | --- |
| 路由授权交回框架 | 0.2.3 移除 `connection.requestRejection`；`WebRoute.auth` 缺省 `required`，由 connection 插件的 `webserver/authorize` 判定（cookie 鉴权） | `src/httpGuard.ts` 只保留方法校验与旧版闸门复用；`src/routes.ts` 注册时显式 `auth: 'required'` | 旧版宿主仍有 `requestRejection` → 沿用原闸门（401/403/503 语义不变）；两者都没有时按框架放行，绝不恢复自建 503 |
| 版本来源改问运行时 | `@deepseek-ai/dsh-app-boot` 的 `getDshRuntimeVersion()`（与 `cordis_inspect` 的 `Runtime.getVersion` 同源） | 新增 `detectVersionLive()` / `versionSourceOf()`；`buildReport` 优先运行时值，失败回落包版本嗅探；兼容报告新增「版本来源」与「路由授权归属」两行 | 旧版无该导出 → 动态 import 失败即回落；`detectDshVersion()` 同步契约不变 |
| 官方文件树样式重定向 | 0.2.3 的 style 元素改为 `data-plugin` + `data-path`（不再有 `data-plugin-css`）；官方 CSS 改挂 `[data-files-navigator-row]` 行标记与 CSS 变量 | `src/client/filesCssCompat.ts` 双选择器 + 双规则集，类名哈希变化时按正则重定向；`navSelectorOf()` 从样式文本取导航器类名 | 任何未知修订版本仍返回 `null`（识别不了就不改）；旧格式选择器与规则保留回落 |
| 死补丁点清理 | 0.2.3 客户端 `workspaces` 服务已无 `openPath`（`patchMethod` 会新建死属性） | `src/client/openPathRouter.ts` 新增 `resolveOpenPathOwner()`；探测不到就不安装并记日志 | 会话文件链接真正的主路径是 `remote.session.openWorkspacePath`（`src/client/remoteOpenRouter.ts`），本轮另把补丁的描述符查找扩展到原型链，类方法形态也能装 |
| root hook 属性要 inject | 0.2.3 起 `uiSession.sessionStatus` 这类 `provideRoot({hooks})` 属性只在 `inject` 声明过才可读，直接读抛 `cannot get property "…" without inject`；该名称同时是服务名 | `src/client/htmlPlan/planActions.ts` 改按服务全名 `ctx.get('uiSession.sessionStatus')` 取，所有嵌套读取经 `probe()` 兜底；新增 `src/client/ui/SideTabBoundary.ts` 就地隔离编辑器子树异常 | 可选服务一律不进 `inject`（旧版 DSH 没有该服务，进了入口会永久停等）；读不到时降级到 `userQuestions` 投影，审批回落到对话卡片。未修前一次读取异常会让 `sidebar.right.pane.tab` 整片空白（计划页与编辑器一起消失） |
| 官方代码审阅扩展位 | `@deepseek-ai/dsh-experimental-client-ui-forge` 的 `forge.changes.toolbar` / `forge.changes.file.menu` 等 slot，与 `ctx.forgeChanges.registerAnnotations()` | 新增 `src/client/officialReview.ts`，在官方变更视图加「在 VSCodeMode 打开」「在编辑器打开」「插入对话草稿」 | slot 服务缺失或注册抛错 → 零注册/跳过，不影响自有 diff 面板；未接行注解与审阅视图（下一批） |
| 官方 MCP 框架接入 | `@deepseek-ai/dsh-mcp-manager` 的 `ctx.mcpManager`（`register/list/watch/restart/startAuthorization/signOut`，条目含 `oauth.credentialKey` 与 `toolLoading`） | 新增 `src/mcpManagerBridge.ts`（端口 + 条目/视图映射 + 凭据键派生）；`mcp.list`/`mcp.snapshot` 合并 manager 托管服务器；新增 `mcp.manager.*` 控制 RPC；表单新增「工具加载（0.2.3+）」开关 | 只做**读状态 + 委派控制**：项目级 `.mcp.json` 仍走插件自有 mcpRuntime（逐 agent 作用域与共享池在 manager 上没有对等物，硬切会丢隔离），迁移列为下一批 |
| 样式产物格式 | 0.2.3 客户端产物把样式改由框架挂载时安装（`meta.stylesheets`） | 本批**保持旧格式**：旧产物仍可加载，代价是热替换后样式残留到刷新 | 自研 `meta.stylesheets` 需要改 `tsdown.config.ts` 与资源 URL 解析，风险大于收益，单列后续 |

**未吸纳并记录理由**：

- `dsh-upstream-skills`：给 CLI 应用插件共用上游技能下载；本插件自带 `skills/` 目录并按
  `SKILL_PREFIXES` 挂载，接入会形成两套来源。
- `ctx.connection.rpc` / `ctx.connection.fetch`：官方新的 host↔client 通道，适合统一鉴权与
  远端配对；迁移要改路由前缀与客户端 URL，与本次 P0 修复叠加风险高。
- 审阅行注解与 `forge.review.conversation`：见上方第 5 行，留作下一批（需先有稳定的注解数据源）。

**验证范围**：`pnpm typecheck` 0 error；目标测试 135 passed / 6 skipped；`pnpm build` 成功。
现场验收（`/edrv/rpc` 200、文件链接、审阅按钮、MCP 状态）需在 DSH 重启后执行，见
`docs/release-0.32.0.md` 的「验收」一节。

## 13. 0.33.0 对 DSH 0.2.3 的吸纳（第二批，2026-11-23）

做完 0.32.0 留作「下一批」的三件事：项目级 MCP 迁到官方 manager 托管、官方变更视图行注解、
客户端样式改 `meta.stylesheets`。

### 13.1 项目 MCP：agent 作用域留在插件侧，挂载原语换 manager.register

| 能力 | 旧路径（连接池） | 新路径（官方 manager） |
| --- | --- | --- |
| 传输挂载 | 私有 scope 里挂 `@deepseek-ai/dsh-mcp-client`（`src/mcpPool.ts:205`） | `ctx.mcpManager.register(name, entry)`，返回 disposer（`src/mcpManaged.ts`） |
| 连接归属 | 逐 agent 实例 + 共享池（`sharing: agent/workspace`） | 注册即启用：一个注册名一条官方实例；`sharing` 在托管路径上不再生效 |
| 工具可见 | 私有 scope 收集后按 agent 重注册代理 | `toolLoading: 'on-demand'`：官方不把工具放进任何会话表；某 agent 调加载器后工具进它自己的 scope |
| 启动时机 | `startup: on-demand`（首次工具调用）/ `background`（会话创建） | 工作区出现首个会话即注册；「首次工具调用才连」无法保留（注册前不存在工具名） |
| 状态 | 池条目 `phase` | `list()` / `watch()` 视图 → 插件状态（`connected/connecting/failed`） |
| 重连 | 重挂载私有 scope | `ctx.mcpManager.restart(name)`（`mcp.projectRefresh` 落到这里） |
| OAuth | 无 | `oauth.credentialKey = mcp-client/vsm-<8 位哈希>`，只有 streamable-http 才登记 |
| 隔离 | 按 agent deny 外部命名空间 + prompt 影子 + 执行守卫 | 同一套机制；归属表多一份「托管注册名 → 工作区」（`runtime.owners()`） |

安装树实测的事实（不是 release notes）：

- `register` 与 `Config.servers` 或既有注册同名即抛；注册条目强制 `enabled: true`，没有
  「注册但禁用」态（`dsh-mcp-manager/src/index.ts:242-259`）。
- `oauth.credentialKey` 必须匹配 `^mcp-client/`（`dsh-mcp-client/src/oauth-options.ts:24`），
  且 OAuth 只能配 `streamable-http`；格式错、跨条目重复、配在 stdio 上都在 `register` 时抛。
- `toolLoading: 'on-demand'` 的加载器把工具注册进调用它的 agent 作用域
  （`tool-loading.ts:127-149`），逐 agent 隔离由官方语义承担。
- `watch(signal)` 是 async iterable，`list()` 同步返回（`:268`、`:220`）。

回落与硬约束：装配时探一次能力（`probeBackend()`），之后固定；托管路径要求旧 loader
项目条目已清空，清理未完就 `forcePool()` 回落连接池并记警告，绝不双写。旧版宿主行为不变。

### 13.2 官方审阅第二批

| 扩展位 | 落点 | 说明 |
| --- | --- | --- |
| `ctx.forgeChanges.registerAnnotations(source)` | `src/client/officialAnnotations.ts` | 行级：会话待审页 → `edrv.review.detail` → 未决差异块 → `{side, startLine, endLine}`；新增/修改落 R 侧、纯删除落 L 侧 |
| `forge.diff.line.annotation`（keyed） | `src/client/officialReview.ts` | key 必须等于注解源 id `dsh-vscode-mode`；注解源注册成功才注册该槽 |
| `forge.diff.comment.actions`（list） | 同上 | 一行「插入对话草稿」，复用加待审能力 |
| `forge.review.conversation`（single） | 不注册 | 官方在 `review-mount.ts:217` 自己注册且是单例，插件再注册会抛 |

同批修正：官方 slot 的组件契约是返回 ReactNode，0.32.0 的两条 slot 返回 DOM 元素
（React 渲染时报错），本批统一改 `React.createElement`。

成本与上限：详情是按条目拉的，一轮最多 40 条、每批并发 4，缓存按「条目 + 修订号」失效；
单文件最多发 8 条块注解。官方按 `annotationLimit` 截断并显示剩余数
（`DiffFile.tsx:222-236`），宿主未报上限时一条都不画。

已知偏差：块的行号来自插件自己的待审差异，不是官方 forge 视图那份 diff；两套来源的
上下文行数可能不同，行号可能整体偏移。因此注解**不带 `digest`**：不冒充「同一份改动」，
也不会进「较早改动」区，宁可画在当前文件上。

### 13.3 客户端样式：meta.stylesheets

- 形状：`window.__ModuleLoader__.load({ id, chunk?, factory, meta })`，`meta` 是工厂，返回
  `{ stylesheets: { '<包内路径>': { text(context) } } }`（`dsh-package-manifest/src/client-module.ts:4-18`）。
- 安装：框架在记录挂载时建 `<style data-plugin="包名" data-path="包内路径">`，记录消失即删
  （`document-styles.ts:155-171`）；热替换后不再残留到刷新。
- 路径：本包文件用 `src/client/...`；node_modules 里的第三方 CSS 统一 `vendor/<包名>/<路径>`，
  不把 pnpm store 哈希写进产物。
- `url()`：`data:`/`blob:`/`http(s):`/片段等自包含地址原样内联；**相对地址构建期直接失败**，
  逼迫改走 `context.asset()`。当前 `editor.css` 只有两处 `data:image/svg+xml` 勾选框图标。
- 自检：`scripts/check-client-artifacts.mjs` 断言每次注册都带 `meta`、路径是包内相对路径、
  `text` 可调用，并断言产物里不再有 `dataset.pluginCss` 自注入。

**本批验证**：`pnpm typecheck` 0 error；目标 15 个测试文件 228 passed / 9 skipped；
`pnpm build` 产出 host + 5 个 chunk，`check-client-artifacts` 通过。现场验收需重启 DSH，
见 `docs/release-0.33.0.md`。

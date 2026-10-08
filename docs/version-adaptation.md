# DSH 版本适配机制（dsh-vscode-mode）

> 更新于 2026-10-08；第 1～7 节记录插件 0.13.0 对 DSH `0.1.7-rc.2` 的历史基线，
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
| Unity bridge | 内嵌包 0.3.0，首次安装自动准备 profile bridge 并写项目 UserSettings hint；UI 覆盖优先 | 不依赖 OS 菜单注册；没有真实 Unity EditMode 验证，不能据编译桩声称完整 Unity 运行通过 |
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
- **运行时告警**：`TESTED_DSH_MAX` 是兼容报告的验证上界，不是 npm peer 区间。
  发布前需将它与最终验收记录一起核对；有限现场通过不意味着所有功能或平台都通过。
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

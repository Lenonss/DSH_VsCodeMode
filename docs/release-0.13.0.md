# dsh-vscode-mode 0.13.0 发布说明

> 发布准备记录，2026-09-28。最终构建、验收与发布结果由发布维护者在发布前更新。
> 基线为已发布的 `v0.12.0`，tag 对应提交 `618fcbb`，该基线 CI 与 GitHub Release 已确认通过。
> 0.13 的 tag、Release 与 npm 状态不能由基线结果推定，见文末待办。

0.13.0 聚焦官方 Desktop/Host 契约适配、项目 MCP 隔离、开发形态恢复，以及文件
从系统/Unity 进入编辑器后的真实完成确认。**用户规则双目录兼容与官方快捷键接管
已在 0.12 发布**；本版是在该基础上修复绑定转换、录制生命周期和首次打开的会话路由。

## 本版变化

### 官方认证、请求体与应用 URL

- `/edrv` 路由在派发前调用官方 `connection.requestRejection(req)`，使用原始请求
  身份信息；认证能力缺失或出错时拒绝请求，不因地址是 localhost 就放行。
- RPC 校验 HTTP 方法、JSON content-type、报文结构与对象参数；Content-Length
  和流式读取的实际字节数均受限，限额计入文本 JSON 转义与二进制 base64 开销。
  与身份相关的响应使用 `no-store`。
- RPC、资源、Monaco/PDF 等 vendor 地址按当前应用 document base 解析，保留
  反向代理部署子路径，并兼容 Desktop 的 `dsh-app:` 来源。旧的固定端口裸 curl
  示例已移除；程序化访问须使用当前已鉴权应用的同源通道。

这些是针对已安装官方接口的适配，不是插件创建了一个新的 DSH 认证 API。

### 项目 MCP：工具、资源与指令共同隔离

项目配置继续以 `.mcp.json` 为持久来源，运行时通过 `agent.ctx.plugin` 挂载官方
MCP 插件。每个活动 agent、每个启用的项目服务各有一个实例；没有活动 agent 时
仅保存配置，不建立后台全局项目连接。

- 启动先移除旧 `vsm-mcp.*` / `vsm-mcp:*` 全局项目条目，再挂载已有 agent；
  新 agent 的串行创建监听等待配置读取与正式插件启动。
- 跨 cwd 子 agent 仍保留原 scope parent 链，但外项目继承工具会被限制；共享
  `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 按
  `arguments.server` 检查归属，不能借共享工具读取父工作区资源。
- 外项目 `mcp:<server>` 指令在子 scope 中被空段覆盖；公开 prompt assembly
  通道按实际查看 scope 过滤官方资源列表，同时保留全局与独立 agent preset
  的资源服务，包括没有工具的纯资源服务。
- 变更、刷新、禁用、删除、agent/插件卸载会释放相应 fiber 与连接；reconcile
  尊重 `disabled`。只有 ENOENT 代表缺少配置，读取/解析/结构错误保留最后有效实例。
- 保存保留未知字段与未改动高级参数；原有 `env`/`headers` 的脱敏掩码恢复原值，
  没有原值的新掩码键会拒绝保存。

| 状态/字段 | 含义 |
|---|---|
| `configured` | 已保存，无挂载实例；打开匹配工作区的 agent 后挂载 |
| `disabled` | 配置停用 |
| `connecting` | 插件启动尚未完成 |
| `unverified` | fiber 已激活，但没有公开实时连接状态证据 |
| `instanceCount` | 挂载的官方插件 fiber 数，不是确认存活的网络连接数 |
| `toolCount: 0` | 可为合法纯资源服务器，不能单独判断失败 |

官方 `failOnStartupError` 默认 false，因此 ACTIVE 本身不能证明握手成功。全局
「我的 MCP」仍使用原 loader CRUD；管理面名称检查也覆盖无 agent/已禁用的项目配置。
完整用法见 [MCP 技能](../skills/dsh-vscodemode-mcp/SKILL.md)。

### profile 定位、开发形态与子进程

- 使用官方 `profileContext.dir` 定位当前运行 profile；旧宿主只接受唯一候选回退。
  不按目录名、固定 `web` profile 或随机扫描结果猜测写入目标。
- 开发形态切换校验源码目录和包身份，写入前保存 manifest、lockfile 与原插件
  安装入口。安装失败尝试恢复原字节和链接身份；恢复失败保留备份并报告位置。
  该恢复范围不等于整个 `node_modules` 的完整快照回滚。
- 优先使用官方 profile 提供的 packageManager 程序、参数和显式环境，支持
  Desktop 随附的执行方式；旧宿主才回退 PATH。成功切换按 `restart` 提示重启。
- `childEnv` 按变量名去除父环境中 KEY/PASSWORD/SECRET/TOKEN 与 `DSH_*` 等隐式
  信息，然后合并用户显式环境。它不是对任意秘密值的通用识别器，显式配置仍会传递。
- LSP/DAP 等进程清理收敛为 Windows 进程树与 POSIX 独立进程组处理。回收是
  **best effort**，受系统权限、进程脱离/重挂等条件限制。

### 快捷键与按会话首次打开

0.12 已引入官方快捷键目录、编辑与迁移；0.13 修正官方返回的 normalized 绑定
与物理控制键的映射，避免 Control/Meta 被错误折叠。录制先进入官方 recording
状态，并在完成、取消、失败、失焦或组件清理时收尾；命令面板、QuickOpen 等首次
入口按当前会话 scope 路由，避免要求编辑器预先挂载。

Web 工作区搜索按官方当前平台允许的三修饰符组合注册；实际键位、冲突和未绑定
状态以「设置 → 快捷键」的官方目录为准。本文不把旧 `Ctrl+Shift+F` 写成所有平台
通用默认；最终平台键位仍列入发布前复核。

### 系统与 Unity 打开：私有 OPEN 请求与真实 ACK

C#、PowerShell、Bash launcher 与 Unity 包共用 `dsh-open.mjs` producer：

1. 读取所选 profile 的桥接元数据，向当前用户私有队列提交限定类型的 OPEN 请求。
2. Host 接收后由客户端领取带 lease 的请求，按工作区与会话路由到目标文件。
3. 只有**目标路径对应的实际 Monaco model 或预览内容加载成功**，才提交匹配
   请求与 lease 的成功 ACK；仅发事件、创建页签、展开侧栏或领取请求都不算成功。
4. producer 核对 profile、请求身份与时效；失败、取消或超时不会被报告为打开成功。

此链路无需 launcher/Unity 持有 Host Cookie，也不依赖固定 HTTP 端口。需要唤起时，
Desktop 使用官方 `dsh://open`，Web 使用已选择的完整应用地址。旧 `edrvOpen`
URL 参数只保留兼容入口，不是当前 launcher 主链，也不是认证绕过通道。

**OS 菜单由用户管理**：注册/移除须在设置页显式执行；reload/更新只升级已经注册
的 launcher 文件与配置，不重新注册或自动撤销系统菜单。需要清理菜单时应在卸载
插件前显式移除。

**Unity 内嵌包升级为 0.3.0**：首次安装/更新自动准备当前 profile 的独立 bridge，
并写入 `<项目>/UserSettings/dsh-editor.ini`；不要求先注册 OS 菜单。配置优先级为
Unity UI 显式覆盖 → 项目 hint → hint 缺失时旧 shell 配置回退。损坏 hint 会报错，
不会悄悄改选另一 profile。UserSettings hint 含本机路径，不作为团队共享凭据或
可移植项目配置。文本白名单与 Prefab/场景原生处理边界保持不变。

## 迁移与部署

1. **确认目标 profile 与备份。** 从当前应用确认实际 profile。保存该 profile 的
   manifest、lockfile、用户 patch，以及需要保留的项目 `.mcp.json`；外部打开用户
   另记录当前 launcher/bridge 配置与 Unity UserSettings hint。按原权限保存备份。
2. **安装已经发布的 0.13.0 产物。** 使用 [README 安装方式](../README.md#安装)，
   将示例 `web` 替换为实际目标 profile。生产安装使用 tag/Release 或已发布 npm 包；
   不把临时开发链接视为正式发布结果。
3. **重启 Host 并刷新原应用入口。** 本版包含 Host 生命周期与路由变化，单独刷新
   浏览器不能替换内存中的 Host 代码。保持原 Desktop/反向代理应用地址，不通过
   新起另一个服务器证明原应用已更新。
4. **检查项目 MCP 迁移。** 新版启动自动清理旧全局项目条目，以 `.mcp.json` 恢复
   agent 挂载；禁用配置继续禁用。无活动 agent 的 configured/0 实例是正常状态。
   不要为了让卡片显示实例数而手工恢复旧全局项目 entry。
5. **检查外部打开和 Unity。** 已注册菜单只升级文件；无菜单的 Unity 项目可直接
   在设置页安装/更新 0.3.0，确认项目 hint 指向所选 profile bridge。若要新建或删除
   OS 菜单，请显式操作。换机器/profile 后重新配置本机 hint，不沿用他人的绝对路径。
6. **验证用户流程。** 依次核对文件打开与行列、实际保存、文本/图片/PDF 等相关
   预览、设置读写、MCP 作用域及快捷键录制。具体范围和结果填写下方清单。

如果开发形态切换失败且自动恢复成功，保留原安装形态继续排查；若报告恢复失败，
使用错误中的备份目录核对并恢复当前 profile 的原文件与入口，不删除唯一备份。

## 回滚到 0.12

- 已发布回退基线为 `v0.12.0`（`618fcbb`）。通过原 profile 的官方插件管理方式
  安装对应 tag/Release 产物，随后重启 Host、刷新原应用。
- 先核对升级后新增或修改的配置，再按备份恢复相应项。不要把另一个 profile 的
  manifest/lockfile覆盖到当前 profile，也不要递归删除开发链接指向的源码。
- 0.13 私有 OPEN producer 依赖新版 Host 消费端与 ACK。回退后若仍需外部打开，
  显式安装/注册与回退版本匹配的 launcher 和 Unity 包；只回退 npm 包不保证外部
  bridge 文件自动回到旧协议。OS 菜单注册仍是用户操作，不作为自动回滚副作用。
- **回退 0.12 会失去本版项目 MCP 工具/资源/指令三面隔离保证。** 在多工作区
  环境重新核对项目 MCP 启用范围；不要把“旧版能连接”当成“保留新版隔离边界”。
- 0.13 未对项目 `.mcp.json` 引入必须执行的破坏性格式迁移；未知字段被保留。
  应结合配置备份恢复用户意图，而不是清空文件来迫使旧版启动。

## 依赖与兼容性说明

本轮扩展了 peer 范围的真实 SemVer 校验，同时区分 npm 默认预发布规则和 DSH gate
的 `includePrerelease` 判据。新增 `semver@7.8.5` 用于开发测试；lockfile 中还存在
schema/cosmokit 去重变化，**不是把 DSH 依赖包整体升级到了 rc.2**。

旧 devDependency 混线产生的 peer warnings 是既有依赖树现象。实际 Host 模块通过
运行入口锚定 `0.1.7-rc.2`；既不能用警告替代运行证据，也不能因本机锚点正确就宣称
所有安装形态都已现场通过。详细历史与适配入口见 [版本适配文档](version-adaptation.md)。

## 已有证据与真实边界

| 范围 | 已记录事实 | 不能扩大解释为 |
|---|---|---|
| Windows 官方已签名打包 Desktop | 隔离启动（`app.isPackaged=true`、协议注册仅记录不执行）；插件进入 boot entries、loader `live`；未捕获未处理异常；`mcp.list` / `vscode.devFormGet` / `compat` 同源 200；Config volatile 15/15；兼容性警告 0 | 所有编辑保存、全部预览、设置写回与快捷键录制已逐项验收 |
| 外部打开（私有队列） | 真实投递 → 宿主消费 → 客户端领取并唤起编辑器 → 目标未就绪时**如实回失败 ACK**（`success:false`），投递方立即得到明确错误而非静默超时 | 隔离实例中一次成功打开已复现（无会话/工作区时编辑器未呈现目标文件）；成功 ACK 契约由单测覆盖 |
| profile 定位 | 宿主在正确的 `profiles/desktop` 下创建私有队列；同一 profile 的正/反斜杠书写被识别为同一实例 | 所有历史 profile 形态组合都已现场遍历 |
| 项目 MCP | 有定向自动化覆盖，以及真实官方模块/本地 HTTP MCP 的隔离测试路径 | 自动化代替最终发布树、所有实际 MCP 服务端或完整 GUI 验收 |
| Unity 0.3.0 | C# 编译桩与 9 项 hint 探针；自动 bridge/hint 路径已形成 | **真实 Unity EditMode/资源双击/Console 跳转已现场通过** |
| Linux/macOS | 代码包含平台分派与对应自动化分支 | **本轮已经完成 Linux/macOS 现场验证** |
| 0.12 基线 | tag `618fcbb`、CI、GitHub Release 已通过 | 0.13 的 CI、Release 或 npm 已上线 |

## 发布验证记录（2026-09-28）

| 检查 | 实际结果 |
|---|---|
| 版本与基线 | 包 `0.13.0`；基线 `v0.12.0` @ `618fcbb`（CI 与 Release 均 success） |
| 类型检查 | `tsc -p tsconfig.json --noEmit` → exit 0 |
| 全量 JS/TS 测试 | `vitest run` → **176 文件通过 + 2 跳过；2337 通过 + 13 跳过**，16.8s |
| 定向验证 | 认证路由与请求上限、profile 身份归一、私有队列回执、回执监视、SVN 会话工具、peer 版本区间等定向用例全绿 |
| 构建 | Host `lib/index.js` 724.67 kB；client `lib/client.js` 1.49 MB |
| 打包 | `npm pack` → 582 项；Host/client 入口、`cordis.patch.yml`、locale、技能、launcher（含 `dsh-open.mjs`）、Unity 包、Monaco/PDF vendor 全部在包内；临时 tgz 已清理 |
| 官方 Desktop 现场 | 0.1.7-rc.2 已签名包，隔离 home/userData，插件装配与三个同源接口均通过；无异常、无快捷键冲突告警 |
| 外部打开链路 | 真实投递 → 消费 → 领取 → 唤起 → 失败如实回执（见上表边界） |
| Unity | C#5 编译与 hint 探针通过；**未**运行真实 Unity EditMode |
| Linux/macOS | **未**现场验证 |

发布走仓库既有 tag → GitHub Actions 流程，不在本地直接 `npm publish`。本文件
记录发布准备与验收边界，不授权额外部署、OS 注册或外部消息操作。

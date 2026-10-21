---
name: dsh-vscodemode-mcp
description: 配置、新增、启用或排查 dsh-vscode-mode 的 MCP 服务：全局「我的 MCP」、项目 .mcp.json、agent 连接实例、工具/资源/指令隔离、mcp.* RPC、命名冲突与连接状态。
whenToUse: 用户要求新增、修改、启停或排查 VSCodeMode MCP 配置，或判断项目工具、资源、服务器指令为何不可见或被拒绝时。
---

# dsh-vscodemode-mcp — MCP 配置与使用

本技能覆盖 dsh-vscode-mode 的 MCP 管理面。连接由 DSH Host 内的官方 `@deepseek-ai/dsh-mcp-client` 插件维护；浏览器只管理配置。

## 1. 先确定作用域

| 项目 | 全局「我的 MCP」 | 项目 MCP |
|---|---|---|
| 持久配置 | profile loader 树 | 已注册 workspace 根目录的 `.mcp.json` |
| 生效范围 | profile 内所有工作区 | cwd 匹配该 workspace 的 agent |
| 运行方式 | 原有全局 loader entry | 私有连接 scope + 会话授权代理，复用官方 MCP 插件 |
| 连接实例 | 每个启用的全局 entry 一份 | 默认逐 agent 隔离；显式选择 workspace 后工作区复用 |
| 没有活动 agent | 仍可运行 | 仅保存配置，`configured`、`instanceCount: 0` |
| 团队共享 | 否 | `.mcp.json` 可以随仓库共享 |

用户说「全局都能用」选全局；说「这个项目需要」「跟仓库一起提交」选项目级。工作区匹配使用最长父路径；Windows 路径忽略大小写，POSIX 路径区分大小写。

## 2. UI 与连接语义

设置 → VSCodeMode → MCP 管理，包含「我的 MCP」「项目 MCP」「MCP 市场」（占位）。项目服务在所选项目内管理。

保存项目服务会写入 `.mcp.json` 并更新匹配 agent 的能力目录与惰性资源入口。新建会话只等待配置准备和轻量入口，不等待任何项目 MCP 握手；默认 `on-demand`，未使用不启动。显式 `background` 后台预热也不阻塞创建。同一 Host 最多两个冷启动；同代次初始化 single-flight。配置写操作仍串行保护，但连接准备不占有跨会话全局锁。

AI 先调用全局发现入口 `discover_project_mcp {action:"list"}`，仅返回执行 agent 工作区内的安全目录；需要时 `{action:"connect",serverName:"..."}` 连接并返回真实 schema。入口从工具执行上下文取 agent，不接受 sessionId、路径、命令、URL 或凭据。真实工具依然走官方审批、guard 和结果投影；Native 在下一次请求获得工具，PTC 必须结束当前程序后新建程序刷新 SDK，禁止 eval 或通用透传绕过权限。资源工具可通过所属工作区的惰性 provider 按需连接。

禁用、删除、配置变更、刷新重连及 agent/插件卸载都会释放相应 fiber 和连接。仅刷新未变化的项目列表不会重复连接。主机代码更新需要重启 DSH 才能加载新实现。

管理页首次加载配置，之后仅在 MCP 页签可见且文档可见时每 2.5 秒读取 `mcp.snapshot`；单次读取 10 秒截止，不重叠、不在卸载后回写。快照只读运行台账，不读项目文件、不 reconcile、不额外建连。外部文件变更通过显式刷新/重新打开设置或新 agent 加载；快照不是文件监听器。配置写操作串行保护读取—修改—写入与跨作用域命名保留。

表单 stdio 参数采用 JSON `string[]` 或每行一个完整参数，不按空格/引号做 shell 拆分；含空参数或内嵌换行使用 JSON。HTTP 请求头每行 `key=value`，保留值内的等号，拒绝非法/重复（忽略大小写）键。失败保存保持表单，忙时禁止重复动作。

### 会话列表状态

官方 `sidebar.session.row.leading` 插槽在会话标题前显示 16px 加载或异常图标；平稳完成不常驻绿色成功标。官方运行中、待审批、新消息状态优先覆盖 leading，归档行不展示 leading；`sidebar.session.row.hover` 悬浮详情仍可查看。

详情只描述 VSCodeMode 管理的**项目 MCP**：待使用（不转圈）、读取配置、等待启动名额、加载插件模块、等待服务插件启动、复用已有连接、释放旧实例、完成或异常，展示完成数、耗时与安全错误摘要。共享显示会话本次等待，不将连接年龄冒充本次等待。超过 10 秒仅提示耗时较长，不判定失败。完成文案为「初始化完成，连接健康未验证」。无活跃 agent 文案为「当前无活跃 MCP 实例」，不是成功；不包含全局或 preset MCP。

所有可见行共用一份 `mcp.sessionSnapshot` 订阅，在文档可见且有消费者时按 2.5 秒间隔查询；请求 10 秒截止、不重叠，隐藏/退订/卸载取消，过期响应丢弃。错误保留上次快照并标过期。查询只读内存，**不读配置、不 reconcile、不激活/保留历史会话、不建立连接**；旧 Host 或缺少插槽时安全降级。错误详情不返回 env、headers、完整配置或凭据 URL，仅返回安全类别提示，原始诊断看 Host 日志。

## 3. 项目配置

`.mcp.json` 示例：

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp", "--path", "D:/Work/MyProject"]
    },
    "remote-tools": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "toolCallTimeoutMs": 60000,
      "reconnect": { "enabled": true }
    }
  }
}
```

- 有字符串 `url` 采用 `streamable-http`；其余采用 `stdio`。文件不用写 `transport`。
- stdio：`command` 必填；可填 `args`、`cwd`、`env`。未指定 `cwd` 时，以项目根作为进程工作目录。
- HTTP：`url` 必须以 `http://` 或 `https://` 开头，可填 `headers`。
- 高级参数：`toolCallTimeoutMs`、`failOnStartupError`、`maxInstructionBytes`、`reconnect`。
- 项目扩展 `vscodeMode: { startup: "on-demand" | "background", sharing: "agent" | "workspace", startupTimeoutMs: 60000 }` 与官方传输配置分离，不透传；默认 on-demand + agent，旧文件不批量改写。初始化预算接受 1000–300000 整数，不是业务调用超时。全局配置不接受项目扩展。
- workspace 共享必须显式确认服务适合共享内部状态；不会自动给 CodeGraph 开启。池键含工作区、有效配置和策略，凭据只做内存摘要身份。共享调用默认串行，最后租约释放保温 60 秒；agent 模式立即释放。禁用/删除/刷新/配置变化先失效与撤销再关闭，关闭未确认则阻止替代。超时显示释放阶段，失败冷却 5 秒后允许显式重试，不无限自动重试。
- `disabled: true` 保持配置但不创建连接；保存表单会恢复启用。重启和 reconcile 都尊重 `disabled`。
- 保存保留文档顶层、其他服务器及当前服务器的未知字段和未编辑高级参数；切换传输方式会移除旧传输专属字段。
- `env` / `headers` 在返回值中使用 `••••••` 脱敏。原键的未修改掩码保存时恢复真实值；新键只有掩码而没有原值时会拒绝保存，需填写凭据。
- 配置不存在只认结构化错误码：官方 fs 的 `FS_NOT_FOUND` 与兼容旧后端的 `ENOENT`；缺失的可选配置按空服务处理，不写空文件，不阻断其他项目的重名检查。权限、IO、JSON 或结构错误会报告 `fileError`，保留最后有效配置与活动连接，不覆盖损坏文件。

全局配置继续使用官方 loader entry：

```yaml
- id: mcp-example
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: codegraph
    transport: stdio
    command: codegraph
    args: ['serve', '--mcp']
```

优先使用设置页或 RPC，保证冲突检查和运行状态同步。

## 4. RPC

`POST /edrv/rpc`，请求 `{ "method": "...", "args": { ... } }`，返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。

| 方法 | 入参 | 成功返回字段 |
|---|---|---|
| `mcp.list` | `{}` | `servers` |
| `mcp.snapshot` | `{}` | `servers`, `projects`（只读运行快照） |
| `mcp.sessionSnapshot` | `{}` | `sessions`, `sampledAt`（按 sessionId 区分的活跃初始化状态，只读内存） |
| `mcp.save` | `{ config }` | `server` |
| `mcp.remove` | `{ id }` | 无 |
| `mcp.toggle` | `{ id, enabled }` | `server` |
| `mcp.refresh` | `{ id }` | `server` |
| `mcp.projects` | `{}` | `projects` |
| `mcp.projectSave` | `{ workspacePath, serverName, config, policy? }` | `project` |
| `mcp.projectConnect` | `{ sessionId, workspacePath, serverName }` | `project`（仅已活跃匹配会话，不激活历史会话） |
| `mcp.projectRemove` | `{ workspacePath, serverName }` | `project` |
| `mcp.projectToggle` | `{ workspacePath, serverName, enabled }` | `project` |
| `mcp.projectRefresh` | `{ workspacePath, serverName }` | `project` |

`MpcServer` 包括 `id`、`serverName`、`enabled`、`transport`、脱敏 `config`、`status`、`instanceCount`、`toolCount`、`tools[]`、可选 `error`。项目视图另有 `workspacePath`、`title`、`source: 'project'`，以及可选 `missingDir`、`fileError`。

## 5. 命名与迁移

- `serverName` 使用 `/^[A-Za-z0-9_-]{1,32}$/`；允许下划线，与技能名规则不同。
- VSCodeMode 管理的全局和所有项目配置之间名称唯一，包括未启用和没有活动 agent 的配置。官方 MCP 还会拒绝同一个 agent scope 中的重复名称。
- 工具名是 `mcp__<serverName>__<原始工具名>`。共享资源工具通过 `arguments.server` 选择服务器。
- 不同服务名称不得以 `__` 形成前缀交叠，例如 `alpha` 与 `alpha__nested`：原始工具名也允许 `__`，官方编码不能唯一反解，不能靠最长前缀猜归属。保存与 reconcile 双向检查全局/所有项目（含禁用项）；历史歧义工具执行时 fail-closed 且不计入任何服务。独立含 `__` 的名称仍合法。
- 项目稳定 id 仍是 `vsm-mcp.<workspaceHash>.<serverName>`，用于 UI/RPC 身份；0.13 起不再代表全局 loader entry。
- 启动迁移会先删除旧的 `vsm-mcp.*` 和 `vsm-mcp:*` 全局项目条目及其连接，再在 agent scope 挂载。不要手动将项目条目改成其他 id。
- 项目写操作只接受已注册 workspace，目标固定为该根目录的 `.mcp.json`。

## 6. 工具、资源和指令隔离

官方 0.1.7-rc.2 的 MCP Config 没有关闭资源/指令的开关；官方注册随 `scopeOf(ctx)` 归属。因此连接在独立 scope 中隔离 tools、mcpResources、systemPrompt，捕获注册后再给合法 agent 提供代理，绝不将原始项目注册暴露全局。创建私有 scope 后先等待 backing fiber 初始激活完成再 provide，防止依赖服务丢失；真实官方模块测试覆盖此边界。

子 agent 会继承父 scope；跨 cwd 子会话还有三层处理：

- `tools.restrict({ deny })` 隐藏继承的外项目工具；执行 guard 同时检查所有项目工具命名空间。
- `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource` 在执行前检查 `arguments.server` 归属，不能通过共享工具访问父工作区资源。
- 子 scope 为外项目 `mcp:<serverName>` 注册空指令段；通过公开 `system-prompt/assemble` waterfall 按实际查看 scope 过滤官方资源服务器列表，保留全局和独立 agent preset 的纯资源服务。不会改动 scope parent 链。官方 0.1.7-rc.2 列表格式已验证；外项目存在且列表格式无法识别时，安全隐藏该提示列表，执行 guard 仍独立生效。

全局 MCP 保持可用。工作区外的 agent 不能访问任何项目 MCP。拒绝文案：

- `已拒绝：当前对话工作区不能使用其他项目的 MCP`
- `项目 MCP 需要在已注册工作区的对话中使用`

## 7. 状态与排错

| 状态/现象 | 含义与处理 |
|---|---|
| `configured` | 中性色；配置已保存，尚无连接实例，首次发现/资源访问或显式手动连接才启动（background 策略除外） |
| `disabled` | 配置已停用，不建立项目连接 |
| `connecting` | 官方插件还在等待启动完成；检查命令、cwd、URL 和握手 |
| `unverified` | 中性色；fiber 已激活，但官方没有公开连接状态证据，不能宣称已连接；右侧绿色开关只表示启用 |
| `error` | 插件启动或挂载失败；读 `error` 与 Host 日志 |
| `instanceCount: N` | N 个挂载的官方插件 fiber，**不等于 N 个确认存活的网络连接** |
| `toolCount: 0` | 可能是合法的纯资源服务器，也可能启动失败或工具同步失败；结合资源调用和日志判断 |
| 文件读取/解析错误 | 修复源文件后刷新；最后有效实例保持运行 |
| 工作区不匹配 | 检查 agent cwd 和最长父路径匹配结果 |

`failOnStartupError` 默认 false：初次连接失败时 fiber 仍可能 ACTIVE。工具数和 ACTIVE 都不能单独证明连接成功；只有实际成功调用等公开证据才能确认。当前管理面保守使用 `unverified`。

## 8. 维护位置与验证

- `src/mcpRuntime.ts`：会话租约/能力台账、官方模块加载、非阻塞接入、迁移与卸载。
- `src/mcpPool.ts`：独立连接、single-flight、并发名额、取消/超时/保温和代次围栏。
- `src/mcpBridge.ts`：私有服务隔离、真实工具代理、动态列表和撤销。
- `src/mcpDiscover.ts`：统一发现入口与按 scope 输出的能力目录。
- `src/mcpProject.ts`：源配置读取、保留字段、命名检查及 reconcile。
- `src/mcpIsolation.ts`：继承工具限制、资源执行 guard、指令和资源列表覆盖。
- `src/mcp.ts`：全局 loader CRUD、脱敏与诚实状态。
- `src/shared/mcp.ts`：共享配置和状态契约。

集成时先 `installIsolation(ctx)`，再 `await installMcpRuntime(ctx)`。UI 需支持 `configured`、`unverified` 和实例数。最小回归只运行 MCP 相关测试；可设置 `DSH_MCP_HOST_ROOT` 为安装的 harness 根来运行真实官方模块与本地 HTTP MCP 测试，未设置时该集成用例跳过。

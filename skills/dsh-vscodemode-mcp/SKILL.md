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
| 运行方式 | 原有全局 loader entry | `agent.ctx.plugin(officialMcp, config)` |
| 连接实例 | 每个启用的全局 entry 一份 | 每个活动 agent、每个启用服务一份 |
| 没有活动 agent | 仍可运行 | 仅保存配置，`configured`、`instanceCount: 0` |
| 团队共享 | 否 | `.mcp.json` 可以随仓库共享 |

用户说「全局都能用」选全局；说「这个项目需要」「跟仓库一起提交」选项目级。工作区匹配使用最长父路径；Windows 路径忽略大小写，POSIX 路径区分大小写。

## 2. UI 与连接语义

设置 → VSCodeMode → MCP 管理，包含「我的 MCP」「项目 MCP」「MCP 市场」（占位）。项目服务在所选项目内管理。

保存项目服务会写入 `.mcp.json` 并更新匹配的活动 agent；没有活动 agent 时保存为待挂载配置。启用不会凭空创建会话。每个新 agent 的串行 `agent/created` 监听会读取最新配置并等待其官方插件启动；插件装配时也会接入已经存在的 agent。

禁用、删除、配置变更、刷新重连及 agent/插件卸载都会释放相应 fiber 和连接。仅刷新未变化的项目列表不会重复连接。主机代码更新需要重启 DSH 才能加载新实现。

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
- `disabled: true` 保持配置但不创建连接；保存表单会恢复启用。重启和 reconcile 都尊重 `disabled`。
- 保存保留文档顶层、其他服务器及当前服务器的未知字段和未编辑高级参数；切换传输方式会移除旧传输专属字段。
- `env` / `headers` 在返回值中使用 `••••••` 脱敏。原键的未修改掩码保存时恢复真实值；新键只有掩码而没有原值时会拒绝保存，需填写凭据。
- 只有 `ENOENT` 表示配置不存在。权限、IO、JSON 或结构错误会报告 `fileError`，保留最后有效配置与活动连接，不覆盖损坏文件。

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
| `mcp.save` | `{ config }` | `server` |
| `mcp.remove` | `{ id }` | 无 |
| `mcp.toggle` | `{ id, enabled }` | `server` |
| `mcp.refresh` | `{ id }` | `server` |
| `mcp.projects` | `{}` | `projects` |
| `mcp.projectSave` | `{ workspacePath, serverName, config }` | `project` |
| `mcp.projectRemove` | `{ workspacePath, serverName }` | `project` |
| `mcp.projectToggle` | `{ workspacePath, serverName, enabled }` | `project` |
| `mcp.projectRefresh` | `{ workspacePath, serverName }` | `project` |

`MpcServer` 包括 `id`、`serverName`、`enabled`、`transport`、脱敏 `config`、`status`、`instanceCount`、`toolCount`、`tools[]`、可选 `error`。项目视图另有 `workspacePath`、`title`、`source: 'project'`，以及可选 `missingDir`、`fileError`。

## 5. 命名与迁移

- `serverName` 使用 `/^[A-Za-z0-9_-]{1,32}$/`；允许下划线，与技能名规则不同。
- VSCodeMode 管理的全局和所有项目配置之间名称唯一，包括未启用和没有活动 agent 的配置。官方 MCP 还会拒绝同一个 agent scope 中的重复名称。
- 工具名是 `mcp__<serverName>__<原始工具名>`。共享资源工具通过 `arguments.server` 选择服务器。
- 项目稳定 id 仍是 `vsm-mcp.<workspaceHash>.<serverName>`，用于 UI/RPC 身份；0.13 起不再代表全局 loader entry。
- 启动迁移会先删除旧的 `vsm-mcp.*` 和 `vsm-mcp:*` 全局项目条目及其连接，再在 agent scope 挂载。不要手动将项目条目改成其他 id。
- 项目写操作只接受已注册 workspace，目标固定为该根目录的 `.mcp.json`。

## 6. 工具、资源和指令隔离

官方 0.1.7-rc.2 的 MCP Config 没有关闭资源/指令的开关；官方注册随 `scopeOf(ctx)` 归属。因此项目连接必须直接在 `agent.ctx` 挂载，不能全局连接后只隐藏工具。

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
| `configured` | 配置已保存，没有已挂载实例；打开匹配工作区会话后挂载 |
| `disabled` | 配置已停用，不建立项目连接 |
| `connecting` | 官方插件还在等待启动完成；检查命令、cwd、URL 和握手 |
| `unverified` | fiber 已激活，但官方没有公开连接状态证据；不能宣称已连接 |
| `error` | 插件启动或挂载失败；读 `error` 与 Host 日志 |
| `instanceCount: N` | N 个挂载的官方插件 fiber，**不等于 N 个确认存活的网络连接** |
| `toolCount: 0` | 可能是合法的纯资源服务器，也可能启动失败或工具同步失败；结合资源调用和日志判断 |
| 文件读取/解析错误 | 修复源文件后刷新；最后有效实例保持运行 |
| 工作区不匹配 | 检查 agent cwd 和最长父路径匹配结果 |

`failOnStartupError` 默认 false：初次连接失败时 fiber 仍可能 ACTIVE。工具数和 ACTIVE 都不能单独证明连接成功；只有实际成功调用等公开证据才能确认。当前管理面保守使用 `unverified`。

## 8. 维护位置与验证

- `src/mcpRuntime.ts`：agent → fibers 台账、官方插件加载、串行创建、迁移与卸载。
- `src/mcpProject.ts`：源配置读取、保留字段、命名检查及 reconcile。
- `src/mcpIsolation.ts`：继承工具限制、资源执行 guard、指令和资源列表覆盖。
- `src/mcp.ts`：全局 loader CRUD、脱敏与诚实状态。
- `src/shared/mcp.ts`：共享配置和状态契约。

集成时先 `installIsolation(ctx)`，再 `await installMcpRuntime(ctx)`。UI 需支持 `configured`、`unverified` 和实例数。最小回归只运行 MCP 相关测试；可设置 `DSH_MCP_HOST_ROOT` 为安装的 harness 根来运行真实官方模块与本地 HTTP MCP 测试，未设置时该集成用例跳过。

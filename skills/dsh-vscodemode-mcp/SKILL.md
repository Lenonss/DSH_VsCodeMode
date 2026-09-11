---
name: dsh-vscodemode-mcp
description: 配置、新增、启用或排查 dsh-vscode-mode 插件（VSCodeMode 设置页）的 MCP 服务——全局「我的 MCP」与项目级 `.mcp.json` 两种作用域、stdio / streamable-http 传输写法、`mcp.*` RPC 方法、serverName 命名与冲突规则、项目 MCP 的工作区隔离边界，以及连接失败/工具数为 0 等故障的定位路径。当用户提到「加个 MCP」「配置 MCP」「MCP 连不上」「项目 MCP」「.mcp.json」「VSCodeMode 的 MCP 管理」时加载本技能。
whenToUse: 用户要求新增/修改/启停/排查 dsh-vscode-mode 的 MCP 服务配置时；或需要判断某个 MCP 工具为何在对话中不可见/被拒绝时。
---

# dsh-vscodemode-mcp — dsh-vscode-mode 的 MCP 配置与使用

本技能覆盖 **dsh-vscode-mode 插件**（DSH 上的类 VSCode 编码体验）提供的 MCP 可视化管理能力。
它管理的是 `@deepseek-ai/dsh-mcp-client` 的 loader 条目，连接由 DSH Host 维护，**不在浏览器侧连接 MCP**。

## 1. 两种作用域（先判断用户要哪一种）

| | 全局「我的 MCP」 | 项目 MCP |
|---|---|---|
| 配置位置 | profile 的 loader 树（`~/.dsh/profiles/<profile>/cordis.yml`） | 项目根 `.mcp.json` 的 `mcpServers` |
| 生效范围 | 该 profile 下所有工作区 | 仅该 workspace（+ 其子路径可匹配到的工作区） |
| 随仓库共享 | 否 | 是（`.mcp.json` 入库即团队共享） |
| 持久真相 | loader 条目 | `.mcp.json` 文件（重启后由插件 reconcile 恢复激活） |
| 受工作区隔离约束 | 否 | **是**（见 §5） |

判断规则：
- 用户说「全局都能用」「所有项目都要」→ 全局。
- 用户说「这个项目需要」「跟仓库一起提交」→ 项目级。
- 不确定且该 MCP 只在某个仓库有意义 → 默认项目级。

## 2. UI 路径

设置 → **VSCodeMode** → **「MCP 管理」** Tab，其下三个子页签：

- **我的 MCP** — 全局服务列表（可查看状态/工具、添加、刷新 ⟳、启用/禁用、删除 ⌫）。
- **项目 MCP** — 先选项目（带路径与 MCP 计数），再管理该项目的服务。
- **MCP 市场** — 占位，暂未接入。

「+ 添加全局 MCP」按钮在子页签栏右侧；项目 MCP 的新增入口在所选项目的分组内。
表单字段：名称 / 传输方式 / （stdio）命令·参数·工作目录 / （streamable-http）URL·请求头。
按钮文案为「保存并连接」——**保存后会立刻尝试连接**。

## 3. 配置写法

### 3.1 项目级 `.mcp.json`

对齐 Claude Code / Cursor 格式，存于项目根：

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
      "toolCallTimeoutMs": 60000
    }
  }
}
```

规则（`src/mcpProject.ts` 的 `configFromDef`）：
- **有 `url` → `streamable-http`；无 `url` → `stdio`**。传输方式由字段形态自动判定，不写 `transport`。
- stdio 字段：`command`（必填）、`args`（数组）、`cwd`、`env`（键值对象）。
- http 字段：`url`（必填，须 `http(s)://`）、`headers`（键值对象）。
- 可选：`toolCallTimeoutMs`（数字）。
- `disabled: true` = 停用（由启停开关维护；**保存时不会写这个键，保存恒为启用**）。
- 顶层可有其他字段，写回时保留；`mcpServers` 之外的未知字段不丢。

### 3.2 全局（等价配置形）

全局条目等价于 profile loader 里的一行 `@deepseek-ai/dsh-mcp-client`：

```yaml
- id: <条目 id>
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: codegraph
    transport: stdio
    command: codegraph
    args: ['serve', '--mcp']
```

但 **优先用设置页 UI 或 `mcp.save` RPC**，不要手改 profile 的 `cordis.yml`：UI/RPC 会同步触发 loader 热更新与冲突校验，手改容易产生重复条目。

### 3.3 两个最小可用示例

stdio（本地命令行 MCP，如 CodeGraph）：
```
名称: codegraph
传输方式: stdio
命令: codegraph
参数: serve --mcp --path D:/Work/MyProject
```

streamable-http（远端/已启动的 HTTP MCP）：
```
名称: remote-tools
传输方式: streamable-http
URL: http://localhost:3000/mcp
请求头: Authorization=Bearer <token>
```

## 4. RPC 方法表（UI 之外的程序化入口）

路由：`POST /edrv/rpc`，报文体 `{ "method": "...", "args": { ... } }`，返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。

| 方法 | 入参 | 返回 |
|---|---|---|
| `mcp.list` | `{}` | `{ servers: MpcServer[] }` |
| `mcp.save` | `{ config: MpcConfig }` | `{ server: MpcServer }` |
| `mcp.remove` | `{ id }` | `{}` |
| `mcp.toggle` | `{ id, enabled }` | `{ server: MpcServer }` |
| `mcp.refresh` | `{ id }` | `{ server: MpcServer }` |
| `mcp.projects` | `{}` | `{ projects: MpcProject[] }` |
| `mcp.projectSave` | `{ workspacePath, serverName, config }` | `{ project: MpcProject }` |
| `mcp.projectRemove` | `{ workspacePath, serverName }` | `{ project: MpcProject }` |
| `mcp.projectToggle` | `{ workspacePath, serverName, enabled }` | `{ project: MpcProject }` |
| `mcp.projectRefresh` | `{ workspacePath, serverName }` | `{ project: MpcProject }` |

`MpcServer` 关键字段：`id`、`serverName`、`enabled`、`transport`、`config`、`status`、`toolCount`、`tools[]`。
`MpcProject` 关键字段：`workspacePath`、`title`、`servers[]`、`source: 'project'`，异常时带 `missingDir` 或 `fileError`。

## 5. 命名规则与冲突（最容易踩的坑）

- **`serverName` 规则**：`/^[A-Za-z0-9_-]{1,32}$/` —— 字母、数字、**下划线**、连字符，最多 32 位。
  ⚠️ 注意与技能名的区别：**MCP 的 `serverName` 允许下划线**，而 DSH 技能名不允许（技能名须 kebab-case）。
- **唯一性**：同一个 `serverName` 在**全局与所有项目之间**全局唯一。重复时保存直接失败：
  `serverName "xxx" 已被另一个 MCP 使用（全局或其他项目），请换一个名称`。
- **模型侧工具名**：`mcp__<serverName>__<原始工具名>`。这段前缀是隔离与可见性机制的判定依据，不要手工改 `serverName` 来"重命名工具"——那会生成一整套新工具名。
- **项目条目 id**：`vsm-mcp.<workspaceHash>.<serverName>`（旧版残留为 `vsm-mcp:<hash>:<name>`，插件识别但不显示为全局 MCP）。
- 项目 MCP 只接受**已注册为 DSH workspace** 的路径，否则报 `项目未注册为 DSH workspace，不能管理项目 MCP`。

## 6. 作用域隔离（项目 MCP 的边界）

项目 MCP 的连接由 Host 维护，但**每个 agent 只继承当前工作区的项目工具**：

- 机制：`tools.restrict({ deny })` 控制模型可见性 + `tools.guard()` 在执行层兜底拒绝。
- 当前对话工作区 ≠ 条目所属工作区时，调用被拒，返回：
  `已拒绝：当前对话工作区不能使用其他项目的 MCP`
- 会话没有落在任何已注册工作区时：
  `项目 MCP 需要在已注册工作区的对话中使用`
- **全局 MCP 不受此限制**，在任何会话都可用。
- 工作区匹配按**最长父路径**：在子目录会话里也能用到父级工作区的项目 MCP。

排查「工具有但没有出现在模型面前」时，先看当前会话 cwd 是否落在目标 workspace 内。

## 7. 故障排查

| 症状 | 原因与处理 |
|---|---|
| 卡片状态 `错误`，提示 `MCP 插件未正常运行` | loader 条目 fiber 未进入 ACTIVE。看 Host 启动日志中该条目的报错；多半是 `command` 不存在或启动即退出 |
| 状态 `连接中` 一直不变 | 服务端未响应 MCP 握手。核对 stdio 的 `command`/`args`/`cwd`，或 HTTP 的 URL 可达性 |
| 已连接但 `toolCount` 为 0 | 服务端 `tools/list` 返回空，或工具同步失败。先用该 MCP 的 CLI 自行验证能列出工具 |
| `stdio MCP 必须填写 command` | 表单「命令」为空 |
| `HTTP MCP 必须填写 http(s) URL` | 「URL」为空或不是 `http(s)://` 开头 |
| `serverName 只能包含字母、数字、下划线和连字符（最多 32 位）` | 名称含空格/点/中文或超长 |
| `serverName "x" 已被另一个 MCP 使用…` | 见 §5 唯一性 |
| 设置页里 `env` / `headers` 的值显示成 `••••••` | **这是脱敏掩码**（`publicConfig`）。读回的是掩码而非真实值，**不要把它原样回写保存**，否则会用掩码覆盖真实凭据 |
| `.mcp.json 解析失败：…` | 文件不是合法 JSON；插件只报错、**不覆盖**该文件，修好 JSON 后刷新 |
| `.mcp.json 的 mcpServers 必须是对象` | `mcpServers` 写成了数组/标量 |
| 项目显示「目录缺失」 | workspace 路径已不存在（项目被移动/删除） |

## 8. 边界与注意事项

- **删除/启停走设置页或 RPC**，不要手删 profile 树里的条目——插件按条目 id（`vsm-mcp.*`）识别项目 MCP，手工改名会让它被当成全局条目。
- **项目 MCP 的持久真相是 `.mcp.json`**：重启后插件按文件内容 reconcile 该项目的激活状态（文件里有的激活、文件里没有的停用）。
- 项目 MCP 的写操作固定写入 `<workspacePath>/.mcp.json`，不会写到别处。
- 全局 MCP 由 loader 落盘到 profile 树，重启自动恢复。
- MCP 条目本身是 loader 条目，**HMR/热更新会重建连接**；调试连接问题时可先 `mcp.refresh`（等价于用当前 config 重新 `loader.update`）。
- 本技能只覆盖 dsh-vscode-mode 的 MCP 管理面。若问题出在 MCP 服务端自身（协议实现、鉴权、工具 schema），那不是本插件的问题，应转向该服务端的调试手段。

## 9. 关键源码位置

需要在插件仓库里核对行为时（按需读取，不要一次全开）：

- `src/mcp.ts` — 全局 MCP 的 list/save/remove/toggle/refresh，`validateConfig`，`publicConfig` 脱敏，`toolsOf` 工具前缀。
- `src/mcpProject.ts` — 项目 `.mcp.json` 读写、`configFromDef`、reconcile、条目 id 生成。
- `src/mcpIsolation.ts` — 工作区隔离（restrict + guard）与两条拒绝文案。
- `src/shared/mcp.ts` — 共享契约（`MpcConfig` / `MpcServer` / `MpcProject`）。
- `src/shared/rpc.ts` — `mcp.*` 方法的入参与返回形状。
- `src/client/ui/McpSettings.ts` — 设置页 UI（三个子页签与表单字段映射）。

# 指令系统与命令栏（Command Palette）

> 面向 dsh-vscode-mode 插件开发者与二次开发者。
> 相关代码：`src/client/ui/commandCatalog.ts`、`src/client/commandRegistry.ts`、
> `src/client/commandBridge.ts`、`src/client/commandPaletteStore.ts`、
> `src/client/ui/CommandPalette.ts`、`src/client/commandSearch.ts`。

## 1. 一句话模型

**一条命令 = 一条注册数据**（`CommandDef`）。命令栏、快捷键设置页、全局键位派发、
Monaco 右键菜单入口全部从同一份目录读取，新增能力只需追加一条定义。

```
commandCatalog.ts ──注册──▶ commandRegistry.ts ──执行──▶ run() 派发 edrv.command.<action>
        │                        ▲                          │
        │ 默认键位                │ 查询/过滤                 ▼
        ▼                        │                  EditorView / QuickOpen 监听并执行
shared/keybindings.ts    ui/CommandPalette.ts
   （host 设置 schema）     （命令栏 UI：搜索 → ↑↓ → Enter）
```

## 2. 数据流（三个平面）

| 平面 | 模块 | 职责 |
|---|---|---|
| 目录（静态） | `ui/commandCatalog.ts` | 命令元数据：id/label/category/order/keybinding/available/run |
| 注册表（运行时） | `commandRegistry.ts` | register/unregister/get/list/available/match/run + 订阅；重复 id 后者生效、旧注销器不误删新实例；`run` 先做可用性判定，异常一律捕获上报 |
| 执行桥（装配） | `commandBridge.ts` | 注册内置目录；为「桥接类」命令挂 window capture 键位；向命令栏注入执行器；`dispose()` 全量回收 |

`run()` 只做两件事：判定可用性 → 派发 `edrv.command.<action>` 窗口事件（或直接执行）。
命令实现落在各自的监听方（EditorView / QuickOpen / 命令栏自身），因此**指令系统不持有
React 状态**：编辑器未挂载时装配、卸载后依然安全。

## 3. 命令栏（Ctrl+Shift+P / F1）

- 默认键位：`Ctrl+Shift+P`（主候选）与 `F1`（VS Code 同款第二候选），由共享表
  `shared/keybindings.ts` 提供，可在「设置 → VSCodeMode → 快捷键」里改绑或解绑。
- 交互：输入即过滤（大小写不敏感、空格分词 AND、中文子串可命中）、`↑/↓` 选择、
  `Enter` 执行、`Esc` 或点击遮罩关闭；每行显示「命令名 · 分类 · 当前键位」。
- 过滤排序（`commandSearch.ts` 纯函数）：命中字段权重（label < id < category）→ 目录序 →
  注册序，结果稳定可预期。
- 浮层实现：React 组件 `ui/CommandPalette.ts`，`createPortal` 到 `document.body`
  （因此不受「官方右侧 Sidebar / better-sidebar / 中央页签」三种形态的几何限制）；
  宿主由 `commandPaletteStore` 的 `claimPaletteHost()` 单实例认领，
  同时挂载多个宿主时只有一个真正渲染。
- 宿主认领契约（v0.3.0 修正）：`claimPaletteHost()` **返回令牌本身**，调用方须原样持有并在卸载时
  传回 `releasePaletteHost(token)`；释放成功后递增 `paletteHostRev` 并通知订阅者，
  其余实例据此**重试认领**（宿主更替后自愈）。
  ⚠️ 旧实现在 `useState` 初始化器里 `claimPaletteHost() ? {} : null` 自造令牌，与 store 内部对象
  身份不同 → 释放校验恒失败 → `hostToken` 永久泄漏 → 之后**任何**实例都渲染 `null`，
  表现为 `Ctrl+Shift+P`「完全没有反应」且永不恢复（回归测试 `tests/paletteHost.test.ts`）。
  认领必须写在 effect 中（render 期副作用在 StrictMode 双调用下会误判失败）。
- 样式：`styles/editor.css` 的 `.edrv-palette*`（走 `--dsw-*` 令牌，自动跟随 DSH 主题）。
  ⚠️ 客户端 CSS 是构建期内联的 `<style data-plugin-css>`，**改样式必须整页刷新**。

## 4. 新增一条命令（三步）

以「切换自动换行」为例：

1. **写定义**（`ui/commandCatalog.ts`）
   - 若该命令需要 `Ctrl+Shift+P` 之外的新键位由指令桥统一派发（推荐）→ 加入 `BRIDGE_COMMANDS`；
   - 若它已有原生键位监听（如保存/侧栏这类历史实现）→ 加入 `EDITOR_COMMANDS`，**不要再给它
     桥接键位**，否则同一次按键会执行两遍。
   ```ts
   function toggleWordWrapDef(): CommandDef {
     return {
       id: 'edrv.toggleWordWrap', label: '切换自动换行', category: '视图', order: 30,
       keybinding: 'Alt+Z', available: needsModel,
       run: () => emit('toggleWordWrap'),
     }
   }
   ```
2. **写默认键位**（`shared/keybindings.ts` 的 `KEYBINDING_DEFAULTS` 追加同一条）。
   host 的 settings schema 键形状由该表生成，测试会断言两者一致。
3. **接住事件**（`ui/EditorView.ts` 的「指令系统接线」`handlers` 表追加一条字面事件名）；
   测试会静态校验「目录 ↔ 接线」双向一致。

设置页命令列表（`client/keybindings.ts` 的 `COMMANDS`）由目录派生，无需手动登记。

## 5. 第三方扩展

```js
// 浏览器控制台/其他插件：读取注册表（挂在 window 自身；DSH 不创建 window.dsh）
const registry = window.__edrvCommands__
registry.list().map((c) => c.id)

// 注册一条命令（返回注销器；遵循 effect/卸载语义）
const dispose = registry.register({
  id: 'myext.hello', label: '我的命令', category: '扩展',
  run: () => console.log('hello'),
})
dispose()

// 直接执行 / 打开命令栏
registry.run('edrv.save')
registry.run('edrv.showCommands')
```

- 运行时键位（不落设置 schema）：`addRuntimeKeybinding(id, chord)`（`client/keybindings.ts`
  导出，返回注销器）；注册表内建命令的键位仍以设置值为准，运行时表优先。
- 命名约定：内置命令一律 `edrv.` 前缀，第三方请避让；命令 id 在同一注册表内必须唯一。
- 契约测试：`tests/commands.test.ts`（目录 ↔ 键位表、目录 ↔ 接线、筛选与派发）、
  `tests/commandRegistry.test.ts`（注册表生命周期与执行语义）。

## 6. 与官方/历史实现的关系

- DSH 官方客户端**没有** command palette 服务，键位由本插件自行 capture 处理，不存在冲突。
- 历史实现（保存/快速打开/侧栏/搜索/后退前进/页签循环）保留各自的窗口级 `keydown` 监听，
  但**键位来源**已统一到 `shared/keybindings.ts`；指令桥不对这些命令挂键位，避免双执行。
- Monaco 自带命令面板（F1）被本次接线取代：编辑区的 F1 打开的是本插件命令栏
  （Monaco 的 `editor.action.quickCommand` 不再单独入口）。

# Sidebar 扩展、按需面板与验证契约

作者：ddj · 2026-10-22

## 注册生命周期与隔离

- `edrvSidebarPanels` 保持 `register/list/get/subscribe` API。同 ID 后注册覆盖；旧 disposer 不会删除新实例，注销可重复调用。
- 新扩展建议采用 `组织名.面板名` ID，既有短 ID 不被拒绝。本期不引入强制协议版本。
- listener 按通知时快照逐个调用，某个异常不阻断其余订阅；新增监听器从下次通知起生效。
- `visible/badge` 同步异常不扩散到其他面板。故障面板保留活动栏入口，可在面板内看到错误并显式重试。
- `render` 在 React 错误边界下执行，组件子树渲染及生命周期异常只替换该子树。图标单独隔离，失败时显示紧凑占位。
- 注册对象、工作区 scope 或 session 更换会重挂面板子树，不复用另一所有者的组件状态。
- 异步事件、Promise、定时器和外部副作用仍由扩展负责捕获与清理。错误边界不是权限或恶意代码沙箱。

## 规则与调试面板加载

构建产物为 `client.js`、`client.rules.js`、`client.debug.js`，均为浏览器 CJS 工厂；host 入口仍为 `index.js`。CSS 留在主样式包。

主入口不包含 RulesPanel/DebugPanel 实现。第一次打开对应面板才通过工厂注入的 `require.async('./client.rules.js')` 或 `require.async('./client.debug.js')` 请求脚本。chunk 使用 `window.__ModuleLoader__.load({id:'dsh-vscode-mode', chunk:'client.rules.js', factory})` 命名 handoff。

加载走 DSH 官方包资源通道；宿主管理反代 base、认证、`rev` URL、脚本到达和 HMR 失效。插件不新增任意文件资源路由。成功组件和在途 Promise 缓存；失败清除插件 Promise 并等待显式重试；卸载后回调不更新 UI。旧版宿主没有 `require.async` 时显示升级提示，不降级到不安全的脚本求值。

chunk 通过根模块 `__lazyShared` 复用 rpc、dapStore、BpWidget 的编辑状态以及 ContextMenu；禁止复制这些单例。该导出仅供本包产物桥接，不是第三方稳定扩展 API。

## 大文件分页：当前能力边界

分页核心支持受授权 `TextPageSource` 注入：每段 256 KiB，严格 UTF-8/BOM、CRLF 原样保留、版本校验与 HMAC 游标。客户端最多保留 8 MiB 或 50,000 行，手动续读、失败重试，绝不创建可保存的部分 Monaco 文档。

**后续复核修正：磁盘安装的官方 dsh-fs 0.2.1-rc.2 已提供 readByteRange，本地后端已有实现，沙箱后端继承其读取能力。** 经用户批准，`edrv.textPage` 每次执行既有会话校验与路径解析，探测 provider 的 `readByteRange/stat` 后，通过该官方能力读取；不解析 opaque targetKey 为物理路径，不调用原生 node:fs 绕过权限，不从头扫描 streamText。游标绑定 cwd、canonical targetKey、session、请求路径和版本；旧版或缺能力 provider 仍返回 `unsupported`。运行中的 Host 版本和实际 GUI 尚未确认，磁盘 API 存在不等于实例已生效。

原有文本整读上限实际为 8 MiB，共用二进制前置上限为 32 MiB；本次保留这两个既有边界，仅给大小错误增加 `file-too-large` 标识。批准方案曾将文本上限表述为32MiB，该描述与现有实现不符，未据此扩大读写内存范围。本次采用可选能力探测，不提高最低宿主版本、不修改宿主；实际使用需实例加载具有该能力的 provider 及新版插件Host产物。

只读视图不能覆盖脏文档或在途保存；与模型、自动保存、格式化、替换、差异回滚路径分离。元数据版本核对不是不可变快照保证。

## 定向验证与隔离构建

不要运行全量测试，也不要执行会清空 live `lib` 的 prebuild/prepare。

```powershell
node ./node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ./node_modules/tsdown/dist/run.mjs --out-dir .validation/better-sidebar --no-clean
$env:EDRV_MODULE_LOADER='<安装的 dsh-client-modules>/lib/client.js'
$env:EDRV_ARTIFACT_DIR='.validation/better-sidebar'
node ./node_modules/vitest/vitest.mjs run tests/clientArtifacts.test.ts
node scripts/check-client-artifacts.mjs .validation/better-sidebar
```

真实 loader 验证执行官方导出的 ClientModuleSystem 与实际 root/chunk 工厂，覆盖并发加载、失败重试、rev URL 与 HMR；不会调用插件 apply 或修改宿主。React 工厂 seeds 和组件 hook harness 不等同真实浏览器挂载。

文件树保留完整逻辑集合，只对 DOM 使用24px行高、上下各8行 overscan。10000行组件测试验证窗口行数不超过 `ceil(height/24)+17`，但浏览器滚动耗时与布局测量须在实际新产物部署后另验。

本任务不安装插件、不改 profile、不重启 Host、不发布。当前 GUI 若未加载新产物，不能作为本次改动的验收证据；真实安装、运行实例的分页及浏览器点击/滚动仍待验证。指定 `EDRV_FS_LOCAL` 为已安装官方 dsh-fs-local 的入口后，定向测试可执行该 provider 的真实 resolve/stat/readByteRange 方法（无 Cordis 注册），以临时文件验证RPC两段拼接和文件替换；这不是运行中实例的集成验收。

## 本次收尾验证结果

- TypeScript `--noEmit` 退出0；17个受影响测试文件156/156通过（3.20s），其中分页核心、真实RPC与EditorView函数接线两文件28/28通过。
- 显式指定实际官方 ClientModuleSystem 与本次隔离产物后，产物契约12/12通过、0跳过（2.67s）；单独产物检查脚本退出0。这不等于真实HTTP/GUI或安装挂载通过。
- 隔离构建 host 884,792 B；client入口1,712,325 B；Rules chunk 31,793 B；Debug chunk 39,258 B（均为原始JS字节，不含map）。
- 同一当前源码、同一编译参数仅恢复两面板静态导入的对照入口为1,772,964 B；拆分后入口减少60,639 B（约3.42%）。按需产物合计1,783,376 B，总代码增加10,412 B；该方案降低首次入口成本，不宣称减少总包体或已测得启动提速。
- 对照配置首次因配置目录改变相对入口解析而失败；显式指定项目cwd与隔离绝对输出目录后成功。构建仍有原有external/noExternal弃用与PURE注释告警，无构建错误。
- `git diff --check`通过。队友工作收齐；真实GUI/安装挂载、实际HTTP MIME与浏览器滚动/布局测量未完成，不能将五期整体验收标记为完成。
- 后续官方range适配：TypeScript退出0，指定实际官方dsh-fs-local后4个受影响文件45/45通过（2.02s），其中分页32/32（Host18+client14），含真实provider方法与临时文件RPC测试。旧宿主unsupported、provider拒绝、cwd变化及版本过期仍有覆盖。更新后的隔离构建成功，Host产物885,608 B；实际loader产物契约再次12/12通过（2.11s）。live client SHA256仍为BF913690EDC5E7447203DBA0171B495C62259D8F94E64630C173AD5B24C6D5CC，本轮未改写live产物；新Host适配未部署。

## 回滚

按逆序反向撤销本次扩展隔离、chunk 接线、树虚拟化、分页和缓存生命周期差异。不对整个工作副本 reset，不删用户快照或覆盖无关本地修改。

**执行偏差（2026-10-22 15:12）：**一次 `pnpm exec vitest ...` 意外触发 pnpm prepare，执行 prebuild 并清理、重建了本包 `lib`。这违反了原计划仅隔离构建的边界；已向用户说明并获准仅继续直接 Node 验证、隔离构建与文档收尾，保留该变更，不自动回滚。未主动安装插件或重启 Host，但开发链接实例可能读取新客户端；实际 GUI 生效情况未验证。此后不再通过 pnpm 执行命令，也不再写入 `lib`。

隔离构建在 `.validation/better-sidebar*` 下；比较配置和产物属于验证材料，不是待发布源码。恢复 live 产物须另行核对原始备份和当前实例后确认，不能把旧隔离构建当作原 live 版本覆盖。

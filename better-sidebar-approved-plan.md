# 计划：借鉴 better-sidebar 完成五期优化

## 一、目标与授权范围

在现有 dsh-vscode-mode 中完成五期优化：**稳定性修复 → 大文件只读分页 → 文件树虚拟化 → 低频面板按需加载 → 扩展故障隔离与产物契约测试**。保留当前编辑、审阅、SVN、Unity 集成与官方 Sidebar 优先策略，不替换为第三方侧栏。

**批准本计划即允许本任务使用 Agent Teams：1 名主 Agent + 2 名额外队友。** 不额外创建子 Agent，不通过 computer-use/chrome-devtools 创建普通对话或投递隐藏任务。团队并行会增加 token 消耗，不能可靠预报费用；通过小范围任务与统一整合控制成本。

批准后按依赖连续推进五期，无需每期重复确认；但超出文件范围、需新依赖、需修改宿主或安全策略、以及无法满足既定设计时，停止相关步骤并提交增量计划。

### 执行边界

- 工作区仅限当前 dsh-edit-review 包；不改 DSH 实现 checkout、profile、Unity 工程和用户真实数据。
- 不发布、提交、推送、打 tag、安装插件或重启 Host，不启动替代 GUI/server。
- 不安装依赖、不跑全量测试，不自动 stash、reset 或覆盖其他会话修改。
- 构建尽量输出到工作区隔离目录；先确认构建配置确实支持指定输出目录，禁止构建直接触发开发链接实例热更新。若只能重写正在使用的 lib，则另行确认。
- 真实 GUI 使用当前 http://127.0.0.1:3080，只在能确认加载本次产物且不需额外部署/重启时验证；否则记录缺口，不以 mock 或旧 GUI 冒充新版本验收。

## 二、协作与依赖

| 成员 | 分工 | 写入范围 |
|---|---|---|
| 主 Agent | SVN/拖拽修复、所有公共入口与接口整合、构建加载接线、错误边界、最终审查验证 | rpc/shared、EditorView、SidebarView、panels/index、构建配置、公共样式、注册表 |
| 队友 A | 树缓存 → 文件树虚拟化及测试 | treeIndex、FileExplorer、树专属新增模块及测试 |
| 队友 B | 大文件读取与分页状态模块、相关测试；后续产物验证脚本 | 大文件专属新增模块及测试；主 Agent 锁定后分配的契约测试 |

用共享任务板记录具体文件、依赖和验收条件；主 Agent 负责调度，不让成员同时修改公共文件。同一文件交接前必须完成审查。第四期在前三期合入验证后实施，第五期在加载接口稳定后整合。队友等待时可做只读交叉审查，不擅自扩大写入范围。

## 三、第一期：缓存正确性与生命周期

### 树缓存

修改 [treeIndex.ts](<src/treeIndex.ts>)，补充 [treeIndex.test.ts](<tests/treeIndex.test.ts>)：

- `ts` 只代表真实扫描确认时间，命中不续期；到达 60 秒 TTL 即失效。
- LRU 使用独立运行时访问记录，删除/淘汰/销毁同步清理，不改变 v1 快照格式。
- 成功列目录写入内存始终 `full=true`；落盘实际截断才置 false，裁剪不能把已有 false 恢复为 true。
- 不完整快照不得作为完整命中，读取时走已有 single-flight 重列；失败返回错误，不返回伪全量。
- 保留容量、force、主动失效和后台自愈机制；旧快照兼容，空目录合法。

### 生命周期

修改 [SvnPanel.ts](<src/client/sidebar/panels/SvnPanel.ts>)、[SidebarView.ts](<src/client/sidebar/SidebarView.ts>)，新增 `tests/svnPairLifecycle.test.ts`、`tests/sidebarDrag.test.ts`：

- SVN 尺寸表绑定 scope/session/candidateKey；旧响应、卸载后的响应不能提交，新身份不得复用旧表；无配对需求不查询，错误不无限重试。
- 两种拖拽统一幂等清理；处理 pointerup、pointercancel、blur、卸载、可见态切换及新拖拽替换，只接受启动的 pointerId。
- 不改变既有宽度边界、12px 拉出阈值、配对规则或 RPC。

**验收：**持续命中不会无限续期；超过1500项的完整内存目录能命中；截断恢复只并发扫描一次；乱序请求不串台；拖拽中断后监听归零。

## 四、第二期：大文件只读分段查看

### 涉及范围

新增 `src/textPages.ts`、`src/shared/textPages.ts`、`src/client/textPages.ts`、`src/client/ui/LargeTextView.ts` 与对应 `tests/textPages.test.ts`、`tests/textPager.test.ts`；由主 Agent 整合 [rpc.ts](<src/rpc.ts>)、[共享 RPC 类型](<src/shared/rpc.ts>)、[EditorView.ts](<src/client/ui/EditorView.ts>) 和 [editor.css](<src/client/editor.css>)。

### 接口和数据流

- 新增加法型 RPC `edrv.textPage`：请求 sessionId/path、可选 cursor；成功返回 text、nextCursor、eof、version、encoding，失败返回结构化错误码与文案。
- cursor 由 Host 生成、校验，绑定路径、工作区和文件版本；客户端不得自行指定任意物理读取位置。每次重新执行现有鉴权、会话和文件解析授权；远端/虚拟文件系统没有安全范围读取能力时明确不支持，不绕过 Host 读取权限。
- 默认每段读取最多256KiB；版本使用现有文件元数据约定并补充读前/读后核对，变更即拒绝继续，提示用户从头重载，不把不同版本拼接。说明这不是不可变快照保证。
- 首期编码支持有效 UTF-8（含 BOM），跨段保留多字节残片，保留原始换行；UTF-16 BOM、二进制或无效 UTF-8 明确拒绝，不静默替换乱码。
- 客户端手动“加载更多”，单请求在途去重，版本/路径/会话/工作区变化与卸载使旧响应失效；隐藏后不继续发起读取。
- 累计最多8MiB UTF-8内容或50000行，达到任一上限停止追加并说明限制；超长单行允许分段显示，标注非完整行，不无限寻找换行。

### 编辑器接入

整文件读取上限仍为32MiB；超限错误增加可选结构化标识，旧错误文案兼容。活动与非活动编辑组均提供只读分段查看入口，使用独立视图，不创建可保存的部分文档，不进入自动保存、格式化、替换或差异回滚路径。切换视图前遵守现有 flushSave 与 model/path 身份约束；现有未保存文档禁止被只读分页替换。

**验收：**多字节跨段、CRLF、空文件、无末尾换行、超长行、文件追加/替换、非法游标、越权、乱序、失败重试及累计上限均有测试；分页操作不产生任何文件写入。

## 五、第三期：文件树视口虚拟化

修改 [FileExplorer.ts](<src/client/sidebar/panels/FileExplorer.ts>)，新增 `src/client/sidebar/panels/treeWindow.ts`、`tests/treeWindow.test.ts`，扩展已有树 reveal 测试；公共样式由主 Agent 合入。

- 保留完整展开行数组与现有 SVN 投影集合，仅虚拟化 DOM，不以4000项截断隐藏文件；删除不实截断提示。
- 固定行高24px，视口上下各8行 overscan，使用上下占位元素；错误提示放在虚拟滚动区之外，加载占位行遵循同高规则。
- ResizeObserver、scroll/rAF 均有卸载清理；窗口隐藏后零高度不破坏滚动位置。
- reveal 根据目标行索引先滚动到窗口，再做高亮；展开/折叠时按首个可见路径保持锚点，路径消失时夹取合法位置。
- 右键菜单以路径身份保存，目标移除或作用域切换后关闭；不因行回收把操作发给另一文件。

**验收：**10000行测试集合下，DOM树行数不超过 `ceil(视口高度/24)+17`；可访问首尾文件，展开、选择、右键、reveal及SVN状态不退化。记录滚动与展开实测，不承诺未经测量的提速百分比。

## 六、第四期：规则与调试面板按需加载

修改 [tsdown.config.ts](<tsdown.config.ts>)、[面板定义入口](<src/client/sidebar/panels/index.ts>)，新增 `src/client/lazyPanel.ts`、`scripts/check-client-artifacts.mjs` 和 `tests/lazyPanel.test.ts`；必要的静态资源接线仅限现有插件资源路由所在模块。具体路由修改前必须读取其实现与宿主类型。

- 先记录入口体积与静态依赖；本期只拆 RulesPanel、DebugPanel，FileExplorer/Search/SVN和编辑器主链不强拆。
- 采用独立浏览器 CJS 产物及与当前 `window.__ModuleLoader__` 兼容的命名 handoff，不直接打开 native ESM splitting。
- 使用本插件现有、鉴权且兼容反代子路径的资源通道加载；模块 URL 绑定内容 hash/rev，资源映射固定，禁止客户端传入任意文件路径。必须先核实真实 ModuleLoader 契约；若不支持该加载方式，停止第四期并提交替代设计，不靠猜测宿主私有 API。
- 每模块缓存成功结果及在途 Promise，失败清理 script/Promise、允许显式重试；组件卸载或切换后旧结果不发布。HMR 清理本代加载状态，不重复注册面板。
- CSS 保留现有统一样式包，避免异步 CSS 与旧 style tag 冲突。

**验收：**新页面未打开两面板前不请求对应脚本，入口不再包含其实现且体积小于同条件基线；首次打开、并发打开、失败重试、卸载后返回、HMR后重开均通过；打包产物能在真实加载契约中执行。

## 七、第五期：扩展隔离与产物契约

修改 [registry.ts](<src/client/sidebar/registry.ts>)、[SidebarView.ts](<src/client/sidebar/SidebarView.ts>)，新增 `src/client/sidebar/PanelBoundary.ts`、`tests/sidebarRegistry.test.ts`、`tests/panelBoundary.test.ts`、`tests/clientArtifacts.test.ts`，以及 `docs/sidebar-extension-contract.md`。

- 保持 register/list/get/subscribe 签名及同ID后注册覆盖语义；旧 disposer 不删除新实例。
- 文档要求新扩展采用命名空间ID，不追溯拒绝现有短ID；本期不强制引入协议版本，避免破坏第三方。
- listener 逐个隔离，某个抛错不阻止其余通知；visible/badge/render同步回调按面板隔离。
- 面板子树使用React ErrorBoundary，提供局部错误与重试；作用域或注册实例变化重置边界。异步事件错误仍由调用方处理，不宣称错误边界是安全沙箱。
- 产物测试验证host/client入口、chunk清单、外部依赖、ModuleLoader包装、资源URL/MIME以及加载去重/重试；使用已有Node/Vitest，不引入Playwright依赖或自动修改CI工作流。
- 补注册→替换→旧注销→新注销→再注册生命周期和故障面板不影响其他面板的测试。真实安装挂载冒烟是最终验收项，若需要安装或独立profile则单独申请，不把模拟挂载称为安装验收。

## 八、执行步骤与验证

1. 用 codegraph 优先检查结构、read检查配置、只读Git状态/diff记录基线。当前本轮 MCP 连接报“初始化失败或超时”，可用read/grep降级；不自行建索引。
2. 审批后创建团队与共享任务板，确定文件归属，先补定向回归再实现；每期收齐结果、审查差异、验证后解锁依赖任务。
3. 每期执行 `pnpm run typecheck`，运行明确列出的受影响 Vitest 文件；根据调用图追加必要文件，但不使用全量 `pnpm test`。
4. 前三期分别覆盖缓存/树读取、分页/保存保护、虚拟窗口/reveal；第四五期覆盖加载器、注册表、错误边界及真实构建产物。对 `@ts-nocheck` 接线额外审查导入、TDZ、运行时类型与生命周期，不能仅靠tsc。
5. 最终在隔离输出目录构建双面产物、运行产物契约测试；逐项报告用例数、通过/失败/跳过、耗时和包体比较。沙箱拒绝时遵循精确命令审批，不换工具绕过。
6. 浏览器可验证时检查核心入口、分页、滚动、面板重试和Console；先确认实际产物版本。缺少部署条件时报告“源码/构建完成，真实GUI与安装验收待完成”，不宣称全部端到端通过。

新代码遵循ddj注释署名、当日日期、类型、方法命名及生命周期规范；不改Lua文件，不涉及Unity测试。

## 九、风险、回滚与完成标准

- **IO和内存**：硬TTL恢复可能增加扫描；保留single-flight；分页有硬读取与累计上限，虚拟化只减少DOM、不掩盖逻辑集合成本。
- **数据安全**：只读分页绝不接入保存；不绕过现有文件授权；文件变动中止而非拼接。
- **共享工作区**：成员不得越界编辑；发现其他会话变更先重读合并，公共文件串行，最终由主Agent审查全部差异。
- **回滚**：按期保留差异与验证记录，只反向撤销本任务改动；不整仓reset、不删用户缓存，不覆盖既有修改。五期互有依赖，回滚按逆序进行。
- **完成标准**：五期生产路径接线齐全，目标测试与隔离构建通过，无新增类型错误，无未回收队友/任务/后台作业，接口兼容性与限制已文档化。若某期被真实宿主契约或权限阻断，明确列为未完成并提出增量方案，不静默降级为“完成”。

最终交付五期变更清单、测试证据、包体与DOM测量、使用方式、回滚范围以及GUI/部署未验证项。本计划只授权开发与上述验证，不授权上线。

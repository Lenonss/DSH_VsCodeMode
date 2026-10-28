---
name: dsh-vscode-mode-dev
description: dsh-vscode-mode 插件开发/发布强制经验集——发布必须打 tag 走 GitHub Actions（禁止本地 npm publish）、CI 测试断言平台陷阱（ubuntu 会踩 Windows 路径）、DSH host 环境约束（subprocess stdio inherit/EditorPrefs 主线程/PATHEXT 污染）、Unity 外部编辑器 API 注意。发布、写测试、改 host 集成/launcher/Unity 包、CI 排错时必须使用。技能本身支持自我更新（见文末协议）。
---

# dsh-vscode-mode 开发/发布经验集（自我更新型技能）

> updated: 2026-10-28 · 维护者：ddj（AI 会话按文末协议更新，保持精炼、去重）
> **发布时先读「发布流程」与「失败恢复」**；下方实录是历史证据，不授权当前重跑发布、改 tag 或部署。冲突旧口径以更新后的规则为准。
- 2026-10-19 实录（v0.17.0 发布：DSH 0.2.1 吸收——locale 元数据 meta 化、engines.dsh、workingDirectory 投影跟随 cd、
  会话级 recordsFeed 轮询收敛、ctx.locale 接入、plugins.detail.section；基线 v0.16.0 @ `8b79f8f`）：
  三门本地全绿（typecheck 0 / **3029 passed + 15 skipped · 225 文件通过 + 2 跳过** / `node --test` 9 passed /
  tsdown 双面 client 1718766 B、host 847975 B），本轮**无 dapFakeAdapter / archiveDb 抖动**。
  **新坑（locale 元数据两处都要改，只改一处等于没改）**：`dsh-app-boot` 的 `dictionariesOf` 只读
  `<specifier>/locale/<lang>.json` 里的 **`meta.title` / `meta.description`**（顶层 `title/description` 一律读不到），
  **且**该资源必须能从包 `exports` 解析——`ERR_PACKAGE_PATH_NOT_EXPORTED` 被 `missingResource` 当「不存在」静默吞掉，
  于是插件管理器常年显示 `package.json.name` 而**没有任何报错**。修法两件套：locale 文件包进 `{"meta":{...}}`
  **且** `exports` 补 `"./locale/*.json": "./locale/*.json"`；`files` 要含 `locale`。`icon` 走 manifest 相对路径，不受 exports 影响。
  **新坑（engines.dsh 一旦声明就独占兼容判定）**：官方 `unmetRequirements` 里 `engines.dsh` 存在时
  **peerDependencies 被完全忽略**，且不满足会 `throw` 直接**阻断安装**（不是告警）。所以绝不能写窄区间；
  官方以 `semver.satisfies(rt, range, { includePrerelease: true })` 求值，`>=0.1.0-rc.1 <0.3.0-0` 可一次放行
  0.1.x / 0.2.x 全线并拒绝 0.3 起。声明前全树扫描确认**官方包自己都不声明 engines.dsh**（本机 0 个），
  本插件会成为唯一声明者——这是有意的显式化，不是抄官方。
  **新坑（workingDirectory 只能可选探测，且客户端拿不到）**：0.2.1 起 `header.cwd` 是**原始**目录，`cd` 后当前目录在
  `sessionProjections` 的 `workingDirectory` 投影里；服务名 `workingDirectory`，`get(session)` 无 IO。
  必须 `ctx.get(...)` 探测 + try/catch + 回落 `header.cwd`，**绝不写进模块 `inject`**（旧版 DSH 会停等不存在的服务）。
  该投影**未声明 wire view**，客户端 `sessions` 快照的 `byId[id].cwd` 仍是 `header.cwd` → 跟随 cd 只能在 host 侧做。
  若函数签名收 `string | null` 而下游要 `string | undefined`，记得 `?? undefined`（TS2345）。
  **事实（多组件 5s 轮询同一 RPC 是常见浪费）**：差异角标 / 输入区 dock / 编辑器 / 体积角标各自
  `setInterval(load, 5000)` 拉同一个 `edrv.list`，同会话 5 秒 4 次。收敛方式 = 会话级共享订阅（按 sessionId 分桶、
  订阅者集合 + 引用计数、退订到 0 才清定时器与事件监听、`seq` 防陈旧、失败保留旧快照只分发错误）。
  **坑（locale 服务 register 与 bind 必须各自独立 try）**：写在一个 try 里时 `register` 抛错会把 `bind` 也拉黑，
  症状是「词典注册失败 → 文案直接退化成 key 本身」；拆开后能各自降级。
  **坑（slot label 改 thunk 才随语言热切换）**：官方 `SlotLabel = string | (() => string)`，thunk 每次读取重算；
  传死字符串则切语言后必须重注册 slot。
  **事实（plugins.detail.section 有两种 subject 形状）**：内置项 `{kind:'item', id}`、安装包 `{kind:'bundle', pkg:{name}}`；
  只判一种会在另一条路径静默不渲染。入口必须做形状校验，未知形状 return null。
- 2026-10-19 实录（v0.16.0 发布：C# provider DotRush 优先 + Roslyn solution/open + DAP dotnet runtime；基线 v0.15.9 @ `89af5e0`）：
  三门本地绿（typecheck 0 / 2961 passed + 15 skipped，负载敏感计时用例
  `tests/dapFakeAdapter.test.ts` 与 `tests/archiveDb.test.ts`（定向计时）首轮全量各挂 1 例，
  隔离重跑 20/20 全绿 → 判抖动非回归）/ tsdown 双面绿；Release 首跑同挂
  `dapFakeAdapter` waitFor 超时（publish 未执行），`gh run rerun --failed` 一次绿（5m）。
  四向闭环一次对齐：registry 0.16.0 `gitHead==8b79f8f`、`dist-tags.latest=0.16.0`、tag 同 commit、
  GitHub Release tgz（7,610,061 B）与 npm 实包 SHA256 同为 `509ac88f…`，SRI/shasum 双验一致。
  **已知抖动锚点新增**：`tests/archiveDb.test.ts` 定向计时用例（全量跑负载下易超时，隔离跑稳定）
  ——「本地全量绿」判据放宽为「失败用例隔离重跑绿 + 不在本次 diff」。
- 2026-10-16 实录（v0.15.9 发布：插件自我更新按钮 + 可用更新提醒；基线 v0.15.8 @ `800eb32`）：
  三门本地全绿（typecheck 0 / **2958 passed + 15 skipped · 220 文件** / node --test 9/9 /
  tsdown 双面：host 843914 B、client 1707844 B）；`release` 全绿直到 Publish to npm，仅
  `Verify published tarball` 报 not retrievable（第三次第三结局），registry 侧 200/gitHead/
  latest 三字段即时对齐，npm 实包与 GitHub asset SHA256 同为
  `45ffd4c3996cfeecde73ccad3d6622b3fbb836f87c81d4029507947948cbd12d`。**新坑（RPC 响应类型）**：
  RPC handler 返回类型被框架要求满足 `{ ok: true }` 交集，宽类型 `ok: boolean` 过不了
  typecheck——自 updateCheck/updateSelf 起统一用可辨识联合 `{ ok: true; ... } | { ok: false; error }`。
  **坑（PowerShell 管道覆写险毁文件）**：用 `Get-Content | -replace | Set-Content` 原地改大文件时
  管道在读未完成前就开写会截断只剩 3 行——技能/文档类文件一律用 edit 工具改，不用 PowerShell 管道覆写。
- 2026-10-09 实证（v0.14.5）：三门绿（2583通过/14跳过）；未改的 `tests/dapFakeAdapter.test.ts:26:9/:236:5` 报 `Error: waitFor 超时`，同提交Release与本地绿，仅CI失败任务重跑1次成功。npm响应 `Your package is being processed and may take a few minutes to become available.` 后约**25分23秒**才公开（01:32:53Z接受 / registry time 01:58:16.247Z）；15×30s Verify先超时，但main/tag/registry gitHead最终同为 `7833fac5c8b94ea940be34689e20d2345a5baea5`。npm实包与GitHub asset SHA256同为 `351280c1a7c19502a3212b8f6f20bf87defbd3524892e1b3b4516fc7c97719f7`，SRI与双入口通过。**未重跑Release、未重打tag、未部署DSH；真实GUI缺口经用户明确接受**。只确认异步处理中超过回读窗口，不猜测底层队列/CDN/stage原因。
- 2026-10-08 MCP 审计：`mcp__${serverName}__${rawName}` 非单射，不能凭最长前缀反解归属；跨全局/项目双向拒绝 `__` 命名交叠，并对历史歧义工具 fail-closed。`ACTIVE`/工具数不是健康证据，`unverified` 应中性色；右侧绿色开关仅启用。状态轮询用只读 `mcp.snapshot`，不复用带文件/reconcile 的列表；初读并发用 `Promise.allSettled` 等所有传输结束，避免半失败导致重叠请求。配置读取—修改—写入需串行，避免并发丢服务；模块加载的 rejected Promise 不能永久缓存，否则刷新无法恢复。官方回归设置 `DSH_MCP_HOST_ROOT` 后才算真实模块测试，资源-only 零工具合法。
- 当前桌面 profile 路径必须依据实际进程核验，不能套用下方旧版本 home 经验；2026-10-08 本机为 `C:\Users\1\.dsh\profiles\desktop`，Electron userData 与 Host profile 不是同一目录。
- 2026-10-08 坑：`ctx.fs.readText` 的缺失错误为官方 `FS_NOT_FOUND`，只认 Node `ENOENT` 会让无 `.mcp.json` 的其他注册项目阻断当前项目重名检查与挂载；按结构化错误码兼容两者，权限/IO/JSON 错误仍报告并保留最后有效连接，测试须模拟官方错误码而非仅模拟 Node errno。
- 2026-09-29 实录（v0.14.0 发布：**界面状态跨 DSH 重启持久化**；基线 `v0.13.1` @ `c8d9843`）：
  三门本地全绿（typecheck 0 / **179 文件通过 + 2 跳过；2377 通过 + 12 跳过** /
  `node --test tests/nativeOpen.test.mjs` 9/9 / tsdown 双面：host 734144 B、client 1499417 B）；
  `release` 一次过 **5m46s**，但**同 commit 的 CI 首跑挂 `tests/dapFakeAdapter.test.ts:26` `waitFor 超时`**
  （又是那个老抖动）→ `gh run rerun --failed` 一次即绿，别去改该测试。
  **注意 main 上共有两个时间敏感用例会抖**，另一种是 `tests/treeIndex.test.ts:195`
  （后台自愈用例 `expect(healed).not.toBeNull()`：fake 时间推进 + 真实 fs IO，靠 200×10ms 轮询等自愈完成）——
  docs-only 提交 `8f1be85` 的 CI 首跑挂的就是它，第 1 次 rerun 又挂回 `dapFakeAdapter:26`，
  第 2 次 rerun 才全绿。所以看到 main 变红先看是不是这两个用例，**别急着自己改代码**。
  四向闭环一次对齐：
  registry 0.14.0 `gitHead==dc16351`、`dist-tags.latest=0.14.0`、tag 同 commit、
  Release 挂 tgz（7,246,248 B，sha256:ab61d315…）。改动 = host 新增 `src/uiState.ts` +
  `paths.ts` 的 `uiStateFile`/`uiGlobalsFile`（`cache/workspace/<hash>/ui.v1.json`、
  `cache/user/ui-globals.v1.json`，写前合并、纳入 `CACHE_SCHEMAS` 白名单）+ RPC
  `edrv.uiState.get/set`（工作区/全局两分区）；客户端新增 `state/uiStatePersist.ts`（包装
  `localStorage` 写口去抖推送、启动回填、广播 `edrv:ui-state-ready`）、`mdPreviewCache.ts`、
  `navStateCache.ts`，并补记官方编辑 Tab 激活态。
  **坑（DSH home 看错目录，代价最高）**：本机 DSH **桌面端**的真实 home 是
  `%APPDATA%\dsh-desktop`（即 `C:\Users\1\.dsh-desktop`，Electron userData），
  `%USERPROFILE%\.dsh` 是 web profile / 手工安装的另一套。排查「host 没写盘」前**先用进程反查真实实例**：
  `Get-CimInstance Win32_Process` 找 `dsh\lib\bin.js --profile web`、看监听端口与
  `profiles\web\node_modules\<插件>` 指向哪；看错目录会让整份取证作废（本次就作废过一轮）。
  **坑（跨重启持久化只能落 host 磁盘）**：DSH 每次启动端口随机，`http://127.0.0.1:<port>` 就是 origin，
  只写 `localStorage` 的界面状态换一次启动即全丢；Electron `Local Storage\leveldb` 里并存十余个
  随机端口 origin 就是判据（但 `LOCK`/`LOG`/`MANIFEST`/当前 `.log` 被进程占用读不出，只能在
  其余 `.ldb` 上做字符串扫描）。
  **坑（水合失败语义）**：`apply` 期 host `requireSession` 尚未就绪会答「会话不存在」→ 取回抛错。
  水合必须**有界重试**（8×800ms），且**重试耗尽也要广播就绪**——别写 `if (filled > 0) emitReady()`，
  否则界面侧的迟到回填永不触发、且没有任何报错。`edrv.debug` 同样先 `requireSession`，
  冷启动期诊断要回退伪 cwd（`UI_AUDIT_CWD = 'ui-state'` → `logs/debug.<hashOf('ui-state')>.log`）才留得下。
  **坑（回填被空初值反杀）**：回填遵守「本地已有值优先」，而界面挂载即把空初值写进 `localStorage`
  （页签 `{"tabs":[],"active":null}` 仅 25 字符）→ 迟到回填永远填不进去。修法 = 写效应加
  「水合未结束不写存档」门控 + 恢复效应依赖里带水合完成标记（**侧栏恢复效应原先缺这个依赖，
  回填后不重读**）。这类「只有重启才复现」的问题**同 origin 刷新测不出来**，验证必须重启（换 origin）。
  **事实（取证锚点）**：host `debugRecord` 无条件落盘（缓冲 32 KB / 空闲 1s flush），是端到端取证的
  可靠锚点——设计任何跨进程记忆功能时，先给每个阶段埋无条件日志，再请用户重启一次，AI 自己读日志即可闭环，
  不必让用户搬运产物。
- 2026-09-28 实录（v0.13.1 发布：**快捷键入口收敛到官方弹窗**；基线 `v0.13.0` @ `75dd3d8`）：
  三门本地全绿（typecheck 0 / **175 文件通过 + 2 跳过；2326 通过 + 12 跳过**，连续两次一致 /
  `node --test tests/nativeOpen.test.mjs` 9/9 / tsdown 双面：host 726.52 kB、client 1.47 MB）；
  `release` 一次过 **6m34s**（含 npm publish + Verify）。四向闭环一次对齐：registry 0.13.1
  `gitHead==c8d9843`、`dist-tags.latest=0.13.1`、tag 同 commit、Release 挂 tgz（7,194,379 B，
  sha256:55239fc7…）。改动 = 删除独立「快捷键」设置区（`ui/ShortcutSettings.ts`）与随其失业的
  `src/client/shortcutRecorder.ts` + 其单测，VSCodeMode 通用页新增「打开官方快捷键配置」按钮
  （`openOfficialShortcuts()` → `registry.invoke('shortcuts.open')`，入口缺失/失败回退 `Ctrl+/` 文案）。
  **删页面前先 `git grep` 确认消费者**：`vsm-kb-*` 与 recorder 只被该页引用，才可一并清掉；
  同理 `client/keybindings.ts` 的 `COMMANDS`、`shortcutsOfficial.resetPluginKeys` 至此仅测试引用（可后续清）。
  **坑（并行会话 / 落后基线，代价最高）**：本地 `main` 可能落后 origin —— 本会话落后 2 个提交
  （= 另一个会话已发布并 npm 上线的 0.13.0），若把基于旧基线的改动直接提交推送会**整包回退别人的发布**。
  处置：先 `git fetch` + `git log HEAD..origin/main` 看清差异，`git stash push -u` 保护本地改动 →
  `git merge --ff-only origin/main` → 在新基线上重建改动（不要硬 pop 旧 stash，冲突面大且会带回旧内容）。
  **坑（依赖同步）**：基线前移后必须 `pnpm install --frozen-lockfile`（0.13.0 新增的 `semver`
  devDependency 未装会让 `tests/peerDeps.test.ts` 报 `Cannot find package 'semver'`，
  看起来像自己改坏了）。
  **坑（老抖动不再「一次即过」）**：`tests/dapFakeAdapter.test.ts:26` `waitFor 超时` 在
  `457750f` 的独立 main CI 上**连挂两次**（第一次 `gh run rerun --failed` 仍挂），第二次重跑才绿；
  遇到它别只重跑一次就下结论、也别去改那个测试。
- 2026-09-28 实录（v0.13.0 发布：官方 Desktop 适配——/edrv 接官方认证与有界请求体、
  应用基址兼容反代子路径与 `dsh-app:`、项目 MCP 按 agent 三面隔离、profile 用运行上下文、
  快捷键 normalized/录制收尾、私有 OPEN/lease ACK 外部打开、SVN 会话工具投递；
  **release 首跑挂 `tests/treeIndex.test.ts:195`**）：三门本地全绿（typecheck 0 /
  **2341 passed · 13 skipped · 175 文件** + `node --test tests/nativeOpen.test.mjs` 9/9 ·
  11.97s / tsdown 724.67kB + 1.49MB）；`release` 首跑挂「后台自愈：失效 3s 后索引自动更新」
  （`expected null not to be null`，fake timers + 真实 fs IO），**同 commit 的 CI 流水线绿**
  → 判据三分全中，`gh run rerun --failed` 一次过（typecheck/test/build/pack/Release/npm/Verify 全绿）。
  四向闭环一次对齐：registry 0.13.0 `gitHead==75dd3d8`、`dist-tags.latest=0.13.0`、tag 同 commit、
  Release 挂 tgz（7,216,347 B，sha256:088b65f5…）。**新坑（外部打开队列，务必先查）**：host 用
  `profileContext.dir`（反斜杠）写入 metadata 并做**严格字符串比较**，任何工具/手写用正斜杠写请求
  都会被**静默丢弃**（请求文件照样被删、不写 ACK、投递方只能等到 TTL 超时）——修法 = 按物理路径身份
  比较（win32 折叠分隔符 + 大小写，POSIX 保持大小写敏感），并给被拒请求补失败 ACK；测试必须**显式
  传平台**（否则 Windows 全绿、ubuntu 挂）。**新坑（Windows ACL）**：继承的 `PSModulePath` 会让
  `Get-Acl`/`Set-Acl` 自动加载失败，队列权限检查改用 .NET Framework
  `Directory/File.GetAccessControl` 直调；`SetOwner` 需特权，只设 DACL（当前 SID + OI/CI）即可。
  **新坑（官方 Desktop 隔离验证）**：packaged 启动**无条件** `setAsDefaultProtocolClient('dsh')`，
  无开关/env 可禁，只能运行时抑制（inspector 暂停替换）或换独立 OS/VM；且首次引导会**改写**私有
  profile 的 `cordis.patch.yml`（`[]` → 默认插件配置），验证驱动必须有「复用已初始化 profile」开关。
  **事实**：客户端 bundle `rev` 可用来确认 GUI 是否真的加载了新构建。
- 2026-09-28 实录（v0.11.0 发布：原生 SVN 更新窗口 + LSP 补全增强 + 设置文件就地打开 + 日志弹窗
  视觉重做；**首跑 CI 两个 job 同挂于新测试的平台陷阱**）：三门本地全绿（typecheck 0 /
  **2051 passed · 11 skipped · 156 文件 · 10.21s** / tsdown 双面）；`release` 首跑 **1.5min 即挂**
  `tests/settingsDocPath.test.ts:7`「returns the absolute settings document path for an exact match」
  与 `:12`「compares paths case-insensitively on Windows」——Windows 形状 fixture
  （`C:/Users/test/.dsh/cordis.patch.yml`）在 ubuntu 被 host `path.resolve` 当相对路径拼上 runner
  cwd（Received `/home/runner/work/DSH_VsCodeMode/DSH_VsCodeMode/C:/Users/test/.dsh/cordis.patch.yml`），
  `build` job 同断言同挂。修法 = `src/settingsDocPath.ts` 按 `platform` 参数选 `win32`/`posix`
  resolve（生产只传 process.platform，语义不变；win32 分支在 Linux CI 也能被真实覆盖）+ 补 POSIX
  大小写敏感用例；当时在发布前失败后删tag、push修复 `6a53f78`、重打tag后CI绿（历史记录，不授权当前重打；现按「失败恢复」严格前提与单独审批）
  （release 7m30s / build 1m30s）。四向闭环一次对齐：registry 0.11.0 `gitHead==6a53f78`（release
  commit）、`dist-tags.latest=0.11.0`、tag 同 commit、Release 挂 tgz（7,076,539 B，
  digest sha256:955c0c0829…）。**坑（新测试上 CI 的判据）**：本地 Windows 全绿 ≠ CI 绿——断言里只要
  出现盘符/反斜杠形状，先自问「ubuntu 上同一输入经 host `path.resolve` 会得到什么」；能用显式平台
  参数消解就不要加 skip（skip 会让该分支在 CI 永远无覆盖）。
- 2026-09-24 实录（v0.10.0 发布，SVN AI 深度分析发送链路重构；**dapFakeAdapter:234 连续第三次
  首跑抖动**）：三门本地全绿（typecheck 0 / **1974 passed · 11 skipped · 147 文件 · 11.19s** /
  tsdown 双面）；`build` 54s 绿；`release` 首跑 **48s 即挂** `tests/dapFakeAdapter.test.ts:234
  waitFor 超时`（判据三分全中：不在本次 diff + 本地全绿 + 前次 CI 绿）→ `gh run rerun <run-id>
  --failed` **4m38s 绿**（本轮连 Verify 一次过，无第三结局）。四向闭环一次对齐：registry 0.10.0
  HTTP 200 且 `gitHead==909df00`（release commit）、`dist-tags.latest=0.10.0`、tag v0.10.0 同
  commit、Release 挂 tgz（digest sha256:b051563e…）。规矩不变：该用例已**连续三次**发布首跑抖动，
  后续先核对失败日志、改动范围与publish是否已尝试，再按「失败恢复」有限重跑无发布副作用的任务。
- 2026-09-23 实录 + 坑（v0.9.0 发布，远端差异审查 issue #7 + SVN 变更 AI 智能分组 +
  0.1.7-alpha.2 适配 + Ctrl+点击首开落点修复；**Release 首跑直接绿**）：三门本地全绿
  （typecheck 0 / **1974 passed · 11 skipped · 147 文件 · 17.63s** / lockfile
  `pnpm install --frozen-lockfile --lockfile-only` 供应链自检过 + tsdown 双面）；
  `release` run 35852383226 job 全绿、本轮无 dapFakeAdapter 抖动，四向闭环一次对齐
  （registry 0.9.0 的 gitHead==c441359、latest=0.9.0、tag 同 commit、Release 挂 tgz）。
  **新坑（跳转第三次回归的根因）**：并行改码触发 client HMR 热重载（判据 = 保留
  console 里插件装配三行日志重复出现的轮次）→ React entry 重挂载 → **挂载级 ref
  （pendingFocusRef 等）随旧实例销毁、意图静默丢失** → 跨热重载必须保留的状态一律落
  `window.__*__` 挂点（修复 = `window.__edrvPendingNav__` 槽 TTL 30s、落点才清 + 落点前
  模型身份守卫；43 单测 + 首开/交接注入/同文件/搜索入口四轮现场复测）。规矩：**并行会话
  改码期间不要做跳转类现场复测**（HMR 风暴会伪造回归）；平静态复测才是有效证据。
  issue #7 已回评（含 host 侧改动、升级后须重启 DSH 的提醒）。
- 2026-09-23 坑（0.1.7-alpha.2 实测，**设置页 P0，两次截图证据**）：**0.1.7 的
  `SettingsForms.describe` 按 `volatileForm(schema)` 门槛下发 entry——Config schema
  无任何 `.volatile()` 字段 = 整条 entry 被跳过**，ns 不进 describe → client
  `configForms` 恒 `status='unavailable'` → 设置页「设置服务暂不可用，当前使用自动选择」
  + 控件禁用，host 写入抛 `has no volatile fields`（alpha.1 即存在，E2E 未闭环未暴露）。
  修法三件套：① Config 全字段 `.volatile()`（`buildSettingsSchema(z,{volatile:true})`，
  section 安装 schema **不标**——旧线无门槛且避免 `scope.get()` 引用污染）+ 能力守卫
  （缺方法/抛错降级，模块加载不炸）；② **依赖移入 dependencies 钉 `~3.18.4`**
  （3.18.1 无 `.volatile()` 方法！peer + 3.18.x 开区间会解析到任意旧版，重演 v0.5.2
  「用户端解析不到」教训）；③ 配置读点收敛 `configField/unref`——cordis `resolveConfig`
  把 volatile 字段解析成稳定引用（`Symbol.for('cosmokit.volatile.write')` 判据），
  不解引用则回退值全落默认。规矩：**插件自带「无自定义 config 字段」类注释必须随
  schema 字段实况复核**（cordis.patch.yml 曾因此漏声明）；兼容性页新增「Config volatile
  字段」行 + 条件告警，同类静默失败以后可在报告直接看见。
- 2026-09-23 实录（v0.8.0 发布，DSH 0.1.7 适配 P0×3 + 文件树原生打开；**dapFakeAdapter:234 连续第二次
  首跑抖动**）：三门本地全绿（typecheck 0 / **1843 passed · 11 skipped · 141 文件** / tsdown 双面）；
  `build` 首跑 41s 挂 `tests/dapFakeAdapter.test.ts:234 waitFor 超时`（与 v0.7.0 首跑逐字同款；判据三分
  全中：失败文件不在本次 diff + 本地全绿 + 前次 CI 绿）→ `gh run rerun <run-id> --failed` **53s 绿**；
  `release` 一次过 **5m30s**（含 Verify，无第三结局）。四向闭环：registry `0.8.0` 200、
  `dist-tags.latest=0.8.0`、`gitHead==4abf0f7`（release commit）、tag 同 commit + Release 挂 tgz。
  该用例的历史抖动仅作线索；后续必须核对三项判据及任务发布副作用，遵守「失败恢复」最多2次预算。
- 2026-09-22 实录（v0.7.0 发布，资源管理器右键菜单；**经历首跑失败→重跑→第三结局**，四向闭环仍一次对齐）：
  三门本地全绿（typecheck 0 err / **1745 passed · 7 skipped · 137 文件 · 19.7s** / build 双面绿）；`build` job 37s success。
  **首跑 `release` 35 秒即挂**：`tests/dapFakeAdapter.test.ts:234` 握手用例 `waitFor 超时`——该文件与 `src/dap/*`
  本次未改动、本地与 v0.6.0 CI 均绿 → 判**抖动非回归**，处置用 **`gh run rerun <run-id> --failed` 原地重跑**
  （发布未发生时无需走「删远端 tag 重推」流程，更省）。重跑测试全过、Release 已产出，但
  `Verify published tarball` 走满 15×30s 仍 `not retrievable` → 查 registry：`0.7.0` HTTP 200、
  `dist-tags.latest=0.7.0`、`gitHead==c7e15b0`（release commit）→ **v0.4.4 第三结局再现（公开可读晚于Verify窗口，
  不据此猜测CDN或stage根因；勿重跑publish防冲突）**，GitHub Release tgz digest `sha256:ffb9fb0f…` 补齐四向闭环。
  教训：`Verify` 步失败**先查 registry 三个字段（200 / latest / gitHead）再决定动作**；判「抖动 vs 回归」的
  判据 = 失败用例所在文件是否在本次 diff 中 + 本地与前次 CI 是否双绿。
- 2026-09-22 实录（v0.6.0 发布，全绿）：`build` 54s success、`release` **5m29s** success（含
  `Verify published tarball`）；四向闭环一次对齐：registry `0.6.0` 的 `gitHead` == `427b7ec`
  （release commit）、`dist-tags.latest` → `0.6.0`、tag 同 commit、Release 挂 tgz
  （digest sha256:52c2c3…）。改动 99 文件（DAP 断点调试 + SVN 补丁/汇总/导出），逐条核对后单提交不 stash。
- 2026-09-22 坑（v0.6.0 发布前实测，**新测试首次上 CI 前必查**）：伪造扩展清单的 fixture
  **漏抄真实清单字段**会产出本地/CI 双态失败——`dapDiscovery` 的 coreclr fixture 漏写
  `languages`（真实 DotRush 清单有 → 经 `LSP_LANG_EXT` 才映射出 `exts=['.cs','.csx']`），
  且只创建 `clrdbg.exe` 入口（Windows 走 `windows.program` 覆盖本地绿；ubuntu 回落基名
  `clrdbg` 不存在 → `available=false` 第 66 行必挂）。规矩：**fixture 模拟真实扩展时对照本机
  实际 package.json 抄全 `languages`/平台入口文件**；判「该修测试还是修实现」看三方契约
  （实现注释「皆空=不限=[]」、`bpAllowed` 空表不过滤、README「按**声明**语言过滤」）——
  三方一致则 fixture 错，改 fixture 不改实现。
- 2026-09-21 事实 + 坑（暂停态调试 hover 对齐 CodeBuddy，源码级核对 `CodeBuddy CN/resources/app/out/vs/
  workbench/workbench.desktop.main.js`）：CodeBuddy/VS Code 的调试浮窗是**独立 widget**（`debug.hoverWidget`
  → `.debug-hover-widget` / `.debug-hover-tree[role=tree]`，成员全量 + 行内折叠按钮），显示时调
  `preventDefaultEditorHover()`（`editor.updateOptions({hover:{enabled:false}})`）**禁用默认（LSP）hover**；
  **按住 Alt** 反过来隐藏调试浮窗、解除禁用 → 显示 LSP hover。本仓 Monaco hover 只能返回 markdown，
  等价实现落在三处：调试内容单块 HTML（`[data-edrv-dap]`，`src/client/dap/hover.ts`）、hover 层
  （`src/client/dap/hoverTree.ts`：给行打 `data-edrv-row=debug|lsp`、注入贴底提示层、按 Alt 切 display）、
  Alt 跟踪（`src/client/dap/hoverMode.ts`）。四个实测坑：
  **①（切换）别用 `showContentHover` 主动重算**：`getContribution('editor.contrib.hover')
  .showContentHover(光标处折叠 Range, 1 Immediate, 0 Mouse, false)` 看似是官方 `showEditorHover` 同法，
  但 `_startShowingOrUpdateHover` 在「新 anchor 与当前结果 anchor 相等」时**直接 return**
  （`HoverRangeAnchor.equals` 只比 range）⇒ 同一鼠标位置反复按 Alt **只有第一次生效**（且整块重渲染闪烁）。
  正解是**不动 provider 的显示层切换**：Alt 变化只改行的 `display` 与提示文案，瞬时、且不依赖 keydown 送达
  （`mousemove.altKey` 兜底）；`debugHoverOwns()` 让位逻辑随之作废（LSP 行默认隐藏、Alt 时显示）。
  **②（钩子）markdown 会剥掉 `class`**：本仓 vendored Monaco 的 markdown→DOM 管线把我们 hover 内容 HTML 里的
  `class` **全部丢掉**（`supportHtml:true` / `isTrusted` 都不豁免，页内实测三种写法全丢），**只有 `data-*` 存活**
  ⇒ 经 provider 返回的 HTML，交互钩子与 CSS 选择器**一律用 data-***；用 class 会静默失效（折叠按钮点了没反应、
  样式全不生效，且 tsc/单测都抓不到）。**③（提示常显）**贴底提示别用 `position: sticky`（滚动链在
  `.monaco-hover-content` 上，会被滚走）也别用 `:has(class)`（class 已被剥）：注入到 `.monaco-hover`
  （**滚动区之外**）`position:absolute;bottom:0`，并给容器打 `data-edrv-hint-host` + `padding-bottom` 预留同高。
  **④（树状态）**`createTreeState` 同 key 必须**复用**旧状态（按名+ref 判等），否则 hover 一重渲染
  `expanded/cache` 清零，观感是「点开又收起」；绑定要用批次末兜底扫描
  （`[data-edrv-tree]:not([data-edrv-wired])`），因为 markdown 内容是异步插入 DOM 的。
- 2026-09-18 实录（v0.5.3 发布，全绿）：`build` 41s success、`release` **5m34s** success
  （`Verify published tarball` 同轮内取到，非 staged）。三向闭环一次对齐：registry
  `dsh-vscode-mode/0.5.3` 的 `gitHead` == `7f71d8e`（release commit SHA）、`dist-tags.latest`
  → `0.5.3`、git tag `v0.5.3` → 同 commit、GitHub Release 挂 tgz asset（digest sha256:5027…）。
  本次改动全为本会话产物（mtime 全在 17:15–17:52 一簇），沿用「逐条核对后单提交、不 stash」口径；
  发布前三门实测：typecheck 0 err、**全量 1447 passed / 7 skipped（104 文件）**、build 双面绿。
- 2026-09-18 坑（v0.5.3 实测，**GUI 验证才能抓到的一类缺陷**）：**用 `typeof x === 'function'`
  判「React 组件是否可用」是错的**——官方 `MarkdownText` 是 `React.memo(...)` 产物
  （`MemoExoticComponent`），`typeof` 为 **'object'** 而非 'function'，函数判据恒 false →
  「兼容降级」分支在**所有新版 DSH 上永久生效**（预览只显示降级纯文本）。该缺陷**同时绕过
  tsc 与全部单测**：手写 ambient 垫片把导出声明得很宽松、纯函数测试不碰该守卫，
  唯一捕获途径是真实浏览器端到端。修法 = 抽纯函数 `isComponentType(value)`，按 React 自身
  口径判（`typeof === 'function'` **或** 带 `$$typeof` 的非 null 对象），并补单测固化
  「memo 替身的 typeof 必须是 object」这一前提（本仓 `src/client/md/componentType.ts`）。
  **教训：凡与 React 组件类型打交道的判据，必须有独立可单测的纯函数**，否则垫片 + `@ts-nocheck`
  会让类型系统完全失明；且**客户端 UI 新功能发版前必须真浏览器冒烟**（对齐既有「发布前仅跑三门
  不抓渲染期错误」条目）。
- 2026-09-18 坑（v0.5.3 实测，**新建数据损坏，已留证未修**）：**700ms 防抖自动保存会把
  「当前活动文件的内容」写进「先前文件的路径」**——症状是旧文件被静默覆盖成新文件内容。
  根因在 `EditorView.ts` 三处叠加：① `doSave` 用 `const path = active` 取路径、`ed.getValue()`
  取内容（**不同源**）；② `onEdit` 的 `arm(schedule, 700, () => doSave(true))` 闭包**触发时**才读
  `active`/`editorRef`；③ `edrv:open-editor` → `addTab` 入口**只 setActive、不 flushSave**
  （页签点击 / 关闭路径都调了 flushSave，唯独这个入口没有）。复现：编辑 A → 700ms 内开 B。
  判别「是不是本次改动引入」的归因实验：把触发概率的条件（如页签上限）设为 0 禁用掉，
  **仍复现即与本次无关**。修法方向（留待立项）：`doSave` 改为按 model uri 反解路径
  （已有 `modelPathOf`，保证 path 与 content 同源）**且**所有改 active 的入口统一先 `flushSave()`。
  同族教训：**任何会替换 Monaco host / 改变 active 的新入口，都必须先 `flushSave()`**，
  否则防抖到点时 `editorRef` 已空 → `doSave` 静默 return → 改动永不落盘（v0.5.3 的 Markdown
  预览切换已按此处理）。
- 2026-09-18 坑（v0.5.3 实测）：**改 `README.md` 必须顺手更新「安装」段的固定 tag 与
  「更新日志」**——该段常年停在旧版本号（v0.5.0 时发现还写着 v0.1.23；v0.5.3 时安装示例
  仍钉 v0.5.2）。发版清单里把它当固定动作：安装示例 3 处 tag（git/Release tgz 的文件名）
  + 顶部「近期关键版本」追加本条。
- 2026-09-18 实录（v0.5.2 发布，全绿）：`build` job 41s success、`release` job 4m32s success
  （含 `Verify published tarball`，**无需等满重试窗口**，本次公开核验很快完成，不据此归因CDN）。三向闭环一次性对齐：
  registry `dsh-vscode-mode/0.5.2` 的 `gitHead` == `980b7b2`（release commit SHA）、
  `dist-tags.latest` → `0.5.2`、git tag `v0.5.2` → 同 commit、GitHub Release 挂 tgz asset。
  事实：本次 **未** stash——改动全部 mtime 集中在同一 5 分钟内（16:30–16:34）且逐条核对确属本次内容，
  当时用 `git add -A` 单提交（仅历史实录，现须获批精确清单）；打 tag 前先确认远端无该 tag 且 npm 该版本 404。
- 2026-09-18 坑（v0.5.2 实测，**用户端 vs 开发形态差异**）：**开发形态（`link:` + junction）会掩盖
  npm 安装缺陷**——本仓 `node_modules` 有 devDependency 副本，`import('schemastery')` 能命中
  `.pnpm/schemastery@3.18.0`，而**用户 npm 安装（profile `nodeLinker: hoisted` + `autoInstallPeers: false`）
  下插件包只有 `dependencies`，解析不到**。判据：改依赖解析/包名相关代码后，别只在本机（dev-link）
  验证——用 `createRequire(anchor).resolve(spec)` 对**安装树入口**（`process.argv[1]` 锚点）与
  **插件自身路径**两个锚点分别探测，二者结果不一致即“只在用户端坏”的缺陷。
  （本轮实例：`fileOpenSettings` 用 `Promise.all([...hostImport('schemastery')])`，安装树里官方已把
  vendored 包改名为 `@deepseek-ai/schemastery` → 整体 reject → 设置 section 静默不装配，面板显示
  「设置 section 尚未装配」；修法 = 候选链解析 + 各依赖独立加载 + 命中库名进报告。）
- 2026-09-18 坑（v0.5.2 实测）：**VSIX 解包必须补 Unix 执行位**——`src/lsp/zip.ts` 的 `zipEntries`
  原先不读中央目录 `offset+38` 的 external attributes（Unix mode 在**高 16 位**，低 16 位仅 DOS 属性），
  `writeFileSync` 落盘默认 0o666 → macOS/Linux 上语言服务器 `spawn EACCES`（Windows 不检查执行位故
  开发机不复现；VS Code 自身解 VSIX 会按该 mode 调 `fs.chmod`）。修法 = 读 mode + 按 `bin/` 等入口名
  兜底 0o755（`src/lsp/extmgr.ts` 的 `execModeOf/applyExecBit`，best-effort 不阻塞安装）。
  测试注意：Windows 宿主 `chmod` 改不了执行位 → 真实落盘断言要 `it.skipIf(process.platform === 'win32')`。
- 2026-09-18 坑（v0.5.2 实测）：**平台专属命令不要“先试错的再回落”**——`revert.deleteCreated` 原先无条件
  先发 `powershell Remove-Item`，macOS/Linux 每次删除都先失败一次再走 `/bin/rm`（功能可用但有失败噪声与
  无谓 spawn）。规矩：按 `process.platform` 一次分派（抽纯函数 `removeFileArgv` 便于单测）。
- 2026-09-18 坑（v0.5.1 实测，**发布前必查**）：**改 `package.json` 的依赖/peer 后必须同步重生成
  `pnpm-lock.yaml`**，否则 CI 的 `Install deps`（`pnpm install --frozen-lockfile`）直接失败 ——
  症状极具迷惑性：CI 两个 job 都在 **~15 秒**内 failure，`Typecheck`/`Test`/`Build` 全部 **skipped**，
  annotations 只有一句「Process completed with exit code 1.」指向 workflow 文件行号（不是源码），
  看代码怎么都找不到问题。修法：`pnpm install --lockfile-only` 后提交 lockfile；本地自检 =
  `pnpm install --frozen-lockfile --lockfile-only` 返回 0。
  （判据：失败时间远小于跑测试所需时间 ⇒ 问题在安装/构建前置步骤，别去翻测试。）
- 2026-09-18 事实（v0.5.1 实测，恢复判据已收紧）：**Release 404本身不足以证明可安全重发**；还须证明publish从未尝试、版本未占用且取得单独审批（见「失败恢复」）。本轮 13 步全 success，
  `Verify published tarball` 约 **4.5 分钟**后成功；只能确认公开核验耗时，不据此判定CDN/stage原因。当时核对：
  registry `<pkg>/<ver>` 的 `gitHead` == release commit SHA、`dist-tags.latest` 已切换、
  git tag 指向同一 commit；现行验收还须下载实包核验SRI/manifest/入口（见「发布验收」）。
- 2026-09-18 事实（v0.5.1）：本仓 `tests/outline.test.ts`（自 v0.1.21 起未改）存在**既有顺序依赖**
  ——`npx vitest run --sequence.shuffle` 会偶发失败，而 CI 用默认顺序（不 shuffle）恒绿；
  排查「偶发失败」时先用 shuffle 复现并区分是否本次引入，别把它当自己的回归去改别人的测试。
- 2026-09-18 坑（v0.5.1 实测）：**官方 alpha 线会移除 client 快照字段，取「当前会话」必须走多级链**——
  DSH 0.1.6-alpha.2 起 `sessions.list` 快照不再有 `current`（改为 `uiSession.current`，其绑定源
  `getSnapshot().key` = sessionId），仍直读 `list.getSnapshot().current` 的代码**静默失效**（不报错，
  只是预热/LSP 同步/编辑 Tab 恢复/文件链接上下文全不工作）。取值顺序：`uiSession.current.key` →
  `list.current`（旧版）→ `byId` 中 `retainedBy.mainView > 0` 的首行 → 槽位 `props.sessionId`；
  `uiSession` 用 `ctx.get` 探测**别进 inject**（旧版无此服务会停等）。本仓实现在 `src/client/sessionScope.ts`。
- 2026-09-18 坑（v0.5.1 实测）：**`window.monaco` 跨插件重载存活，模块级 `registered` 守卫会失效**——
  插件重载后 bundle 重新求值使模块状态复位，但 Monaco 实例还在 → 每次重载**重复注册整套 provider**
  （补全/跳转/hover 翻倍）。规矩：provider 注册标记与注销器一律落 `window.__edrv*__`（跨代认领 + 可清理），
  并在 client `apply` 的 `ctx.effect` 卸载回调统一 dispose。改动前先 grep「`disposeXxx` 是否有调用方」——
  本仓曾出现 `disposeSnippets()` 定义完整却**零调用**（死代码），AI/LSP 两处更是完全没有复位路径。
- 2026-09-18 坑（v0.5.1 实测）：**peer 区间写 `>=0.1.0-rc.1 <0.2.0-0` 对 alpha 版本恒不匹配**——
  semver 要求比较器的元组自带预发布标识，否则该区间对**任何**预发布返回 false（实测
  `satisfies('0.1.6-alpha.2','>=0.1.0-rc.1 <0.2.0-0')===false`，而 `'0.1.0-rc.8'===true` 只因恰好落
  在下界元组内）。每条 alpha 线要显式写 `>=0.1.6-0 <0.2.0-0`。本仓守卫见 `tests/peerDeps.test.ts`。
- 2026-09-18 事实（v0.5.1 实测）：**host 半改动不随 client 热更新生效**——client 走 combo 端点按 rev 读盘
  可即时生效（新增 window 标记浏览器里能立刻读到），但 host 半在进程内**不重载**：`compat` RPC 仍报旧
  `TESTED_DSH_MAX` 而磁盘 bundle 已是新值。判别「跑的是不是新 host」= 调一个只有新代码才有的行为/RPC；
  **改 host 后必须重启 DSH 才能验收 host 侧效果**，别把「磁盘已改」当「已生效」。
- 2026-09-18 事实（v0.5.1）：`plans/` 在 `.gitignore:19` 被忽略 → 计划文件不会进发布提交（本轮 22 个
  文件全为 `src/`、`tests/`、`docs/`、`package.json`、`README.md`；现按获批精确清单暂存，不因目录被忽略就默认 `git add -A`）。
- 2026-09-18 事实（v0.5.0 实测，四条全绿一次过）：① **真实仓库数据样本不入库**——测试若依赖真实仓库导出（如 `svn log -g` 的 XML），把样本放 `tests/fixtures/*.xml` 并加进 `.gitignore`（已加），用例写成
  `const f = fileURLToPath(new URL('./fixtures/x.xml', import.meta.url)); it.skipIf(!existsSync(f))('…', () => …)`：本地有文件即真跑，CI 无文件自动 skip（v0.5.0 实测 43→42 passed + 1 skipped，两面都绿）；
  别指望 `git rm --cached` 之后 CI 还能找到它。② 本仓JS发布套件按获批范围执行（当时1337用例≈8s）；日常验证只跑受影响最小集，不扩展为Unity全量。
  ③ 本次 `release` 工作流 13 步全 success，含 `Verify published tarball`（**5 分 34 秒**才拿到 tarball，不据此归因CDN/stage）；当时核对registry `latest` 的
  `gitHead` == release commit SHA；现行验收还须核验实包完整性与入口，SHA元数据本身不闭环。④ 顺手更新 README 的**安装示例固定 tag** 与「更新日志」段——它常年停在旧版本号（v0.5.0 时发现还写着 v0.1.23）。
## 何时使用

- 发布新版本（commit/push/tag/npm 相关操作）。
- 编写或修改测试（尤其涉及路径、文件 URL、平台差异）。
- 修改 host 集成（subprocess/reg/csc）、launcher（C#/PS）、Unity 包（DshCodeEditor）。
- 新增/修改插件自带技能（`skills/` 随包 SKILL.md、`src/skills.ts` provider）。
- CI（GitHub Actions）失败排查。

## 仓库布局与 issue 修复

- 2026-09-22 事实：**本仓库真实开发 checkout 就是 `DeepSeekHarnessPlugin/packages/dsh-edit-review`**（remote 指向 Lenonss/DSH_VsCodeMode.git）；
  `packages/dsh-vscode-mode` 是停更的 v0.1.28 旧副本，缺官方侧栏文件（OfficialSideTab.ts/officialSidebar.ts），别在那里改。
- 2026-09-22 坑：edrv URI 拼绝对路径必崩——`'edrv:///' + encodeURI(path)` 遇 `/home/x` 拼出 `edrv:////`（4 斜杠），
  Monaco Uri.parse 抛 UriError 白屏（issue #5/#6，Linux/macOS 必现）；修法 = 先 `String(path ?? '').replace(/^\/+/, '')` 再拼，
  Windows 盘符形态不变；同源隐患在 lspClient.toEdrvUri（root 不匹配时 relativeLspPath 返回绝对路径）要一并修。
- 2026-09-22 坑：`@ts-nocheck` 文件里「调用未导入的标识符」typecheck 抓不到（OfficialSideTab 漏 import markEditorActive →
  卸载 ReferenceError）；排查运行时 ReferenceError 时优先核对 import 列表与调用点，别只看类型检查。
- 2026-09-22 坑：Monaco loader 失败永久卡死 = fail() 不清 `<script data-edrv-monaco-loader>` + 残留分支同步 boot()；
  且其他插件注入全局 `module`（loader.js 用 `typeof module < 'u' && !!module.exports` 判环境）会让 loader 误判 Node
  不挂 window.require → 注入前临时删全局 module/exports（onload/onerror 后还原）+ boot 前校验 require + 失败清标签
  + 残留分支「require 就绪才 boot，否则移除重注入」；boot 内 require 缺失直接 fail 报真实原因（别再重注入，防死循环）。
- 2026-09-22 坑（测试）：mock window.require 就绪时，loader 残留分支会走「require 就绪直接 boot」而非「移除重注入」——
  测「残留+require 缺失」场景必须初始 stub `{ require: undefined }`，注入后（onload 前）再换成就绪 require。
- 2026-09-22 坑（v0.4.4 引入，v0.4.6 修）：渲染期裸赋值 `ref.current = 后置const` 是 TDZ 必炸——FileExplorer 组件体
  134 行 `dirsMapRef.current = loadDir` 写在 157 行 `const loadDir` 之前 → 「文件编辑」Tab 挂载即 `Cannot access
  'loadDir' before initialization`，slot 错误边界清空正文全空白（无堆栈指向源码行，全平台）；且该 ref 无消费者（监听实际
  走 reloadDirRef）= 死代码。规矩：**渲染期 ref 镜像赋值必须放在被引用 const 定义之后**；删 ref 前先 grep 消费方。
- 2026-09-22 坑：发布前仅跑三门不抓组件渲染期错误（tests 全是纯逻辑，无 DOM 渲染测试）——v0.4.5 带着上述回归过全量
  1082 用例照发。**客户端 UI 改动发版前必须真实浏览器冒烟核心入口**（官方侧栏「文件编辑」Tab 打开 + 资源管理器挂载）；
  复现用 chrome-devtools：点侧栏入口卡片 → 看 console 是否 slot entry crashed。工具缺失时不得以三门绿替代；明确记录缺口并获用户接受，发布不等于已完成GUI验收。
- 2026-09-17 坑：Ctrl+点击「只打开文件不跳转行」的真因在 **EditorView 而非 opener**——跳转/model 同步 effect 用
  `content === null` 当就绪判据，跨文件切换那一帧 content 仍是**上一个文件**的内容（非 null），于是先建 model(A 内容)
  → reveal/setPosition(目标行) 生效 → B 真实内容到达触发 `setValue` → Monaco 重置光标到 1:1，而 pendingFocus 已消费
  → 落点永久丢失（同文件跳转不换内容故不复现，看起来「时好时坏」）。修法：门控一律用 `contentReady`（contentPath === active）。
  诊断法：hook ed 的 onDidChangeModelContent/setValue/setPosition 打时序日志，一条 trace 就能看出顺序错位。
- 2026-09-17 坑：**Monaco `model.getWordAtPosition()` 只返回 `{ word, startColumn, endColumn }`，不含行号**——
  直接把它当 range 透传会产出 `startLineNumber: undefined` 的非法装饰：`deltaDecorations` 正常返回 id、装饰也「挂上了」，
  但 DOM 里查不到该 class（零可见高亮，极易误判为「装饰没生效」）。必须用当前行补齐行号。另：零宽 range
  （start === end，Monaco 原生跳转 `collapseToStart` 后的常态）同样渲染不出任何高亮，需识别为「无区间」并回落到单词/整行。

## 发布流程（必须照做，禁止偏离）

### 发布前与推送

1. **先审批、后写入/外部动作**：明确版本、具体文件清单、原有本地修改归属、验证范围、GUI缺口、恢复边界。发布不等于安装或部署，不能自动改profile/重启DSH。mtime与测试结果只辅助判断，不替代用户授权。
2. 用 `Get-Location`、`git status --porcelain`、remote/分支/HEAD、远端main/tag、registry版本与 `dist-tags.latest` 核对真实checkout和基线；远端前移或版本/tag已占用即停，不force push。不自动stash/merge别人的改动；如需隔离WIP或前移基线，追加审批并保存原件。
3. 版本同步 `package.json`、README安装示例（git/npm/tgz）、最新日志及发布说明；历史兼容声明不整体替换。仅依赖/peer变更时同步lock并验证frozen install，纯版本/文档改动不无谓重生lock。备份和验证报告可落 `plans/`，每次仍核对git忽略，不假定其状态永远不变。
4. 最终三门顺序为 `npm run typecheck` → `npm run test` → `npm run build`；本仓JS发布套件范围须在计划中写清，不扩大为Unity全量。保存退出码、测试通过/跳过/失败/耗时、双bundle结果与warning。先核验prebuild清理的绝对 `lib` 目标为本工作区普通目录、非junction。失败先定位，不偷偷修范围外源码。
5. UI改动须真实浏览器冒烟受影响入口、回退、主题/滚动并检查Console；测试与mock DOM不能替代。工具不可用时写清“未验证”，**取得用户明确接受缺口后**才发布，不伪造验收；不为冒烟启动替代GUI或自动部署。
6. **精确暂存获批清单**（`git add -- <paths>`），比较 `git diff --cached --name-only` 与清单、核对暂存diff及 `git diff --cached --check`。提交必须与三门已验证的内容一致；混合WIP不能仅暂存一部分却用脏树绿灯充当验证，需先获准隔离/验证实际提交树。commit：`release: vX.Y.Z <摘要>`。
7. 再查远端基线/版本占用 → `git push origin main` → `git tag vX.Y.Z` → `git push origin vX.Y.Z`；任一步失败即停，记录已成功的步骤，不能盲重复整串命令。核对main/tag指向发布提交。
8. tag触发 `.github/workflows/release.yml`：tag/版本一致 → 三门 → pack → GitHub Release tgz → 有NPM_TOKEN才publish → Verify；记录CI/Release run ID和步骤结论。**本仓禁止本地 `npm publish`**，只走获批CI，不读取凭据。观察权限/CLI版本以当前证据为准，不沿用旧whoami/版本结论。

### 发布验收与有限等待

- 分别记录：提交/tag、CI构建、Release资产、npm上传接受、npm公开元数据/实包、当前DSH部署与GUI验收。`npm publish`退出0或 `+ pkg@ver` **仅表示上传接受**；Verify失败**仅表示该窗口未验证完成**，不能推导“未上线”或“staged”。
- 读 `https://registry.npmjs.org/<pkg>/<ver>` 与 `/latest`（本仓稳定版目标latest）；确认version、`gitHead == 发布SHA`、目标dist-tag，再下载 `dist.tarball` 验证 `dist.integrity`（SRI）/shasum、包版本与 `package/lib/index.js` + `package/lib/client.js`。GitHub asset单独下载比API digest；若两端设计为同一个pack产物，还要比完整摘要。SHA/SRI/版本/入口不一致立即停止并报告，不当作传播慢；metadata SHA本身不证明实包字节或部署生效。
- `404`、latest未切换、time字段或Verify超时都不能证明staged；`Your package is being processed and may take a few minutes to become available.` 按“接受后待公开”处理，不猜CDN/安全扫描/队列根因。只有明确stage列表/响应或**已出现** `Cannot publish over previously staged version` 才判暂存并请维护者走官方2FA审批；不能用再次publish来试探stage，不代办审批。
- 等待建议：接受上传起最多60min、120s间隔，按当前工具/审批能力运行**一个**可取消后台任务；用job_output等待通知/结果，不另开重复探针。60min是操作预算，不是npm保证；404/408/429/5xx/超时按分类记录，429尊重Retry-After，401/403立即停查权限。TLS/代理/沙箱错误不证明registry未上架，按工具边界处理，不绕过限制。metadata就绪后进入独立完整性检查，不能把检查异常catch为“继续等待”。超时先复核现状，报告“上传接受、公开核验未完成”，保存时间/错误/证据并征求延长或暂停；没有用户批准不无限等待。
- 发布报告须含SHA/run链接、测试范围及计数/耗时、metadata/dist-tag、实包完整性/入口、未验证项与部署边界。只要独立核验闭环，可以报告“已发布”；同时如实保留Release workflow历史Verify红灯，不用重跑发布来洗绿。

### 失败恢复（先判断发布是否已尝试）

| 失败位置/证据 | 允许动作 | 禁止动作 |
| --- | --- | --- |
| 安装/typecheck/新测试/构建失败 | 查原文与改动范围；需要源码修复时追加审批 | 把平台路径断言失败一概判为抖动 |
| 已知计时抖动，失败测试及实现未改、本地与同提交/前次CI绿 | 记录用例与stack；按获批预算最多2次 `gh run rerun <id> --failed`，仅无发布副作用CI任务或publish从未运行的Release任务 | 不看日志直接重跑；已尝试publish后重跑整Release job |
| publish被跳过、拒绝，或日志/传输结果不明确 | 明确记录未尝试/失败/未知，查metadata与原响应，请用户决定凭据/CI恢复 | 未知状态当成安全重发；本地publish兜底 |
| 上传已接受后Verify失败或404 | 只读有限等待；就绪后独立校验实包 | 重跑含publish的job、重打同tag、擅自升版本 |
| 明确stage证据 | 引导维护者用当前官方支持的CLI/Web与2FA确认/审批 | AI代办审批，重发探针 |
| gitHead/SRI/入口不一致 | 立即停止，保留证据并请求恢复方案 | 当成延迟盲重试/宣称已发布 |

- 已知抖动锚点：`tests/dapFakeAdapter.test.ts:26` 的 `waitFor 超时`；`tests/treeIndex.test.ts:195` 的 `expected null not to be null`。行号会漂移，核对测试名/当前stack。两次重跑仍失败就停并汇报，既有经验不是永远免责。
- **重打tag不是默认恢复动作**：只有明确证明publish从未尝试、版本未被占用/暂存且无Release资产，并取得用户对删tag/重打的单独批准后才考虑。已公开/已接受/未知的版本保持不可变；需要修复时另批新版本，不覆盖发布历史。
- 日志优先 `gh run view <id> --log-failed` 或定向读取publish/verify步骤；再按实际权限回落check-runs/annotations。不能把旧“日志API需admin”当现行事实；504等临时故障有限重试，拿不到就明说，不猜失败原因，不输出token/env配置。

### 历史教训（已纠偏）

- v0.4.2出现 `409 Conflict - Cannot publish over previously staged version "X"` 是明确stage证据；不能复刻“再publish看409”的危险诊断。v0.4.3/v0.4.4/v0.14.5证明相似404/Verify超时也会自行公开，不能单凭时间窗口归因。
- `git add -A` / 自动stash是早期实录，不作默认动作：先逐条确认归属与发布授权，优先精确清单；WIP隔离和恢复都须用户确认，不能盲stash pop覆盖前移基线。
- v0.3.3平台错误 `tests/skills.test.ts:158` 的 `'/D:/pkg/skills' !== 'D:/pkg/skills'` 说明Windows本地绿不保证ubuntu绿；先查失败步骤和断言。awesome PR #2532曾有过期固定tarball，修改外部收录要单独授权，优先npm映射避免冗余固定版本。
- 历史pnpm报 `unable to open database file` 不授权跳过脚本；本次用 `npm run` 保留pre/post hooks成功。换执行入口必须确认钩子/测试链等价并按现行沙箱规则处理，不能只调vitest而漏掉native-open或prebuild。


## 差异审查（DiffBox / 旁车）设计口径

- 2026-10-28 坑（**失效记录全 stale 时差异栏空白，v0.20.3 修**）：`pendingRegions=0` 时官方差异栏既不渲染 zone 也不给任何提示，
  用户只看到「待审 N + 位置 `—` + 上下箭头点了没反应」（桌面端真实报障）；prompt 待审数是**记录数**、箭头是**可定位块数**，两者不同源却无文案解释。
  修法 = 客户端纯函数 `src/client/reviewBar.ts`（`reviewBarView`）统一「位置 / 箭头禁用原因 / 失效叙事 / Keep 提示 / 待审标题」四条分支：
  全 stale 给「无可跳转 + 点 Keep 结案（只标记已采纳、不改写磁盘）」，`contentReady` 门控避免内容未载入时误报失效；
  `reviewError` 经 `sessionErrorText()` 归一（裸 `会话不存在` → 可读指引），`loadReview` 成功清同源陈旧错误。
  与 2026-09-15「可见性必须配套可操作性」同源，补的是另一半：**无操作可用时必须有解释**。
- 2026-09-23 事实（issue #7）：dsh-remote-ssh 远程工作区 cwd = **本机镜像**（根含 `.remote-ssh.json {profileId,host,user,remotePath}`，向上 ≤8 层判定，与上游 findMirrorRoot 同判据）；agent
  `remote_ssh_write` 直写远端不落镜像 → `capture.ts` 已扩展捕获（before=镜像快照 / after=args.content，before===after 不产记录）并以 **node:fs 写穿镜像**——勿走 ctx.fs，否则触发上游 2.4.14 写桥把相同内容
  再推回远端（重复 SSH 往返 + 补丁次序）；展示走 `RecordView.displayPath`（`recView(record, ws)` 运行时算、**不落盘**），client 一律渲染 `displayPath ?? path`，分组/打开仍用 `path`。
- 2026-09-23 坑（测试）：断言记录 `hunks` 用 `toEqual` 必须带上 `annotateHunks` 写入的 `afterStart/afterEnd`
  （如 `{oldText:'old',newText:'new',afterStart:0,afterEnd:3}`）——这是既有标注行为，漏了会 deep-equal 失败，不是回归。
- 2026-09-15 坑：`recordIsStale` 对「pending hunk 的 newText 已不在文件中」的记录**不归档**（只置 `conflict=true` 留在待处理列表供复核），
  而单文件 Keep/Undo 原先只认 `pendingRegions`（可定位差异）→ 这类文件恒留在差异栏、按钮置灰，全局 Keep All/Undo All 却是亮的（幽灵条目）。
  规矩：**给某类差异「可见性」时必须同时给「可操作性」**——`canDecideFile(pending, stale)` 决定按钮可用性、单文件决策作用域 = `pendingRegions + staleRegions`、
  host `revertHunk` 定位失败返回 `stale:true` 并由 `applyDecisions` 按「已回滚」记账（不写文件、状态栏提示「N 处已不存在于文件」）。
- 2026-09-15 事实：同一文件被连续/并发 edit 后，先前的 pending 记录会整批变成 conflict（before/after 链断裂、当前内容不等于任一快照）——这是正常现象而非 bug；
  判别某条记录是否真过时：逐条比对 hunk `newText` 在当前内容里的 `indexOf`（原始 + 归一化两种口径），全为 -1 即确属「已被后续修改覆盖」。

## 开发/部署形态切换（profile 安装形态）

- 开发形态 = profile node_modules 里 Junction → 源码目录（构建即生效）；正式形态 = npm 版本依赖。
  解除：备份 profile `package.json` → 依赖改 `^<version>` → `cmd /c rmdir` 删 Junction（只删重解析点，
  禁用 `Remove-Item -Recurse` 以防触达源码）→ profile 内 `pnpm install` → 重启 DSH 生效
  （运行中 host 半仍是旧代码）。解除后源码改动不再直达 profile，需走 tag 发布 + `pnpm install`。
- 2026-09-08 坑：profile 依赖写 `file:...tgz` 但实际装的是手动 Junction 时，`readDevForm` 只认
  `link:` 前缀 → 兼容性报告误报「非开发形态」；依赖声明必须与实际安装方式一致。
- 2026-09-08 事实：web profile pnpm 为 `nodeLinker: hoisted`（无 .pnpm 分层，包是顶层实目录）；
  pnpm v11 默认拦截依赖构建脚本，白名单在 profile `pnpm-workspace.yaml` 的 `allowBuilds`。
- 2026-09-08 事实：`@vscode/ripgrep` 新版经平台可选包（`@vscode/ripgrep-win32-x64`）分发 rg.exe，
  不在 `@vscode/ripgrep/bin`（勿按旧路径判缺失）；rg 不可用时插件搜索报「ripgrep 不可用」并降级。
- 2026-09-22 坑：裸 Junction（manifest 依赖仍是版本号）会被 DSH 启动从插件缓存恢复成实目录覆盖 →
  持久开发形态 = manifest 依赖写 `link:<源码目录>` + Junction + profile `pnpm install`
  （本插件可直接 RPC `vscode.devFormSet {enabled:true,path}`，返回 restart:true 后重启生效）。
- 2026-09-22 事实：运行中判别 host 是否新构建——POST /edrv/rpc 调只有新代码才有的方法，旧版统一回
  「未知方法: ...」；vendor 静态资源看 `/edrv/vendor/*` 状态码与 Content-Type。
- 2026-09-22 坑：client CSS 构建期内联 `<style data-plugin-css>`（同 tagId 幂等跳过）→ 同文档热重载
  旧样式残留，改 CSS 必须整页刷新才生效；验证是否随包生效直接 grep lib/client.js。
- 2026-09-22 坑：编辑区新增命令式面板外壳（React 条件分支的空 div）不给尺寸样式 → flex 子项
  0 高度，面板执行正常但整片空白无报错；对齐 .edrv-monaco-host 模式（外壳 flex:1+min-height:0+
  position:relative，内层 absolute inset:0）。
- 2026-09-22 事实：client 包内加载第三方 ESM 库（v0.1.55 pdf.js）= vendor 产物入 assets/vendor/ +
  VENDOR_MIME 补扩展名（.mjs 必须 text/javascript，ESM import 严格校验 MIME；.bcmap/.pfb 等标 binary）+
  运行时一条 module-script 按序 import 产物挂 window handoff（打包器会改写源码内 import(URL)）；
  库枚举值跨版本漂移（pdf.js AnnotationEditorType.NONE=0/1），对照官方接线源码核实后再硬编码。
- 2026-09-10 坑：client bundle 由 host 按内容算 rev 实时读盘（改代码**不需要**重启 host），但浏览器按
  同一 rev URL 命中 HTTP 缓存 → 普通刷新仍跑旧 bundle；生效/验证必须 ignoreCache 硬刷新，判别 =
  `__DSH_BOOT__.entries` 里该包 rev 是否变化。
- 2026-09-10 事实：官方 UI 原语 `@deepseek-ai/dsh-client-ui-primitives` 是 loader 虚拟模块（磁盘无包
  目录，40+ 官方包 require 消费）→ 插件要用必须（a）加进 tsdown `CLIENT_EXTERNALS`，（b）加 ambient
  `.d.ts` 垫片，（c）审计脚本从 `dsh-web-frontend/dist/assets` 断言导出面；`Icon*` 组件直接渲染
  `<svg class=…>`（不是 span 包 svg，探针别用 querySelector('svg') 误判），props = `{size, className}`。
- 2026-09-10 事实：跟随官方主题（ctx.theme + 令牌）——`--dsw-alias-*` 定义在 **body**（不是 :root），
  `--shiki-background/-foreground` **不存在**（代码面底色用 `--dsw-alias-markdown-code-block`、前景用
  label-primary），令牌值可能是 `hsl(0 0% 4.3% / 5%)`（百分比 alpha 要 /100）；Monaco 的 token `''`
  基础规则会盖住 editor.foreground，必须显式覆盖 `.mtk1`；免挂编辑器的验证手段 = 先
  `monaco.editor.colorize()` 触发主题样式生成，再读 `<style>` 里 `.mtk*` 的实际颜色。
- 2026-09-10 坑：`[data-edrv-view]` 作用域内重新定义 `--dsw-alias-*` 会让插件永久不跟随 DSH 主题
  （v0.1.63 移除）→ 想跟随官方令牌就不要在插件作用域重定义同名变量，回落值写在 `var(..., 值)` 里。
- 2026-09-10 坑：DSH **没有** `window.dsh` 命名空间（全仓库无赋值；真实全局仅 `__ModuleLoader__`/
  `__DSH_BOOT__`/`__edrvExtPoll` 等）→ 插件对外暴露能力**禁止**挂 `window.dsh.*`：条件式
  `if (window.dsh) …` 是死代码、读取方恒得 undefined。改用 `window.__edrv*__` 风格自有键，
  且**首选模块内引用直传**（全局只作镜像）——v0.2.0 命令栏空列表即此因（桥装配日志正常但浮层读不到注册表）。
- 2026-09-10 坑：单实例「宿主认领」若 claim 返回 boolean 而调用方自造令牌（`claim() ? {} : null`），
  与 store 内部对象**身份不同** → release 的身份校验恒失败 → 令牌永久泄漏 → 之后任何实例都渲染 null，
  表现为 `Ctrl+Shift+P`「**完全没有反应**」且永不恢复（v0.3.0 修）。规矩：claim 必须**返回 internal
  存下的同一对象**、释放后 `notify` 让其余实例重试认领（宿主更替自愈，slot 重挂/骨架形态切换会触发）；
  且认领**禁止写在 render 期**（`useState` 初始化器等）——StrictMode 双调用会让首次认领被判失败。
- 2026-09-10 坑：排查「快捷键没反应」先判**按键是否已被捕获**——命令桥处理过就会 `preventDefault`，
  故「`defaultPrevented=true` 但 DOM 无浮层」= 命令已派发、无人渲染（宿主认领/挂载问题），
  与「按键根本没被处理」是两类故障，别混为一起查。第三个判据：**`defaultPrevented=false` 且命令
  的 `available()` 返回 false** = 可用性探测误判（桥按设计「不可用则不吞键」）→ 见下条。
- 2026-09-10 坑：**禁止用 `textarea.inputarea` 探测「编辑器是否打开文件」**——Monaco 在支持
  **EditContext API** 的浏览器（Chrome/Edge）里默认用它取代 textarea（源码
  `editContext: se(44,"editContext",!0)`），只建 `div.native-edit-context`，于是 `.monaco-editor
  textarea.inputarea` 恒为 0、`hasEditorModel()` 永假 → 13 条 `needsModel` 命令被静默隐藏且按键被
  放行（v0.3.0 的 `Ctrl+U`「完全没效果」即此因，v0.3.1 修）。正确判据：插件编辑器行内的 Monaco 实例
  ——`.edrv-editor-row .monaco-editor`（与输入实现无关；用 `.edrv-editor-row` 限定可避免误命中官方
  预览的 Monaco，否则无编辑器时快捷键会吞键）。凡是探测第三方库内部 DOM 结构的代码都要按此警惕：
  升级/换浏览器即可让选择器静默失效，且**不报错**（法一线索是「DOM 有编辑器但探测恒假」）。
- 2026-09-10 事实：判断「编辑器是否打开文件」的可靠信号是 **Monaco API**
  （`window.monaco.editor.getEditors().some(e => !!e.getModel())`）或插件自有类名，
  不要去猜 Monaco 的输入层 DOM（textarea / EditContext / 未来的实现都可能变）。

## DSH 对话输入框（composer）——写内容前必读

- 2026-09-11 坑：composer 有**两套坐标系**且混用会毁数据。`detect` 投影里 chip 只占 **1 个 U+FFFC**，
  `clipboard` 投影里占 `clipboardText` 全文（源码 `$composerLayout`：`pushLeaf('chip', kid, '￼', kid.getTextContent())`）。
  `insertReference/insertText/caretSpan` 全要 **detect 坐标**，而 `state.getSnapshot().draft` 是 **clipboard 投影**。
  拿 `draft.length` 当 detect 偏移 → 有 chip 时越界 → `selectSpan` 返回 null → 插入被拒。
- 2026-09-11 坑：`setDraft(text)` 是**整篇重建**且剔除 U+FFFC（`text.replace(REFERENCE_PLACEHOLDER_RE,'')` + `root.clear()`）
  → 一旦把它当「降级兜底」，就会**销毁用户已插入的全部 chip**并把引用退化成重复纯文本
  （v0.3.2 修的「连续添加多个引用显示异常」即此因）。规矩：降级用 `insertText`（就地替换、保留 chip）；
  两条通道都失败就**一个字节都不写**并回报失败，绝不用 setDraft 兜底。
- 2026-09-11 事实：插入位置用 `caretSpan()`——契约即 detect 坐标、无选区时回落文档末尾的塌缩 span
  （与插入 API 同坐标系，无需换算）；选区非塌缩取 `end` = 插入而非替换，不删用户选中内容。
  缺失/抛异常/非法值一律回落末尾。换算 detect↔clipboard：每个位于该点之前的 chip 多占 `length−1`。
- 2026-09-11 坑：验证 composer 时 **Lexical 不理会合成键盘事件**（`dispatchEvent(new KeyboardEvent(...))`），
  Ctrl+A/Ctrl+End 等都不会生效；移光标/清草稿要用 Selection + Range API，或 Chrome DevTools MCP 的真实按键。

## CI/测试平台陷阱（写测试前必读）

- CI 跑 ubuntu：新测试断言**禁止写死 Windows 反斜杠路径**。`path.join` 结果在 Linux 是 `/`
  分隔，断言前先 `.replace(/\\/g, '/')` 归一再比较（或两侧都用同一构造方式）。
- 2026-09-11 坑（**第二次踩，务必内化**）：`norm()` 归一化只解决反斜杠，**解决了不盘符**。
  `skillsDirOf('file:///D:/pkg/lib/index.js')` 断言 `'D:/pkg/skills'` 在 ubuntu 上得到
  `/D:/pkg/skills`（盘符被当成普通路径段）→ 恒失败，而**本地 Windows 是绿的**。
  规矩：路径类断言**不写死盘符/绝对 URL**——用 `fileURLToPath(new URL('..', import.meta.url))`
  取真实包根，两侧都由同一平台语义构造（`pathToFileURL` 造 URL、`join` 造期望值），
  两平台同时成立且更贴近真实调用。
- `pathToFileURL('C:\\x\\y')` 在 Linux 被当作**相对路径**按 cwd 解析（盘符不会成为路径段）；
  需要 file URL 的测试按 `process.platform` 分支构造合法 URL 并分别断言。
- .NET Framework 的 csc 是 **C# 5 方言**：无局部函数、无字符串插值、无 is-pattern；
  给 launcher 写编译探针时用传统语法。
- 本地 Windows 全绿不代表 CI 绿——发布前自问：新断言在 Linux 上成立吗？
- 2026-09-08 坑：DSH 会话沙箱内 vitest 必挂 esbuild `spawn EPERM`（esbuild 异步 build/transform
  API 恒 spawn 服务子进程，`ESBUILD_WORKER_THREADS` 只救 *Sync 变体，vite 不用）→ 测试/发布
  三门在用户真实终端或 CI 执行，会话内只跑 typecheck（tsc 无子进程）与 build（rolldown 原生）；
  2026-09-22 补：策略 danger-full-access 时 vitest 直接可跑；workspace-write（审批 ask）下对同一
  `npm run test` 命令一次性升 danger-full-access 重跑即可（v0.1.57 三门实测 597 passed）。
  2026-10-28 补：绕过 vitest 用裸 node 直跑 TS 行不通——Node 24 的 `--experimental-strip-types` 不会把源码里
  `./x.js` 说明符映射到 `./x.ts`（`ERR_MODULE_NOT_FOUND`），纯函数验证仍走 vitest；另 `pnpm build` 会先做
  store 检查并因 `[ERR_SQLITE_ERROR] unable to open database file` 失败，发布三门一律用 `npm run typecheck/test/build`。

## DSH host 环境约束

- 2026-09-23 坑：workspace-write 审批模式下 pwsh 工具启动可能报 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区>)`——
  沙箱给工作区挂写 ACL 被拒，**任何** pwsh 命令（含只读 ls）都起不来，非命令本身问题；处置 = 对**同一条命令**一次性升 danger-full-access
  重跑（审批策略为 never、升权也被拒时只能等策略切换），本会话 typecheck/vitest/build 均如此跑通。
- `ctx.subprocess.spawn` 的 stdio **必须** `{ stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' }`；
  管道收集模式（`{ maxBytes }`）在受管环境报 `spawn EPERM`。只需退出码的命令（reg/csc）用
  inherit；`handle.done` 成功解析为 `{ exitCode, signal }`（非 `{code}`）。
- teardown/卸载路径里直调子进程用 node `child_process.spawn` + `stdio: 'ignore'`
  （`execFile` 异步重载不支持 stdio 选项，TS2769）。
- 2026-09-20 坑（**GUI 拉起绝不能走 `ctx.subprocess.spawn`**）：DSH 在 Win32 走 Windows Job runner，
  其 `launchWindowsJob` 与 runner 内部 spawn **硬编码 `windowsHide: true`**——连 `explorer.exe` 的窗口
  一起隐藏，症状是 `edrv.revealInExplorer` 回 `{"ok":true}` 但**资源管理器窗口根本不出现**（用户报
  「在文件浏览器打开不生效」）。同目录交替 `windowsHide` 实测 4/4 出窗 vs 0/4 不出，`cmd /c start` 与
  `powershell Start-Process` 均无效。修法 = 该路径改 node `child_process.spawn` + `{ stdio:'ignore',
  windowsHide:false, detached:true }`，只等 `spawn` 事件（GUI 进程退出码无意义）后 `child.unref()`；
  契约抽成纯函数 `revealSpawnOpts` 以便单测断言 `windowsHide === false`。
  凡「让 OS 弹窗/拉起外部 GUI」的新功能都要按此自检。
- 2026-09-20 坑：**验证 GUI 是否真弹出**别只看 RPC 返回或进程存在——`windowsHide` 只隐窗口、
  进程照起。判据用 `Get-Process explorer | Where MainWindowTitle`，且 Explorer 对**已打开**的
  同一目录只复用窗口不一定新建，必须挑没开过的目录或先关窗，否则误判「没生效」。
- 本会话审批策略为 never 时，pwsh 工具会降级 ConstrainedLanguage（子进程无输出、无
  `$LASTEXITCODE`，报 `Cannot run a document in the middle of a pipeline`）→ 派子代理跑构建；
  其环境 `PATHEXT` 被污染（=.CPL），需 cmd 内 `set PATHEXT=.COM;.EXE;.BAT;.CMD` 修正。
- PATH 里的 `bash` 是 WSL 残缺 stub（execvpe 失败）；shell 语法检查用
  `C:\Program Files\Git\bin\bash.exe`。
- 诊断通道：工作区注册表在 `~/.dsh/storages/workspace.json`
  （`tables.workspaces[id] = {path,title,sessionIds}`）；DSH `fs.resolve` 绝对路径直过
  （cwd 非边界），插件可读任意绝对路径文件，保存仍受会话沙箱 `policyOf` 约束。
- 2026-09-22 坑：沙箱内 `git push` 挂在凭据辅助器（Git sh.exe `couldn't create signal pipe`，Win32 error 5
  → could not read Username），commit 正常 → push 对同一命令一次性升 danger-full-access 重试即可。
- 2026-09-22 坑：沙箱内出站 HTTPS 受限——后台任务报 `The SSL connection could not be established`，
  前台 Invoke-WebRequest 报 `Authentication failed`（TLS 认证失败）→ 会话内查 CI/registry/公开 API
  用 web_fetch 工具（api.github.com、registry.npmjs.org 直达），不起后台轮询任务。
- 2026-09-08 事实：gh CLI v2.94 已登录 Lenonss（keyring token，credential.helper=`!gh auth git-credential`，
  gh git 协议默认 ssh）→ `gh repo edit/fork/pr`、git clone/ls-remote/推 fork 一次性升权后可用；
  外部仓库克隆用显式 https URL 走 gh 凭据助手，别用 gh 的 ssh URL。
- 2026-09-08 坑：git 身份只配在主检出仓库级（.git/config）无全局 → 新克隆 commit 报
  `Author identity unknown` → 克隆内补 `git config user.name/user.email`
  （Lenonss / lenonss@users.noreply.github.com）。

## Unity 外部编辑器（com.dsh.editor）

- `EditorPrefs` 等 Unity API **仅主线程**：后台线程只做网络 IO + 纯计算；baseUrl 等必须在
  主线程读好后闭包捕获；回退 UI 操作经 `EditorApplication.delayCall` 切回主线程。
- `CodeEditor.Register` 的安装条目路径可能被下拉按存在性过滤 → 用真实存在路径
  （`EditorApplication.applicationPath`），`TryGetInstallationForPath` 同时认虚拟路径与真实路径。
- "Open C# Project" 传入**空路径** → 视为打开 Unity 项目根。
- Unity 内置 `CodeEditor.OnOpenAsset` 对双击的**任何**资产（含 prefab/scene）回调 `OpenProject`，返回 true
  即视为已处理 → 外部编辑器必须按扩展名白名单过滤、不支持时 return false（对齐
  `DefaultExternalCodeEditor`），否则双击预制体/场景被外部编辑器劫持（v0.1.56 修复）。
- 极简 JSON 提取器偏移：`"key":` 起点 = `key.Length + 3`；`"key":"` 起点 = `key.Length + 4`。
- 内嵌包更新 = 整目录替换 + Unity 重新聚焦自动生效；版本号驱动设置页「可更新」徽标；
  Unity 生成的 `.meta` 文件要随 git 提交（稳定 GUID）。
- 2026-10-12 坑：桌面端 client 的 `ctx.get('sessions')` 服务面缺 `.open`（直调抛
  `TypeError: ... .open is not a function`）且可能缺 `.create` → 外部打开走 catch → ACK
  success=false → Unity 报「编辑器打开失败或取消」。**禁止直调 `sessions.open/create`**；
  改用 `materializeScope?.(id)` → `manager?.select?.(id)` → `open?.(id)` 多面切换（同
  `addToConversation.startDraftSession`），建会话缺 `.create` 时回落 `newDraftSession`
  多通道。客户端日志只有 `dbg(sessionId,text,level)` 经 `edrv.debug` 落 host
  `~/.dsh/dsh-vscode-mode/logs/debug.*.log`，console sink 不落盘——排查 client 侧原因靠
  dbg 探针而非 console.log。桌面 profile bridge 由 `ensureActiveBridge`（`vscode-mode:bridge`
  effect）开机自动 provisioning，`FindBridge(mode)` 在 `~/.dsh/profiles/*/dsh-vscode-mode/bridge/dsh-open.ini`
  按 `mode=` 定位。

## 插件技能组（随包 skills/）

- 2026-09-11 坑：**技能名必须 kebab-case**——`@deepseek-ai/dsh-skill` 的
  `SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/` 是硬校验，**下划线非法**；写 `dsh_vscodemode_mcp`
  会被 `skill-filesystem` 记 `ignored: invalid skill name` 直接丢弃，`ctx.skills.register()`
  则**抛错**。本插件技能组因此用连字符前缀 `dsh-vscodemode-`（注意与 MCP 的 `serverName`
  规则相反：那个 `/^[A-Za-z0-9_-]{1,32}$/` **允许**下划线）。
- 2026-09-11 事实：本插件的技能分发走**自研 provider**（`src/skills.ts` 注册进 `ctx.skills`），
  不用官方 `@deepseek-ai/dsh-skill-filesystem`。原因：profile 以 **junction** 安装本插件，
  Node ESM 按 **realpath** 解析 import，从工作区真实路径出发 walk 不到 profile 的
  `node_modules` —— `node --input-type=module -e "await import('@deepseek-ai/dsh-skill-filesystem')"`
  在包目录下恒 `ERR_MODULE_NOT_FOUND`；官方的 `customSkillDirs` 路子（`@openviking/dsh-memory-plugin`
  那种）需要 dev + peer 依赖 + registry `pnpm install`，且多拉一个 chokidar watcher。
  自研 provider 零依赖、开发/正式形态一致、可直接单测。
- 2026-09-11 事实：技能名冲突（registry 抛错）、`skills` 服务缺失、provider 注册失败都必须
  **降级不致命**——用 `ctx.inject(['skills'], cb)` 惰性获取（**别写进插件 `inject` 数组**，
  否则 skills 缺失时整个插件装载失败），`cb` 内 `sctx.get('skills') ?? sctx.skills` 双读
  （同 `fileOpenSettings.runSettingsInstall` 的写法）。
- 2026-09-11 事实：registry 有**收集缓存**（`collectCache`），provider 自己 parse 不缓存也没用——
  改 SKILL.md 要即时可见必须 `control.invalidate()`；`fs.watch` 的 watcher 挂 `'error'` 处理器
  （EventEmitter 无监听者时抛未捕获异常），并按 `control.signal` 关闭。
- 2026-09-11 事实：`package.json` 的 `files` 必须含 `"skills"`，否则 tarball 漏发 → 技能组恒为空；
  用「读真实 `skills/` 目录自检」的用例兜底。`skills/` 根目录**别放裸 `.md`**（会被当单文件技能解析，
  缺 frontmatter 就刷 `缺少合法 frontmatter` 告警）——约定文档放 README。

## 自我更新协议（技能如何更新自己）

1. **何时更新**：本次会话踩到本文件未记录的新坑（环境/流程/平台/接口），或既有条目已失效
   （API 变更、流程变更）。
2. **如何更新**：直接编辑本文件对应小节，追加一行 `- YYYY-MM-DD 坑：<现象> → <解法>`（一行
   讲完，超过两行说明就压缩）；失效条目改写而非堆叠。更新后把顶部 `> updated:` 改为当天。
3. **边界**：只沉淀会复发的事实与解法，不记录一次性调试过程与猜测；与既有条目重复时不加。
4. **同步**：本文件位于仓库内（`<项目根>/.dsh/skills/`），更新后随常规 commit/push 提交，
   技能内容即随仓库版本化。

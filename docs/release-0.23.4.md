# v0.23.4：计划卡「查看全文」直通本插件编辑器，不再闪一下再关

作者：ddj，2026-10-31。

## 背景与根因

桌面端点「计划待审」卡片的「查看全文」时，右侧栏会先弹出一页计划预览（正文「正在打开计划预览…」），
几百毫秒后又自己关掉，最后才在「文件编辑」里看到计划。用户感知就是「闪一下」。

链路分三段：

1. 官方 `@deepseek-ai/dsh-client-ui-plan` 的卡片按钮走 `ctx.sidebarRight.openResource(...)`：
   已提交计划用 `planAddress(callId)` → `dsh-resource://plan/<sessionId>/<callId>`；
   待审回顾卡片额外带 `params.planReview`（含正文）→ `dsh-resource://plan-review/<sessionId>/<requestKey>`。
2. 官方 sidebar-right 的页签类型注册表按优先级选定义（extension > builtin > fallback），
   同一种 kind 可同时被内置与扩展认领，**扩展生效**。本插件以 extension 优先级注册
   `dsh-vscode-mode/plan`（`kind: edrvPlan`），认领 `dsh-resource://plan/**` 与
   `dsh-resource://plan-review/**`，因此这次 `openResource` 建出来的并不是官方 plan 页签，
   而是本插件自己的认领页签——标题同样是「计划预览」，正文是 `PlanRouter` 的「正在打开计划预览…」。
3. `PlanRouter` 挂载后才把计划经 `requestOpen(..., { preview: true })` 转进「文件编辑」，
   转移成功立即 `tab.actions.close()` 关掉这个侧栏页签。

所以闪烁不是渲染问题，而是**「先建侧栏页签 → 再转移 → 再关闭」这条链路本身**。
只要点击还从 `openResource` 进，就一定会先建出那个页签。

## 变更

- 新增 `src/client/planDirect.ts`：`installPlanDirect(ctx, service)` 在装配期捕获
  `service.openResource` 的原始方法并包装：
  - 只接管「2 段计划地址 + 会话等于在屏会话」。subagent 的 5 段地址、其它会话的地址一律透传，
    与官方行为一致。
  - 正文来源三级：回顾卡片 `params.planReview` → `planState` 的地址→正文缓存 →
    可选 `resources.source(address)` 资源流（`status === 'live'` 才取值，未就绪最多等 1.5s）。
  - 拿到正文直接 `requestOpen(null, …, session, { preview: true, plan, signal, timeoutMs: 5_000 })`
    进编辑器虚拟只读页签；同一地址在途合并，连点不会叠开多个页签。
  - 任何一步不成立（正文不可得、资源流缺失或超时、编辑器 5s 未回执、会话已切走、
    服务对象只读导致包装赋值失败）都回落原生 `openResource`，行为等同 v0.23.3，不会更差。
  - `dispose()` 先置 closed、取消在途，再「只在自己仍持有包装时」还原原方法，HMR 重挂安全。
- `src/client/planState.ts`：新增 `rememberPlan()` / `cachedPlan()` 与模块级有界缓存
  （64 条、插入序淘汰），`clearPlanState()` 一并清空；`createPlanFeed` 的 `exit_plan_mode`
  分支把刚提交的计划写进缓存，因此最常见的一次点击（卡片刚出现就点）无需等资源流。
- `src/client/openReceipt.ts`：`OpenOptions` 新增可选 `timeoutMs`（默认仍 20s）。
- `src/client/planBridge.ts`：`planRouter()` 改为接收直通装配返回的 `native` 回调，
  官方回退不再直接调用被包装后的 `service.openResource`（否则会自我递归）；
  `registerPlan()` 改为「注册类型 → 装直通 → 挂 router 与 body」，卸载顺序反向；
  原私有 `optional()` 换成 `planDirect` 导出的 `optionalService()`。
- 测试：新增 `tests/planDirect.test.ts`（9 例）；`tests/planBridge.test.ts` 增直通 3 例、
  官方回退断言改指原方法；`tests/planState.test.ts` 增缓存 2 例；`tests/openReceipt.test.ts`
  增自定义 `timeoutMs` 1 例。四套合计 41 例。

## 行为对照（点卡片「查看全文」）

| 场景 | v0.23.3 | v0.23.4 |
| --- | --- | --- |
| 待审回顾卡片（带正文） | 先建侧栏页签、再关，最后进编辑器 | 直接进编辑器 |
| 已提交计划（本地已有正文缓存） | 同上 | 直接进编辑器 |
| 已提交计划（冷缓存，需读资源流） | 同上 | 1.5s 内读到正文即直通，否则回落 v0.23.3 |
| 跨会话 / subagent 计划地址 | 官方侧栏页签 | 不变（透传原生方法） |
| 普通文件地址 | 官方侧栏 | 不变（透传原生方法） |
| 服务对象只读、包装装不上 | — | 回落 v0.23.3 链路，只留一条 warn 日志 |

## 验证

- `npm run typecheck`：0 error。
- `npm run test`（全量）：283 个文件、3673 passed / 22 skipped，另 `node --test tests/nativeOpen.test.mjs`
  9/9，退出码 0。
- 定向四套（planDirect / planBridge / planState / openReceipt）：41/41。
- `npm run build`：四个 bundle 产出并过客户端产物完整性校验（`lib/index.js` 1,058,337 B、
  `lib/client.js` 23,360,042 B、`client.rules.js` 31,793 B、`client.debug.js` 39,258 B）；
  仅有既有 rolldown `INVALID_ANNOTATION` 警告，与本次改动无关。
- 浏览器：刷新后 `__DSH_BOOT__.entries` 已含本插件新 bundle，Console 无插件装配错误、
  无「计划直通装配失败」（该日志只在包装装不上时打印）。
- GUI 点按：本轮由用户在本机 Web 端手动复验（刷新后点计划卡「查看全文」）并同意发布；
  浏览器自动点按未做端到端执行。

## 已知缺口与不打算做的事

- 浏览器侧自动点按未能端到端完成（同一浏览器实例里会话列表点击不导航、页面无全局 ctx 可注入），
  本版改由用户手动复验，见上节。
- 资源流等待上限 1.5s 是经验值：正文极大或宿主繁忙时可能超时回落，此时仍会出现一次「建而即关」，
  行为与 v0.23.3 相同，不会更差。
- 直通依赖官方 `sidebarRight` 服务对象可写。若将来 DSH 把它冻结或换成只读代理，包装会装不上，
  自动降级为 v0.23.3 链路并留一条 `计划直通装配失败` warn，不会抛错、不影响其它功能。

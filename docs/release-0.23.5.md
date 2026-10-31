# v0.23.5：同一文件不再被算成两条差异；本会话新建的文件按整文件新增渲染

作者：ddj，2026-10-31。

## 背景与根因

### 一、同一文件被算成两条差异

差异栏的「差异文件 x / y」会把同一个文件算两次：一条来自待审投影行，一条来自官方汇总行。

根因是两侧的路径写法不同：

- 待审条目存的是**写入时的原始写法**，agent 常用工作区相对路径，例如
  `Assets/Scripts/Lua/Module/Common/View/Component/AdvanceBubbleComponent.lua`；
- 官方条目与导航用**绝对身份**，例如
  `D:\Work\PopIsland\IslandSplash_BugFix2\Assets\...\AdvanceBubbleComponent.lua`。

而两处去重都只按 path 建覆盖集：

- `mergedPage()`（`src/pendingCompat.ts`）只用 `pending.items` 的 `path` 建 `covered`，
  官方行按 `currentPath` / `path` 查表，查不到就保留 → 同文件同时出现待审行与官方行；
- `diffSummary.pendingRowsOf()`（`src/client/state/diffSummary.ts`）同样只按 `path` 入覆盖集，
  官方汇总行不被压掉 → 计数翻倍。

修复：覆盖集同时加入**条目身份**。待审条目的 `id` 与官方 `identity` 同源（同一个规范路径），
所以 `mergedPage()` 加 `pathKey(item.id)`、客户端加 `pathKey(item.id.slice(PENDING_PREFIX.length))`，
两侧口径一致。

### 二、本会话新建的文件被渲染成一堆修改块

新建文件应当只有新增行，实际却显示成若干修改块、还夹着删除行。

根因是累计基线的口径：基线保留「最早内容」。若文件是本会话新建、首次采集时磁盘上已经有内容
（会话自己的中间产物，例如分段写出的脚本），基线就不是空的，于是「新增 516 行」被切成
若干 `-`/`+` 混合的块，与官方对整文件新增的表达（`oldLines=0`、全是 `+` 行）正好相反。

修复：

- 新增 `addedFiles(cwd, sessionId)`（`src/reviewDb.ts`）：按会话取每个 `identity`
  **最早**的那条官方记录，`json_extract(diff,'$.before') = 0` 才判定为整文件新增
  （后续修改块不能反过来把「新建」改写成「有旧基线的修改」）。
- `diffOf()` / `countsOf()` / `itemOf()` / `loadPage()` / `loadDetail()` 增加 `baselineEmpty`
  参数（`src/pending/decide.ts`、`src/pending/store.ts`）：命中整文件新增时基线置空，
  差异只出一块全加（`oldLines = 0`、无 `-` 行），增删计数 = 整文件行数。
- 调用方统一口径：`edrv.pending.list` / `edrv.pending.detail`（`src/pendingRpc.ts`）与
  `pendingPageOf` / 待审详情（`src/reviewRpc.ts`）都按同一份 `addedFiles()` 结果渲染，
  避免「官方说全加 516 行、待审说改 8 处」两套相反说法同时出现在差异栏。

`addedFiles()` 任何异常（表不存在、查询失败）都只返回空集，也就是回退旧的累计基线口径，
不影响列表与详情可用性。

## 变更

- 新增 `src/reviewDb.ts` 的 `addedFiles(cwd, sessionId)`。
- `src/pending/decide.ts`：`diffOf(entry, baselineEmpty=false)`，空基线时把 hunks 规整为
  整文件新增形状（`oldLines=0`、过滤 `-` 行）；`newText` 为空时仍返回空差异。
- `src/pending/store.ts`：`countsOf` / `itemOf` / `loadPage` / `loadDetail` 透传 `baselineEmpty` /
  `wholeAdd`。
- `src/pendingCompat.ts`：`mergedPage()` 覆盖集加入 `item.id`。
- `src/client/state/diffSummary.ts`：待审行覆盖集加入去掉前缀的身份。
- `src/pendingRpc.ts`、`src/reviewRpc.ts`：列表、详情统一按 `addedFiles()` 判定基线是否置空。
- `src/pending/decide.ts`：`diffOf()` 的空基线分支补 `diff.kind !== 'text'` 收窄
  （`OfficialDiff` 是 text / binary / oversized 联合类型，不收窄时 `hunks` 不可访问，typecheck 会报
  `TS2339`）。
- 测试：`tests/pendingStore.test.ts` 新增 2 例（相对 path 与绝对身份合并、新建文件只剩一块全加
  差异且无删除行）；`tests/pendingSummary.test.ts` 新增 1 例（相对路径待审行与绝对身份官方行
  只算一次）。

## 验证

- `npm run typecheck`：0 error。
- `npm run test`（全量）：283 个文件，**281 passed | 2 skipped**；用例 **3676 passed + 22 skipped**；
  另 `node --test tests/nativeOpen.test.mjs` 9/9，退出码 0。
- 定向三套（pendingStore / pendingSummary / reviewRpc）：**30/30**。
- `npm run build`：四个 bundle 产出并通过客户端产物完整性校验
  （`lib/index.js` 1,060,643 B、`lib/client.js` 23,360,090 B、`client.rules.js` 31,793 B、
  `client.debug.js` 39,258 B）；只有既有 rolldown `INVALID_ANNOTATION` 警告，与本次改动无关。

## 已知缺口与不打算做的事

- **未做 GUI 点按验收**：本轮只跑 typecheck、全量单测与构建，差异栏的计数与新建文件差异块
  外观没有在修改后的宿主上目视确认。风险面集中在展示层两处（覆盖集与差异形状），
  可用 `edrv.pending.list` / `edrv.pending.detail` 的返回先核对数据口径。
- `addedFiles()` 依赖官方库中该会话的首块记录。若首条官方记录被归档或库被清理过，
  判定会退回旧的累计基线口径（表现为「还是老样子」，不是新错误）。
- 只覆盖「官方记录判定为本会话整文件新增」的情形；其他会话新建、随后被本会话编辑的文件
  仍按修改块展示，这是刻意保留的既有语义。

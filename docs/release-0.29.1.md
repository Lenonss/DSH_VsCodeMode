# v0.29.1：待审差异引擎精准化（千行文件不再整段替换）

## 修复

- **根因**：`src/pending/hunks.ts` 在裁掉公共前后缀后对中段做 O(n·m) LCS；中段单元格数超过
  `1_000_000` 就直接“整段删除 + 整段新增”。门槛取决于文件长度与改动分布——千行文件只要首尾
  各有改动就必然超标，于是一处小改动也显示成几百行 `-` / 几百行 `+`，块级 Keep/Undo 退化成
  只能整文件处理。
- **新引擎** `src/pending/lineDiff.ts`：先裁当前窗口的公共前后缀，再按“两侧都恰好出现一次的
  相同行”做锚点，对锚点做最长递增链切分，只在小窗口内做最优 LCS；单窗口 100 万单元格、
  单次差异 1200 万单元格（约 80 ms 量级）与递归深度 64 三层预算兜底。只有窗口内确实找不到
  可匹配行的区域才整段替换并标 `coarse`，不再由文件长度触发。
- **行号修正**：`buildHunks` 原先每块结束时把 `head` 上下文重复计入行号，多 hunk 差异的
  `oldStart/newStart` 每块多偏移 3 行（影响块 ID、行区间选块与删除行 gutter 行号）；本次一并
  修正，并加了“按 hunks 重建全文 == 新文本”的不变式测试。
- `src/pending/hunks.ts` 只保留 `textDiff` 与块级文本合成，`coarse` 改由真实退化驱动；
  `src/shared/review.ts` 与 README §6.1 同步说明。

## 验证

- typecheck 0 error。
- 全量：304 个测试文件通过 + 2 跳过（306），**3861 通过 / 22 跳过**（34.65 s）；
  `node --test tests/nativeOpen.test.mjs` 9/9（13.5 s）。无 dapFakeAdapter / treeIndex 抖动。
- 新增 `tests/lineDiff.test.ts` 9 例：千行回归、真实历史形状（2365 → 2509 行、520 万单元格）、
  多 hunk 行号、分散改动、退化边界、新建口径、CRLF/BOM、千行文件块级 Keep/Undo、2 万行性能冒烟。
- 真实归档历史只读回归（本机 `pending_history`）：`DreamDuelLogic.lua` 中 20 个旧实现会整段
  替换的状态，新引擎 **20/20 精准**、重建通过；最坏 6,094,517 单元格状态由整段替换变为
  `-0/+76`、0.8 ms。
- 真机反向验证（Web 3080，开发链接形态）：1201 行临时文件 + 顶部插入/中部改行，旧 host 返回
  `coarse=true`、`+1141/−1140`、1 个 hunk `@@ -8,1146 +8,1147 @@`；用 Plugin Manager 重载插件
  （无需重启 DSH）后返回 `coarse=false`、`+2/−1`、2 个 hunk（`@@ -8,6 +8,7 @@`、
  `@@ -1147,7 +1148,7 @@`），GUI 差异栏显示 `1/2`、`2/2`，编辑器只高亮真实改动行。
- 构建：host `index.js` 1,101,565 B；根 `client.js` 930,057 B；`client.rules.js` 14,035 B；
  `client.debug.js` 18,149 B；`client.excel.js` 11,371,696 B；`client.excelcodec.js` 1,002,902 B。
  `check-client-artifacts` 全部通过。

## 边界

- 只改待审（pending）差异通道；官方轮次差异仍由 DSH host 的 `compareText`（jsdiff + 100 ms
  超时）生成，插件只负责存储与展示，本次未改宿主。已落库的官方 coarse 记录没有原始字节证据，
  无法事后重算。
- 块 ID 由差异现场推导：多 hunk 条目的历史块决定可能因行号修正而回到 pending，需要重新确认；
  不做数据迁移，`pending_*` / `review_*` 表结构不变。
- 无 schema 变化；回退安装旧版本不需要迁移。

## 回滚

可安装上一稳定版 0.29.0 并重启 DSH；公开版本与 tag 保持不可变，不覆盖发布历史。

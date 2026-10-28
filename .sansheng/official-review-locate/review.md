# 门下省审查：官方差异块定位

## 审查依据与范围
- 已读[批准计划](<D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/plans/official-review-locate/01-plan.md>)全文，接收中书五项成案澄清及 Lead 明确接受的门禁补充。
- 独立只读源码核对：[reviewRegions.ts:26–73](<D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/src/shared/reviewRegions.ts#L26-L73>)、[reviewEvidence.ts:29–64](<D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/src/reviewEvidence.ts#L29-L64>)、[reviewBar.ts:51–87](<D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/src/client/reviewBar.ts#L51-L87>)及 OfficialDiff 类型。未写文件、未委派。本轮是执行前门禁，不是修复完成或最终验收。

## blocking:
[]

当前方案连同已接受补充不存在尚未解决的执行前阻塞。以下为可判定执行/验收门槛；实现或测试若违反任一项，应重新封驳，不可用本次通过覆盖偏离。

## 必须保持的执行契约
1. **禁止历史行号猜测**：定位只扫描当前内容中的完整 pattern（contextBefore + newLines + contextAfter）；不得使用 oldStart/newStart 或最近历史位置打破多命中，也不得缩短上下文求成功。坐标只保留块身份与既有范围计算用途。
2. **严格唯一优先**：严格恰一命中即采用；严格多命中必须 ambiguous，绝不进入 trimEnd；只有严格零命中才可考虑第二档。
3. **trimEnd 三门同时成立**：严格零命中、pattern.some(line => line.trimEnd().length > 0)、双方仅 trimEnd 后全上下文恰一命中。全空白 pattern 禁宽松；宽松多命中仍 ambiguous；前导缩进不归一；空 pattern missing。纯删除保持 start===end，block id 公式不变。
4. **Undo 行为保持而非扩修**：logicalLine 必须与既有 /(?:\r\n|\r|\n)$/ 剥离单个末尾 EOL 等价。rawLines、原始证据 hash/base64、BOM、物理行尾、段提取及 reversed!==beforeText 的字节保护不变；reviewBlocks 归一化不能改 id/坐标/行数。[reviewEvidence.ts:46–47](<D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/src/reviewEvidence.ts#L46-L47>) old/next 未逻辑化的 CRLF patch Undo 缺陷是既有边界，不在本次修，不得声称 Undo 一直正常或 CRLF Undo 已修。
5. **失败叙事全链一致**：notice、navPrevTitle、navNextTitle、keepHint 同时按原因处理；loading 优先中性，ambiguous/noBlocks 不宣称改动消失；missing 保持兼容旧导航断言；缺省可选原因字段继续兼容 Sidecar。noBlocks 以 kind非text或hunks空判断，coarse 不等于 noBlocks，不拦已有 hunks 跳转，不向 binary/oversized 承诺旧新全文。
6. **既有修改保护**：限定计划9文件，不整文件覆盖或重排；EditorView 仅原因计数和 dock 快照两点增量，不动 receiptLoad/Excel 既有本地修改与 decoration/lineRegionMap/decideRegions。不得改官方 payload、DB/schema、digest 或持久决策主键。回滚不能整体丢弃已有本地修改。

## 根因证据判定
- 现有源码文件侧剥 CRLF，而 patch line.slice(1) 保留 CR；严格全等因此失败，符合具体代码机制。
- 御史证据经 Lead/中书转交：最小 CRLF patch+CRLF content 旧 stale=true，仅剥 patch CR 后 stale=false，start=2/end=3。
- 同一真实 session-3bd4cac4-379c-4a46-bc11-ee4db533ca6b、turn1、seq1237：CfgStore 记录70e1a4b66d65c44ddbf7842f5215780376fd3beda5cb8109d8b40bc7739510bb旧0/6→对照6/6；GameRoot记录0dfffec15b31882f4d508c36bac81b4a1e779bb68e40e8781d1ec57ccca38862旧0/7→对照7/7。
- 判定：CRLF 定位主因的复现、单变量对照和真实记录证据足以放行修复；这不等于尚未实现的 trimEnd/UI 已获运行验证。

## 建议（不阻塞）
- 在矩阵明确加入：严格多命中但宽松仍会命中的禁止回退、严格唯一与宽松多命中并存时严格优先、全空白宽松禁用、宽松多命中、前导缩进差异不定位。不要只验证单个宽松成功案例。
- 原因文案测试同时覆盖 ambiguous、混合、noBlocks、loading 的 notice/nav/Keep；计数归零测试显式 pendingRecords:0，单独测试待审无块。
- Undo 最小测试应证明既有 LF patch+BOM/CRLF/无尾换行字节往返与拒绝外部行尾变化仍保持；既有 CRLF patch 拒绝应标范围外，不强行转通过。
- 实施前记录基线差异，交付比较任务增量，生成产物与临时脚本不可混入源码交付；计划旧 GUI 地址13926不是当前运行地址，当前应验证 http://127.0.0.1:3080 的实际构建链，不能把 pnpm build 本身当已部署。

## 结论：通过
允许尚书按批准计划与以上已接受澄清执行。最终交付仍须通过四个目标 vitest 文件、typecheck、必要构建，以及御史独立复核；本审查未执行测试、未复读真实数据库，真实库结论明确采自御史转交证据。

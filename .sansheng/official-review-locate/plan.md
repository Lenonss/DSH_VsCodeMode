# 中书成案补充：官方差异定位

作者：ddj 2026年10月28号。正文来源：中书 zhongshu-1，Lead接受后由尚书唯一落盘。本文件仅记录已批准方案补充，不重写或扩大计划。

批准依据：[01-plan.md](<D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/plans/official-review-locate/01-plan.md>)。执行写入仍以门下无blocking为前提；实际门禁与实现见同目录changes.md、review.md。

## 五项澄清（Lead已接受）
1. 批准9文件内可执行。UI字段必须走EditorView.ts:649派生→:4582快照→侧栏:4828 spread/ConversationDiffDock.ts:63 Object.assign→DiffBox.ts:35原props→OfficialDiffBar.tsx:61，后三处本来透传无需改，OfficialBarProps新增可选字段。EditorView只两处增量，不碰receiptLoad/Excel等已有本地修改。
2. noBlocks=diff.kind!='text'||hunks.length===0（detail未就绪不要误报），coarse是独立boolean，不据coarse禁已有块跳转。无块通常stale=0，pendingRecords>0中性文案要可达；不要对binary/oversized承诺可看旧新全文。
3. reviewBar.ts:53,68 Keep提示原全stale均称“已不在文件中”，须同步修notice/nav/Keep；ambiguous/noBlocks/loading全用中性，不只修notice。missing保留旧navNextTitle兼容。tests/reviewBar.test.ts:70计数归零用例显式pendingRecords:0，另新增待审无块用例；ambiguity/mixed/noBlocks/loading同时覆盖notice/nav/Keep错误断言。
4. 匹配严格唯一优先；严格多命中直接ambiguous；只严格0且pattern.some(line=>line.trimEnd().length>0)宽松，宽松唯一才定位；全空白禁宽松；保留缩进、纯删除零长、空pattern missing、稳定block id。
5. reviewEvidence.ts仅logical复用等价；46-47 old/next未logical的CRLF patch Undo既有缺陷只报告，不顺手修、不放松63字节保护。无DB/diff持久化变动。门下已收到完整成案补充正文。

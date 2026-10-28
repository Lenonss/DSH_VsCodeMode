# 官方差异栏定位失效：根因与边界假设池
- 角色：集贤院 jixian-1（只读）
- 作者：ddj 2026年10月28号
- 依据：已批准 plans/official-review-locate/01-plan.md。使用read/grep阅读源码；以下证据强度为静态证据，不冒称本轮已执行真实数据复现。

## H1：CRLF patch 与内容单边归一化导致合法块被误判 stale
**强度：高。** src/shared/reviewRegions.ts:33-34 的 line.slice(1) 留下补丁末尾CR；:56 内容 replace(/\r\n/g,'\n') 消去CR；:61-68 pattern逐行全等，任一待匹配行含CR即失配。tests/reviewRegions.test.ts:20-23仅content带CRLF，patch仍LF，漏了关键输入。精确边界：oldLines不参加定位，仅删除行带CR而上下文和新增行不带CR时未必失败。
**验证：** 现两块fixture每个patch行追加CR，分别传LF/CRLF content，修前全stale；只剥patch行单个EOL应恢复[2,3]、[4,5]，块ID和decision保持。真实记录输出归一前0、归一后恰1匹配数；计划历史6/6、7/7不算本轮执行证据。

## H2：Undo/evidence并非已对CRLF patch双边逻辑化
**强度：高。** src/reviewEvidence.ts:29-35 rawLines保留EOL而logical去单个EOL；:43 expected=logical(before)，但:46-47的hunk old/next只slice(1)，未logical；:50 expected与带CR old全等可抛「原始基线与官方上下文不一致」；:51,54 next原样插入也会和logical(after)不等。tests/reviewEvidence.test.ts:4-5 patch全部LF，:9-12 raw evidence混合EOL不证明CRLF patch正常。计划:25-26“Undo一直正常”需收窄，:69只替换logical实现不会修复:46-47。
**验证：** evidence fixture仅patch行加CR、raw before/after为相应CRLF，修前预期:50失败；LF patch对照通过。src/reviewEvidence.ts:63精确逆向重建保护不能放松。是否扩大范围由中书/门下裁定，不由集贤改代码。

## H3：单CR、纯删除、EOF与空文本是独立边界
**强度：高。** src/shared/reviewRegions.ts:56不按单CR分行；src/shared/diff.ts:62-64 normalizeForCompare也只处理CRLF对，不能直接处理patch行尾孤立CR。reviewRegions.ts:61-62无上下文纯删除pattern为空必须missing，不能历史行号猜测；:69-70纯删除start=end零长区间。reviewEvidence.ts:29-35 rawLines丢最后空哨兵，content split保留终止换行后空项，两API数组口径不能机械等同。
**验证：** 单CR内容+patch；BOM+CRLF patch纯删除仍[2,2]；EOF有前上下文无后上下文应定位；无上下文删除missing；空文本、有无尾换行固定logicalLines空文本语义。

## H4：stale原因合并导致UI错误断言，Keep提示亦受影响
**强度：高。** reviewRegions.ts:59-68 null、空pattern、零命中、多命中均stale；tests/reviewRegions.test.ts:15-18明确重复上下文必须冲突，不可历史行号消歧。src/client/reviewBar.ts:81-84任意stale宣称“均已不在当前文件”，证据不足；:52-54,68 fullStaleKeepHint亦声称“这些改动已不在文件中”，仅改notice会留下Keep悬停错误。:70-72 ready保护优先级必须保留。
**验证：** ambiguous、mixed missing/ambiguous、no-content、载入四态；检查notice/navTitles/keepHint均不对歧义宣称已消失。粗粒度无blocks常stale=0，核实计划noBlocks分支是否可达；pendingRecords>0无块应给中性说明。

## H5：trimEnd二档是独立行为扩展，不能破坏唯一性
**强度：中。** reviewRegions.ts:54,65-68唯一全上下文契约；plans/official-review-locate/01-plan.md:66,125-128只允许严格零命中后尝试宽松档。
**验证：** 严格恰1处优先，即使trimEnd后两处；严格0且宽松恰1才定位，宽松2处ambiguous/0处missing。全空白pattern不得凭宽松制造位置；“含非空行”需固定trimEnd后非空或length>0语义，建议测试全空白。仅忽略尾空白，不忽略前导缩进；不凭oldStart/newStart消歧；第二命中即早退。

## 汇总与未验证项
H1优先御史复现；H2纠正对照组前提，是否处理由门禁裁定；H3/H4是主修复语义边界，Keep提示需纳入；H5单独举证唯一性。本轮仅源码阅读，未运行测试、未读取真实数据库、未检查浏览器。集贤未写文件、未建子代理，根目录和包内既有本地修改保持原样。

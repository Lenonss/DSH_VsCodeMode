# 尚书实施记录：官方差异定位

作者：ddj 2026年10月28号

## 门禁与范围
- Lead 接受中书澄清；门下 task-3 blocking=[] 后领取 task-4，才开始写入。
- 源码/测试唯一写者 shangshu-1。严格限定批准9文件；另统一保存本目录协作文书。
- EditorView 仅两处增量：staleMissing/staleAmbiguous/noBlocks 派生与 dock 快照字段，保留 Excel/receiptLoad 等既有本地修改。
- 未改数据库、官方diff payload、digest、block id公式、包清单/锁文件；未安装、发布、重启或启动服务器。

## 实施
1. src/shared/lineEndings.ts：stripBom/logicalLine/logicalLines 单一逻辑行工具，logicalLine只剥一个末尾EOL。
2. src/shared/reviewRegions.ts：内容和patch双边逻辑化；严格全上下文唯一优先；严格多命中不降级；只有严格0且至少一行trimEnd非空才双方trimEnd重扫；第二命中即停止。staleReason分类no-content/missing/ambiguous，纯删除零长区间和身份保持。
3. src/reviewEvidence.ts：仅logical()改map(logicalLine)等价复用；old/next CRLF patch既有Undo限制未修，字节保护不松。
4. src/client/reviewBar.ts：missing兼容旧导航；ambiguous/mixed/noBlocks/loading的notice/nav/Keep中性。无块但有待审记录提示可达；不对binary/oversized承诺全文，不把coarse当noBlocks。
5. src/client/ui/OfficialDiffBar.tsx 与 src/client/ui/EditorView.ts：可选原因计数沿既有透传链进入UI。
6. tests/lineEndings.test.ts、tests/reviewRegions.test.ts、tests/reviewBar.test.ts：EOL矩阵、BOM/EOF、严格/宽松唯一性、空白禁宽松、保留缩进、失败叙事四通道覆盖。

## 验证
- 本会话 `npm exec -- vitest run tests/reviewRegions.test.ts tests/lineEndings.test.ts tests/reviewBar.test.ts tests/reviewEvidence.test.ts` 首次exit1，Vite config加载esbuild `ensureServiceIsRunning` 报 `Error: spawn EPERM`，未绕沙箱。Lead原命令提权后exit0：Vitest v3.2.7，lineEndings19、reviewEvidence3、reviewRegions25、reviewBar22，共4文件69/69通过，总1.53s（tests15ms）。
- `npm run typecheck` exit0。
- 构建前Get-Item核验绝对目标 D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review/lib 为普通Directory，LinkType/Target为空，再 `npm run build`（保留prebuild钩子）exit0。
- host构建247ms、934160 B；client1703ms、23176244 B。警告：external/noExternal弃用、CJS建议、范围外snippets/LSP/AI既有PURE注释位置提示；无构建错误。
- `git diff --check` exit0。
- 本次新增可自主命名方法均≤17字符，含ddj 2026年10月28号文档注释；核心方法均不超过50有效行。既有大型Editor组件只两点字段增量，不机械重构。

## 产物 SHA256（不作为源码提交）
- lib/client.js：45AAC8AA487FCDF21D6EF0CE765EC16AFE8AB3692B4AC27D35DC34C5F6995484
- lib/index.js：3012EF9622589B5F2B07C01F630D9EE07FCB423D4F5756BB4D781EC1B3354D7C

## 既有文件保护
执行前后SHA256一致：
- package.json：658B8D06D030FB62586DD4A26077BB21106DEB2CFFCE755E2F6B16ED334F200B
- pnpm-lock.yaml：5629AFB2CD682547623D2822BE92231D9AEA4C07C7E683838008DB8BA49C3DCB
EditorView执行前已捕获git diff，均为既有Excel改动；本轮只新增6行定位字段。

## 验收边界
真实数据库阶段2由御史独立复核。不声称CRLF patch Undo已修。
- Lead GUI证据：刷新当前 http://127.0.0.1:3080 独立page4，boot dsh-vscode-mode rev从0beeb340a0cb变为856be8a80297；combo req7381 HTTP200。响应grep确认包含新logicalLine/逻辑分行及两条新原因文案（行110378/489029/489039）。新版bundle实际送达GUI已验，不仅是构建通过。
- 目标官方导航未验：当前打开sidecar非目标官方会话，目标session尚未在活动列表找到，不能冒称GUI上6/7导航实测。Console只有待分类404资源报错，无client throw。

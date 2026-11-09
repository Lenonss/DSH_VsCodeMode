# v0.28.0：dsh-ops 写工具纳入待审差异采集

## 改进

- `ops_edit_file` / `ops_write_file` / `ops_remove` / `ops_copy` / `ops_move` 与官方
  `edit` / `write` 走同一条累计待审通道：执行前冻结写前基线，执行后读回真实内容，
  内容变化才产生待审条目，面板可查看差异、Keep 与 Undo。
- `ops_replace`（目录级字面量批量替换）按「执行前预读候选 + 执行后回执对齐」尽力采集：
  以替换作用域为搜索根、按 `glob` 过滤，最多预读 16 个候选文件；回执里完成写入
  但未被预读到的文件只记缺口，不伪造基线。
- `dryRun: true` 的预览调用既不预读基线也不产生待审条目。
- 采集失败、搜索不可用、路径不可解析都不改变工具返回值，只记录缺口说明。

## 实现边界

- 只扩展待审采集通道（`src/pending/capture.ts`、`src/pending/bulkTargets.ts`、
  `src/toolTargets.ts`）；未改动官方 workspace-changes 采集、回滚字节证据、
  VCS 导入与存储层。
- 批量替换的候选预读直接调用 `searchRipgrepContent`，不复用 `ContentSearcher`
  ——后者会中止同根在途搜索，抢走用户正在进行的搜索。
- 不覆盖的写入：`ops_bash` 内的写盘、PTC 内联工具、dsh-ops 之外的任意进程写入。
  git 工作区仍由官方快照列出（可展示与 Keep，但没有字节证据，不能 Undo）；
  SVN 等非 git 工作区看不到，可走既有「从版本库导入」RPC 兜底。
- 建议上游 dsh-ops 在写入前 emit `fs/write-intent` / `fs/edit-intent`，
  这样非 git 工作区也能走官方通道；本次未改 dsh-ops 包本身。

## 验证与已知缺口

- 类型检查 0 error；全量 301 个测试文件 3835 通过 / 22 跳过（37.73 秒）+
  `node --test tests/nativeOpen.test.mjs` 9/9；构建产出 host 1,093,961 B、
  client 23,431,817 B，仅 `src/client/monaco/lsp/providers.ts` 的既有
  `@__PURE__` 位置告警。
- 新增 `tests/pendingOpsCapture.test.ts` 9 例：真实写前/写后内容、内容不变不落库、
  新建与删除、copy/move 双条目、`ops_replace` 候选对齐与缺口、搜索失败不改工具结果、
  `dryRun` 短路、未声明 ops 前缀的工具不采集。
- Host 侧改动需重启 DSH 才生效；本次未安装到任何 profile、未重启 DSH。
  真实面板差异、Keep 与 Undo 的端到端冒烟缺口经维护者接受，待安装新版后另行确认。
- 未实测真实 dsh-ops 包在本机 Host 内的端到端调用：其 `dryRun` 同样需要发布授权，
  会话内被拒绝。

## 回滚

可安装上一稳定版 0.27.2 并重启 DSH。公开版本与 tag 保持不可变，不覆盖发布历史。

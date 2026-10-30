# v0.22.0：累计基线待审（非 UI 能力对齐 dsh-diff-approval）

作者：ddj，2026-10-30。

## 变更

- 新增待审投影（`pending_*` 表，`review_*` 事实不改）：同一文件被多次编辑折叠为一条待审，基线保留最早内容，最新侧保留最新内容；A→B→C 显示 A→C，A→B→A 自然归零，不做 BOM/CRLF 归一化判等。
- 判定语义：Keep 只推进基线、不写目标文件；Revert 带 `replaceIfVersion` 版本守卫写回并读回校验，新建文件 Revert 等于删除；已解决条目保留在列表中可再移除。
- 撤销/重做改为游标模型（`pending_history.state`），撤销后重做回到同一状态，栈跨重启保留、`operationId` 保证幂等。
- 差异来源扩到 `edit`/`write` 结果自带的 before/after、`fs/edit-intent` 与 `fs/write-intent` 预像配对（`str_replace_editor`）、`fs/observed` 终像；已入列路径的外部改动被吸收为最新内容并标记分歧，文件缺失/不可读转为 `missing` 并退出写回。
- 新增 git / svn / Perforce 基线导入（`edrv.pending.import`），可从版本库补出「插件没看见的」本地改动；命令执行沿用会话沙箱策略。
- 旧 sidecar 写入口（`edrv.accept`/`reject`/`decideBatch`/`missingReview`/`missingDecide`）对已被待审接管的路径服务端拒绝，不再依赖界面隐藏。
- 界面：待审条目直接画进 Monaco，块级 Keep/Undo 走行内药丸，文件级在差异栏；按本次产品决定**移除详情面板与批注**（含「让 AI 应答」），相关 RPC、技能与数据表一并删除。

与上游的有意偏差见 README「### 6.1 累计基线待审（对齐 dsh-diff-approval）」。

## 验证与已知边界

- `npm run typecheck` 0 error；`npm run test` 全量通过（含既有套件与本轮新增的 kernel / store / vcs / p4 / path / summary / guard 用例）；`npm run build` 四产物（rules / debug / host / client）成功。
- 真机（Web profile，重启后宿主加载新 bundle）已验：同文件两次写入折叠为一条、文件级 Keep `wrote:false`、Revert 写盘并读回、新建文件 Revert 删除、撤销/重做回到同一状态、块身份由差异现场推导、旧入口对已接管路径拒绝、外部删除经 `refresh` 标记 `missing`、git 基线导入端到端（用 shell 改写已跟踪文件后导入得到 `earlierVersion:'file'`、`added:1`）。
- 已知缺口：Perforce 仅有假 shell 单测（本机无 Perforce 客户端，未端到端验证）；批注与「让 AI 应答」随本次产品决定下线，故原计划的应答链验收不再适用。
- 完整 JS 发布套件按本版发布门禁执行，结果以对应 CI / 发布验收记录为准，不用定向测试数字代替完整套件。未进行 Unity 全量验证。

## 升级

待 npm 精确版本或 GitHub Release 资产可查询后，按 README 三选一安装示例选择实际目标 profile。升级操作由用户自行安排；若需要重新加载 Host，应由用户确认并执行，不由发布流程自动重启。

数据迁移：首次访问工作区时创建 `pending_*` 表（`pending_schema` 版本标记，缺列用 `ALTER TABLE` 补齐），`review_*` 与既有归档不变；迁移前会按 `.before-pending.bak` 后缀备份。回退可选择原版本，`pending_*` 表残留不影响旧版本读取。

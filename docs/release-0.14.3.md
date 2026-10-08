# dsh-vscode-mode 0.14.3 发布说明

> 2026-10-08；基线 v0.14.2。差异审查性能、SQLite 活跃/归档持久化、归档分页与侧栏差异栏布局。本版未调整 DSH peer 兼容范围或 npm 依赖。

## 改动

- 大文件多 hunk 差异定位延迟扫描重复文本，区域行号采用预计算换行索引，多块替换一次拼接；本地同一记录连续 Undo 可复用文件读取/写回，远程会话和整调用回滚保留原路径。
- 归档按工作区落在 DSH home 的 `dsh-vscode-mode/data/archive/<cwdHash>.sqlite`（WAL / FULL），批次及记录按键索引、幂等追加；新归档不再每次读写整个旧 `.dsh-edit-review-archive.json`。旧历史**不自动导入**新归档列表，旧 JSON 保留不删除。
- 活跃记录首次载入时从工作区 `.dsh-edit-review.json` 严格校验后迁入同一 SQLite 数据库；迁移完成后旧 JSON 只读保留，后续采纳/拒绝只 UPSERT/DELETE 变动记录。归档记录、活跃决策和 Undo 意图同一事务提交；检测到旧 Host 继续改写旧文件时拒绝写入，避免两份数据静默分叉。数据库不可用、损坏、锁竞争或迁移中源变动会报错，不用空记录替代。
- 归档界面按 keyset 游标分页（默认 50、上限 100），按单个文件+批次展开详情；旧 `edrv.archiveList` 接口保留兼容。侧栏文件编辑形态的差异操作条改为底部居中、按内容宽度收缩的悬浮 banner，窄栏内部滚动，避免遮挡横向滚动条。

## 验证证据与范围

- 本地定向验证：受影响的 archiveDb/archiveRpc/store/decideBatch/model/perf/diffLauncher/captureRemote/diff/regions fixture **131/131** 通过；本版发布流水线将再运行类型检查、全套 JS 测试和 Host/Client 构建。
- 在隔离 200 条、约 18 MB 活跃记录样本中，一次性迁移约 **305 ms**、单次 SQLite 更新及归档事务约 **2.4 ms**（单次测试结果，非性能保证）。
- 已在 Windows、DSH Web `0.2.0-rc.1` 的本机 profile 安装测试包并重启：迁移后 SQLite schema=3、`integrity_check=ok`，与迁移前一致的 200 条记录 / 198 条未归档、原有 2 批归档；旧 JSON SHA256 未变。真实采纳 trace 中，两次单 hunk RPC **17.0 / 22.2 ms**，37 项批量 **134.6 ms**，13 项批量 **74.0 ms**；均返回成功。旧版全量 JSON 归档路径 Keep RPC 约 5.1–5.3 秒，随后 SQLite 归档但仍全量保存活跃 sidecar 的单次 Keep RPC 约 223–236 ms。不同数据与机器上的耗时可能变化。
- 未在 Desktop、Linux/macOS 或全量真实工作区做手工 E2E；没有模拟真实 Undo 的破坏性现场操作，相关锁竞争/失败恢复仅用隔离测试验证。`node:sqlite` 在 Node 22/24 仍标记为实验性，Windows 本机为 Node 24；本包 `engines` 仍为 `^22.19.0 || >=24.0.0`。

## 安装、迁移与回退

运行 `dsh plugin --profile web add dsh-vscode-mode@0.14.3`（确认 npm 已上架后），或从固定 `v0.14.3` Git tag / GitHub Release tgz 安装，**停止旧 Host 的差异操作后重启目标 DSH Host 并刷新客户端页面**。仅刷新浏览器不会加载新 Host。首次载入工作区会迁移旧活跃侧车；强烈建议升级前一致性备份工作区 `.dsh-edit-review.json`、旧归档 JSON、DSH home 下现有 SQLite（打开中的库请使用 SQLite backup API，勿只复制主文件）和 profile 安装信息。迁移失败时停止操作并处理报错，不删除旧 JSON。

**回退不是简单装回旧包：**v0.14.2 只认旧活跃 JSON；v0.14.3 首启后新变更仅在 SQLite，旧包无法看见新增的活跃差异。要回退须先保留新库主文件及 WAL/SHM 或一致性备份，并经人工核对制定导出/回填步骤；不得直接清理新库或把旧快照覆写为当前数据。旧归档 JSON 未迁移且仍作为历史留存，Web profile 本机已安装的测试 tgz 不会因 npm 上架自动改装为 registry 版本。

本发布通过 Git tag 触发 `.github/workflows/release.yml` 生成 GitHub Release；只有仓库配置了 `NPM_TOKEN` 时 CI 才自动 npm publish。本机不执行 `npm publish`。
# dsh-vscode-mode 0.14.7 发布说明

> 2026-10-12；基线 v0.14.6。SVN 资源管理器状态图标叠加、编辑过程自抵消自动归档与 DAP 帧源码路径修复。没有新增 npm 依赖、Host RPC、数据迁移或扩大 DSH 兼容版本范围。

## 改动

- 文件树叠加 SVN 状态图标：目录按子树聚合出单一决胜状态（冲突 > 阻碍 > 缺失 > 不完整 > 删除 > 替换 > 修改 > 新增 > 未纳入版本控制），文件/目录图标以矢量叠加方式呈现 ✓ / ! / × / + / − / ? / · / ↗，冲突与缺失走独立显式标记。有界快照单飞投影，防抖 300ms、上限 1s、事件批 512 与行数/条数双上限，控制高频刷新开销。
- SVN 状态流式解析：`svn status` XML 以 StringDecoder 流式 framing 读取，支持超时/取消与 EOF 校验；远程状态解析吸收 `props='modified'`，`remoteStatus` 增加截断标记；`tree-conflicted` 识别为冲突状态。写操作（add/revert/ignore/cleanup/update/tortoise）后定向刷新，不整树全量轮询。
- 编辑过程自抵消自动归档：判定"新增后还原"的整记录逆反（含分块逆序），贪心配对同类抵消记录；命中后先保存再独立归档、归档事务失败回滚内存标志，reason 为「编辑过程自抵消（新增后还原），自动跳过审查」，不再进入待审查列表。桶上限沿用既有 MAX_RECORDS。
- DAP 帧源码路径修复：按当前语言过滤并排序源码候选并缓存，帧视图只保留合法源码路径；反查失败且已知语言或裸 chunk 时置空，不再回退到错误语言的文件。
- 客户端刷新事件细化：刷新/文件变更事件携带 scope、paths、eventId、kind，编辑器各决策/保存/回滚/更新路径定向传递，侧栏与编辑器按范围局部刷新。
- 新增 SVN 资源管理器/流式解析/目录聚合/过程抵消归档相关测试 9 个，扩展归档 RPC、捕获远程、DAP 帧路径、模型测试 4 个。

## 验证范围与边界

- 本次改动的最小回归范围为新增 9 个测试文件（explorerViewClient、svnExplorer、svnExplorerCache、svnExplorerHook、svnExplorerSmoke、svnExplorerView、svnFolderStatus、svnNotice、svnStatusStream）与修改的 4 个（archiveRpc、captureRemote、dapFramePath、model），全部通过；覆盖目录聚合决胜、状态流式 framing、过程抵消归档及事务失败回滚（SQLite TRIGGER 模拟）、DAP 语言过滤、刷新范围传递与写操作后定向刷新。
- 发布门禁在实际暂存树按顺序执行 `pnpm typecheck` → `pnpm test`（完整 Vitest 与 nativeOpen JS 发布套件）→ `pnpm build`（Host / Client 双入口）；公开状态另由 GitHub Actions、npm 版本/latest/gitHead 与实包完整性、入口核验确定。发布会话记录保存完整退出码、计数、耗时及构建提示。
- 自动化测试使用生命周期/Monaco 替身，不代替真实浏览器渲染验收。本会话没有浏览器调试工具，**尚未完成真实 GUI、Console、SVN 状态图标渲染与刷新交互验收**；用户已明确接受该发布缺口。加载发布包后应现场复核：SVN 工作区文件树显示状态图标（含目录聚合与冲突标记）→ 执行 add/revert 后图标与刷新定向更新；编辑新增后还原不应出现在待审查列表。
- 未执行 Linux/macOS 现场验收或 Unity Editor 测试。DSH 兼容范围与 v0.14.6 相同：已声明的 0.1.x 和精确放行的 0.2.0-rc.1 / rc.2，不包含其他未经适配的 0.2 版本。

## 升级与回退

确认产物可查询后，从 `v0.14.7` Git tag、GitHub Release tgz 或 `dsh-vscode-mode@0.14.7` 安装到实际目标 profile。Desktop 使用其专属安装入口，不套用 Web 示例目录。本次公开发布不自动替换当前本地包、修改 profile、刷新页面或重启 DSH；此前单独批准的本地部署与此次公开发布分别记录。

本版源码功能改动涉及 Host 与 Client；替换包后仍应确认当前 Host / Client 的实际加载版本，必要时由用户重启目标 DSH Host 并强制刷新原页面，不把安装完成当作 GUI 生效证据。

回退到 v0.14.6 会失去本次 SVN 状态图标、过程抵消归档与 DAP 路径修复，没有新增数据迁移。从 0.14.2 或更旧版本升级或回退，继续遵循 [0.14.3 数据迁移与回退说明](release-0.14.3.md)，不要删除 SQLite 新库或用旧 JSON 覆盖当前数据。

发布仅由新 Git tag 触发现有 GitHub Actions；本机不执行 `npm publish`。上传接受不等于已公开，Verify 超时不等于未上线或需要重新发布。

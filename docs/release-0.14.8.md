# dsh-vscode-mode 0.14.8 发布说明

> 2026-10-12；基线 v0.14.7。Unity 外部脚本编辑器支持显式选择打开目标（自动/DSH Web/DSH 桌面端），桌面 profile 开机自动准备独立 bridge，并修复桌面端 sessions 服务面缺 `.open`/`.create` 导致的「编辑器打开失败或取消」。没有新增 npm 依赖、Host RPC、数据迁移或扩大 DSH 兼容版本范围。

## 改动

- Unity 内嵌包 `com.dsh.editor` 0.3.0→0.3.1：外部工具面板新增「打开目标」下拉（自动/DSH Web/DSH 桌面端，按项目保存）。选择 DSH 桌面端时通过 `FindBridge("desktop")` 在 `~/.dsh/profiles/*/dsh-vscode-mode/bridge/dsh-open.ini` 中定位 `mode=desktop` 的独立 bridge；目标缺失时明确报错（提示先打开一次 DSH 桌面端或填写显式 bridge 配置），不再静默回退到 Web 配置。
- 桌面 profile 开机自动 provisioning 独立 bridge：`ensureActiveBridge` 在 `apply` 期以 `vscode-mode:bridge` effect 为当前 profile（desktop 或 web）生成 `<profile>/dsh-vscode-mode/bridge/dsh-open.ini`（mode 按 profile 自动判定），无需先注册 OS 菜单或登记 Unity 项目；未知 profile 返回 null 不抛错、不阻断启动。
- 修复桌面端外部打开失败：客户端 `openFlow.realDeps.openSession` 不再直调 `service('sessions').open(id)`（桌面端 sessions 服务面缺该方法，实证 `TypeError: ... .open is not a function`，导致 openDeepLink 走 catch、ACK success=false、Unity 报「编辑器打开失败或取消」），改为 `materializeScope → manager.select → open` 多面切换，缺面静默不致命；`createSession` 在 `sessions.create` 缺失或失败时回落 `newDraftSession` 多通道建会话（宽松解析 id），彻底失败才报「新建会话失败」。
- 新增测试：`tests/openBridge.test.ts`（ensureActiveBridge 端到端：desktop/web profile 独立 bridge、无 profile 返回 null、INI 注入拒绝，4 个）、`tests/openFlow.test.ts` 桌面 sessions 面回归（sessions 无 `.open` 时编排不抛错走 `manager.select`；无 `.create` 时回落通道失败报「新建会话失败」，2 个）、`unityHintProbe.cs` 扩展（桌面目标选择/FindBridge 探针，+42 行）。

## 验证范围与边界

- 本次改动的最小回归范围为新增 `openBridge`、`openFlow` 桌面 sessions 回归与 Unity 探针扩展，连同既有 `integrate`/`unityBridge` 相关用例，本地 24/24 通过；完整 Vitest 套件与 nativeOpen JS 发布套件在发布门禁中执行。
- 发布门禁在实际暂存树按顺序执行 `pnpm typecheck` → `pnpm test`（完整 Vitest 与 nativeOpen JS 发布套件）→ `pnpm build`（Host / Client 双入口）；公开状态另由 GitHub Actions、npm 版本/latest/gitHead 与实包完整性、入口核验确定。发布会话记录保存完整退出码、计数、耗时及构建提示。
- 自动化测试使用生命周期/Monaco 替身，不代替真实浏览器渲染验收。本会话没有浏览器调试工具，**尚未完成真实 GUI、Console、Unity EditMode 验收**；用户已明确接受该发布缺口。Unity 桌面端打开路径已在桌面 DSH 上完成现场验证（用户确认「没问题了」）。加载发布包后应现场复核：Unity 外部工具选择「DSH 桌面端」打开脚本 → 文件在桌面端会话打开；桌面 profile 启动后 `bridge/dsh-open.ini` 自动出现。
- 未执行 Linux/macOS 现场验收。DSH 兼容范围与 v0.14.7 相同：已声明的 0.1.x 和精确放行的 0.2.0-rc.1 / rc.2，不包含其他未经适配的 0.2 版本。

## 升级与回退

确认产物可查询后，从 `v0.14.8` Git tag、GitHub Release tgz 或 `dsh-vscode-mode@0.14.8` 安装到实际目标 profile。Desktop 使用其专属安装入口，不套用 Web 示例目录。本次公开发布不自动替换当前本地包、修改 profile、刷新页面或重启 DSH；此前单独批准的本地部署与此次公开发布分别记录。

本版源码功能改动涉及 Host 与 Client；替换包后仍应确认当前 Host / Client 的实际加载版本，必要时由用户重启目标 DSH Host 并强制刷新原页面，不把安装完成当作 GUI 生效证据。

回退到 v0.14.7 会失去本次 Unity 打开目标选择、桌面 bridge 自动 provisioning 与桌面 sessions 兼容修复，没有新增数据迁移。从 0.14.2 或更旧版本升级或回退，继续遵循 [0.14.3 数据迁移与回退说明](release-0.14.3.md)，不要删除 SQLite 新库或用旧 JSON 覆盖当前数据。

发布仅由新 Git tag 触发现有 GitHub Actions；本机不执行 `npm publish`。上传接受不等于已公开，Verify 超时不等于未上线或需要重新发布。

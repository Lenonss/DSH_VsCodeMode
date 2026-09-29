# dsh-vscode-mode 0.14.1 适配与发布说明

> 2026-09-29；仅针对 Web DSH `0.2.0-rc.1` 的安装兼容性修复。发布由 `v0.14.1` tag 触发 GitHub Actions，GitHub Release 和 npm 是否可用须分别核对；旧版 `0.14.0` 仍会被新 Host 的 peer 门禁拒绝。

## 原因与变更

`0.14.0` 的六个官方 `@deepseek-ai/dsh-*` peer 均以 `<0.2.0-0` 收尾。Web Host 及这些包实际为 `0.2.0-rc.1`，故 DSH 出于安全考虑拒绝安装，而非缺少一次 `allow-version` 风险豁免。`0.14.1` 保留旧版已支持范围，只增加精确 `|| =0.2.0-rc.1`，锁文件 importer 同步；测试确保既不扩大到 alpha.1 / rc.2 / 0.2.0 正式版，也不排斥此前已支持的 0.1.x。`familyLabel` 对 0.2 单列，防止报告误写成 0.1.7。

## 兼容证据及边界

- 比较官方已安装的 Desktop `0.1.7-rc.2` 与 Web `0.2.0-rc.1` 树：插件消费的 10 个 UI 原语两侧齐备；新 Web 树中硬注入 Host 服务、Config / 设置、快捷键、官方侧栏、当前会话、连接鉴权候选面均存在。删除的 `codeRuntime` 未被本插件使用；这是静态接口审计，不等于功能完全验证。
- `TESTED_DSH_MAX` 暂保留 `0.1.7-rc.2`：已验证安装与 Web 端基本挂载，但尚未逐项现场验证插件全部能力，不能据此提高完整实测上界。
- 定向 `tests/peerDeps.test.ts tests/dshVersion.test.ts tests/compat.test.ts`：97/97 通过；`pnpm run typecheck`：通过；`pnpm test`：179 文件通过、2 跳过，2390 用例通过、12 跳过，原生打开 9/9 通过；`pnpm run build`：通过。`pnpm pack` 生成的 `dsh-vscode-mode-0.14.1.tgz` 已核对版本、六项 peer、Host/Client 产物和 bundle patch；SHA256：`920BCE9109926B880287AE982ED08C2131EC9766CFA2AA92D59B2C8CE1EF8A4A`。
- 已向正在运行的 Web `0.2.0-rc.1` profile 安装本地 tgz：CLI 退出码 0，插件管理页显示 `v0.14.1`、已启用、`1 运行中`。刷新**原** `http://127.0.0.1:3080` 后，插件 Client 入口、样式和 Monaco 编辑器均加载，文件编辑侧栏可见，相关 `/edrv/rpc` 请求返回 HTTP 200。未重启 Host、未使用 `allow-version`。控制台另有 Bloom 主题客户端资源 404，属其他插件，不计作本插件问题。
- 未在 Desktop、Linux/macOS、Unity 真机或其他 DSH 0.2 版本现场验收；LSP、SVN、调试等完整工作流尚未逐项验收；旧运行树的开发锁定依赖没有升级。

## 本地安装与回退

在仓库运行 `pnpm run typecheck && pnpm test && pnpm run build`，再以 `pnpm pack --pack-destination <临时目录>` 产生 `dsh-vscode-mode-0.14.1.tgz`。核对其中 `package.json` 的版本/peer 和 Host、Client 双面文件之后，仅对确认运行的是 `0.2.0-rc.1` 的 profile 执行 `dsh plugin --profile web add <临时目录>/dsh-vscode-mode-0.14.1.tgz`。安装会修改 profile 的 manifest、锁文件和 bundle；先备份这三项。安装后刷新原 Web 页面，核对插件管理状态、侧栏与浏览器错误；本次已即时挂载，无须重启。

本机实际使用的包在 `C:\Users\1\AppData\Local\Temp\dsh-vscode-mode-0.14.1-compat\dsh-vscode-mode-0.14.1.tgz`，原 profile 三文件备份在 `C:\Users\1\.dsh\profiles\web\backup-dsh-vscode-mode-0.14.1-20260929-150640`。首次安装因 profile 中原有的 `node_modules\dsh-vscode-mode` Junction 指向开发仓库，pnpm 试图从仓库 `node_modules` 建立符号链接而报 `EPERM`；恢复被改动的 lock 后，只将原 Junction 改名保留为 `C:\Users\1\.dsh\profiles\web\node_modules\dsh-vscode-mode.preinstall-junction-20260929-151732`，原目标不变，单次重试即成功。不要把这个旧链接当成新安装包删除或覆盖，也不要清除上述临时 tgz：现有 profile 依赖仍引用该本地文件，今后重装/更新前需先迁移到持久包源。

如需回退，先核对 profile 的其他依赖与用户改动，再用 `dsh plugin --profile web remove dsh-vscode-mode` 移除本次安装；确认新包路径腾出后才将保存的旧 Junction 改回原名，并按需从上述备份恢复原有 manifest / lock / patch。不要盲目覆盖安装后其他插件的新变更，也不得删除用户已有配置。**本机当前仍引用本地 tgz**：发布 npm 不会自动把现有 profile 切换到注册表包；更换来源前需另行确认并保留回退点。仅当 npm 上确实查得到 `0.14.1` 且版本元数据核对通过，才把 npm 安装视为可用。

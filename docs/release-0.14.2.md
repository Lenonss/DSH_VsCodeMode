# dsh-vscode-mode 0.14.2 发布说明

> 2026-09-29；基线 v0.14.1。本版修复文件编辑侧栏的全局内容搜索选项行为，不改变 DSH 版本兼容范围、配置格式或依赖。

## 变更

- 未勾选「区分大小写」时，Host 内容搜索显式向 ripgrep 传入 `--ignore-case`，不再让包含大写字母的查询落入 smart-case 而意外区分大小写；勾选时仍传 `--case-sensitive`。该选项不影响文件名与 glob 的大小写规则，避免错误排除大小写不同的源码目录。
- 搜索面板开启「仅当前文件」却没有活动文件时，不向 Host 发出退化为全工作区范围的请求；关闭或切换活动文件时刷新搜索结果，保留旧请求序号防护。
- 覆盖大小写、全词、正则、包含/排除开关与仅当前文件范围的定向测试。

## 验证与边界

- 发布前执行 `pnpm run typecheck`、`pnpm exec vitest run tests/content-search.test.ts tests/searchPanel.test.ts` 和 `pnpm run build`；结果以对应命令日志及发布流水线终态为准。
- 发布前已在原 `http://127.0.0.1:3080/` Web profile 安装修复构建并重启 Host，现场搜索 `SEARCHINCLUDES`：未勾选「区分大小写」时命中小写 `searchIncludes`，显示 3 文件、15 处匹配；勾选后显示无匹配，关闭后结果恢复。实测环境为 Web DSH `0.2.0-rc.1`、Windows；未对 Desktop、Linux/macOS 或全部功能进行现场验收。
- 发布 GitHub Release / npm 的实际结果须分别核对；tag 推送并不代表 npm 已发布。`.github/workflows/release.yml` 在存在 `NPM_TOKEN` 时才自动发布 npm，缺少则跳过。

## 安装与回退

通过 `dsh plugin --profile web add dsh-vscode-mode@0.14.2`（确认 npm 已发布后）或固定 Git tag / GitHub Release tgz 安装。替换已安装的同名插件包后重启目标 DSH Host，并刷新原页面，以载入新的 Host 模块；只刷新浏览器不足以更新后端搜索逻辑。回退时安装 `v0.14.1` 对应的已有包并重启 Host；本次无配置迁移。当前本地 Web profile 使用此前已安装、包含本次修复的本地 tgz，其 package 元数据仍为 `0.14.1`，不会因发布 v0.14.2 自动切换；保留原本地 tgz、profile 备份与回退链路，不在本次发布中更动。

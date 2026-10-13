# 0.14.10：简化 DSH 版本政策

## 变更

- 六项 `@deepseek-ai/dsh-*` peerDependencies 统一为 `*`，取消长版本区间、逐版 rc 白名单和版本上界。Node、React、Cordis、schema 约束保持不变。
- 兼容报告不再仅因 DSH 版本高于已实测版本告警；保留版本探测、实际能力、设置依赖/volatile 标记和路由/重复装配诊断。
- 六项 DSH 开发依赖固定原解析版本，与发布 peer 分离；锁文件仅调整 importer 项，不升级开发环境。

## 语义与验证边界

DSH 的 `includePrerelease` 检查接受 alpha、rc、正式版和未来主版本。npm 默认 semver 的 `*` 仍排除预发布，可能产生 peer 不匹配提示；宽松声明不是未来所有 DSH API 的兼容保证。

发布前执行 frozen-lockfile、类型检查、完整 JS 发布套件（Vitest 与 nativeOpen）、Host/Client 构建和打包入口核验。实际通过/跳过数量、耗时、CI 与公开实包核验结果由本次发布报告记录。

本次无客户端 UI 改动，未做当前 GUI 或跨 DSH 版本全功能验收，该缺口经用户接受；发布不代表当前 DSH 实例已部署或生效。

## 升级与回退

安装前确认目标版本已在 npm 或 GitHub Release 可读取。替换插件后需重启目标 Host 并强制刷新原页面；本次发布不自动执行安装或重启。

如新 DSH 存在 API 变化，请根据能力诊断报告反馈，而非只按版本号判断。回退可安装此前可用版本；旧包仍保留其当时的 peer 版本限制。未新增数据迁移。

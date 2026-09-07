# v0.1.51 发布说明

> v0.1.50 已发布规则面板交互重构。本版针对「语言服务器」设置页做两项改进：
> 卡片按当前已装 LSP 动态显示（替代 Lua/C# 常驻），并补齐同语言多版本 LSP 的选取规范化。

## 语言服务器设置页动态显示

- 新增 RPC `edrv.lsp.detect`：对全部支持语言返回 provider 检测结论（不启动服务器），
  替代设置页原先调用的 `edrv.lsp.status`（仅返回已启动服务器，未启动时状态区空白）
- **可见性规则**：检测到可用 LSP（source ≠ none）、或该语言已存配置（禁用开关/手动命令/路径）、
  或存在待一键安装的缺失环境（覆盖 DotRush 已装但缺 .NET 时 source=none 仍需显示安装入口）才显示卡片
- 未检出的语言以灰字汇总列出；全部未检出时空态引导前往「市场」搜索安装或安装本地 .vsix
- 市场/本地 .vsix 安装、卸载、更新成功后自动刷新检测结果——新装 LSP 的卡片即时出现，无需手动刷新
- 底部提示改为语言无关文案；DSH 宿主设置页的 schemastery section 维持现状（仅子页动态化）

## 同语言多 LSP 选取规范化

- 优先级链不变：手动配置 > 扩展源注册 > 自动发现；同一工作区同语言仍仅启动一个服务器实例
- 自动发现内部定序不变：Lua 为 EmmyLua > LuaLS > PATH；C# 为 Roslyn > DotRush > OmniSharp
- **多版本并存取清单版本最高**（对齐 EmmyLua/DotRush 既有策略）：补齐 LuaLS
  （`candidateLuaServers` 改返回 `{path, version}[]` 按版本降序）、Roslyn 与 OmniSharp
  （`candidateCSharpServers` 收集全部命中后排序取最高，原先取目录扫描序第一个，可能选中旧版）
- LuaLS 命中后状态行补 `providerName: 'LuaLS'` 与版本号展示

## 候选服务器展示

- `LspServerStatus` 新增可选 `candidates?: { name, version?, path?, chosen? }[]`
  （纯增量字段，旧客户端忽略，与 `missingEnv` 同款策略）
- 卡片在多候选时显示「候选（N）：名称 vX（当前）· 名称 vY」；
  `chosen` 以候选路径命中 `spec.argv` 判定，手动配置指向同路径时同样可标记

## 修复

- `edrv.lsp.configUpdate` 语言校验条件恒真（`resolveProviderSpec` 总返回带 languageId 的对象），
  任何 languageId 都不会被拒绝；改为 `LSP_LANGUAGES` 白名单判断

## 兼容性

- `candidates` 为可选增量字段；无 settings 结构变更、无数据迁移；
  检测复用 provider 发现缓存（目录指纹 + TTL），设置页重复打开不重复扫描
- DotRush 缺运行时时的后台 .NET 自动下载行为与 v0.1.47 一致（非新增副作用）

## 测试

- 全量 vitest：512 通过 / 6 既有跳过（新增 6 例：多版本 LuaLS/Roslyn 选取、
  `candidatesFor` 候选汇总与 chosen 标记、手动配置同路径标记、LuaLS 未发现回退分支）
- typecheck 零错误；host + client tsdown 构建通过；web profile 实装校验
  （安装产物含 `edrv.lsp.detect` / `candidatesFor` / `LANG_META` 标记）

## 已知

- 旧版本发现结果在磁盘缓存指纹/TTL 失效前仍被复用，多版本机器升级后如需立即切换到最高版本，
  在卡片上点「重新检测」即可
- 「扩展源」provider 注册表（`registerExtensionProvider`）生产代码中仍无调用方，
  extmgr 安装的扩展实际经自动发现扫描扩展目录生效（现状保留，未改动）

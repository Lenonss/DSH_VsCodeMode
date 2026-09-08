# v0.1.54 发布说明

> v0.1.53 之后两块内容：① DSH 0.1.3-alpha 适配修复——会话内文件链接（文件引用 /
> 产物「打开」）点击不再跳转插件内嵌编辑器的问题；② 新功能——编辑区图片文件预览。

## 背景：DSH 0.1.3 改了文件链接的打开路径

- DSH 0.1.3-alpha 起，`dsh-client-ui-chat` 的 `openFile` 改为直接调用
  `ctx.remote.session.openWorkspacePath`（`session/openWorkspacePath` RPC，浏览器直连 host），
  不再经过客户端 `workspaces.openPath`——v0.1.51 及更早版本把打开路由补丁装在后者上，
  补丁仍在但无人调用，点击因此落到 host 的「系统默认应用打开」，不进插件编辑器
- 文件引用（助手消息内）与产物文件（Produced Files「打开」）在 0.1.3 均汇聚到该新路径；
  产物区「在文件夹中显示」（path `"."`）同样走此路径

## 修复：能力探测式双路由

- 新增 `remote.session.openWorkspacePath` 路由补丁（`remoteOpenRouter`）：
  0.1.3+ 对话文件链接优先进插件打开器（vscode 打开器优先级 100，与 `fileOpenTool` 设置、
  dsh-better-sidebar 打开器共用同一注册表），失败回退系统打开；与旧 `workspaces.openPath`
  路由行为一致
- **accessor 感知补丁 `patchAccessor`**：0.1.3+ remote 命名空间方法是 getter-only
  accessor（`Object.defineProperty` 仅定义 get，直接赋值抛 TypeError），补丁改为整体替换
  属性描述符；`original` 每次现场取自原 getter，跟随 DSH 内部实现变化；恢复带归属校验，
  data 属性自动降级 `patchMethod`
- **安装时序**：`remote.session` namespace 由 api-remotes 在 loader 就绪后挂载，晚于本插件
  apply，且旧版 DSH 可能整段不存在——不加 `inject`（避免旧版停等永不激活），改为定时探测
  有界重试（2s × 15，与侧栏服务探测同款节奏）；未命中仅告警，不影响其余功能
- 旧路径补丁（`workspaces.openPath`）原样保留：0.1.2 及更早 DSH 的对话文件链接主路径不变
- `path === "."`（打开工作区文件夹）始终透传原实现，避免内嵌编辑器误开目录

## 新功能：编辑区图片预览

- 点击图片文件（png/jpg/jpeg/gif/webp/bmp/ico/avif/svg）时，编辑区不再以文本乱码打开，
  改为渲染只读图片预览面板：显示自然尺寸，解码失败显示占位与重试；不建 Monaco model、
  不进文本/差异流程
- host `edrv.read` RPC 新增 `encoding: 'base64'` 响应（返回 base64 + 按扩展名判定的 MIME，
  8MB 上限与路径解析行为不变）；MIME 表收敛在 `shared/rpc.ts`，host/client 同源不漂移
- SVG 额外支持「以文本查看」切换（唯一提供文本切换的图片格式）
- **版本兼容守卫**：新客户端配旧 host（响应缺 mime）时明确报「host 版本过旧：图片响应缺少
  mime」，读取失败信息携带 host 解析后的真实路径，便于区分路径解析错与目标不存在

## 兼容性

- 新路由按「`remote.session.openWorkspacePath` 属性是否存在」能力探测安装，不依赖版本号
  判断；0.1.2 线及更早版本行为与 v0.1.51 完全一致
- 已实测 DSH 上界更新为 0.1.3-alpha.2（`TESTED_DSH_MAX`）；兼容性报告版本线标签新增
  「0.1.3-alpha 及更新（对话文件链接=remote.session.openWorkspacePath）」
- 设置页兼容性报告新增适配行「会话文件链接路由（remote.session.openWorkspacePath）」，
  安装成功即 active，可用于自诊断
- 无设置结构变更、无数据迁移、无 host 侧路由变更（纯 client 运行时补丁）

## 已知

- profile 的 web-package.json 依赖仍指向 v0.1.51 tgz，实际安装为指向源码目录的 Junction
  （开发形态）；在 profile 重跑 `pnpm install` 会以旧 tgz 拷贝覆盖 Junction，导致功能回退
  ——升级部署请打包新 tgz 或维持 Junction 后仅执行构建
- DSH 0.1.3-alpha.2 顶栏新增官方「在应用中打开」（open-in-app）为 Workspace 级能力，
  未提供第三方应用扩展点，与本插件的会话内文件链接路由互不影响

## 测试

- 全量 vitest 通过（新增 35 例：`patchAccessor` 拦截/实时 original/归属校验/幂等/data 降级/
  缺失返回 null；`probeRemoteOpen` 四态；`patchRemoteOpen` 接管/"."透传/无打开器透传/
  失败回退/system 选择/恢复；图片判定/data URL/MIME 表 9 例）
- typecheck 零错误；host + client tsdown 构建通过

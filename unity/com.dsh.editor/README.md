# com.dsh.editor — DSH 文件编辑

Unity 外部脚本编辑器通过当前用户私有的 OPEN REQUEST/ACK 文件队列打开脚本或项目。收到 profile 与 requestId 匹配的成功 ACK 才确认完成；超时、拒绝或无效 ACK 会在 Unity Console 报告错误。

## 安装

在 DSH 设置 → VSCodeMode → 系统集成中添加 Unity 项目并安装/更新内嵌包，或在 Unity Package Manager 中选择本包。切回 Unity 后，在 Preferences → External Tools → External Script Editor 中选择 **DSH 文件编辑**。

DSH 安装 Unity 集成时会为当前 profile 准备独立的 `<profile>/dsh-vscode-mode/bridge`，并在项目的 `UserSettings/dsh-editor.ini` 写入 `config=<绝对桥接INI路径>`；无需先注册资源管理器菜单，也不会覆盖其他 profile 的菜单配置。

**DSH 桥接配置**字段为每个 Unity 项目单独保存。填写绝对路径时使用该显式覆盖；留空时，后台先读取本项目的安装提示，只有提示文件不存在才回退 `$DSH_HOME/dsh-vscode-mode/shell/dsh-open.ini`。未设 `DSH_HOME` 时旧目录以用户目录中的 `.dsh` 为根。提示损坏、相对路径或目标配置不可读会通过 Unity Console 报告错误，不会猜测端口或切换 profile。清空字段可恢复自动选择。

## 配置契约

INI 保留 `base`，并包含 `mode=desktop|web`、绝对 `profile`、绝对 `inbox`、绝对 `node` 可执行文件、`nodeMode=node|electron` 和绝对 `helper`（安装的 `dsh-open.mjs`）。配置由 DSH 生成，Unity 不推测端口或 profile，也不创建任何队列目录。

桌面模式仅唤起官方 `dsh://open`；Web 模式仅唤起所选 `base`。文件和行列只进入队列，不附加到 URL。Electron 解释器使用 `ELECTRON_RUN_AS_NODE=1`。producer 必须与 INI 一同安装，不能只复制 Unity 包后填写一个服务地址。

## 使用与边界

- 双击支持的文本/代码文件，或从 Console 跳转行列。原有文本扩展名白名单及自定义文本扩展保留；prefab 和 scene 始终交回 Unity。
- “Open C# Project” 的空路径打开 Unity 项目根；测试按钮也打开项目根。
- 偏好读取在主线程；配置/队列 IO 与等待在后台 producer 中。界面激活通过 `EditorApplication.delayCall` 执行，不在后台调用 Unity UI。
- 队列要求 Windows 当前用户独占 ACL，或 POSIX 目录 0700、文件 0600，并拒绝链接/重解析逃逸。目录缺失或不安全时失败，不建立宽松回退目录。
- 请求最多 20 个绝对路径，每个至多 8192 字符，JSON 至多 64 KiB，有效期及 ACK 等待上限 60 秒。不使用 cookies 或通用 RPC。
- 卸载时删除内嵌包并选择其他外部编辑器。个人配置保存在项目专属 EditorPrefs 键中，不修改项目资源。

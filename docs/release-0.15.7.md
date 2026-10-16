# dsh-vscode-mode 0.15.7

## 改动

- 对 EmmyLua 0.9.41 的标识符词边界解析问题，将 definition、references、hover 查询位置调整到词尾；definition 返回空或误指向同文件使用点时，从引用结果和目标文件声明文本推导跨文件定义。
- Lua 表字面量枚举键（例如 `EventId.ISTaskSystem` 表内的 `TaskStateChange = 50000`）在 Ctrl+点击时打开引用 Peek；字段使用处继续使用 Monaco 原生定义跳转。
- 补充跳转推导与枚举键 Ctrl+点击的针对性测试。

## 发布与验证边界

通过 tag v0.15.7 触发 GitHub Actions 发布，不在本机执行 npm publish。没有依赖或 peer 变更，锁文件保持原状。发布前执行项目 typecheck、JavaScript 发布测试套件与双端构建；具体计数以发布记录为准。

当前 DSH GUI 可打开，但尚未完成目标 Lua 枚举键的真实 Ctrl+点击验收；用户已明确接受此发布缺口，测试和构建不代替 GUI 验收。

## 更新提示

公开发布不等于当前 DSH 实例已安装或生效。本次不修改 profile、不安装、不重启 DSH，也不启动替代 GUI。升级后应分别核验 Host/Client 版本与目标 Lua 工程中的点击行为。

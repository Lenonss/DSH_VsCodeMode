# com.dsh.editor — DSH 文件编辑（Unity 外部脚本编辑器集成）

把 DSH 的 `dsh-vscode-mode`（VSCodeMode）编辑器注册为 Unity 外部脚本编辑器：
双击脚本 / Console 报错跳转时，优先把打开请求**移交已打开的 DSH 页面**就地执行（不重复开新页）；
无活跃页面时回退经默认浏览器深链打开对应文件并定位行列。

## 安装方式一：DSH 设置页一键安装（推荐）

1. 打开 DSH Web GUI → 设置 → VSCodeMode → 通用 →「系统集成」。
2. 在 Unity 集成区添加你的 Unity 项目根（包含 `Assets/` 与 `ProjectSettings/` 的目录）。
3. 点「安装」—— 包会复制为 `<项目>/Packages/com.dsh.editor`（Unity 内嵌包，自动发现）。
4. 切回 Unity 窗口（或下次启动 Unity）自动生效。

后续插件更新后，同一按钮即为一键更新（整目录替换，列表里会显示「可更新」徽标）。

## 安装方式二：Package Manager 手动安装

- Unity → Window → Package Manager → 左上角 `+` → **Add package from disk** →
  选择插件目录下的 `unity/com.dsh.editor`（含本 README 的目录）。

## 使用

1. Unity → Edit → Preferences → External Tools → External Script Editor 下拉选择 **DSH 文件编辑**。
2. 展开 DSH 文件编辑选项，确认「DSH 服务地址」（默认 `http://127.0.0.1:3080`，需与 DSH Web GUI 地址一致）。
3. 双击任意脚本即可打开（有已打开 DSH 页面时直接在其页面内打开，不再新开标签）；Console 报错双击会带上行列。

## 说明

- 本包为虚拟外部编辑器：不需要本地可执行文件。打开优先走「移交」：POST 到 DSH host 的
  `edrv.external.handoff`，已打开页面 3s 轮询领取并执行打开规则（文件夹/文件的智能路由见插件 README）；
  无活跃页面或 2s 未领取时回退 `Application.OpenURL` 深链。移交在后台线程执行，不阻塞编辑器。
- 编辑器内查看任意绝对路径文件；保存受 DSH 会话沙箱策略约束（工作区外保存会被拒绝，属预期安全行为）。
- 卸载：删除 `<项目>/Packages/com.dsh.editor` 目录，并在 External Script Editor 换回其他编辑器。

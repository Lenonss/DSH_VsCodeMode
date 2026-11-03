# v0.25.1：下载到本机支持选择保存位置

作者：ddj，2026-11-03。

## 背景

v0.25.0 的「下载到本机」用浏览器原生 `<a download>` 落盘，**保存位置完全由浏览器决定**
（一般是默认下载目录，或者浏览器设置里的「每次询问保存位置」）。网页无法指定任意磁盘路径，
于是从远程环境下载时文件散落在默认目录，找起来和当初在远端手工搬运一样别扭。

## 实现方式

点「下载」后先弹一次系统目录选择器，之后所有文件按**工作区相对路径**写进用户所选目录：

- 用 File System Access API 的 `showDirectoryPicker({ id, mode: 'readwrite', startIn: 'downloads' })`；
- 选中目录后按相对路径逐级 `getDirectoryHandle({ create: true })` 建子目录，
  再 `getFileHandle` + `createWritable()` 写入——文件夹下载仍是逐个原文件，不打包；
- 路径切段时过滤空段、`.` 与越界 `..`，兼容反斜杠，末段作文件名；
- 用户取消选择（`AbortError`）视为「整批中止」，提示「已取消下载」，不回落；
- 不可用/被拒时回落浏览器默认下载目录，并区分提示：API 缺失（unsupported）、
  非安全上下文（insecure，需 https 或 localhost）、写入权限被拒（denied）；
- 部分浏览器选择后仍需显式 `requestPermission({ mode: 'readwrite' })`，失败同样按 denied 回落；
- 选择器必须在用户手势的同步栈内触发，因此 `runBatch` 把 `pickSaveSink()` 放在第一个 await，
  单文件菜单与文件夹确认框两条入口都满足。

未采用的方案：

- **逐文件「另存为」**：能逐个改名，但勾选 N 个文件就要确认 N 次，交互成本过高；
- **zip 打包后单次下载**：与「不打包、拿原文件」的产品决策冲突，且大目录会顶到读取上限；
- **依赖浏览器「每次询问保存位置」设置**：页面无法读取或修改该设置，等于把问题丢给用户。

## 验证

- `npm run typecheck` → 0 error。
- `npm run test` → 全量 288 文件、3733 通过 + 22 跳过。
- `npm run build` → host 与 client 四 bundle 均产出。
- 本机 GUI 冒烟（注入远程座位 + 本地重写 `/remote/edrv/` 前缀），四条分支实测：
  取消 → 「已取消下载」且不发起读取；拒绝授权 → 「未获得目录写入权限，已保存到默认下载目录」；
  选中目录 → `tests/officialBackfill.test.ts` 按相对路径写入 4328 B；
  文件夹流程 → `.codegraph/.gitignore` 写入 229 B，弹窗按钮为「选择位置并下载 N 个文件」。

**未验证项**：真实系统目录选择器的原生对话框交互（自动化无法点击系统对话框），
以及真实远程设备下的端到端写入。选择器 API 存在性与 `isSecureContext` 已在本机核对。

# v0.24.0：经第三方远程访问插件访问时，文件管理器与 Monaco 恢复可用

作者：ddj，2026-11-02。

## 背景与根因

从另一台设备通过 `@linxin666/dsh-remote-web-ui` 打开 DSH Web GUI 时，本插件两个入口同时失效：

- 文件管理器：「读取目录异常：Error: DSH 拒绝了当前页面的访问」（HTTP 403）；
- 编辑器：「Monaco loader 加载失败」。

根因不在资源完整性，而在宿主的准入顺序。`connection.requestRejection()`
（`@deepseek-ai/dsh-client-connection`）先做 Host 围栏，再看身份：

```js
admit(request) {
  if (!this.isTrusted(request)) return { rejection: 403 }   // Host 围栏先于一切
  ...
  return record === void 0 ? { rejection: 401 } : { peer: record.peer }
}
```

`isTrustedApiRequest` 只认回环、监听 bind 地址字面量与显式声明的 `trustedHosts`，
所以局域网 IP 或隧道域名来的请求**无论有没有登录 cookie 都是 403**；401 才代表登录失效。
这正是「DSH 拒绝了当前页面的访问」。

远程访问插件只改写它认领的路径：`/api/`、`/sidebar/`、`/git/`、`/pet/`，以及
`fetch`、`EventSource`、`WebSocket` 与被包过 `src` 访问器的 `<img|script|iframe>`。
`/edrv/` 不在其中，于是本插件的 RPC（`fetch`）与 vendor 静态资源直连宿主被拒：

| 入口 | 加载方式 | 被改写? |
| --- | --- | --- |
| `/edrv/rpc`（含二进制预览） | `fetch` | 否 → 403 |
| Monaco `loader.js`、AMD 模块 | `<script src>` | 路径不匹配 → 403 |
| Monaco CSS（`editor.main.css`） | `<link href>` | 不在补丁范围 → 403 |
| codicon 字体 | CSS `url()` | 不在补丁范围 → 403 |
| Monaco 语言 Worker | `new Worker` | 不在补丁范围 → 403 |
| pdf.js 模块 / worker / cmaps | `import` + `Worker` | 不在补丁范围 → 403 |

## 适配方式

远程插件的 `/remote/<任意内部路径>` 是服务端 catch-all：带同源设备 cookie、
回环重发到 `127.0.0.1`、并换上进程内凭据，因此**本插件自己的 Host 围栏与权限校验照常执行且通过**，
且**任何子资源类型都可达**（`<link>`、CSS `url()`、`Worker`、ESM `import` 都不需要主线程补丁）。

所以取它作为传输通道：远程页面把插件内部路径统一前缀成 `/remote/edrv/...`，
本地、桌面（`dsh-app:`）、未装远程插件时保持 `/edrv/...` 不变。

判定依据是远程插件在 `<head>` 解析期内联安装的座位对象
`window.__DSH_REMOTE_CHANNEL_BOOT__`（其发布源码 `remote-channel-boot.ts` 赋的是对象，
不是布尔标记）。它是 classic script、早于任何 module script 求值，因此本插件装配时读到即为定值。

未采用的方案：

- **`/api/edrv` 双挂载**：`/api/` 虽被改写，但补丁不覆盖 `link.href`、CSS `url()`、
  `new Worker`、ESM `import`，Monaco 的 CSS/codicon/Worker 与 pdf.js 模块仍会 403，
  只能做成看起来可用、实际半残的版本。
- **公开 vendor 路由**：违反「不取消鉴权、不无条件公开资源」的边界。
- **要求 `trustedHosts`**：需要用户改宿主配置，不在插件侧解决问题的范围内。

## 变更

- 新增 `src/shared/remoteChannel.ts`：`CHANNEL_SEAT`、`CHANNEL_PREFIX`、
  `channelPrefix()`、`transportPath()`、`transportUrl()`。`transportUrl` 内部仍走 `appUrl`，
  因此继续继承应用基址、反向代理子路径与 `dsh-app:` 协议；无 `window` 时前缀为空，
  host 侧与 node 测试环境行为不变。
- `src/client/rpc.ts`：业务 RPC 改走 `transportUrl(RPC_PATH)`；失败文案按状态细分，
  403 若响应体带 `{result:{ok:false,error:{code:'unpaired'}}}` 提示「远程访问设备尚未配对」，
  否则提示 Host 校验未通过并附「本页未接入远程访问通道」；404 提示路由不存在、
  确认插件与宿主版本匹配。
- `src/shared/rpc.ts`：二进制预览（`edrv.readBinary`）同改。
- `src/client/monaco/loader.ts`：`MONACO_BASE` 走 `transportUrl`，loader 地址、AMD `paths.vs`、
  CSS、codicon 字体与语言 Worker 全部随基址继承前缀；`onerror` 先探测真实状态再报错。
- `src/client/pdf/pdfLoader.ts`：pdf.js 基址同改（worker、cmaps、standard_fonts、viewer CSS）。
- `src/client/ui/DiffBadge.ts`：差异角标图片同改。
- 新增 `src/client/loadFailure.ts`：`probeStatus()`（HEAD 探测）、`statusHint()`、
  `loadFailureText()`、`monacoHint()`。区分 403 来源校验拒绝 / 401 认证失效 /
  404 资源或路由缺失 / 0 请求未到达宿主；文案只含 pathname 与状态码，不含 origin、查询串或凭据。
- `src/client/ui/EditorView.ts`：Monaco 失败面板改为按错误内容给差异化提示，
  不再一律「请确认插件包 assets/vendor/monaco 完整」。
- 未改：`src/routes.ts`、`src/httpGuard.ts`、`src/paths.ts`（服务端零改动）、
  `/api/session/*` 两处（本就被远程补丁覆盖）。

## 测试

- `tests/remoteChannel.test.ts`（新增 5 例）：无 window 空前缀；座位对象在位时的
  RPC 与 vendor 全链；座位为布尔时降级；`dsh-app://` 桌面协议；外部路径拒绝。
- `tests/loadFailure.test.ts`（新增 4 例）：探测 403 与抛错回 0；四类提示互异；
  文案只含 pathname、不含 origin 与查询串；Monaco 三类提示互异。
- `tests/transportCoverage.test.ts`（新增 2 例）：扫描 `src/client`、`src/shared`，
  禁止再出现裸 `appUrl('/edrv…')`，防止后续新增入口漏改。
- `tests/loader.test.ts`、`tests/appUrl.test.ts` 各补 2 例（通道前缀下的 loader/src 与 RPC 目标、
  未配对的 403 文案）。既有断言在无 window 时前缀为空，全部保持通过。

## 验证

- `npm run typecheck`：0 error。
- `npm run test`（全量）：284 个文件 **passed** | 2 skipped（共 286）；用例
  **3691 passed + 22 skipped**（共 3713），26.58s；另 `node --test tests/nativeOpen.test.mjs`
  9/9，退出码 0。
- `npm run build`：四个 bundle 产出并通过客户端产物完整性校验；
  只有既有 rolldown `INVALID_ANNOTATION` 警告（`src/client/monaco/lsp/providers.ts:281`），与本次无关。
- 本机入口（真实浏览器）：128 个 `/edrv/*` 请求全部 200；Monaco 全链加载
  （loader → editor.main → css → nls → tsMode → 两个 Worker → codicon 字体）并挂载成功；
  同一路径不带 cookie 直接 `curl` 仍回 **401**，确认没有变成公开资源；带 `If-None-Match` 回 304。
- 远程通道（本地回环代理复刻远程插件的转发语义：剥 `/remote` 前缀、重写 Host、
  `sec-fetch-site: same-origin`、响应头只放行常见六项）：注入座位对象后
  **138/138 个 `/edrv` 请求全部落在 `/remote/edrv/…`，裸 `/edrv` 为 0、4xx 为 0**；
  `edrv.listDir` / `edrv.read` / `edrv.save` / `edrv.readBinary` 全部 200 且内容往返一致；
  Monaco 与 Worker 在通道前缀下同样加载完成；Console 无插件相关 401/403/404 与 Worker/CSP 报错。

## 已知缺口与不打算做的事

- **真机远程未验收**：本机没有安装远程插件、也没有第二台设备，远程分支用等价的回环代理验证。
  **未覆盖**：真实设备配对门禁、进程内凭据交换、LAN/隧道 TLS 与证书、设备 cookie 的一年期流程。
  升级后请在任意手机/平板经远程插件打开，确认目录展开、打开与保存、Monaco 编辑与高亮、
  TypeScript 语言 Worker、整页刷新。
- 该代理的响应头白名单会丢掉 `x-edrv-mime` / `x-edrv-size` / `x-edrv-version`，
  远程下二进制预览会回退 base64：功能正常、体积偏大。要拿回直出通道需远程插件放行这三个响应头，
  宿主与本插件侧无需再改。
- 前缀判定只认该插件暴露的座位全局。若将来出现只代理 `/api`、不提供 `/remote` 的其它方案，
  远程 RPC 会从 403 变成 404（文案已能区分），那类场景需要新的适配约定。
- 客户端半改动由 `lib/client.js` 承载：升级后需**强制刷新**原页面；host 半无需重启。
- 本版不自动部署，也不修改任何 profile。

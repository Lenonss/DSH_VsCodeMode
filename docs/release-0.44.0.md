# dsh-vscode-mode v0.44.0 — UI 材料页（创建 UI 的默认入口）+ 对话链接打开修复

日期：2026-11-27　上一版：v0.43.0

## 背景

「创建 UI」此前要用户先把效果图贴进对话，模型再回头找素材。这次把入口前置成一张空白材料页：
工具生成页面，用户拖图填表，提交后材料落盘、清单发回当前会话。

顺带修一个老问题：对话里的文件链接点开后，编辑器会自己跳回上一个文件。

## 一、UI 材料页

```
模型 / 指令 → ui_builder_intake(slug, title?)
              → <项目>/plans/ui/<slug>/intake/materials.html（注入项目 config + 随机令牌）
              → 在官方 HTML 预览里打开（页面自带拖拽、表单、缩略预览）
用户拖图 + 填表 → 提交
              → 官方 fileUpload 暂存（无回执时回退 base64）
              → RPC edrv.uiIntake.save → <项目>/…/intake/submissions/<id>/
                    original/*（原始字节）+ request.json（v2 清单）
              → 清单作为一条消息投进当前会话（sendTaskWithFiles 带官方附件回执）
```

- 三个 RPC：`edrv.uiIntake.save`（校验 + 落盘 + 清单）、`edrv.uiIntake.latest`（刷新/重载后恢复上次提交）、`edrv.uiIntake.markSent`（送达回执）。
- 三面同源契约 `src/shared/uiIntake.ts`：路径归一、令牌校验、尺寸与清单文案只有一份，页面 / 客户端 / 宿主共用。
- 防伪：来源窗口身份 + 页面内随机令牌 + 宿主重新读页面校验，三者都过才落盘；写入限制在项目边界内。
- 降级：没有官方上传回执时走 base64；宿主不支持自动发送时，页面展示可复制的继续指令，不把 HTTP 200 说成「对话已收到」。
- 技能母版同步：`runtime/intake.mjs`（与工具同一套模板的命令行入口）、`runtime/intake/{materials.html,server.mjs,shared.mjs,limits.json,selftest.mjs}`（本机带令牌服务，供无宿主 / 受限 iframe 场景）、`references/intake.md`。

## 二、修复：对话链接点开后被状态恢复顶掉

- 现象：点 `BootText.cs` 这类链接，编辑器打开目标文件后立刻回到上一个文件（实测停在 `GameInitState.cs`），落盘页签里根本没有点开的那个文件。
- 根因：打开走 `edrv:open-editor` 事件，而编辑区每次挂载/重挂载都会从界面状态存档恢复页签——恢复先清空、再整份塞回滞后存档，两者没有互斥，一重挂载就整份覆盖。
- 修法：新增 `src/client/state/recentOpen.ts` 记「最近打开」（12 秒有效、挂 window 上跨重挂载存活）；恢复流程读出记录后合并进恢复结果——不在页签表就插入并设为活动页，存档为空时也保住它。

## 验证

- `npm run typecheck` 0 error
- `npm run test`：vitest 375 文件（373 通过 + 2 跳过）、4616 用例（4594 通过 / 22 跳过），31.23s；`node --test` 9/9
- `npm run build`：`lib/index.js` 1,674,841 B、`lib/client.js` 1,387,909 B（另有 rules / debug / excel / excelcodec 产物）
- 新增用例：`tests/recentOpen.test.ts`（10 条）+ `uiIntake{Page,Tool,Store,Protocol,Shared}.test.ts`

## 已知缺口

未做真机 GUI 冒烟（材料页提交全链路、对话链接打开）。两处都需要装到 profile 并重启后在真实页面验；本次发布不含本地部署。

## 升级

`npm i dsh-vscode-mode@0.44.0` 后重启 DSH。项目里已装 ui-kit 技能的，重新安装/更新技能以获得 `runtime/intake`（升级只覆盖 `runtime/`，保留 `config.json`、结构库、设计稿与 `intake/` 下的用户材料）。

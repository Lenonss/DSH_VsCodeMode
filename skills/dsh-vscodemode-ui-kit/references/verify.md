# 落地与对账

## 材料页回归（升级后先跑）

```bash
node .dsh/skills/ui-builder/runtime/intake.mjs --selftest
node .dsh/skills/ui-builder/runtime/intake.mjs --selftest-http
```

- `--selftest` 应输出 `6/6 passed`：生成、复用、覆盖、缺 config 默认值、非法 slug、页面路径。
- `--selftest-http` 必须真实启动服务，覆盖：空草稿、图片原始字节、文字/图片乱序、正式清单原名与字节、同一 `submissionId` 幂等、错误令牌、无效尺寸、服务停止；输出 `16 checks passed` 一类带数量的结果，不只看 HTTP 200。
- 浏览器侧必须在独立临时目录起服务，验证：
  1. 普通浏览器：填表 + 选择/拖入图片 → 草稿保存 → 提交 → 显示“材料已保存”与继续指令。
  2. `srcdoc` + `sandbox="allow-scripts"`（无 same-origin、无 `allow-forms`）：按钮可点、能保存、无宿主时显示复制指令。
  3. 销毁并重建 iframe：字段、尺寸、路径、效果图、素材、提交结果全部恢复；移除的图片不复活。
  4. 修改文字/图片：旧清单失效；重新提交生成新清单。
  5. 停服务后提交：显示具体失败原因，表单和图片保留；`--resume` 后重试成功。
  6. 无效名称/尺寸/类型/超量：页面或服务拒绝，`submissions/` 不新增目录。
- 普通浏览器、受限 iframe、真实 DSH 容器分别报告；没点过的容器写“未验证”，不要用 HTTP 200 代替按钮证据。
- 测试结束删除临时项目/服务/页面；不要动真实项目的 `intake/draft` 或 `submissions`。

## 三条落地路径（由 `config.editor.way` 决定）

| way | 谁写预制体 | 能回读吗 | 适用 |
|---|---|---|---|
| `editor-script` | 生成一个 Editor C# 脚本，用户点菜单跑 | 脚本顺手打印回读结果 | 默认 |
| `mcp` | agent 通过 Unity MCP 直接在场景里建 | 能，逐节点读 | 会话有 Unity MCP |
| `yaml` | agent 直接写 `.prefab` YAML | 只能文本比对 | 简单结构，且用户明确同意 |
| `spec-only` | 不落地，只交规格 | 不能 | 只是设计稿 |

## Editor 脚本约定

- 一个屏一个脚本，放 `plans/ui/<slug>/unity/Build<Slug>.cs`，菜单项 `Tools/ui-kit/Build <slug>`。
- 脚本只读 `spec.json`，不内嵌坐标常量：改数值不用重生成脚本。
- 只处理 `kind` 已知的节点；`opaque` 节点按 `prefab` 路径加载并实例化，不展开。
- 跑完打印 `设计 vs 实际` 表：id、rect、anchor 三列差异，空表就是零差异。

## 回读对账

能回读时（`mcp` 或 Editor 脚本）输出差异表：

```
id                    设计(x,y,w,h)         实际(x,y,w,h)         结论
Popup/Root/Title      560,270,300,48        560,270,300,48        ✅
Popup/Root/List       540,330,840,480       540,330,840,480       ✅
Popup/Root/Close      1352,252,32,32        1352,252,32,32        ✅
```

不能回读时，人工核三件事：容器尺寸、锚点、九宫格边距。别逐节点核，核不完。

## 差异常见来源

- 锚点 `pivot` 与 `anchor` 不一致 → 位置差半个尺寸。
- 九宫格边距用了切图前的数值 → 拉伸后内容错位。
- 字号单位（px vs pt）没换算 → 文字整体偏大偏小。
- 父节点 `opaque` 节点内部坐标是父级局部坐标，设计页里写成了屏幕坐标。

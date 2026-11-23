# 0.33.1 — 旧宿主兼容修复：RPC 全量 503 与样式丢失

日期：2026-11-23　基线：`@deepseek-ai/dsh-desktop@0.2.2-rc.5`（桌面端）／`@deepseek-ai/dsh@0.2.3-alpha.2`（Web）

## 背景

v0.33.0 在桌面端（DSH 0.2.2-rc.5）更新后整体不可用，两个症状同时出现：

1. 设置弹窗显示「读取快捷菜单失败：Error: DSH 认证服务尚未就绪」，DevTools 里
   `POST dsh-app://app/edrv/rpc` 连续 503（14 分钟内涨到 14,000 条）。
2. 悬浮按钮的鲸鱼标记按 SVG 原始尺寸铺满整屏，所有设置页退化成无样式文本。

两者都是 0.2.3 适配引入的回归，各自独立：

- **503 根因**：0.33.0 把旧宿主围栏写成「先取出方法、再裸调」
  （`reject = ctx.get('connection')?.requestRejection; return reject(req)`）。`requestRejection`
  是类方法，方法体要读 `this.admit()`，裸调时 `this` 为 undefined → 每次调用抛 TypeError →
  兜底分支回 503。0.2.3 已无该围栏，所以在 Web 端完全看不出来。
- **样式丢失根因**：0.33.0 把 CSS 改成 `meta.stylesheets`（宿主在记录挂载时安装）。
  机制只在 0.2.3+ 存在；0.2.2 的客户端模块系统是 `claimStyles()`，只认「模块自己在物化期
  插入的 `<style data-plugin-css>`」。旧宿主上插件 CSS 一份都没装上。

## 改动

| 文件 | 改动 |
| --- | --- |
| `src/httpGuard.ts` | 围栏改 `reject.call(connection, req)`；抛错时把原因（每进程一次）交给诊断回调，不再静默 |
| `src/routes.ts` | 把注册期的 warning 回调透传给 `admitRoute` |
| `tsdown.config.ts` | 每个产物的 factory 体前置守卫式自注入：按样式文本指纹探测「宿主是否已装」，未装才插 `<style data-plugin-css>`；`meta.stylesheets` 保留给 0.2.3+ |
| `scripts/check-client-artifacts.mjs` | 原「禁止自注入」断言替换为双通道校验：`meta.stylesheets` 必须在，且自注入片段在 vm 里真跑一遍「缺失→注入」「已装→不重复」两态 |
| `tests/httpGuard.test.ts`（新） | 7 例：接收者绑定（回归锚点）、403/undefined/服务缺失/抛错/405 分支、异常只报一次 |

## 验证

- `tsc -p tsconfig.json --noEmit`：0 error。
- `vitest run tests/httpGuard.test.ts`：7/7 通过。
- `tsdown` 构建 + `node scripts/check-client-artifacts.mjs lib`：全部通过
  （root 1,285,717 B；4 个 chunk 合同、共享只读、双样式通道、注入幂等均校验）。

## 验收

1. 桌面端（0.2.2-rc.5）重启后：`/edrv/rpc` 不再 503，DevTools 报错停止增长。
2. 鲸鱼缩回左下角悬浮按钮，快捷菜单与设置弹窗恢复样式。
3. Web 端（0.2.3-alpha.2）无回归：样式仍由宿主 `meta.stylesheets` 安装，自注入探测命中后跳过。

## 已知边界

- 0.2.3 上若宿主安装样式晚于模块物化，自注入会多插一份同内容样式（视觉无差异，仅多一次解析）。
- 围栏自身坏掉（不是 `this` 丢失）时仍然 503，但此时宿主日志里有原因行。

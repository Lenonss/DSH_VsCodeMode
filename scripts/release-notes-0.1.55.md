# v0.1.55 发布说明

> 新功能：编辑区 PDF 浏览与注释级编辑（借鉴开源 Mozilla pdf.js，Apache-2.0）。

## 功能：PDF 浏览

- 打开 `.pdf` 文件（资源管理器/QuickOpen/对话文件链接/手动输入路径）在编辑区页签内
  直接渲染：连续滚动 + 虚拟化渲染（大文档只渲染可见页）、◀▶ 翻页、−＋缩放
  （初始适配页宽）、文本选择复制
- 中文/未嵌字体 PDF：vendor `cmaps/` + `standard_fonts/`（pdfjs-dist@5.4.624，
  Apache-2.0，随包离线分发，经 `/edrv/vendor/pdfjs/*` 路由，与 Monaco 同模式）
- 加载失败（损坏/加密/超限）走既有 loadError 面板（重试可用）；base64 读取上限
  提升至 32MB（`BINARY_READ_CAP`，仅二进制分支；文本侧 READ_CAP 8MB 不变）

## 功能：PDF 注释级编辑

- 工具条三种内置注释编辑器（pdf.js AnnotationEditorLayer）：
  ✎ 文本框（FreeText）/ 🖌 画笔（Ink）/ 🖍 高亮（Highlight），☐ 选择退出编辑
- `Ctrl+S` 或 💾 保存：`pdfDocument.saveDocument()` 导出编辑后字节 → base64 →
  新 RPC `edrv.saveBinary` 回写原文件；脏状态上抛 tab 脏点，保存后自动归档该路径
  旧文本差异记录（superseded，防陈旧 diff 应用）
- **能力边界**：注释级编辑（浏览器开源方案不支持无损改写既有正文文字/页面增删，
  后续可评估 pdf-lib 扩展）；加密 PDF 暂不支持

## 安全与取舍

- `edrv.saveBinary` 最终落盘经 `node:fs writeFile`（DSH fs 服务仅有文本写
  writeText/editText）：以 `fs.contains` 工作区边界 + 32MB 解码上限 + 仅用户显式
  保存动作触发三重约束兜底（对齐 revert.ts deleteCreated 的 contains 用法）
- pdf.js 三份产物（pdf.mjs / pdf.worker.mjs / pdf_viewer.mjs）必须同版本，
  `scripts/vendor-pdfjs.mjs` 一次性铺齐并断言；升级：`node scripts/vendor-pdfjs.mjs [版本]`

## 其他

- `VENDOR_MIME` 新增 `.mjs` / `.bcmap` / `.pfb`；`.gitattributes` 补二进制标记
- 手动保存收尾（目录树失效 + supersede 归档）从 `edrv.save` 提取为 `afterManualSave`
  供两个 handler 复用
- 新增单测：`pdfPreview.test.ts`（判定/编解码往返）、`pdfSave.test.ts`（边界拒绝/
  超限拒绝/落盘参数/supersede）

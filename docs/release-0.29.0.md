# v0.29.0：Excel 引擎按需分块与编辑热路径优化

## 改进

- **Excel 引擎与编解码按需分块**：根包 `client.js` 不再内联 Univer / ExcelJS / fflate / saxes；
  打开表格时才加载 `client.excel.js`（引擎面板）与 `client.excelcodec.js`（解码/导出），
  不打开表格就不下载。`src/client/excel/ExcelHost.ts` 作为 React 边界负责加载与重试，
  `mountExcel.ts` 复用同一个引擎节点（切换文件不重建），`codecLoader.ts` 单例懒加载 codec，
  `lazyPanel.ts` 从「内置面板专用」扩展为通用 `loadChunk`。
- **构建侧防回内联**：`tsdown.config.ts` 新增 `excel` / `excelcodec` 两个 chunk entry，并对
  client 产物启用 `minify`（根包在首屏关键路径上，面板 chunk 按需下载）；
  `scripts/check-client-artifacts.mjs` 按 chunk 校验「消费的 `__lazyShared` 键 + 导出面」，
  并增加根包 3 MB 预算与引擎 chunk 下限，防止 Univer 被重新内联回入口。
- **调试 hover 树热路径**：MutationObserver 只处理本批次实际受影响的 hover（不再对每个新增行
  做全量查询），跳过 Monaco 展示层子树；提示文案相同不重复写 DOM（避免观察器被自身更新唤醒）；
  卸载时清空待处理队列。
- **侧栏拖拽**：宽度预览合并到 `requestAnimationFrame`，`pointerup` 时取最终宽度并只提交一次
  `onWidth`；拖动过程中不再触发 React 重渲染。
- **快捷菜单测量**：新增 `src/client/ui/quickMeasure.ts` 统一测量调度，合并 resize /
  ResizeObserver / 低频轮询，覆盖位置变化与宿主替换锚点，`dispose` 可完全撤销。
- **官方文件侧栏 CSS 兼容**：`src/client/filesCssCompat.ts` 在页面内给官方
  `FilesBody.module.css` 的已知选择器打运行时补丁（只限制右列目标、保留媒体查询与特异性，
  卸载时恢复），不修改已安装的官方包文件。
- **编辑器**：Excel 挂载节点 `.edrv-excel-host` 的尺寸样式移到根样式表，保证引擎 chunk
  加载前就有高度。

## 实现边界

- 不改 Host 路由、鉴权与差异审查数据层；本次改动集中在 client 包与构建/校验脚本。
- Excel 分块只改变加载时机与打包位置，编解码与导出行为不变；codec 内联的 Univer 枚举改为
  与 `@univerjs/core` 同值的字面量，避免把 Univer 运行时拉进 codec chunk。
- CSS 兼容补丁只作用于官方文件侧栏的已知类名选择器；官方包升级后选择器变化时补丁自然失效，
  不报错、不回退成覆盖样式。
- 未改 `@deepseek-ai/dsh-client-ui-sidebar-files` 安装包本身。

## 验证与已知缺口

- typecheck 0 error。
- 全量：303 个测试文件通过 + 2 跳过（305），**3852 通过 / 22 跳过**（26.68 s）；
  `node --test tests/nativeOpen.test.mjs` 9/9（11.9 s）。无 dapFakeAdapter 抖动。
- 构建：host `index.js` 1,093,961 B；根 `client.js` 930,057 B（v0.28.0 为 23,431,817 B）；
  `client.rules.js` 14,035 B；`client.debug.js` 18,149 B；`client.excel.js` 11,371,696 B；
  `client.excelcodec.js` 1,002,902 B。`check-client-artifacts` 全部通过
  （根包 ≤ 3 MB、引擎 chunk ≥ 3 MB）。
- Web 3080 真机冒烟（dev 链接部署）：打开 xlsx 后 Univer 面板渲染（canvas ×3、工具栏与
  单元格区域正常），侧栏拖拽宽度 452 → 560 px 并在 `pointerup` 提交，控制台无本插件新增错误
  （反复出现的 `host-bridge` 404 来自 dsh-notify-me，与本插件无关）。
- **已知缺口**：快捷菜单悬浮入口未在真机复测（当前页面默认未显示该入口）；调试 hover 树需要
  DAP 调试会话，本次未构造。两处改动均有单测覆盖（`tests/quickMeasure.test.ts`、
  `tests/dapHoverTree.test.ts`），但真实浏览器交互验收缺口保留。

## 回滚

可安装上一稳定版 0.28.0 并重启 DSH；公开版本与 tag 保持不可变，不覆盖发布历史。

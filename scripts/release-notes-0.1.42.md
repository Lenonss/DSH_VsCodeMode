# v0.1.42 发布说明

## 新增：语言服务器「重新检测」
- 保存配置后自动重新检测
- 切换启用状态后自动重新检测
- 语言卡片新增「重新检测」按钮
- 链路：清 provider 发现缓存 → 释放旧 server → 重扫 EmmyLua/LuaLS → 返回检测状态（不误启动）
- 当前已打开文档自动重新同步，无需重开文件

## 新增：EmmyLua provider 接入
- 自动识别 tangzx.emmylua-* 扩展 server/emmylua_ls.exe
- 优先级：手动 > EmmyLua > LuaLS > PATH
- 状态页显示实际 provider 与版本

## 新增：semantic tokens 语义分色
- host 按服务器 legend 归一化，Monaco 固定 legend
- 明暗双主题

## 修复
- 跳转路径不再把 Monaco edrv Uri 当磁盘路径（\edrv\ 泄漏）
- provider 发现缓存按 DSH home 隔离 + TTL + 目录指纹失效
- 扩展安装/卸载/更新后立即清缓存
- 修复 Linux CI 下 Windows URI 转换测试（v0.1.35 已修，延续）

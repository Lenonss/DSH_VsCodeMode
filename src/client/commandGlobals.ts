/**
 * dsh-vscode-mode client — 指令系统的全局挂点名约定。
 * 单独成模块：装配层（client/index.ts）与读取方（命令栏/第三方）都要用，
 * 放这里可避免 CommandPalette ↔ index 的循环依赖。
 *
 * ⚠️ 必须挂在 window 自身（双下划线 + edrv 前缀，与既有 __edrvExtPoll 同风格）。
 * 旧实现写 window.dsh.edrvCommands——DSH 从不创建 window.dsh 命名空间（全仓库无赋值），
 * 该路径恒为死代码并导致命令栏读到空表；不要再改回气泡式挂点。
 * 作者 ddj 2026年09月10号
 */

/** 指令注册表的全局挂点名：window[REGISTRY_GLOBAL]（第三方注册与调试读取；命令栏首选模块引用）。 */
export const REGISTRY_GLOBAL = '__edrvCommands__'

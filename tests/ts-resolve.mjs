/**
 * dsh-vscode-mode — node 原生测试解析钩子注册入口（--import 用）。
 * 钩子实现见 tests/ts-resolve-inner.mjs。作者 ddj
 */
import { register } from 'node:module'

register('./ts-resolve-inner.mjs', import.meta.url)

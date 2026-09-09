/**
 * dsh-vscode-mode — node 原生测试 .js→.ts 解析重映射钩子（仅导出 resolve）。
 * 注册入口见 tests/ts-resolve.mjs（node --import）。作者 ddj
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

/** 解析重映射：parentURL 同目录下 x.js 不存在而 x.ts 存在 → 改指 x.ts。 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && error?.code === 'ERR_MODULE_NOT_FOUND') {
      const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : undefined
      if (parentPath) {
        const candidate = join(dirname(parentPath), specifier.slice(0, -3) + '.ts')
        if (existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true }
        }
      }
    }
    throw error
  }
}

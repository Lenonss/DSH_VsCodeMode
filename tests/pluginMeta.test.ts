/**
 * 插件元数据（locale meta + 导出资源）可被 DSH 插件管理器读到。
 * DSH 的 app-boot 只读 <specifier>/locale/<lang>.json 里的 parsed.meta.title / parsed.meta.description，
 * 且只通过包导出（exports）解析该子路径；任一环节缺失就静默回落到 package.json 的 name/description。
 * @author ddj 2026年10月19号
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 从包根解析子路径，模拟 DSH 以 profile 为解析根的 import 行为。 */
const requireFromRoot = createRequire(join(root, 'package.json'))

/** 读取并解析 locale 词典。 */
function readLocale(lang: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, 'locale', lang + '.json'), 'utf8')) as Record<string, unknown>
}

describe('locale 词典结构', () => {
  for (const lang of ['en', 'zh']) {
    describe(lang, () => {
      it('把标题与描述放在 meta 下（DSH 只读 parsed.meta）', () => {
        const dict = readLocale(lang)
        const meta = dict.meta as Record<string, unknown> | undefined
        expect(meta, 'locale/' + lang + '.json 缺少 meta 包裹').toBeTypeOf('object')
        expect(typeof meta?.title).toBe('string')
        expect(typeof meta?.description).toBe('string')
      })

      it('标题与描述非空', () => {
        const meta = readLocale(lang).meta as Record<string, string>
        expect(meta.title.trim().length).toBeGreaterThan(0)
        expect(meta.description.trim().length).toBeGreaterThan(0)
      })

      it('不再残留顶层 title/description（旧格式已废弃）', () => {
        const dict = readLocale(lang)
        expect(dict.title).toBeUndefined()
        expect(dict.description).toBeUndefined()
      })
    })
  }

  it('中英两版标题一致、描述各不相同', () => {
    const en = readLocale('en').meta as Record<string, string>
    const zh = readLocale('zh').meta as Record<string, string>
    expect(en.title).toBe(zh.title)
    expect(en.description).not.toBe(zh.description)
  })
})

describe('locale 子路径可被导出解析', () => {
  for (const lang of ['en', 'zh']) {
    it('解析 <pkg>/locale/' + lang + '.json 不抛 ERR_PACKAGE_PATH_NOT_EXPORTED', () => {
      expect(() => requireFromRoot.resolve('dsh-vscode-mode/locale/' + lang + '.json')).not.toThrow()
    })
  }

  it('解析结果落在本包 locale 目录内', () => {
    const resolved = requireFromRoot.resolve('dsh-vscode-mode/locale/en.json')
    expect(resolved.startsWith(join(root, 'locale'))).toBe(true)
  })
})

describe('包导出与 files 覆盖元数据资源', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    exports?: Record<string, string>
    files?: string[]
    icon?: string
  }

  it('exports 含 locale 通配子路径', () => {
    expect(pkg.exports?.['./locale/*.json']).toBe('./locale/*.json')
  })

  it('files 含 locale 目录与 icon 资产目录', () => {
    expect(pkg.files).toContain('locale')
    expect(pkg.files).toContain('assets')
  })

  it('icon 指向包内相对路径', () => {
    expect(pkg.icon).toBe('assets/icon.svg')
    expect(pkg.icon?.startsWith('/')).toBe(false)
    expect(pkg.icon).not.toContain('://')
  })
})

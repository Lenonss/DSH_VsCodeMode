/**
 * client localeClient.ts 测试：壳层词典完整性、服务探测的三种降级路径、thunk 读时解析。
 * @author ddj 2026年10月19号
 */
import { describe, expect, it } from 'vitest'
import { LOCALE_DICTS, LOCALE_FALLBACK, LOCALE_NS, directTranslate, installLocale } from '../src/client/localeClient.js'

/** 造只提供 get 的最小上下文。 */
function makeCtx(services: Record<string, unknown> = {}): { get(name: string): unknown } {
  return { get: (name: string) => services[name] }
}

describe('localeClient 词典', () => {
  it('中英词典键集合一致（缺译会暴露为键名，先在此拦截）', () => {
    const zhKeys = Object.keys(LOCALE_DICTS.zh ?? {}).sort()
    const enKeys = Object.keys(LOCALE_DICTS.en ?? {}).sort()
    expect(enKeys).toEqual(zhKeys)
    expect(zhKeys.length).toBeGreaterThan(0)
  })

  it('词典不含空值', () => {
    for (const [lang, dict] of Object.entries(LOCALE_DICTS)) {
      for (const [key, text] of Object.entries(dict)) {
        expect(text.trim(), `${lang}.${key}`).not.toBe('')
      }
    }
  })

  it('中文为缺省回退语言', () => {
    expect(LOCALE_FALLBACK).toBe('zh')
    expect(directTranslate()('slot.fileEditor')).toBe(LOCALE_DICTS.zh!['slot.fileEditor'])
  })

  it('未知语言回退中文，未知键回退键本身', () => {
    expect(directTranslate('ja')('slot.diff')).toBe(LOCALE_DICTS.zh!['slot.diff'])
    expect(directTranslate('en')('no.such.key')).toBe('no.such.key')
  })
})

describe('installLocale 服务探测', () => {
  it('服务可用时注册词典并返回 bind 的翻译函数', () => {
    const registered: Array<{ ns: string; dicts: unknown }> = []
    const ctx = makeCtx({
      locale: {
        register: (ns: string, dicts: unknown) => {
          registered.push({ ns, dicts })
          return () => {}
        },
        bind: (ns: string) => (key: string) => `${ns}:${key}`,
      },
    })

    const t = installLocale(ctx)

    expect(registered).toHaveLength(1)
    expect(registered[0].ns).toBe(LOCALE_NS)
    expect(registered[0].dicts).toBe(LOCALE_DICTS)
    expect(t('slot.diff')).toBe(`${LOCALE_NS}:slot.diff`)
  })

  it('服务缺失时回落直读中文词典', () => {
    const t = installLocale(makeCtx())
    expect(t('slot.settings')).toBe(LOCALE_DICTS.zh!['slot.settings'])
  })

  it('register 抛错不影响 bind 生效', () => {
    const ctx = makeCtx({
      locale: {
        register: () => {
          throw new Error('already has locale')
        },
        bind: () => (key: string) => `B:${key}`,
      },
    })

    expect(installLocale(ctx)('slot.diff')).toBe('B:slot.diff')
  })

  it('bind 抛错时回落直读词典，不向上传播', () => {
    const ctx = makeCtx({
      locale: {
        register: () => () => {},
        bind: () => {
          throw new Error('bind boom')
        },
      },
    })

    expect(() => installLocale(ctx)).not.toThrow()
    expect(installLocale(ctx)('slot.diff')).toBe(LOCALE_DICTS.zh!['slot.diff'])
  })

  it('ctx.get 本身抛错时也回落直读词典', () => {
    const ctx = {
      get: () => {
        throw new Error('service unavailable')
      },
    }
    expect(installLocale(ctx)('guide.title')).toBe(LOCALE_DICTS.zh!['guide.title'])
  })

  it('返回的翻译函数每次都重新问 bind（支持语言热切换）', () => {
    let lang = 'zh'
    const ctx = makeCtx({
      locale: {
        register: () => () => {},
        bind: () => (key: string) => `${lang}:${key}`,
      },
    })
    const t = installLocale(ctx)
    expect(t('slot.diff')).toBe('zh:slot.diff')

    lang = 'en'
    expect(t('slot.diff')).toBe('en:slot.diff')
  })
})

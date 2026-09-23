/**
 * imagePreview 纯函数单测：扩展名判定（isImagePath/isSvgPath）、data URL 组装，
 * 与图片缩放纯逻辑（clampZoom/zoomStepOf/页签记忆键）。
 * 断言全部使用字符串字面量，不依赖 path.join（CI ubuntu 平台陷阱，见 dsh-vscode-mode-dev 技能）。
 * @author ddj 2026年09月08号 / 2026年09月22号
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  clampZoom,
  clearZoomMem,
  dataUrlOf,
  isImagePath,
  isSvgPath,
  recallZoom,
  rememberZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  zoomKeyOf,
  zoomStepOf,
} from '../src/client/imagePreview.js'
import { imageMimeOf } from '../src/shared/rpc.js'

describe('isImagePath', () => {
  it('accepts common raster extensions', () => {
    expect(isImagePath('assets/ui/logo.png')).toBe(true)
    expect(isImagePath('assets/ui/photo.JPG')).toBe(true)
    expect(isImagePath('sprite.JPEG')).toBe(true)
    expect(isImagePath('anim.gif')).toBe(true)
    expect(isImagePath('bg.webp')).toBe(true)
    expect(isImagePath('tex.bmp')).toBe(true)
    expect(isImagePath('fav.ico')).toBe(true)
    expect(isImagePath('hero.avif')).toBe(true)
  })

  it('accepts svg and both separators', () => {
    expect(isImagePath('assets/icons/close.svg')).toBe(true)
    expect(isImagePath('C:\\proj\\assets\\logo.PNG')).toBe(true)
  })

  it('rejects non-image and extensionless paths', () => {
    expect(isImagePath('src/main.ts')).toBe(false)
    expect(isImagePath('README.md')).toBe(false)
    expect(isImagePath('png')).toBe(false)
    expect(isImagePath('.png')).toBe(false)
    expect(isImagePath('')).toBe(false)
    expect(isImagePath('archive.png.bak')).toBe(false)
  })
})

describe('isSvgPath', () => {
  it('accepts svg in any case', () => {
    expect(isSvgPath('icons/star.SVG')).toBe(true)
    expect(isSvgPath('icons/star.svg')).toBe(true)
  })

  it('rejects other images and non-images', () => {
    expect(isSvgPath('assets/logo.png')).toBe(false)
    expect(isSvgPath('src/main.ts')).toBe(false)
    expect(isSvgPath('svg')).toBe(false)
  })
})

describe('imageMimeOf', () => {
  it('maps extensions to mime types', () => {
    expect(imageMimeOf('a/b/shot.png')).toBe('image/png')
    expect(imageMimeOf('a\\b\\shot.jpg')).toBe('image/jpeg')
    expect(imageMimeOf('vector.SVG')).toBe('image/svg+xml')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(imageMimeOf('data.bin')).toBe('application/octet-stream')
    expect(imageMimeOf('')).toBe('application/octet-stream')
  })
})

describe('dataUrlOf', () => {
  it('prefixes mime and base64 payload', () => {
    expect(dataUrlOf('aGVsbG8=', 'image/png')).toBe('data:image/png;base64,aGVsbG8=')
  })

  it('falls back to octet-stream without mime', () => {
    expect(dataUrlOf('aGVsbG8=', '')).toBe('data:application/octet-stream;base64,aGVsbG8=')
  })
})

describe('zoom constants', () => {
  it('pins step and clamp bounds (10%/档, 25%–400%)', () => {
    expect(ZOOM_STEP).toBe(0.1)
    expect(ZOOM_MIN).toBe(0.25)
    expect(ZOOM_MAX).toBe(4)
  })
})

describe('clampZoom', () => {
  it('clamps below-min and above-max values', () => {
    expect(clampZoom(0.1)).toBe(0.25)
    expect(clampZoom(99)).toBe(4)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  it('rounds float noise to whole percents', () => {
    expect(clampZoom(1.2000000000000002)).toBe(1.2)
    expect(clampZoom(0.26999999999999996)).toBe(0.27)
  })

  it('treats non-finite input as 100%', () => {
    expect(clampZoom(Number.NaN)).toBe(1)
    expect(clampZoom(Infinity)).toBe(1)
  })
})

describe('zoomStepOf', () => {
  it('steps up and down by ZOOM_STEP', () => {
    expect(zoomStepOf(1, 1)).toBe(1.1)
    expect(zoomStepOf(1, -1)).toBe(0.9)
  })

  it('clamps at 400% and 25%', () => {
    expect(zoomStepOf(ZOOM_MAX, 1)).toBe(4)
    expect(zoomStepOf(ZOOM_MIN, -1)).toBe(0.25)
  })

  it('keeps repeated steps exact (no float drift)', () => {
    expect(zoomStepOf(zoomStepOf(1, 1), 1)).toBe(1.2)
  })
})

describe('zoom memory (会话+路径)', () => {
  afterEach(() => clearZoomMem())

  it('builds a key that separates session and path without collisions', () => {
    expect(zoomKeyOf('s1', 'a.png')).toBe(zoomKeyOf('s1', 'a.png'))
    expect(zoomKeyOf('s1', 'a.png')).not.toBe(zoomKeyOf('s2', 'a.png'))
    expect(zoomKeyOf('s1', 'a.png')).not.toBe(zoomKeyOf('s1', 'b.png'))
    // NUL 分隔防撞：朴素 "::" 拼接下 ('s1', 's1::b') 与 ('s1::s1', 'b') 会同键
    expect(zoomKeyOf('s1', 's1::b')).not.toBe(zoomKeyOf('s1::s1', 'b'))
  })

  it('roundtrips explicit zoom and fit (null)', () => {
    const key = zoomKeyOf('s1', 'a.png')
    expect(recallZoom(key)).toBe(null) // 无记忆 = 初始适应宽度
    rememberZoom(key, 1.5)
    expect(recallZoom(key)).toBe(1.5)
    rememberZoom(key, null) // 用户点「适应宽度」
    expect(recallZoom(key)).toBe(null)
  })

  it('clearZoomMem empties every remembered tab', () => {
    rememberZoom(zoomKeyOf('s1', 'a.png'), 2)
    clearZoomMem()
    expect(recallZoom(zoomKeyOf('s1', 'a.png'))).toBe(null)
  })
})

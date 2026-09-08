/**
 * imagePreview 纯函数单测：扩展名判定（isImagePath/isSvgPath）与 data URL 组装。
 * 断言全部使用字符串字面量，不依赖 path.join（CI ubuntu 平台陷阱，见 dsh-vscode-mode-dev 技能）。
 * @author ddj 2026年09月08号
 */
import { describe, expect, it } from 'vitest'
import { dataUrlOf, isImagePath, isSvgPath } from '../src/client/imagePreview.js'
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

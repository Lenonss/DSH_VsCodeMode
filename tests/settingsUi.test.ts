import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingRow, SettingNotice } from '../src/client/ui/SettingsUi.js'

describe('settings presentation', () => {
  it('associates labels and descriptions while preserving existing help', () => {
    const markup = renderToStaticMarkup(React.createElement(SettingRow, {
      label: '页签数量上限', description: '0 表示不限制',
      children: React.createElement('input', { type: 'number', min: 0, disabled: true, 'aria-describedby': 'existing-help' }),
    }))
    const fieldId = markup.match(/<label for="([^"]+)"/)?.[1]
    expect(fieldId).toBeTruthy()
    expect(markup).toContain('id="' + fieldId + '"')
    expect(markup).toContain('aria-describedby="existing-help ' + fieldId + '-help"')
    expect(markup).toContain('id="' + fieldId + '-help"')
    expect(markup).toContain('disabled=""')
    expect(markup).toContain('min="0"')
  })
  it('uses distinct ids for multiple settings without requiring help', () => {
    const markup = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(SettingRow, { label: 'A', children: React.createElement('input') }),
      React.createElement(SettingRow, { label: 'B', children: React.createElement('input') })))
    const ids = [...markup.matchAll(/<label for="([^"]+)"/g)].map(match => match[1])
    expect(new Set(ids).size).toBe(2)
    expect(markup).not.toContain('aria-describedby')
  })
  it('announces success, errors and empty results appropriately', () => {
    expect(renderToStaticMarkup(React.createElement(SettingNotice, { message: '已保存' }))).toContain('role="status"')
    expect(renderToStaticMarkup(React.createElement(SettingNotice, { message: '保存失败', error: true }))).toContain('role="alert"')
    expect(renderToStaticMarkup(React.createElement(SettingNotice, { message: '' }))).toBe('')
  })
})

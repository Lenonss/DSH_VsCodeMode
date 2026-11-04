/** Official parser adapter target boundaries. @author ddj 2026年11月04号 */
import { describe, it, expect } from 'vitest'
import { toolTargets } from '../src/toolTargets.js'

describe('toolTargets', () => {
  it('retains legacy write aliases', async () => {
    expect(await toolTargets({ name: 'edit', arguments: { file_path: 'a' } })).toEqual(['a'])
    expect(await toolTargets({ name: 'read', arguments: { path: 'a' } })).toEqual([])
  })
  it('deduplicates all source and move destinations without interpreting result nulls', async () => {
    const parser = () => [{ path: 'a', moveTo: 'b' }, { path: 'b' }, { path: 'c' }]
    expect(await toolTargets({ name: 'apply_patch', arguments: { input: 'patch' } }, parser)).toEqual(['a', 'b', 'c'])
  })
  it('fails closed when parser or input is unavailable', async () => {
    await expect(toolTargets({ name: 'apply_patch', arguments: { input: 'patch' } }, null)).rejects.toThrow('parser unavailable')
    await expect(toolTargets({ name: 'apply_patch' }, () => [])).rejects.toThrow('input unavailable')
  })
})

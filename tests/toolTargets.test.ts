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
  it('maps dsh-ops single-target writes onto arguments.path', async () => {
    for (const name of ['ops_edit_file', 'ops_write_file', 'ops_remove']) {
      expect(await toolTargets({ name, arguments: { path: 'a' } })).toEqual(['a'])
    }
  })
  it('returns both dsh-ops source and destination without duplicates', async () => {
    expect(await toolTargets({ name: 'ops_move', arguments: { path: 'a', to: 'b' } })).toEqual(['a', 'b'])
    expect(await toolTargets({ name: 'ops_copy', arguments: { path: 'a', to: 'a' } })).toEqual(['a'])
    expect(await toolTargets({ name: 'ops_move', arguments: { path: 'a' } })).toEqual(['a'])
  })
  it('leaves undeclared ops tools without targets', async () => {
    expect(await toolTargets({ name: 'ops_replace', arguments: { path: '.', pattern: 'a' } })).toEqual([])
    expect(await toolTargets({ name: 'ops_bash', arguments: { path: 'a' } })).toEqual([])
    expect(await toolTargets({ name: 'ops_write_image', arguments: { path: 'a' } })).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { shellInstallDir, shellMenuLifecycle } from '../src/integrate.js'
import type { Ctx } from '../src/store.js'

const fixture = vi.hoisted(() => ({ home: '' }))
vi.mock('../src/paths.js', async (original) => ({ ...await original<typeof import('../src/paths.js')>(), dshHome: () => fixture.home }))
vi.mock('../src/openInbox.js', async (original) => ({ ...await original<typeof import('../src/openInbox.js')>(), ensureOpenInbox: async (profile: string) => join(profile, 'inbox') }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, copyFile: async (_source: string, target: string) => fs.writeFile(target, 'launcher fixture') }
})

let profile = ''
let dispose: (() => void) | undefined
const commands: string[][] = []

beforeEach(async () => {
  fixture.home = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.open-migration-'))
  profile = join(fixture.home, 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await mkdir(shellInstallDir(), { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-vscode-mode': '^0.13.0' } }))
  commands.length = 0
})
afterEach(async () => { dispose?.(); dispose = undefined; await rm(fixture.home, { recursive: true, force: true }) })

/** @private @author ddj 2026年09月28号
 * Simulate only compiler output while recording every requested subprocess.
 * @returns Host fixture; no registry or native process is executed.
 */
function migrationCtx(): Ctx {
  return { get(name: string) {
    if (name === 'profileContext') return { dir: profile, name: 'desktop' }
    if (name !== 'subprocess') return undefined
    return { spawn(options: { argv: string[] }) {
      commands.push(options.argv)
      const output = options.argv.find((arg) => arg.startsWith('/out:'))?.slice(5)
      return { done: output ? writeFile(output, 'compiled fixture').then(() => ({ exitCode: 0 })) : Promise.resolve({ exitCode: 0 }) }
    } }
  } } as unknown as Ctx
}

describe('registered launcher migration lifecycle', () => {
  it('upgrades assets and preserves INI base without re-registering or deleting OS menus', async () => {
    const dir = shellInstallDir()
    await writeFile(join(dir, 'registered.json'), JSON.stringify({ baseUrl: 'http://localhost:3080', at: '' }))
    await writeFile(join(dir, 'dsh-open.ini'), '[dsh]\nbase=http://localhost:4567\n')
    dispose = shellMenuLifecycle(migrationCtx())
    await vi.waitFor(async () => {
      const marker = JSON.parse(await readFile(join(dir, 'registered.json'), 'utf8'))
      expect(marker.transport).toBe(1)
    })
    const config = await readFile(join(dir, 'dsh-open.ini'), 'utf8')
    expect(config).toContain('base=http://localhost:4567')
    expect(config).toContain('profile=' + profile)
    expect(config).toContain('helper=')
    expect(config).not.toMatch(/cookie|token|secret/i)
    dispose()
    expect(commands.some((argv) => /reg\.exe$/i.test(argv[0]))).toBe(false)
  })

  it('does not recreate explicitly removed registration', async () => {
    dispose = shellMenuLifecycle(migrationCtx())
    await new Promise((resolve) => setTimeout(resolve, 30))
    await expect(readFile(join(shellInstallDir(), 'dsh-open.ini'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(commands).toEqual([])
  })

  it('does not change the profile already chosen by a different registration', async () => {
    const dir = shellInstallDir()
    await writeFile(join(dir, 'registered.json'), JSON.stringify({ baseUrl: 'http://localhost:4567', profile: '/other-profile', transport: 1 }))
    await writeFile(join(dir, 'dsh-open.ini'), '[dsh]\nprofile=/other-profile\n')
    dispose = shellMenuLifecycle(migrationCtx())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await readFile(join(dir, 'dsh-open.ini'), 'utf8')).toBe('[dsh]\nprofile=/other-profile\n')
    expect(commands).toEqual([])
  })
})

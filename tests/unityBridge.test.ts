/**
 * host unityBridge.ts 测试：纯函数 + tmp 目录端到端（安装/更新/拒绝分支/登记清单）。
 * 包源与 home 均用 fixture 注入，不触碰真实 ~/.dsh 与真实 Unity 项目。
 * 作者 ddj 2026-09-07
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isUnityProject,
  normalizeUnityRoot,
  readPackageVersion,
  unityAdd,
  unityEntryOf,
  unityInstall,
  unityList,
  unityProjectsFile,
  unityRemove,
  unitySourceDir,
  unityTargetOf,
} from '../src/unityBridge.js'
import { UNITY_PACKAGE_NAME } from '../src/shared/integration.js'

/** 活动临时根（每个用例独立，afterEach 清理）。 */
let root: string | null = null

async function tempRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'edrv-unity-'))
  return root
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

/** 造一个假包源：<base>/unity/com.dsh.editor（moduleUrl 指向 <base>/lib/index.js）。 */
async function makeSource(base: string, version: string): Promise<string> {
  const source = join(base, 'unity', UNITY_PACKAGE_NAME)
  await mkdir(join(source, 'Editor'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: UNITY_PACKAGE_NAME, version }), 'utf8')
  await writeFile(join(source, 'Editor', 'DshCodeEditor.cs'), '// source', 'utf8')
  return pathToFileURL(join(base, 'lib', 'index.js')).href
}

/** 造一个 Unity 项目根：<base>/proj（Assets + ProjectSettings + Packages）。 */
async function makeProject(base: string): Promise<string> {
  const project = join(base, 'proj')
  await mkdir(join(project, 'Assets'), { recursive: true })
  await mkdir(join(project, 'ProjectSettings'), { recursive: true })
  await mkdir(join(project, 'Packages'), { recursive: true })
  return project
}

describe('纯函数', () => {
  it('normalizeUnityRoot 去引号/空白/尾部分隔符', () => {
    expect(normalizeUnityRoot('  "D:\\Work\\PopIsland\\" ')).toBe('D:\\Work\\PopIsland')
    expect(normalizeUnityRoot('/home/u/proj/')).toBe('/home/u/proj')
    expect(normalizeUnityRoot('')).toBe('')
  })

  it('isUnityProject 要求 Assets + ProjectSettings 同时存在', () => {
    expect(isUnityProject(['Assets', 'ProjectSettings', 'Packages'])).toBe(true)
    expect(isUnityProject(['Assets'])).toBe(false)
    expect(isUnityProject([])).toBe(false)
  })

  it('unityTargetOf 固定到 Packages/com.dsh.editor；unitySourceDir 按 moduleUrl 推导（分隔符归一后断言）', () => {
    const slash = (p: string): string => p.replace(/\\/g, '/')
    expect(slash(unityTargetOf('D:\\Work\\PopIsland'))).toBe('D:/Work/PopIsland/Packages/com.dsh.editor')
    const moduleUrl = pathToFileURL('C:\\x\\y\\lib\\index.js').href
    expect(slash(unitySourceDir(moduleUrl))).toBe('C:/x/y/unity/com.dsh.editor')
    expect(slash(unityProjectsFile('C:\\home\\.dsh'))).toBe('C:/home/.dsh/dsh-vscode-mode/unity-projects.json')
  })

  it('readPackageVersion 缺失/非法 → null', async () => {
    const base = await tempRoot()
    expect(await readPackageVersion(join(base, 'missing.json'))).toBeNull()
    await writeFile(join(base, 'bad.json'), 'not json', 'utf8')
    expect(await readPackageVersion(join(base, 'bad.json'))).toBeNull()
  })
})

describe('unityInstall（tmp 端到端）', () => {
  it('一键安装：复制包源到 Packages/，entry 显示已安装', async () => {
    const base = await tempRoot()
    const moduleUrl = await makeSource(base, '0.2.0')
    const project = await makeProject(base)
    const entry = await unityInstall(project, moduleUrl)
    expect(entry.installedVersion).toBe('0.2.0')
    expect(entry.upToDate).toBe(true)
    expect(entry.error).toBeUndefined()
    const copied = JSON.parse(await readFile(unityTargetOf(project) + '/package.json', 'utf8'))
    expect(copied.version).toBe('0.2.0')
  })

  it('一键更新：包源升版后整目录替换', async () => {
    const base = await tempRoot()
    const moduleUrl = await makeSource(base, '0.2.0')
    const project = await makeProject(base)
    await unityInstall(project, moduleUrl)
    await writeFile(join(base, 'unity', UNITY_PACKAGE_NAME, 'package.json'), JSON.stringify({ name: UNITY_PACKAGE_NAME, version: '0.3.0' }), 'utf8')
    const stale = await unityEntryOf(project, moduleUrl)
    expect(stale.upToDate).toBe(false)
    await unityInstall(project, moduleUrl)
    expect(await readPackageVersion(unityTargetOf(project) + '/package.json')).toBe('0.3.0')
    expect((await unityEntryOf(project, moduleUrl)).upToDate).toBe(true)
  })

  it('拒绝：目标已存在同名目录但不是 DSH 包', async () => {
    const base = await tempRoot()
    const moduleUrl = await makeSource(base, '0.2.0')
    const project = await makeProject(base)
    const target = unityTargetOf(project)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'package.json'), JSON.stringify({ name: 'com.other.thing', version: '1.0.0' }), 'utf8')
    await expect(unityInstall(project, moduleUrl)).rejects.toThrow('不是 DSH 包')
  })

  it('拒绝：非 Unity 项目根 / 目录不存在', async () => {
    const base = await tempRoot()
    const moduleUrl = await makeSource(base, '0.2.0')
    const notUnity = join(base, 'plain')
    await mkdir(notUnity, { recursive: true })
    await expect(unityInstall(notUnity, moduleUrl)).rejects.toThrow('不是 Unity 项目根')
    await expect(unityInstall(join(base, 'nope'), moduleUrl)).rejects.toThrow('目录不存在')
    const entry = await unityEntryOf(join(base, 'nope'), moduleUrl)
    expect(entry.missingDir).toBe(true)
  })
})

describe('登记清单（home 注入）', () => {
  it('add → list → remove 全流程，重复登记幂等', async () => {
    const base = await tempRoot()
    const moduleUrl = await makeSource(base, '0.2.0')
    const project = await makeProject(base)
    const home = join(base, 'home')
    await unityAdd(project, moduleUrl, home)
    await unityAdd(project + '/', moduleUrl, home) // 尾分隔符归一化后幂等
    const listed = await unityList(moduleUrl, home)
    expect(listed.projects).toHaveLength(1)
    expect(listed.projects[0].path).toBe(project)
    expect(listed.sourceVersion).toBe('0.2.0')
    await unityRemove(project, home)
    expect((await unityList(moduleUrl, home)).projects).toHaveLength(0)
    expect(await readPackageVersion(unityTargetOf(project) + '/package.json')).toBeNull() // 登记移除不删包目录
  })

  it('add 拒绝非 Unity 目录且不写入清单', async () => {
    const base = await tempRoot()
    const moduleUrl = await makeSource(base, '0.2.0')
    const home = join(base, 'home')
    const plain = join(base, 'plain')
    await mkdir(plain, { recursive: true })
    await expect(unityAdd(plain, moduleUrl, home)).rejects.toThrow('不是 Unity 项目根')
    expect((await unityList(moduleUrl, home)).projects).toHaveLength(0)
  })
})

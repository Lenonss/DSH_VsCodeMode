/** 调试配置文件解析测试（全量配置 + raw 透传 + 变量替换 + 路径常量）。作者 ddj 2026年09月29号 / 2026年09月21号 / 2026年09月22号 */
import { describe, expect, it } from 'vitest'
import { hasCmdPlaceholder, parseLaunchConfigs, stripJsonc } from '../src/dap/launchConfig.js'
import { DAP_LAUNCH_REL, DAP_LEGACY_LAUNCH_REL } from '../src/shared/dap.js'

const LAUNCH_JSONC = `{
  // VS Code 调试配置
  "version": "0.2.0",
  "configurations": [
    {
      "type": "emmylua_attach", // 注入附加
      "request": "attach",
      "name": "通过进程ID附加",
      "pid": 0,
      "processName": "IslandSplash_BugFix2",
      "captureLog": true,
    },
    {
      "name": "Launch .NET",
      "type": "coreclr",
      "request": "launch",
      "program": "\${workspaceFolder}/bin/App.dll",
      "cwd": "\${workspaceFolder}",
      "justMyCode": false,
    },
    {
      "name": "Attach with command",
      "type": "coreclr",
      "request": "attach",
      "processId": "\${command:dotrush.pickProcess}"
    }
  ]
}`

describe('stripJsonc', () => {
  it('去掉行注释', () => {
    expect(JSON.parse(stripJsonc('{\n// c\n"a": 1}'))).toEqual({ a: 1 })
  })

  it('去掉块注释', () => {
    expect(JSON.parse(stripJsonc('{ /* c */ "a": 1 }'))).toEqual({ a: 1 })
  })

  it('字符串内的注释符保留', () => {
    expect(JSON.parse(stripJsonc('{"a": "http://x/*y*/"}'))).toEqual({ a: 'http://x/*y*/' })
  })

  it('去掉尾逗号', () => {
    expect(JSON.parse(stripJsonc('{"a": [1,2,]}'))).toEqual({ a: [1, 2] })
  })
})

describe('parseLaunchConfigs', () => {
  it('全量保留配置（不再限定 emmylua）并携带已知字段', () => {
    const configs = parseLaunchConfigs(LAUNCH_JSONC)
    expect(configs).toHaveLength(3)
    expect(configs[0]).toMatchObject({
      name: '通过进程ID附加',
      type: 'emmylua_attach',
      request: 'attach',
      processName: 'IslandSplash_BugFix2',
      captureLog: true,
    })
    expect(configs[0].pid).toBeUndefined()
    expect(configs[1]).toMatchObject({ type: 'coreclr', request: 'launch' })
  })

  it('raw 原样透传未识别字段并替换 ${workspaceFolder}', () => {
    const configs = parseLaunchConfigs(LAUNCH_JSONC, 'D:/ws')
    expect(configs[1].raw).toMatchObject({
      program: 'D:/ws/bin/App.dll',
      cwd: 'D:/ws',
      justMyCode: false,
    })
    // 已知字段也在 raw 中（attach/launch 参数整体透传，对齐 VS Code）
    expect(configs[1].raw).toMatchObject({ type: 'coreclr', name: 'Launch .NET' })
  })

  it('${command:...} 占位被检出（本插件不可解析）', () => {
    const configs = parseLaunchConfigs(LAUNCH_JSONC, 'D:/ws')
    expect(hasCmdPlaceholder(configs[1])).toBe(false)
    expect(hasCmdPlaceholder(configs[2])).toBe(true)
    expect(hasCmdPlaceholder(configs[0])).toBe(false)
  })

  it('缺工作区根时不替换变量（保留原样）', () => {
    const configs = parseLaunchConfigs(LAUNCH_JSONC)
    expect(configs[1].raw).toMatchObject({ program: '${workspaceFolder}/bin/App.dll' })
  })

  it('非法 JSON 返回空表', () => {
    expect(parseLaunchConfigs('not json {{')).toEqual([])
  })

  it('无 configurations 返回空表', () => {
    expect(parseLaunchConfigs('{"version":"0.2.0"}')).toEqual([])
  })

  it('缺 name/type 的条目跳过', () => {
    const configs = parseLaunchConfigs('{"configurations":[{"type":"x"},{"name":"y"},{"type":"z","name":"ok"}]}')
    expect(configs).toHaveLength(1)
    expect(configs[0]).toMatchObject({ type: 'z', name: 'ok' })
  })
})

describe('配置路径常量（独立后防漂移）', () => {
  it('插件专属路径与 VS Code 旧共用路径分离', () => {
    expect(DAP_LAUNCH_REL).toBe('.dsh/launch.json')
    expect(DAP_LEGACY_LAUNCH_REL).toBe('.vscode/launch.json')
    expect(DAP_LAUNCH_REL).not.toBe(DAP_LEGACY_LAUNCH_REL)
  })
})

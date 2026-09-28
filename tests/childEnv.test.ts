/** 子进程环境边界回归。作者 ddj 2026年09月28号。 */
import { describe, expect, it } from 'vitest'
import { childEnv } from '../src/childEnv.js'

describe('childEnv', () => {
  it('scrubs implicit credentials and DSH facts case-insensitively', () => {
    const parent = { PATH: '/bin', HOME: '/home/test', LANG: 'en_US', HTTP_PROXY: 'http://localhost', DEEPSEEK_API_KEY: 'host', github_token: 'secret', DbPassword: 'secret', dsh_HOME: '/private', DSH_SESSION_ID: 'id', ELECTRON_RUN_AS_NODE: '1' }
    expect(childEnv({}, parent)).toEqual({ PATH: '/bin', HOME: '/home/test', LANG: 'en_US', HTTP_PROXY: 'http://localhost', ELECTRON_RUN_AS_NODE: '1' })
    expect(parent.DEEPSEEK_API_KEY).toBe('host')
  })
  it('keeps intentionally configured secrets and removes explicit undefined entries', () => {
    expect(childEnv({ API_TOKEN: 'configured', DSH_HOME: '/chosen', PATH: undefined }, { API_TOKEN: 'host', PATH: '/bin' }))
      .toEqual({ API_TOKEN: 'configured', DSH_HOME: '/chosen', PATH: undefined })
  })
})

/** 外部进程环境：参照官方 dsh-subprocess.scrubbedParentEnv。 */
const SENSITIVE_ENV = /KEY|PASSWORD|SECRET|TOKEN/i

/**
 * 清理父进程隐式凭据及 DSH 身份，再合并用户显式配置；保留 Electron Node 模式。
 * @public
 * @author ddj 2026年09月28号
 * @param explicit 用户显式配置的环境变量，可有意传递凭据
 * @param parent 父环境，默认当前进程；测试可注入
 * @returns 新环境对象，不修改任何输入
 */
export function childEnv(explicit: NodeJS.ProcessEnv = {}, parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || SENSITIVE_ENV.test(key) || key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return { ...env, ...explicit }
}

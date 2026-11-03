/**
 * 远程访问通道适配：插件内部路径 → 远程传输可达路径。
 *
 * 背景：宿主 connection 插件对 Host 不是 loopback / bind 地址 / trustedHosts 的请求一律回 403
 * （Host 围栏先于任何 cookie 校验），因此 /edrv/rpc 与 /edrv/vendor/** 在局域网 IP 或隧道域名
 * 页面上必然被拒。第三方远程访问插件（@linxin666/dsh-remote-web-ui）提供 /remote/<内部路径>
 * 的 catch-all 代理：校验配对设备后回环重发到本进程，本插件自身的准入照旧执行。
 *
 * 该插件在 <head> 首部内联一段 classic script（解析期同步执行，早于任何 module script），并在
 * window 上安装 seat 对象作为「本页已接入通道」的唯一标记。本模块据此选前缀：
 * 有标记 ⇒ '/remote' + 原路径；无标记 ⇒ 原路径（本机、桌面 dsh-app:、未装该插件均不受影响）。
 * 只决定 URL 前缀，不读取、不写入、不转发任何 cookie 或凭据。
 *
 * Purity rule: no node/react imports（与 appUrl.ts 一致）。
 * @author ddj 2026年11月02号
 */
import { appUrl } from './appUrl.js'

/** 远程访问插件在解析期安装的通道 seat 全局名（其 REMOTE_CHANNEL_BOOT_GLOBAL）。 */
export const CHANNEL_SEAT = '__DSH_REMOTE_CHANNEL_BOOT__'

/** 远程访问插件接管的前缀：/remote/<内部路径> 由服务端回环转发。 */
export const CHANNEL_PREFIX = '/remote'

/**
 * 当前页面的通道前缀。
 * @author ddj 2026年11月02号
 * @returns 本页已接入远程通道时为 '/remote'，否则空串（保持既有本地路径）。
 */
export function channelPrefix(): string {
  if (typeof window === 'undefined') return ''
  try {
    const seat = (window as unknown as Record<string, unknown>)[CHANNEL_SEAT]
    return seat && typeof seat === 'object' ? CHANNEL_PREFIX : ''
  } catch (e) {
    return ''
  }
}

/**
 * 本页是否经远程访问通道接入（远程 vs 本机回环）。
 * 与 {@link import('../client/rpc.js').channelNote} 同口径：只认通道 seat，不解析地址。
 * 用于「仅远程可用」能力的显隐，例如资源管理器的「下载到本机」。
 * @author ddj 2026年11月03号
 * @returns 已接入远程通道为 true；本机、桌面 dsh-app:、未装该插件均为 false
 */
export function isRemoteChannel(): boolean {
  return channelPrefix() !== ''
}

/**
 * 给插件内部路径加通道前缀。
 * @author ddj 2026年11月02号
 * @param path 以 '/' 开头的插件内部路径（合法性由 {@link transportUrl} 内的 appUrl 兜底校验）
 * @returns 带通道前缀的路径；本机页面原样返回
 */
export function transportPath(path: string): string {
  return channelPrefix() + path
}

/**
 * 把插件内部路径解析为当前页面可请求的地址（继承通道前缀、反向代理前缀与桌面协议）。
 * @author ddj 2026年11月02号
 * @param path 以 '/' 开头的插件内部路径
 * @param base 测试用显式 document base；缺省同 appUrl（document.baseURI → location.href）
 * @returns 应用地址；无浏览器环境时返回原根路径
 */
export function transportUrl(path: string, base?: string): string {
  return appUrl(transportPath(path), base)
}

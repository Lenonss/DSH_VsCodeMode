/**
 * dsh-vscode-mode host — 纯 Node ZIP 解压（零依赖，跨平台）。
 * 供 extmgr 解包 VSIX 使用；只实现 VSIX 需要的子集：
 * 读取 EOCD + 中央目录，支持 stored(0)/deflate(8)，忽略 zip64（VSIX < 4GB）。
 * 作者 ddj 2026-08-27
 */
import { inflateRawSync } from 'node:zlib'

/** 单条解压结果：相对路径 + 内容（目录条目 path 以 / 结尾）+ Unix 权限位（可缺失）。 */
export interface ZipEntry {
  path: string
  data: Buffer
  isDirectory: boolean
  /** Unix 权限位（中央目录 external attributes 高 16 位；0 或非 Unix 归档时缺失）。 */
  mode?: number
}

const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50
const LHDR_SIG = 0x04034b50

/**
 * 解析 ZIP 缓冲区 → 条目列表（不解压内容，仅元数据）。
 * @author ddj 2026年08月27号 / 2026年09月18号
 * @param buf zip 字节
 * @returns 条目元数据（含 Unix mode，见 modeOf）
 */
export function zipEntries(buf: Buffer): { name: string; method: number; compressed: number; uncompressed: number; localOffset: number; mode?: number }[] {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件（找不到 EOCD）')
  const total = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out: { name: string; method: number; compressed: number; uncompressed: number; localOffset: number; mode?: number }[] = []
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== CDIR_SIG) throw new Error('ZIP 中央目录损坏')
    const method = buf.readUInt16LE(offset + 10)
    const compressed = buf.readUInt32LE(offset + 20)
    const uncompressed = buf.readUInt32LE(offset + 24)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    const mode = modeOf(buf.readUInt32LE(offset + 38))
    out.push({ name, method, compressed, uncompressed, localOffset, ...(mode === undefined ? {} : { mode }) })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 中央目录 external attributes → Unix 权限位。
 * ZIP 把 Unix mode 放在 `st_mode << 16`（含 S_IFREG 等类型位），低 16 位仅 DOS 属性；
 * 故必须右移 16 再取低 9 位权限。非 Unix 归档（Windows 打包）该字段为 0 或纯 DOS 位。
 * @author ddj 2026年09月18号
 * @param attributes 中央目录 offset+38 的 4 字节
 * @returns 0o000~0o777 权限位；无有效 mode 返回 undefined
 */
export function modeOf(attributes: number): number | undefined {
  const mode = (attributes >>> 16) & 0o777
  return mode === 0 ? undefined : mode
}

/**
 * 解压 ZIP → 条目列表（目录条目含尾部 /）。
 * @author ddj 2026年08月27号 / 2026年09月18号
 * @param buf zip 字节
 * @returns 条目（含内容与可选 mode）
 */
export function unzip(buf: Buffer): ZipEntry[] {
  const metas = zipEntries(buf)
  const out: ZipEntry[] = []
  for (const meta of metas) {
    const lh = meta.localOffset
    if (buf.readUInt32LE(lh) !== LHDR_SIG) throw new Error('ZIP 本地头损坏：' + meta.name)
    const nameLen = buf.readUInt16LE(lh + 26)
    const extraLen = buf.readUInt16LE(lh + 28)
    const dataStart = lh + 30 + nameLen + extraLen
    const isDir = /\/$/.test(meta.name)
    let data: Buffer = Buffer.alloc(0)
    if (!isDir && meta.compressed > 0) {
      const raw = buf.subarray(dataStart, dataStart + meta.compressed)
      data = meta.method === 8 ? Buffer.from(inflateRawSync(raw)) : meta.method === 0 ? Buffer.from(raw) : Buffer.alloc(0)
    }
    out.push({ path: meta.name, data, isDirectory: isDir, ...(meta.mode === undefined ? {} : { mode: meta.mode }) })
  }
  return out
}

/** 定位 EOCD（从尾部向前扫，容忍尾部注释）。 */
function findEocd(buf: Buffer): number {
  const maxScan = Math.min(buf.length, 65557)
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (i < 0) break
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

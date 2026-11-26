/**
 * dsh-vscode-mode host — 附件字节处理（`/html-plan` 与 `/test-check` 共用）。
 *
 * 两个命令都要把 composer 里的图片/文件落盘到自己的子目录，差别只在目标目录与说明文案；
 * 读流拼字节、归一字节类型、失败回滚这三段完全一致，所以抽在这里，避免复制两份后各自跑偏。
 * @author ddj 2026年11月25号
 */
import { rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

//region 读取

/**
 * 把流式字节拼成一个 Uint8Array（附件可能是任意长度，不假设单块）。
 * @author ddj 2026年11月25号
 * @param source 按顺序产出的字节块
 * @returns 拼接后的字节
 */
export async function readChunks(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0
  for await (const part of source) {
    parts.push(part)
    total += part.byteLength
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

/**
 * 归一化附件存储返回的字节。
 * @author ddj 2026年11月25号
 * @param value 服务返回值
 * @returns 字节视图
 * @throws 无法识别时抛错（由上层记入 skipped）
 */
export function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('附件存储返回了无法识别的字节')
}

//endregion

//region 回滚

/** 回滚需要的落盘结果（只要路径与目录名）。 */
export interface StagedFiles {
  /** 已写入文件的工作区相对路径。 */
  files: ReadonlyArray<{ relativePath: string }>
  /** assets 目录（工作区相对路径）。 */
  dir: string
}

/**
 * 回滚本次写入的附件：逐个删除文件，再尝试移除空目录。
 * @author ddj 2026年11月25号
 * @param workspace 工作区绝对路径
 * @param stage 落盘结果
 * @returns 完成后的 Promise（单步失败只忽略）
 */
export async function rollbackFiles(workspace: string, stage: StagedFiles): Promise<void> {
  for (const file of stage.files) {
    try {
      await unlink(join(workspace, file.relativePath))
    } catch {
      /* 文件可能已被删除 */
    }
  }
  try {
    await rmdir(join(workspace, stage.dir))
  } catch {
    /* 目录非空或已不存在 */
  }
}

//endregion

/**
 * dsh-vscode-mode host — SVN **文本输出**解析（svn update/revert/add/commit 均无 `--xml`）。
 *
 * 为什么单独成模块：这些子命令只给人类可读文本，解析必须「宽松 + 原文兜底」，
 * 且共用同一批基元（退出码判定、输出合并/截断、结果行字母表）。与 svnXml.ts 的区别：
 * 这里没有结构化格式可用，只能按行首字母与摘要行解析，故全部可注入/可单测。
 *
 * 本地化注意：实测中英文输出都要容忍（「Updated to revision N」/「已更新到版本 N」），
 * 无法识别时一律保留原文而不猜。
 * 作者 ddj 2026年09月16号
 */
import type { SvnActionResult, SvnUpdateEntry, SvnUpdateResult } from './shared/svn.js'

/** 输出载荷上限（1MB，与 runSvn stdio 限额一致）。 */
export const TEXT_OUTPUT_CAP = 1 << 20
/** 冲突清单上限（防异常输出撑爆载荷）。 */
export const TEXT_CONFLICT_CAP = 64
/** 条目级结果上限（防超大工作副本 update 撑爆载荷）。 */
export const TEXT_ENTRY_CAP = 4000

/**
 * 命令输出是否成功。
 * @author ddj 2026年09月16号
 * @param code 退出码
 * @returns 是否成功
 */
export function isOkCode(code: number | null): boolean {
  return code === 0
}

/**
 * 合并 stdout/stderr 为单一诊断文本（去空、截断到上限）。
 * @author ddj 2026年09月16号
 * @param stdout 标准输出
 * @param stderr 标准错误
 * @param cap 上限
 * @returns 合并文本
 */
export function mergeOutput(stdout: string, stderr: string, cap: number = TEXT_OUTPUT_CAP): string {
  const output = [stdout, stderr].filter((item) => item && item.trim()).join('\n').trim()
  return output.slice(0, cap)
}

/**
 * 取文本尾部（错误提示只带末尾关键信息）。
 * @author ddj 2026年09月16号
 * @param text 原始文本
 * @param max 保留长度
 * @returns 末尾片段
 */
export function tailOfText(text: string, max = 400): string {
  const trim = String(text ?? '').trim()
  if (trim.length <= max) return trim || '无输出'
  return '…' + trim.slice(-max)
}

/**
 * svn update 的逐条结果行状态字母表（`svn help update` 的「A  Added / U  Updated …」）。
 * 保留中文字面量以覆盖本地化输出；未识别字母不生成条目（宁缺勿错）。
 */
const UPDATE_ACTION_LABEL: Record<string, string> = {
  A: '已添加',
  U: '已更新',
  D: '已删除',
  G: '已合并',
  C: '冲突',
  E: '已存在',
  R: '已替换',
  ' ': '无变化',
}

/** update 结果行：行首若干空白 + 单字母 + 空白 + 路径（路径可含空格，取整段）。 */
const UPDATE_LINE_RE = /^([ADGCEUR]|\s{3})\s{2,}(\S.*)$/

/**
 * 解析 `svn update` 文本输出为**条目级**结构化结果（附冲突清单与一行摘要）。
 *
 * 为什么不能只给摘要：update 是「逐文件状态」语义，用户需要看到哪些文件被更新、
 * 哪些冲突（实测冲突行 `C    conf.txt` + 末尾 `Summary of conflicts:` 段）。
 * update 不接受 `--xml`（实测：`Subcommand 'update' doesn't accept option '--xml'`），
 * 故只能文本解析；解析不出条目时保留 revision/冲突摘要等既有字段，保证不退化。
 *
 * @author ddj 2026年09月16号
 * @param stdout 标准输出
 * @param stderr 标准错误
 * @param code 退出码
 * @returns 结构化结果（entries 为条目级明细；conflicts 为冲突路径清单）
 */
export function updateResultOf(stdout: string, stderr: string, code: number | null): SvnUpdateResult {
  const output = mergeOutput(stdout, stderr)
  // 修订版号：英文 `Updated to revision N` / 中文「已更新到版本 N」；取最后一处（汇总行）
  const matches = [...output.matchAll(/(?:revision|版本)\s*\.?\s*(\d+)/gi)]
  const revision = matches.length ? Number(matches[matches.length - 1][1]) : undefined
  const entries: SvnUpdateEntry[] = []
  const conflicts: string[] = []
  for (const line of output.split(/\r?\n/)) {
    // 条目行（`U    a.txt` / `C    conf.txt` / `A    new.txt`）
    const hit = UPDATE_LINE_RE.exec(line)
    if (hit) {
      const action = hit[1].trim()
      const path = hit[2].trim()
      if (path && entries.length < TEXT_ENTRY_CAP) {
        entries.push({
          action: action as SvnUpdateEntry['action'],
          path,
          label: UPDATE_ACTION_LABEL[action] ?? action,
        })
      }
      if (action === 'C' && conflicts.length < TEXT_CONFLICT_CAP) conflicts.push(path)
      continue
    }
    // 兼容 P1 的宽松口径：属性列冲突（` M C  f` 等）也算冲突
    const loose = /^(?:\s?[A-Z_ ]?C)\s+(\S.*)$/.exec(line)
    if (loose && conflicts.length < TEXT_CONFLICT_CAP) {
      const path = loose[1].trim()
      if (!conflicts.includes(path)) conflicts.push(path)
    }
  }
  // 冲突摘要段（`Summary of conflicts:` / 中文本地化）作为兜底：段落里的数字不当作路径
  const conflictText = conflicts.length ? '，冲突 ' + conflicts.length + ' 项' : ''
  const summary = revision !== undefined
    ? '已更新到修订版 r' + revision + conflictText
    : '更新完成' + conflictText
  void code
  return { summary, revision, conflicts, entries, output }
}

/**
 * 解析 revert/add/commit 等批量命令输出为「计数 + 摘要」。
 * @author ddj 2026年09月16号
 * @param stdout 标准输出
 * @param stderr 标准错误
 * @param code 退出码
 * @param verb 动作动词（中文摘要用）
 * @returns 动作结果载荷
 */
export function batchResultOf(
  stdout: string,
  stderr: string,
  code: number | null,
  verb: string,
): SvnActionResult {
  const output = mergeOutput(stdout, stderr)
  const count = (stdout.match(/^(?:Reverted|A|Adding|Skipped|Deleting|D)\b/gm) ?? []).length
  const failed = !isOkCode(code)
  const summary = failed
    ? verb + '失败' + (output ? '：' + tailOfText(output) : '')
    : verb + '完成' + (count ? '（' + count + ' 项）' : '')
  return { count, summary, output }
}

/**
 * 解析 `svn commit` 输出（取新版本号；宽松中英文）。
 * @author ddj 2026年09月16号
 * @param stdout 标准输出
 * @param stderr 标准错误
 * @param code 退出码
 * @param verb 动作动词
 * @returns 动作结果 + 新修订版号（成功且可解析时）
 */
export function commitResultOf(
  stdout: string,
  stderr: string,
  code: number | null,
  verb = '提交',
): SvnActionResult & { revision?: number } {
  const base = batchResultOf(stdout, stderr, code, verb)
  const output = base.output
  const matches = [...output.matchAll(/(?:Committed revision|提交后的版本为|提交.*?版本)\s*\.?\s*(\d+)/gi)]
  const revision = matches.length ? Number(matches[matches.length - 1][1]) : undefined
  const summary = isOkCode(code) && revision !== undefined
    ? verb + '成功：r' + revision
    : base.summary
  return { ...base, revision, summary }
}

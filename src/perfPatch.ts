/**
 * dsh-vscode-mode host — profile patch 压缩调优（文本行级，零 YAML 依赖）。
 * 在 ~/.dsh/profiles/<profile>/cordis.patch.yml 末尾追加/移除一段带标记注释的
 * id 定向覆盖块（compaction-basic / tool-result-pruner 更低阈值）。
 * 纯文本函数可单测：幂等追加、整段移除、无块原样返回。
 * 作者 ddj 2026-09-02
 */

/** 性能块起始标记注释（文件内唯一锚点）。 */
export const PERF_MARK_START = '# dsh-vscode-mode perf tuning (start)'
/** 性能块结束标记注释。 */
export const PERF_MARK_END = '# dsh-vscode-mode perf tuning (end)'

/**
 * 建议的压缩调优 YAML 块（顶层 loader patch 条目，id 定向覆盖）。
 * - compaction-basic：thresholdRatio 0.8→0.6、retainRatio 0.16→0.12（更早触发压缩）；
 * - tool-result-pruner：thresholdChars 8192→4096、head/tail 同步收窄（大 tool result 提前截断）。
 * 注意：压缩只降低模型可见上下文压力，不重写已持久化会话日志（append-only）。
 * @author ddj 2026年09月02号
 * @returns 带前后标记注释与尾换行的 YAML 块
 */
export function perfConfigBlock(): string {
  return [
    PERF_MARK_START,
    '# 更早触发会话内压缩：降低模型可见上下文压力（仅影响后续轮次，不缩小已持久化日志）。',
    '- id: compaction-basic',
    '  config:',
    '    thresholdRatio: 0.6',
    '    retainRatio: 0.12',
    '- id: tool-result-pruner',
    '  config:',
    '    thresholdChars: 4096',
    '    headChars: 2048',
    '    tailChars: 512',
    PERF_MARK_END,
    '',
  ].join('\n')
}

/** 当前文本是否已包含性能块。 */
export function patchHasPerfConfig(text: string): boolean {
  return text.includes(PERF_MARK_START)
}

/**
 * 移除性能块（起止标记注释之间的整段，含所在行），无块时原样返回。
 * 移除后压缩多余空行、确保以单个换行结尾。
 * @author ddj 2026年09月02号
 * @param text 原 patch 文本
 * @returns 移除后的文本
 */
export function patchRemovePerfConfig(text: string): string {
  const start = text.indexOf(PERF_MARK_START)
  if (start === -1) return text
  const end = text.indexOf(PERF_MARK_END, start)
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  if (end === -1) return text.slice(0, lineStart).replace(/\n+$/, '\n')
  const after = (() => {
    const nl = text.indexOf('\n', end)
    return nl === -1 ? text.length : nl + 1
  })()
  const removed = (text.slice(0, lineStart) + text.slice(after)).replace(/\n{3,}/g, '\n\n')
  return removed.replace(/\n+$/, '\n')
}

/**
 * 幂等追加性能块：已有块先整段移除再追加到文件末尾（保证全文件只有一份、位置固定）。
 * @author ddj 2026年09月02号
 * @param text 原 patch 文本
 * @returns 追加后的文本
 */
export function patchInsertPerfConfig(text: string): string {
  const base = patchRemovePerfConfig(text)
  const trimmed = base.replace(/\n+$/, '')
  return trimmed + '\n' + perfConfigBlock()
}

/**
 * dsh-vscode-mode host — SVN XML 解析基元（零第三方依赖，可单测）。
 *
 * 为什么单独成模块：svn 的 `--xml` 输出结构简单且高度同形（`<entry attr="...">` 族 +
 * 文本节点），status/log/info 三处解析共用同一套「实体反转义 + 取属性 + 单趟标签扫描」，
 * 各自实现会重复踩同一批坑（实测两次：闭标签被当成新条目、路径含 `&` 需反转义）。
 *
 * 设计约束：不引 XML 库——输出有上限保护，且只需识别少数字段，正则单趟扫描足够且可确定测试。
 * 作者 ddj 2026年09月16号
 */

/** XML 实体表（`&amp;` 等命名实体）。 */
const NAMED_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/**
 * XML 实体反转义（命名实体 + 十进制/十六进制数字引用）。
 * 实测场景：工作副本路径含 `&` 时 svn 输出 `a&amp;b.txt`，不反转义会把实体写进 UI。
 * 无法识别的引用原样保留（不猜）。
 * @author ddj 2026年09月16号
 * @param text 原始文本
 * @returns 反转义后的文本
 */
export function unescapeXml(text: string): string {
  if (typeof text !== 'string' || !text.includes('&')) return text ?? ''
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITY[body] ?? whole
  })
}

/**
 * 取标签属性值（`path="..."`；未命中返回空串）。属性值自动反转义。
 * @author ddj 2026年09月16号
 * @param tag 标签原文（含属性部分）
 * @param name 属性名
 * @returns 属性值；缺失返回 ''
 */
export function attrOf(tag: string, name: string): string {
  const hit = new RegExp(name + '\\s*=\\s*"([^"]*)"').exec(tag)
  return hit ? unescapeXml(hit[1]) : ''
}

/**
 * 取标签的文本内容（`<msg>...</msg>` 形式，支持换行）。
 * 与 attrOf 互补：SVN 的提交信息/作者/日期是文本节点而非属性。
 * @author ddj 2026年09月16号
 * @param xml 源文本
 * @param tag 标签名
 * @returns 反转义后的内容；缺失返回 ''
 */
export function textOf(xml: string, tag: string): string {
  const hit = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(xml)
  return hit ? unescapeXml(hit[1]) : ''
}

/** 一条标签扫描命中。 */
export interface XmlTagHit {
  /** 标签名。 */
  name: string
  /** 是否闭合标签（`</x>`）。 */
  closing: boolean
  /** 是否自闭合（`<x/>`）。 */
  selfClosing: boolean
  /** 属性原文（未反转义）。 */
  attrs: string
}

/**
 * 单趟扫描指定标签族（只识别 name 集合内的标签，其余忽略）。
 *
 * 调用方须自行处理「闭标签不等于新条目」——`<wc-status>`/`<logentry>` 的闭标签无属性，
 * 若当成新条目会产出多余的空记录（P2 实测踩过）。
 *
 * @author ddj 2026年09月16号
 * @param xml 源文本
 * @param names 关注的标签名集合
 * @returns 命中序列
 */
export function scanXmlTags(xml: string, names: readonly string[]): XmlTagHit[] {
  if (typeof xml !== 'string' || !xml || !names.length) return []
  const alternation = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp('<(/?)(' + alternation + ')\\b([^>]*?)(/?)>', 'g')
  const hits: XmlTagHit[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    hits.push({ closing: match[1] === '/', name: match[2], attrs: match[3], selfClosing: match[4] === '/' })
  }
  return hits
}

/**
 * 解析数字属性（`revision="123"`）；非法/缺失返回 undefined。
 * @author ddj 2026年09月16号
 * @param tag 标签原文
 * @param name 属性名
 * @returns 数字或 undefined
 */
export function numAttrOf(tag: string, name: string): number | undefined {
  const raw = attrOf(tag, name)
  if (raw === '') return undefined
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) ? value : undefined
}

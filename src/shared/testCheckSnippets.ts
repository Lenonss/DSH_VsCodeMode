/**
 * dsh-vscode-mode shared — `/test-check` 的上报片段（纯字符串生成，不落盘）。
 *
 * 目标项目零依赖：唯一必需的通道就是「往 events/ 写一个 JSON 文件」。
 * 所以插件不发布包、不做 SDK，只在建单时给几段可以直接粘进项目的代码，
 * 覆盖 C#、Lua、Python、bash、Node 五种常见环境。
 * @author ddj 2026年11月25号
 */

import { TEST_CHECK_ITEMS, TEST_CHECK_SNIPPETS } from './testCheck.js'

//region 结构面

/** 一段可复制的片段。 */
export interface TestCheckSnippet {
  /** 语言 id（用于标题与复制按钮）。 */
  id: string
  /** 展示名。 */
  label: string
  /** 代码高亮语言。 */
  lang: string
  /** 代码正文（5~10 行，直接可粘）。 */
  code: string
}

//endregion

//region 片段正文

/**
 * 取事件目录的相对写法（片段里统一用它）。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 相对项目根的目录
 */
function eventsPathOf(id: string): string {
  return '.dsh/test-check/' + id + '/events'
}

/**
 * Node 片段：`node report.mjs <item> <status> <summary>`。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 片段
 */
function nodeSnippet(id: string): TestCheckSnippet {
  const code = [
    "import { mkdirSync, writeFileSync } from 'node:fs'",
    "const [item, status = 'pass', summary = 'manual'] = process.argv.slice(2)",
    'const dir = ' + JSON.stringify(eventsPathOf(id)),
    'mkdirSync(dir, { recursive: true })',
    'const at = new Date().toISOString()',
    "const name = at.replace(/[:.]/g, '') + '-' + Math.random().toString(16).slice(2, 6)",
    "writeFileSync(`${dir}/${name}.json`, JSON.stringify({ item, status, at, evidence: { kind: 'test', summary } }))",
  ]
  return { id: 'node', label: 'Node / ESM', lang: 'js', code: code.join('\n') }
}

/**
 * Python 片段：`python report.py <item> <status> <summary>`。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 片段
 */
function pythonSnippet(id: string): TestCheckSnippet {
  const code = [
    'import json, os, sys, time, uuid',
    'item, status, summary = sys.argv[1], sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "manual")',
    'directory = os.path.join(' + JSON.stringify('.dsh/test-check/' + id) + ', "events")',
    'os.makedirs(directory, exist_ok=True)',
    'payload = {"item": item, "status": status, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),',
    '           "evidence": {"kind": "test", "summary": summary}}',
    'name = time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:4] + ".json"',
    'open(os.path.join(directory, name), "w", encoding="utf-8").write(json.dumps(payload))',
  ]
  return { id: 'python', label: 'Python 3', lang: 'py', code: code.join('\n') }
}

/**
 * bash 片段：`report.sh <item> <status> <summary>`。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 片段
 */
function bashSnippet(id: string): TestCheckSnippet {
  const code = [
    '#!/usr/bin/env bash',
    'item="${1:?item 必须给}"; status="${2:-pass}"; summary="${3:-manual}"',
    'dir=' + JSON.stringify(eventsPathOf(id)),
    'mkdir -p "$dir"',
    'name="$(date -u +%Y%m%dT%H%M%S)-$RANDOM"',
    "printf '{\"item\":\"%s\",\"status\":\"%s\",\"at\":\"%s\",\"evidence\":{\"kind\":\"test\",\"summary\":\"%s\"}}\\n' \\",
    '  "$item" "$status" "$(date -u +%FT%TZ)" "$summary" > "$dir/$name.json"',
  ]
  return { id: 'bash', label: 'bash', lang: 'bash', code: code.join('\n') }
}

/**
 * Lua 片段：`report.lua <item> <status> <summary>`（5.3+）。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 片段
 */
function luaSnippet(id: string): TestCheckSnippet {
  const code = [
    'local item, status, summary = arg[1], arg[2] or "pass", arg[3] or "manual"',
    'local dir = ' + JSON.stringify(eventsPathOf(id)),
    'os.execute([[mkdir -p "]] .. dir .. [["]])',
    'local name = os.date("!%Y%m%dT%H%M%S") .. "-" .. tostring(math.random(0x1000, 0xffff))',
    'local file = assert(io.open(dir .. "/" .. name .. ".json", "w"))',
    'file:write(string.format(',
    '  [[{"item":"%s","status":"%s","at":"%s","evidence":{"kind":"test","summary":"%s"}}]],',
    '  item, status, os.date("!%Y-%m-%dT%H:%M:%SZ"), summary))',
    'file:close()',
  ]
  return { id: 'lua', label: 'Lua 5.3+', lang: 'lua', code: code.join('\n') }
}

/**
 * C# 片段（Unity 项目可直接抄；需要 System.Text.Json 或 Newtonsoft）。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 片段
 */
function csharpSnippet(id: string): TestCheckSnippet {
  const code = [
    'static void Report(string item, string status, string summary) {',
    '  var dir = Path.Combine(ProjectRoot, ' + JSON.stringify('.dsh/test-check/' + id) + ', "events");',
    '  Directory.CreateDirectory(dir);',
    '  var at = DateTime.UtcNow.ToString("o");',
    '  var name = DateTime.UtcNow.ToString("yyyyMMddTHHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 4);',
    '  var payload = new { item, status, at, evidence = new { kind = "test", summary } };',
    '  File.WriteAllText(Path.Combine(dir, name + ".json"), JsonSerializer.Serialize(payload));',
    '}',
  ]
  return { id: 'csharp', label: 'C# / Unity', lang: 'cs', code: code.join('\n') }
}

/**
 * 五语言片段清单（顺序即页签展示顺序）。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @returns 片段数组
 */
export function reportSnippets(id: string): TestCheckSnippet[] {
  return [nodeSnippet(id), pythonSnippet(id), bashSnippet(id), luaSnippet(id), csharpSnippet(id)]
}

/**
 * 生成 `snippets.md`（建单时落盘，用户随时可重生成）。
 * @author ddj 2026年11月25号
 * @param id 单子 id
 * @param title 单子标题（可选）
 * @returns markdown 全文
 */
export function snippetsMarkdown(id: string, title = ''): string {
  const parts: string[] = []
  parts.push('# 验收上报片段 · ' + (title || id))
  parts.push('')
  parts.push('唯一必需的通道：往 `.dsh/test-check/' + id + '/events/` 写一个 JSON 文件。')
  parts.push('必填只有 `item` 与 `status`（pass / fail / blocked / skip）；`at` 缺省用文件时间。')
  parts.push('**没有 evidence 的 pass 不算通过**：至少给一句 `summary`（测试名、命令或日志路径）。')
  parts.push('')
  for (const snippet of reportSnippets(id)) {
    parts.push('## ' + snippet.label)
    parts.push('')
    parts.push('```' + snippet.lang)
    parts.push(snippet.code)
    parts.push('```')
    parts.push('')
  }
  parts.push('## 需要「改动后需复验」时加 subject.hash')
  parts.push('')
  parts.push('定义里写了 `files` 的条目，事件里可以带 `subject.hash`；与当前文件复算值不一致就显示「需复验」。')
  parts.push('口径：把 `files` 按路径排序，逐个拼 `路径 + 换行 + 文件内容的 sha256(hex) + 换行`，整体再取 sha256，前面加 `sha256:`。')
  parts.push('')
  parts.push('```js')
  parts.push("import { createHash } from 'node:crypto'")
  parts.push("import { readFileSync } from 'node:fs'")
  parts.push('const sha = (buffer) => createHash("sha256").update(buffer).digest("hex")')
  parts.push('const parts = files.sort().map((path) => path + "\\n" + sha(readFileSync(path)) + "\\n")')
  parts.push('const hash = "sha256:" + sha(Buffer.from(parts.join("")))')
  parts.push('```')
  parts.push('')
  return parts.join('\n')
}

/**
 * 定义文件与上报片段在单子目录里的固定文件名（提示文案用）。
 * @author ddj 2026年11月25号
 * @returns 文件名对
 */
export function sheetFileNames(): { items: string; snippets: string } {
  return { items: TEST_CHECK_ITEMS, snippets: TEST_CHECK_SNIPPETS }
}

//endregion

# 官方差异定位：独立验证报告
## 阶段1：旧实现失败与根因确认（2026-10-28）
环境：cwd D:/Work/ToolsDev/DeepSeekHarnessPlugin/packages/dsh-edit-review，Node v24.11.0，现有typescript依赖；CodeGraph projectPath同cwd，索引有效。真实库以node:sqlite DatabaseSync({readOnly:true})打开，无修改。原工作区存在package.json/pnpm-lock.yaml及EditorView等大量无关修改，不归本任务。

### 源码与测试证据
- src/shared/reviewRegions.ts:34 text=line.slice(1)保留patch物理行尾CR；:56内容侧replace(/\r\n/g,'\n').split('\n')消除CRLF中的CR；:61 pattern复用未处理块行；:65严格===；:68非唯一即stale。内容"head"与patch"head\r"必不等。
- tests/reviewRegions.test.ts:20-23的CRLF旧用例只给content CRLF，patch为LF，未覆盖CRLF patch+CRLF content。
- src/client/reviewBar.ts:81-84把全部stale直接归因为覆盖/撤销，导致误导文案。

### 完整命令A（PowerShell，无脚本文件）
```powershell
@'
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const source=fs.readFileSync('src/shared/reviewRegions.ts','utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {reviewBlocks,reviewRegions}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const diff={kind:'text',path:'a',display:'a',before:true,after:true,coarse:false,hunks:[{oldStart:1,oldLines:3,newStart:1,newLines:3,lines:[' head\r','-old\r','+new\r',' tail\r']}]};
const content='head\r\nnew\r\ntail\r\n';
const regions=reviewRegions(diff,'crlf',[],content);
const lfDiff={...diff,hunks:diff.hunks.map(h=>({...h,lines:h.lines.map(line=>line.replace(/\r$/,''))}))};
console.log('CRLF old implementation:',JSON.stringify(regions));
console.log('Identical input except hunk CR stripped:',JSON.stringify(reviewRegions(lfDiff,'lf-control',[],content)));
assert.equal(regions[0].stale,true);
assert.equal(reviewRegions(lfDiff,'lf-control',[],content)[0].stale,false);
console.log('content first logical line:',JSON.stringify(content.replace(/\r\n/g,'\n').split('\n')[0]));
console.log('patch first context line:',JSON.stringify(reviewBlocks(diff)[0].contextBefore[0]));
console.log('READ-ONLY REPRO ASSERTIONS PASSED');
'@ | node --input-type=module
```
输出（exit 0）：
```text
CRLF old implementation: [{"id":"0:2:2","hunkIndex":0,"oldStart":2,"newStart":2,"oldLines":["old\r"],"newLines":["new\r"],"contextBefore":["head\r"],"contextAfter":["tail\r"],"sourceKind":"official","recordId":"crlf","idx":0,"status":"pending","stale":true}]
Identical input except hunk CR stripped: [{"id":"0:2:2","hunkIndex":0,"oldStart":2,"newStart":2,"oldLines":["old"],"newLines":["new"],"contextBefore":["head"],"contextAfter":["tail"],"sourceKind":"official","recordId":"lf-control","idx":0,"status":"pending","stale":false,"start":2,"end":3}]
content first logical line: "head"
patch first context line: "head\r"
READ-ONLY REPRO ASSERTIONS PASSED
```
备注：实际首次执行还在同一命令末尾只读打印review_% schema，未改变复现逻辑。

### 完整命令B（真实库旧实现/剥CR对照）
```powershell
@'
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
const js=ts.transpileModule(fs.readFileSync('src/shared/reviewRegions.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {reviewRegions}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const db=new DatabaseSync(process.env.USERPROFILE+'/.dsh/dsh-vscode-mode/data/archive/67a3b038ea21013c.sqlite',{readOnly:true});
const rows=db.prepare("SELECT id,session_id,turn,seq,identity,summary,diff FROM review_files WHERE id LIKE '70e1a4b6%' OR diff LIKE '%GameRoot.Runtime.cs%'").all();
for(const row of rows){
 const diff=JSON.parse(row.diff);
 console.log('RECORD',JSON.stringify({id:row.id,sessionId:row.session_id,turn:row.turn,seq:row.seq,identity:row.identity,path:diff.path,display:diff.display}));
 const path=fs.existsSync(diff.path)?diff.path:'D:/Work/PopIsland/IslandSplash_BugFix/'+diff.path;
 if(!fs.existsSync(path)){console.log('MISSING DISK',path);continue;}
 const content=fs.readFileSync(path,'utf8');
 const before=reviewRegions(diff,row.id,[],content);
 const stripped={...diff,hunks:diff.hunks.map(h=>({...h,lines:h.lines.map(line=>line.replace(/\r$/,''))}))};
 const after=reviewRegions(stripped,row.id,[],content);
 console.log('RESULT',JSON.stringify({physicalCRLF:(content.match(/\r\n/g)||[]).length,patchCR:diff.hunks.flatMap(h=>h.lines).filter(l=>l.endsWith('\r')).length,oldLocated:before.filter(r=>!r.stale).length,total:before.length,stripCROnlyLocated:after.filter(r=>!r.stale).length,locations:after.map(r=>({id:r.id,start:r.start,end:r.end,stale:r.stale}))}));
 assert.equal(before.filter(r=>!r.stale).length,0);
 assert.equal(after.filter(r=>!r.stale).length,after.length);
}
db.close();
console.log('ARCHIVE CONTROL ASSERTIONS PASSED');
'@ | node --input-type=module
```
完整stdout：
```text
RECORD {"id":"0dfffec15b31882f4d508c36bac81b4a1e779bb68e40e8781d1ec57ccca38862","sessionId":"session-3bd4cac4-379c-4a46-bc11-ee4db533ca6b","turn":1,"seq":1237,"identity":"D:\\Work\\PopIsland\\IslandSplash_BugFix\\Assets\\Scripts\\GameRoot.Runtime.cs","path":"Assets/Scripts/GameRoot.Runtime.cs","display":"Assets/Scripts/GameRoot.Runtime.cs"}
RESULT {"physicalCRLF":158,"patchCR":84,"oldLocated":0,"total":7,"stripCROnlyLocated":7,"locations":[{"id":"0:93:93","start":93,"end":101,"stale":false},{"id":"0:96:103","start":103,"end":111,"stale":false},{"id":"0:103:113","start":113,"end":129,"stale":false},{"id":"0:108:134","start":134,"end":136,"stale":false},{"id":"0:113:139","start":139,"end":148,"stale":false},{"id":"0:122:149","start":149,"end":153,"stale":false},{"id":"0:123:154","start":154,"end":154,"stale":false}]}
RECORD {"id":"70e1a4b66d65c44ddbf7842f5215780376fd3beda5cb8109d8b40bc7739510bb","sessionId":"session-3bd4cac4-379c-4a46-bc11-ee4db533ca6b","turn":1,"seq":1237,"identity":"D:\\Work\\PopIsland\\IslandSplash_BugFix\\Assets\\Scripts\\Module\\Activity\\Config\\CfgStore.cs","path":"Assets/Scripts/Module/Activity/Config/CfgStore.cs","display":"Assets/Scripts/Module/Activity/Config/CfgStore.cs"}
RESULT {"physicalCRLF":100,"patchCR":61,"oldLocated":0,"total":6,"stripCROnlyLocated":6,"locations":[{"id":"0:47:47","start":47,"end":60,"stale":false},{"id":"0:50:63","start":63,"end":70,"stale":false},{"id":"0:59:72","start":72,"end":79,"stale":false},{"id":"0:62:80","start":80,"end":83,"stale":false},{"id":"0:64:85","start":85,"end":89,"stale":false},{"id":"0:66:90","start":90,"end":92,"stale":false}]}
ARCHIVE CONTROL ASSERTIONS PASSED
```
stderr：`(node:66444) ExperimentalWarning: SQLite is an experimental feature and might change at any time` 与 `Use node --trace-warnings ...`，exit 0。
结论：旧实现0/6、0/7，仅patch行尾CR去除后6/6、7/7唯一匹配；其他变量不变，根因已确认。

### 既有Undo限制（计划前提更正，非本次扩修）
src/reviewEvidence.ts:43将before逻辑化，:46-47的patch old/next仅slice(1)，:50直接比较，故真实CRLF patch在Undo既有实现中也会失败。01-plan.md:25-26“一直正常”仅适用于LF patch+CRLF raw，不能推广。复现命令：
```powershell
@'
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const compile=path=>ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const url=js=>'data:text/javascript;base64,'+Buffer.from(js).toString('base64');
const regionsUrl=url(compile('src/shared/reviewRegions.ts'));
const evidenceSource=compile('src/reviewEvidence.ts').replace("'./shared/reviewRegions.js'",JSON.stringify(regionsUrl));
const {rawReviewFile,evidenceBlocks}=await import(url(evidenceSource));
const diff={kind:'text',path:'a',display:'a',before:true,after:true,coarse:false,hunks:[{oldStart:1,oldLines:3,newStart:1,newLines:3,lines:[' head\r','-old\r','+new\r',' tail\r']}]};
const evidence={before:rawReviewFile(Buffer.from('head\r\nold\r\ntail\r\n')),after:rawReviewFile(Buffer.from('head\r\nnew\r\ntail\r\n'))};
try{evidenceBlocks(diff,evidence);assert.fail('Expected baseline CRLF-patch failure');}catch(error){assert.equal(error.message,'原始基线与官方上下文不一致');console.log('CRLF PATCH BASELINE:',error.message);}
const lfDiff={...diff,hunks:diff.hunks.map(h=>({...h,lines:h.lines.map(line=>line.replace(/\r$/,''))}))};
console.log('LF PATCH WITH SAME CRLF RAW EVIDENCE:',JSON.stringify(evidenceBlocks(lfDiff,evidence)));
console.log('BASELINE UNDO CONTROL ASSERTIONS PASSED');
'@ | node --input-type=module
```
完整输出（exit 0）：
```text
CRLF PATCH BASELINE: 原始基线与官方上下文不一致
LF PATCH WITH SAME CRLF RAW EVIDENCE: [{"id":"0:2:2","before":"old\r\n","after":"new\r\n","offset":6}]
BASELINE UNDO CONTROL ASSERTIONS PASSED
```
未验证项：实现后diff/最小测试/真实库修复回归待阶段2；浏览器实际跳转尚未验证；Undo CRLF patch既有问题按lead要求不扩修。

# 独立验收报告：官方差异定位

作者：ddj 2026年10月28号。来源：御史台 yushi-1 阶段2原文，由尚书唯一落盘；末尾GUI为Lead补充。

## 阶段2：实现后独立复核（御史台）
### 差异复核
已只读执行 `git diff -- src/shared/reviewRegions.ts src/reviewEvidence.ts src/client/reviewBar.ts src/client/ui/OfficialDiffBar.tsx tests/reviewRegions.test.ts tests/reviewBar.test.ts` 与 `git diff -- src/client/ui/EditorView.ts`，并读取新增lineEndings源文件/测试与reviewEvidence测试。范围为批准9文件；EditorView大量Excel修改在阶段1已存在，本次仅staleMissing/staleAmbiguous/noBlocks三项派生与dock透传，不能把Excel代码归本任务。
- reviewRegions：唯一全上下文匹配；最多2命中即停；严格零命中才放宽trimEnd；仅空白pattern不放宽；历史坐标未用于消歧；纯删除保持零长。
- reviewBlocks id公式未变；JSON入参未修改；reviewEvidence只复用完全同构的logicalLine，原始物理字节处理不变。
- reviewBar：新增字段可选、侧车旧四计数仍兼容；仅歧义/混合不再冒称全部改动消失；载入优先；coarse不等同于无块，不承诺不存在的旧新全文。
- 测试审阅：16组合双向EOL矩阵；严格优先、宽松歧义、空白/缩进边界、EOF删除、null原因、BOM+CRLF patch均有目标断言。

### 独立机器验证：无脚本文件，无数据库写入
完整命令（pwsh，cwd项目根）：
```powershell
@'
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const cache=new Map();
function moduleUrl(path){if(cache.has(path))return cache.get(path);let js=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;js=js.replace(/from ['"](\.[^'"]+\.js)['"]/g,(_,specifier)=>{const child=new URL(specifier,new URL(path,'file:///'+process.cwd().replaceAll('\\','/')+'/'));return 'from '+JSON.stringify(moduleUrl(decodeURIComponent(child.pathname).replace(/^\/(\w:)/,'$1').replace(/\.js$/,'.ts')));});const url='data:text/javascript;base64,'+Buffer.from(js).toString('base64');cache.set(path,url);return url;}
const {reviewRegions,reviewBlocks}=await import(moduleUrl('src/shared/reviewRegions.ts'));
const {logicalLine}=await import(moduleUrl('src/shared/lineEndings.ts'));
const {reviewBarView}=await import(moduleUrl('src/client/reviewBar.ts'));
const {rawReviewFile,evidenceBlocks}=await import(moduleUrl('src/reviewEvidence.ts'));
const patch={kind:'text',path:'a',display:'a',before:true,after:true,coarse:false,hunks:[{oldStart:1,oldLines:3,newStart:1,newLines:3,lines:[' head','-old','+new',' tail']}]};
let matrix=0;
for(const eol of ['', '\r','\n','\r\n'])for(const text of ['head\nnew\ntail','head\r\nnew\r\ntail','head\rnew\rtail','head\r\nnew\ntail']){const diff={...patch,hunks:patch.hunks.map(h=>({...h,lines:h.lines.map(l=>l+eol)}))};const before=JSON.stringify(diff);assert.equal(reviewRegions(diff,'x',[],text)[0].stale,false);assert.equal(JSON.stringify(diff),before);matrix++;}
console.log('INDEPENDENT EOL MATRIX',matrix+'/16; input payload immutable');
assert.equal(reviewRegions(patch,'x',[],null)[0].staleReason,'no-content');
assert.equal(reviewRegions(patch,'x',[],'absent')[0].staleReason,'missing');
assert.equal(reviewRegions(patch,'x',[],'head\nnew\ntail\nhead\nnew\ntail')[0].staleReason,'ambiguous');
const base={jumps:0,stale:2,index:0,ready:true,pendingRecords:1,canKeep:true,staleAmbiguous:2,staleMissing:0};
assert.doesNotMatch(JSON.stringify(reviewBarView(base)),/已不在/);
assert.match(reviewBarView({...base,stale:3,staleMissing:1}).notice,/1 处改动未在当前文件中找到，2 处上下文出现多次/);
assert.equal(reviewBarView({...base,ready:false}).notice,'');
assert.doesNotMatch(JSON.stringify(reviewBarView({...base,noBlocks:true})),/已不在|旧新全文/);
console.log('REASON / UI ASSERTIONS PASSED');
for(const line of ['', 'a','a\n','a\r','a\r\n','a\r\r','a  \r','\uFEFFa\n'])assert.equal(logicalLine(line),line.replace(/(?:\r\n|\r|\n)$/,''));
const ev={before:rawReviewFile(Buffer.from('head\r\nold\r\ntail\r\n')),after:rawReviewFile(Buffer.from('head\r\nnew\r\ntail\r\n'))};
assert.deepEqual(evidenceBlocks(patch,ev),[{id:'0:2:2',before:'old\r\n',after:'new\r\n',offset:6}]);
const crlfPatch={...patch,hunks:patch.hunks.map(h=>({...h,lines:h.lines.map(l=>l+'\r')}))};
assert.throws(()=>evidenceBlocks(crlfPatch,ev),{message:'原始基线与官方上下文不一致'});
console.log('LOGICAL REUSE EQUIVALENCE 8/8; LF-patch Undo preserved; existing CRLF-patch Undo limitation unchanged');
const dbPath=process.env.USERPROFILE+'/.dsh/dsh-vscode-mode/data/archive/67a3b038ea21013c.sqlite';
const hash=()=>createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');const hashBefore=hash();
const db=new DatabaseSync(dbPath,{readOnly:true});
const rows=db.prepare("SELECT id,identity,diff FROM review_files WHERE id LIKE '70e1a4b6%' OR diff LIKE '%GameRoot.Runtime.cs%'").all();assert.equal(rows.length,2);
for(const row of rows){const diff=JSON.parse(row.diff);const content=fs.readFileSync(row.identity,'utf8');const states=db.prepare('SELECT block_id AS id,decision FROM review_blocks WHERE file_id=?').all(row.id);const regions=reviewRegions(diff,row.id,states,content);const expected=diff.path.endsWith('CfgStore.cs')?6:7;assert.equal(regions.length,expected);assert.equal(regions.filter(r=>!r.stale).length,expected);assert.deepEqual(regions.map(r=>r.id),reviewBlocks(diff).map(b=>b.id));for(const region of regions)assert.equal(region.status,states.find(s=>s.id===region.id)?.decision??'pending');console.log('ARCHIVE REGRESSION',JSON.stringify({path:diff.path,located:regions.length,total:expected,decisionsRead:states.length,locations:regions.map(r=>[r.id,r.start,r.end])}));}
db.close();assert.equal(hash(),hashBefore);console.log('ARCHIVE SHA256 UNCHANGED',hashBefore);console.log('INDEPENDENT READ-ONLY REGRESSION PASSED');
'@ | node --input-type=module
```
完整stdout（exit0，约1秒）：
```text
INDEPENDENT EOL MATRIX 16/16; input payload immutable
REASON / UI ASSERTIONS PASSED
LOGICAL REUSE EQUIVALENCE 8/8; LF-patch Undo preserved; existing CRLF-patch Undo limitation unchanged
ARCHIVE REGRESSION {"path":"Assets/Scripts/GameRoot.Runtime.cs","located":7,"total":7,"decisionsRead":7,"locations":[["0:93:93",93,101],["0:96:103",103,111],["0:103:113",113,129],["0:108:134",134,136],["0:113:139",139,148],["0:122:149",149,153],["0:123:154",154,154]]}
ARCHIVE REGRESSION {"path":"Assets/Scripts/Module/Activity/Config/CfgStore.cs","located":6,"total":6,"decisionsRead":6,"locations":[["0:47:47",47,60],["0:50:63",63,70],["0:59:72",72,79],["0:62:80",80,83],["0:64:85",85,89],["0:66:90",90,92]]}
ARCHIVE SHA256 UNCHANGED 0b4a652286bae8771b71061cafbbf452f22b9188574b0e47b8b45e5a8771b3ce
INDEPENDENT READ-ONLY REGRESSION PASSED
```
stderr：`(node:59436) ExperimentalWarning: SQLite is an experimental feature and might change at any time`，及trace-warnings提示；非失败。

### 分工验证结果（明确证据来源）
- Lead执行目标Vitest：4文件69/69通过，1.53s。首次受限spawn EPERM后由Lead授权路径执行；御史未绕过权限，未冒称亲跑Vitest。
- 尚书typecheck/build/scoped diffcheck exit0，均为尚书报告，非御史独立执行。命令按实际执行为npm run，而非pnpm；精确记录见changes.md。
- 御史独立执行上方Node无文件回归，原始数据库patch直接定位CfgStore6/6、GameRoot7/7；读取13条既有decision验证id/状态仍命中；DB文件hash不变。

### 未验证项 / 已知边界
1. 当前3080实例尚未找到目标会话，真实GUI的1/6显示、按钮逐块跳转与绿标注未由御史实测；不得据纯函数结果宣称目视通过。
2. CRLF patch的Undo仍有阶段1确认的既有限制，错误「原始基线与官方上下文不一致」；本次明确不扩修。LF patch配CRLF raw Undo与逻辑归一复用行为保持。
3. 未跑全量测试，不包含与本任务无关本地改动的全面回归。
结论：批准范围源码与只读数据回归通过；无新增blocking；可按以上真实GUI缺口与既有Undo限制如实交付。

## Lead最终GUI补充
刷新当前 http://127.0.0.1:3080 独立page4，boot dsh-vscode-mode rev从0beeb340a0cb变为856be8a80297；combo req7381 HTTP200。响应grep确认包含新logicalLine/逻辑分行及两条新原因文案（行110378/489029/489039）。新版bundle实际送达GUI已验。当前打开sidecar非目标官方会话，目标session尚未在活动列表找到，不能冒称GUI上6/7导航实测。Console只有待分类404资源报错，无client throw。Lead决定不继续扩大GUI探查。

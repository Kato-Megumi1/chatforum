const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const calls=[],request={get:async(...args)=>{calls.push(['get',...args]);return[];},post:async(...args)=>{calls.push(['post',...args]);return{status:'QUEUED'};}};
const moduleValue={exports:{}};
const compiled=ts.transpileModule(readFileSync(join(__dirname,'../src/utils/tool-approvals.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','module','exports',compiled)(name=>{if(name==='./request')return{default:request};throw Error('Unexpected import');},moduleValue,moduleValue.exports);
const {readToolApproval,decideToolApproval,fetchToolApprovals}=moduleValue.exports;
const item={id:'10000000-0000-4000-8000-000000000001',runId:'20000000-0000-4000-8000-000000000001',toolName:'manage_forum_tracking',
 state:'WAITING_APPROVAL',argsHash:'a'.repeat(64),policyVersion:'tool-execution-v1',title:'新增追踪',details:{query:'校园',privateState:'SECRET'},reasoning_content:'SECRET'};
test('only a versioned waiting business action becomes a user confirmation, with private fields excluded',()=>{
 const parsed=readToolApproval(item);assert(parsed);assert(!JSON.stringify(parsed).includes('SECRET'));
 for(const bad of [{...item,argsHash:'x'},{...item,state:'APPROVED'},{...item,toolName:'run_shell'},{...item,policyVersion:'old'}])assert.equal(readToolApproval(bad),undefined);
});
test('reading confirmations never creates a task and an explicit decision posts only its immutable fingerprint',async()=>{
 calls.length=0;await fetchToolApprovals(4);assert.equal(calls[0][0],'get');
 await decideToolApproval(readToolApproval(item),true);
 assert.equal(calls.length,2);assert(calls[1][1].endsWith('/decision'));
 assert.deepEqual(calls[1][2],{approved:true,argsHash:item.argsHash,policyVersion:item.policyVersion});
 assert(!JSON.stringify(calls).includes('confirmed'));
});
test('the confirmation UI uses escaped text, separate execute/decline actions and no raw thought display',()=>{
 const source=readFileSync(join(__dirname,'../src/components/ToolApprovals.vue'),'utf8');
 assert(source.includes('确认执行'));assert(source.includes('不执行'));assert(!source.includes('v-html'));
 assert(source.includes('sameSession(session)'));assert(source.includes('controller?.abort()'));
});

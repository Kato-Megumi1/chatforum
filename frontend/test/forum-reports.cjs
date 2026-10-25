const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function load(name,exports,imports,extra={}){
  const script=readFileSync(join(__dirname,'../src/',name),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const module={exports:{}};const code=ts.transpileModule(script+'\nexport {'+exports+'};',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  new Function('require','module','exports','defineProps','defineEmits','crypto','document',code)(
    key=>{if(imports[key])return imports[key];throw Error('Unexpected report import '+key);},module,module.exports,
    ()=>extra.props,()=>extra.emit||(()=>{}),require('node:crypto'),{getElementById:()=>null});
  return module.exports;
}
function env(){let epoch=1;const watchers=[],events=[],messages=[],calls=[];
  const user={user:{id:1},token:'fixture',getAuthSession:()=>({userId:user.user?.id??null,epoch})};
  const common={'vue':{ref:value=>({value}),watch:(source,cb,options)=>{watchers.push(cb);if(options?.immediate)cb();},onUnmounted:()=>{},nextTick:async()=>{}},
    'element-plus':{ElMessage:{success:value=>messages.push(value)}},'@/stores/user':{useUserStore:()=>user}};
  return{user,watchers,events,messages,calls,common,switchAccount:()=>{epoch++;user.user={id:2};user.token='second';watchers.forEach(fn=>fn());}};
}
test('report dialog submits plain reason with a stable idempotency ID and does not hide the source',async()=>{
  const f=env(),request={post:async(path,body)=>{f.calls.push({path,body});}},props={modelValue:true,type:'COMMENT',targetId:20};
  const view=load('components/ReportDialog.vue','submit,reason,detail',{'@/utils/request':request,...f.common},{props,emit:(...args)=>f.events.push(args)});
  view.reason.value='垃圾广告';view.detail.value='<script>not markup</script>';await view.submit();
  assert.equal(f.calls[0].path,'/forum/reports');assert.equal(f.calls[0].body.type,'COMMENT');assert.equal(f.calls[0].body.targetId,20);
  assert.match(f.calls[0].body.requestId,/^[a-f0-9-]{36}$/);assert.equal(f.calls[0].body.detail,'<script>not markup</script>');
  assert.deepEqual(f.events,[['update:modelValue',false]]);assert(!f.calls.some(call=>/status|delete/.test(call.path)));
});
test('late report success cannot close or toast into another account',async()=>{
  const f=env(),pending=deferred(),props={modelValue:true,type:'POST',targetId:10};
  const view=load('components/ReportDialog.vue','submit,reason,detail',{'@/utils/request':{post:()=>pending.promise},...f.common},{props,emit:(...args)=>f.events.push(args)});
  view.reason.value='人身攻击';const sending=view.submit();f.switchAccount();pending.resolve({});await sending;
  assert.equal(f.events.length,0);assert.equal(f.messages.length,0);assert.equal(view.reason.value,'');
});
test('a failed request keeps the same report ID for explicit retry',async()=>{
  const f=env();let fail=true;const props={modelValue:true,type:'POST',targetId:10};
  const request={post:async(path,body)=>{f.calls.push({path,body});if(fail)throw Error('fixture unavailable');}};
  const view=load('components/ReportDialog.vue','submit,reason,detail,error',{'@/utils/request':request,...f.common},{props});
  view.reason.value='隐私泄露';await view.submit();assert.equal(view.error.value,'fixture unavailable');fail=false;await view.submit();
  assert.equal(f.calls[0].body.requestId,f.calls[1].body.requestId);
});
test('report records use separate owner projections and do not restore late list data after account change',async()=>{
  const f=env(),first=deferred(),second=deferred();let count=0;
  const route={query:{tab:'decisions'},fullPath:'/reports?tab=decisions'};
  const request={get:(path,options)=>{f.calls.push({path,options});return++count===1?first.promise:second.promise;}};
  const view=load('views/Reports.vue','rows,kind,load',{'@/utils/request':request,'vue-router':{useRoute:()=>route},...f.common});
  assert.equal(f.calls[0].path,'/forum/reports/decisions');f.switchAccount();first.resolve({rows:[{id:30,reason:'private old account'}],nextCursor:null});await tick();
  assert.deepEqual(view.rows.value,[]);second.resolve({rows:[{id:31}],nextCursor:null});await tick();assert.deepEqual(view.rows.value,[{id:31}]);
});
test('report and appeal texts are escaped by Vue; admin content uses textContent and routes stay local',()=>{
  for(const name of ['components/ReportDialog.vue','views/Reports.vue'])assert(!readFileSync(join(__dirname,'../src/',name),'utf8').includes('v-html'));
  const monitor=readFileSync(join(__dirname,'../../backend/monitor-public/monitor.js'),'utf8');
  assert(monitor.includes("$('report-context-text').textContent="));assert(!monitor.includes("$('report-context-text').innerHTML"));
  const notifications=readFileSync(join(__dirname,'../src/views/Notifications.vue'),'utf8');assert(notifications.includes('reports\\?case=[1-9]\\d*&tab=(?:mine|decisions)'));
});

const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const entry={kind:'episode',id:2,text:'我：喜欢散步\n回复：好呀',sourceIds:[1,2],pinned:false,version:'a'.repeat(64)};
function fixture(handler={}){
  let epoch=1;const watchers=[],calls=[],routes=[],timers=[],confirmation=deferred();
  const user={user:{id:1},token:'fixture',getAuthSession:()=>({userId:user.user?.id??null,epoch})};
  const vue={ref:value=>({value}),computed:fn=>({get value(){return fn();}}),watch:(_source,fn)=>watchers.push(fn),
    onMounted:()=>{},onBeforeUnmount:()=>{},nextTick:async fn=>fn?.()};
  const request={get:async path=>{calls.push(['get',path]);return handler.get?handler.get(path):path.includes('conversations')?
    {items:[{id:3,title:'测试对话',conversationType:'ASSISTANT'}],nextBefore:null}:{items:[entry],nextBefore:null,rebuildStatus:'READY'};},
    post:async(path,body)=>{calls.push(['post',path,body]);return handler.post?handler.post(path,body):{};}};
  const imports={vue,'vue-router':{useRoute:()=>({query:{}}),useRouter:()=>({push:value=>routes.push(value),back:()=>{}})},
    '@element-plus/icons-vue':{},'element-plus':{ElMessageBox:{confirm:()=>confirmation.promise}},
    '@/stores/user':{useUserStore:()=>user},'@/utils/request':request};
  const script=readFileSync(join(__dirname,'../src/views/MyMemory.vue'),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const code=ts.transpileModule(script+'\nexport {entries,sources,sourceDialog,conversationId,visibleEntries,loadError,loading,confirming,loadConversations,loadEntries,showSources,mutate,forget,openSource,filter};',
    {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const module={exports:{}};
  new Function('require','module','exports','document','setTimeout','clearTimeout',code)(key=>{
    if(imports[key])return imports[key];throw Error('Unexpected memory import '+key);
  },module,module.exports,{hidden:false},fn=>{timers.push(fn);return timers.length;},()=>{});
  return{...module.exports,user,calls,routes,timers,confirmation,switchAccount:()=>{epoch++;user.user={id:2};user.token='second';watchers.forEach(fn=>fn());}};
}
test('memory actions use the source version, never client-written memory or chat deletion',async()=>{
  const f=fixture();await f.loadConversations();assert.equal(f.conversationId.value,3);await f.mutate(entry,'pin');
  const call=f.calls.find(call=>call[0]==='post');assert.equal(call[1],'/chat/memory/3/pin');
  assert.deepEqual(call[2],{kind:'episode',id:2,version:entry.version});assert(!JSON.stringify(call).includes('喜欢散步'));
  f.openSource(2);assert.deepEqual(f.routes,[{path:'/chat',query:{conversationId:'3',messageId:'2'}}]);
});
test('only pinned entries are shown by the pinned filter and all source text is escaped',async()=>{
  const f=fixture();f.entries.value=[entry,{...entry,kind:'pin',id:8,pinned:true}];f.filter.value='pinned';
  assert.equal(f.visibleEntries.value.length,1);assert.equal(f.visibleEntries.value[0].id,8);
  const source=readFileSync(join(__dirname,'../src/views/MyMemory.vue'),'utf8');assert(!source.includes('v-html'));
});
test('old-account source responses and old-account confirmations cannot cross a session switch',async()=>{
  const pending=deferred(),f=fixture({post:()=>pending.promise});await f.loadConversations();
  const source=f.showSources(entry);f.switchAccount();pending.resolve({messages:[{id:1,content:'old private source'}]});await source;await tick();
  assert.deepEqual(f.sources.value,[]);assert.equal(f.sourceDialog.value,false);
  const deletion=f.forget(entry);f.switchAccount();f.confirmation.resolve();await deletion;
  assert(!f.calls.some(call=>call[1].endsWith('/forget')));
});
test('delete requires confirmation and pauses rebuild polling while the decision is open',async()=>{
  const f=fixture({get:path=>path.includes('conversations')?{items:[{id:3,title:'Fixture',conversationType:'ASSISTANT'}],nextBefore:null}:
    {items:[entry],nextBefore:null,rebuildStatus:'QUEUED'}});await f.loadConversations();
  const deletion=f.forget(entry),before=f.calls.length;assert.equal(f.confirming.value,true);
  f.timers[0]();await tick();assert.equal(f.calls.length,before);
  f.confirmation.resolve();await deletion;assert(f.calls.some(call=>call[1]==='/chat/memory/3/forget'));
  assert.equal(f.confirming.value,false);
});
test('a failed initial conversation request is visible instead of pretending there is no memory',async()=>{
  const f=fixture({get:()=>{throw Error('fixture unavailable');}});await f.loadConversations();
  assert.match(f.loadError.value,/读取失败/);assert.equal(f.entries.value.length,0);
});

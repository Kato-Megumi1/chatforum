const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
function load(request){const mod={exports:{}};new Function('module','exports','require',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/chat-files.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports,()=>({default:request}));return mod.exports;}
test('mixed uploads retain original selection order; references contain identity, never names/content',async()=>{
 let n=0;const api=load({post:async(url,input)=>url.endsWith('/files')?{files:input.files.map(f=>({id:++n,path:f.path,kind:'text',revision:1}))}:{id:++n,name:input.get('file').name,kind:'image',revision:1}});
 let selected;await api.uploadChatFiles(1,[new File(['image'],'one.png'),new File(['text'],'two.txt'),new File(['image'],'three.png')],files=>selected=files);
 assert.deepEqual(selected.map(f=>f.path),['one.png','two.txt','three.png']);assert.deepEqual(api.chatFileRef(selected[0]),{id:2,kind:'attachment',revision:1});assert.deepEqual(api.chatFileRef(selected[1]),{id:1,kind:'text',revision:1});
 assert.notEqual(api.chatFileKey({id:1,kind:'image'}),api.chatFileKey({id:1,kind:'text'}));
});
test('partial upload failure still selects already-saved files',async()=>{
 let selected;const api=load({post:async(url)=>{if(url.endsWith('/files'))return{files:[{id:1,path:'ok.txt',revision:1,kind:'text'}]};throw Error('synthetic failure');}});
 await assert.rejects(api.uploadChatFiles(1,[new File(['text'],'ok.txt'),new File(['image'],'fail.png')],files=>selected=files),/已保存1个文件/);assert.equal(selected.length,1);assert.equal(selected[0].path,'ok.txt');
});
test('message downloads use immutable ID and text revision; removal handles explicit text kind',async()=>{
 const calls=[],api=load({get:async(...args)=>calls.push(args),delete:async(...args)=>calls.push(args)});
 await api.fetchChatFile(5,{id:2,path:'a.txt',kind:'text',revision:3});assert.equal(calls[0][0],'/coding/5/files/2/download');assert.deepEqual(calls[0][1].params,{revision:3});
 await api.fetchChatFile(5,{id:2,path:'b.png',kind:'image',revision:1});assert.equal(calls[1][0],'/coding/5/attachments/2/download');
 await api.deleteChatFile(5,{id:2,path:'a.txt',kind:'text',revision:3});assert.deepEqual(calls[2][1].params,{kind:'text',revision:3});
});

const recoveryModule={exports:{}};
new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/chat-draft-recovery.ts'),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(recoveryModule,recoveryModule.exports);
const {recoverChatDraft,sameDraftFiles,sameDraftSession}=recoveryModule.exports;
const fileResumeModule={exports:{}};
new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/file-resume.ts'),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(fileResumeModule,fileResumeModule.exports);
const resumePointer={draftId:'39411c9b-62be-44da-b3bc-1eac374f3925',revision:2,hash:'a'.repeat(64)};
const roleplayDefaultsModule={exports:{}};
new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/roleplay-defaults.ts'),'utf8'),{
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(roleplayDefaultsModule,roleplayDefaultsModule.exports);
const owner={userId:7,epoch:3}, attachment={id:42,path:'fixture.png',kind:'image',revision:1};
const failed={text:'Describe this fixture image',files:[attachment]};
const recoveryInput=(overrides={})=>({expectedSession:owner,currentSession:{...owner},navigationUserId:7,conversationExists:true,
 current:{text:'',files:[]},failed,...overrides});

test('failed/aborted durable sends restore text and accepted attachments even while the chat route is absent',()=>{
 // Recovery is a store operation with no mounted-view requirement. A new route
 // instance reads this same per-conversation state when it opens again.
 const before=structuredClone(failed), input=recoveryInput();
 const recovered=recoverChatDraft(input);
 assert.deepEqual(recovered,failed);assert.notEqual(recovered.files,failed.files);
 const drafts={},selections={};drafts[11]=recovered.text;selections[11]=recovered.files;
 assert.equal(drafts[11],failed.text);assert.deepEqual(selections[11],[attachment]);
 assert.deepEqual(failed,before);assert.deepEqual(input.current,{text:'',files:[]});
});

test('late acceptance and failed-send recovery are invalid after account/epoch changes, including same-id relogin',()=>{
 for(const currentSession of [{userId:8,epoch:3},{userId:null,epoch:4},{userId:7,epoch:5}]){
  assert.equal(sameDraftSession(owner,currentSession,7),false);
  assert.equal(recoverChatDraft(recoveryInput({currentSession})),undefined);
 }
 assert.equal(recoverChatDraft(recoveryInput({navigationUserId:8})),undefined);
 assert.equal(recoverChatDraft(recoveryInput({conversationExists:false})),undefined);
});

test('recovery preserves a newer text draft or changed attachment selection rather than overwriting it',()=>{
 for(const text of ['A newer question',' '])assert.equal(recoverChatDraft(recoveryInput({current:{text,files:[]}})),undefined);
 for(const files of [[{...attachment,id:43}],[{...attachment,revision:2}],[attachment,{...attachment,id:43}]]){
  const current={text:'',files},before=structuredClone(current);
  assert.equal(recoverChatDraft(recoveryInput({current})),undefined);assert.deepEqual(current,before);
 }
 // A pre-admission failure has not consumed its original selection yet.
 assert.deepEqual(recoverChatDraft(recoveryInput({current:{text:'',files:[attachment]}})),failed);
});

test('attachment admission/recovery compares immutable identity and revision, not names or current route',()=>{
 assert.equal(sameDraftSession(owner,{...owner},7),true);
 assert.equal(sameDraftFiles([attachment],[{...attachment,path:'renamed-display.png'}]),true);
 assert.equal(sameDraftFiles([attachment],[{...attachment,id:43}]),false);
 assert.equal(sameDraftFiles([attachment],[{...attachment,revision:2}]),false);
 assert.equal(sameDraftFiles([attachment],[{...attachment,kind:'text'}]),false);
 assert.equal(sameDraftFiles([{...attachment,kind:undefined}],[{...attachment,kind:'text'}]),true);
});

const vue=require('vue');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function draftConversation(id=11,userId=7){return{id,userId,title:'Synthetic fixture',conversationType:'ASSISTANT',personaKey:'assistant'};}
function chatRecoveryFixture({acceptImmediately=true,knowledgeBaseId=0,perConversationRuns=false}={}){
 let epoch=3,admission,sentArguments;
 const run=deferred(),runs=[],sentCalls=[],running=vue.reactive(new Set()),errors=[],request={get:async path=>path.startsWith('/coding/')?{files:[attachment]}:[]};
 const store=vue.reactive({currentConversation:draftConversation(),conversations:[draftConversation()],navigation:{userId:7,space:'ASSISTANT',conversationId:11,scroll:{}},
  messages:[],drafts:{},draftAttachments:{11:[{...attachment}]},failedAttempts:{},isStreaming:false,isLoadingConversation:false,
  llmConfig:{models:[{id:'fixture-model',available:true}],defaultModelId:'fixture-model'},
  initializeNavigation(){},setSpace(space){this.navigation.space=space;},selectedModelId(){return'fixture-model';},
  getConversationSettings(){return{agentMode:'normal',knowledgeBaseId,codingEnabled:false};},saveConversationSettings(){},
  saveView(id,scroll,draft){this.drafts[id]=draft;},loadDefaultConfig:async()=>{},loadConversations:async()=>{},
  async selectConversation(conversation){this.currentConversation=conversation;},clearSelection(){this.currentConversation=null;},
  sendConfigured(...args){sentArguments=args;sentCalls.push(args);const cid=this.currentConversation.id,wait=runs.length&&perConversationRuns?deferred():run;runs.push(wait);
   if(perConversationRuns)running.add(cid);else this.isStreaming=true;admission=args[8]?.onAccepted;if(acceptImmediately)admission?.();
   return wait.promise.finally(()=>{if(perConversationRuns)running.delete(cid);else this.isStreaming=false;});},
 });
 if(perConversationRuns)Object.defineProperty(store,'isStreaming',{get:()=>running.has(store.currentConversation?.id),configurable:true});
 const user=vue.reactive({user:{id:7,username:'Fixture'},getAuthSession:()=>({userId:user.user?.id??null,epoch})});
 const navigationModule={exports:{}};
 new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/chat-navigation.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(navigationModule,navigationModule.exports);
 function view(){
  const mounted=[],unmounted=[],scope=vue.effectScope();
  const imports={vue:{...vue,onMounted:fn=>mounted.push(fn),onBeforeUnmount:fn=>unmounted.push(fn)},
   'vue-router':{useRoute:()=>({query:{}}),useRouter:()=>({replace:async()=>{},resolve:path=>({href:'#'+path})}),onBeforeRouteLeave(){}},
   'element-plus':{ElMessage:{error:value=>errors.push(value),warning(){},info(){},success(){}},ElMessageBox:{}},
   '@/stores/chat':{useChatStore:()=>store},'@/stores/user':{useUserStore:()=>user},'@/utils/request':request,
   '@/utils/api':{publicAsset:path=>path,CONNECTION_SETTINGS_ENABLED:false},'@/utils/chat-navigation':navigationModule.exports,
   '@/utils/chat-draft-recovery':recoveryModule.exports,'@/utils/chat-files':load(request),
   '@/utils/roleplay-defaults':roleplayDefaultsModule.exports,'@/utils/file-resume':fileResumeModule.exports,
   '@/utils/forum-links':{},marked:{marked:{}},dompurify:{},dayjs:()=>({format:()=>''}),
  };
  const script=readFileSync(join(__dirname,'../src/views/Chat.vue'),'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const code=ts.transpileModule(script+'\nexport {handleSendMessage,retryFailedAnswer,continueAnswer,inputText,uploadingFiles,sendingLocks,failureHeading,failureDescription};',{
   compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const mod={exports:{}};
  scope.run(()=>new Function('require','module','exports','window',code)(name=>{
   if(Object.hasOwn(imports,name))return imports[name];
   if(name.endsWith('.vue'))return{};
   throw Error('Unexpected Chat.vue import: '+name);
  },mod,mod.exports,{matchMedia:()=>({matches:false}),addEventListener(){},removeEventListener(){}}));
  return{...mod.exports,mount:async()=>{for(const fn of mounted)await fn();await tick();},unmount(){for(const fn of unmounted)fn();scope.stop();}};
 }
 return{store,user,run,runs,sentCalls,errors,view,sentArguments:()=>sentArguments,accept:()=>admission?.(),switchSession(id){epoch++;user.user=id?{id,username:'Fixture '+id}:null;store.navigation.userId=id??0;}};
}

test('ordinary AI does not send an obsolete saved novel knowledge base with an attachment',async()=>{
 const f=chatRecoveryFixture({knowledgeBaseId:73}),active=f.view();await active.mount();active.inputText.value='Read the attached file';
 const sending=active.handleSendMessage();await tick();
 assert(f.sentArguments(),'The ordinary request must still be sent');
 assert.equal(f.sentArguments()[5],undefined,'A hidden old knowledge-base selection must not affect ordinary AI');
 assert.deepEqual(f.sentArguments()[8].files,[attachment],'Message attachments remain independent and available');
 f.run.resolve(true);await sending;active.unmount();assert.deepEqual(f.errors,[]);
});

test('real Chat.vue send recovers a failed accepted draft after leaving and hydrates it on return',async()=>{
 const f=chatRecoveryFixture(),old=f.view();await old.mount();old.inputText.value=failed.text;
 const sending=old.handleSendMessage();await tick();assert.deepEqual(f.store.draftAttachments[11],[]);
 old.unmount();f.run.reject(Error('Synthetic provider failure'));await sending;
 assert.equal(f.store.drafts[11],failed.text);assert.deepEqual(f.store.draftAttachments[11],[attachment]);
 const returned=f.view();await returned.mount();assert.equal(returned.inputText.value,failed.text);
 returned.unmount();assert.deepEqual(f.errors,[]);
});

test('a returned Chat.vue observes late recovery from its unmounted predecessor',async()=>{
 const f=chatRecoveryFixture(),old=f.view();await old.mount();old.inputText.value=failed.text;
 const sending=old.handleSendMessage();await tick();old.unmount();
 const returned=f.view();await returned.mount();assert.equal(returned.inputText.value,'');
 f.run.resolve(false);await sending;assert.equal(returned.inputText.value,failed.text);
 assert.deepEqual(f.store.draftAttachments[11],[attachment]);returned.unmount();
});

test('late failure does not replace a newer returned-view draft or attachment version',async()=>{
 const f=chatRecoveryFixture(),old=f.view();await old.mount();old.inputText.value=failed.text;
 const sending=old.handleSendMessage();await tick();old.unmount();
 const returned=f.view();await returned.mount();returned.inputText.value='Keep the newer draft';
 f.store.draftAttachments[11]=[{...attachment,revision:2}];f.run.reject(Error('Synthetic failure'));await sending;
 assert.equal(returned.inputText.value,'Keep the newer draft');assert.equal(f.store.drafts[11],'Keep the newer draft');
 assert.equal(f.store.draftAttachments[11][0].revision,2);returned.unmount();
});

test('late admission/cancellation for conversation A cannot clear or recover into current conversation B',async()=>{
 const f=chatRecoveryFixture({acceptImmediately:false}),active=f.view();await active.mount();active.inputText.value=failed.text;
 const sending=active.handleSendMessage();await tick();const other=draftConversation(12);
 f.store.conversations.push(other);f.store.drafts[12]='B draft';f.store.draftAttachments[12]=[{...attachment,id:43}];
 f.store.currentConversation=other;f.store.navigation.conversationId=12;await tick();f.accept();
 assert.deepEqual(f.store.draftAttachments[11],[]);assert.equal(f.store.draftAttachments[12][0].id,43);
 f.run.resolve(false);await sending;assert.equal(f.store.drafts[11],failed.text);assert.equal(f.store.drafts[12],'B draft');
 assert.equal(active.inputText.value,'B draft');assert.deepEqual(f.store.draftAttachments[11],[attachment]);active.unmount();
});

test('old-view admission and failure cannot alter a new account or same-account relogin',async()=>{
 for(const userId of [8,7]){
  const f=chatRecoveryFixture({acceptImmediately:false}),old=f.view();await old.mount();old.inputText.value=failed.text;
  const sending=old.handleSendMessage();await tick();old.unmount();f.switchSession(userId);
  f.store.drafts[11]='New session draft';f.store.draftAttachments[11]=[{...attachment,id:99}];
  f.accept();f.run.reject(Error('Synthetic failure'));await sending;
  assert.equal(f.store.drafts[11],'New session draft');assert.equal(f.store.draftAttachments[11][0].id,99);assert.deepEqual(f.errors,[]);
 }
});

test('retry button preserves newer drafts and only explicitly resubmits the matching failed attempt',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();
 const message={id:-2,conversationId:11,failure:{retryable:true}};
 f.store.failedAttempts[11]={question:{content:failed.text,ragMetadata:{messageAttachments:[attachment]}},reply:message};
 active.inputText.value='A newer unsent question';await active.retryFailedAnswer(message);
 assert.equal(f.sentArguments(),undefined);assert.equal(active.inputText.value,'A newer unsent question');
 active.inputText.value=failed.text;const sending=active.retryFailedAnswer(message);await tick();
 assert.equal(f.sentArguments()[0],failed.text);assert.deepEqual(f.sentArguments()[8].files,[attachment]);
 f.run.resolve(true);await sending;active.unmount();
});

test('Chat.vue allows a second conversation to send while the first view handler awaits generation',async()=>{
 const f=chatRecoveryFixture({perConversationRuns:true}),active=f.view();await active.mount();active.inputText.value='Question A';
 const first=active.handleSendMessage();await tick();assert.equal(f.sentCalls.length,1);
 const other=draftConversation(12);f.store.conversations.push(other);f.store.currentConversation=other;f.store.navigation.conversationId=12;await tick();
 active.inputText.value='Question B';const second=active.handleSendMessage();await tick();
 assert.equal(f.sentCalls.length,2,'A waiting handler cannot lock the B composer');assert.equal(f.sentCalls[1][0],'Question B');
 f.runs[0].resolve(false);await first;assert.equal(f.store.isStreaming,true,'A finishing cannot clear B running state');
 assert.equal(f.store.currentConversation.id,12);assert.equal(active.inputText.value,'');
 f.runs[1].resolve(true);await second;active.unmount();assert.deepEqual(f.errors,[]);
});

test('incomplete file delivery requires a user-triggered full regeneration request instead of appending broken code',async()=>{
 for(const fileIncomplete of [true,false]){
  const f=chatRecoveryFixture(),active=f.view();await active.mount();f.store.draftAttachments[11]=[];
  const message={id:200,conversationId:11,role:'assistant',content:'Previous output',ragMetadata:{generation:{truncated:true,canContinue:true,fileIncomplete,filePaths:['demo.html']}}};
  f.store.messages=[message];assert.equal(f.sentArguments(),undefined,'Showing a continuation action must not start a task');
  const continuing=active.continueAnswer(message);await tick();
  assert.equal(f.sentCalls.length,1);
  assert.equal(f.sentArguments()[0],fileIncomplete?'请根据原需求，重新生成一个完整、精简的可下载文件。':'请继续上一条回答，从中断处接着写，不要重复已经输出的内容。');
  f.run.resolve(true);await continuing;active.unmount();assert.deepEqual(f.errors,[]);
 }
});

test('file regeneration cannot replace a newer draft and is unavailable to roleplay or a non-continuable answer',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();f.store.draftAttachments[11]=[];
 const message={id:200,conversationId:11,role:'assistant',content:'Previous output',ragMetadata:{generation:{truncated:true,canContinue:true,fileIncomplete:true}}};f.store.messages=[message];
 active.inputText.value='Keep my newer draft';await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);assert.equal(active.inputText.value,'Keep my newer draft');
 active.inputText.value='';message.ragMetadata.generation.canContinue=false;await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);
 message.ragMetadata.generation.canContinue=true;f.store.currentConversation={...draftConversation(),conversationType:'ROLEPLAY',personaKey:'kato_megumi_persona'};await tick();
 await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);active.unmount();
});

test('explicit versioned file resume can target an older current-conversation answer without prose regeneration',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();f.store.draftAttachments[11]=[];
 const earlier={id:190,conversationId:11,role:'assistant',content:'Partial file',ragMetadata:{generation:{truncated:true,canContinue:true,fileIncomplete:true,resumeFile:resumePointer}}};
 f.store.messages=[earlier,{id:200,conversationId:11,role:'assistant',content:'A later answer'}];
 assert.equal(f.sentCalls.length,0);const operation=active.continueAnswer(earlier);await tick();
 assert.equal(f.sentCalls.length,1);assert.equal(f.sentArguments()[0],'继续完成文件');assert.deepEqual(f.sentArguments()[9],resumePointer);
 assert(!f.sentArguments()[0].includes('重新生成'));f.run.resolve(true);await operation;active.unmount();
});

test('file resume pointer survives a failed attempt retry and restored composer submission',async()=>{
 for(const trigger of ['retry','composer']){
  const f=chatRecoveryFixture(),active=f.view();await active.mount();f.store.draftAttachments[11]=[];
  const message={id:-2,conversationId:11,failure:{retryable:true}};
  f.store.failedAttempts[11]={question:{content:'继续完成文件',ragMetadata:{resumeFile:resumePointer}},reply:message};
  active.inputText.value='继续完成文件';const operation=trigger==='retry'?active.retryFailedAnswer(message):active.handleSendMessage();await tick();
  assert.equal(f.sentCalls.length,1);assert.equal(f.sentArguments()[0],'继续完成文件');assert.deepEqual(f.sentArguments()[9],resumePointer);
  f.run.resolve(true);await operation;active.unmount();
 }
});

test('resume action rejects another conversation and preserves a newer draft while ordinary continuation stays latest-only',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();f.store.draftAttachments[11]=[];
 const message={id:190,conversationId:12,role:'assistant',content:'Partial file',ragMetadata:{generation:{truncated:true,canContinue:true,fileIncomplete:true,resumeFile:resumePointer}}};
 f.store.messages=[message];await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);
 message.conversationId=11;active.inputText.value='Keep my newer draft';await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);assert.equal(active.inputText.value,'Keep my newer draft');
 active.inputText.value='';delete message.ragMetadata.generation.resumeFile;message.ragMetadata.generation.fileIncomplete=false;
 f.store.messages.push({id:200,conversationId:11,role:'assistant',content:'Latest answer'});await active.continueAnswer(message);
 assert.equal(f.sentCalls.length,0);active.unmount();
});

test('resume protocol permits only immutable identifier, positive revision and lowercase hash',()=>{
 const read=fileResumeModule.exports.readFileResume;
 assert.deepEqual(read({...resumePointer,source:'SECRET_SOURCE',originalQuestion:'SECRET_TASK'}),resumePointer);
 for(const value of [null,[],{...resumePointer,draftId:'not-a-uuid'},{...resumePointer,revision:0},{...resumePointer,revision:1.1},
  {...resumePointer,revision:Number.MAX_SAFE_INTEGER+1},{...resumePointer,hash:'A'.repeat(64)},{...resumePointer,hash:'a'.repeat(63)}])assert.equal(read(value),undefined);
});

test('failed-file recovery metadata keeps only a valid public generation projection',()=>{
 const read=fileResumeModule.exports.readRecoverableFileGeneration;
 const generation={fileIncomplete:true,truncated:true,canContinue:true,fileFailureReason:'SERVICE_ERROR',resumeFile:resumePointer};
 assert.deepEqual(read({...generation,privatePrefix:'SECRET_CODE',source:'SECRET_SOURCE'}),generation);
 for(const value of [{...generation,resumeFile:{...resumePointer,hash:'bad'}},{...generation,fileIncomplete:false},{...generation,truncated:false},
  {...generation,canContinue:false},null])assert.equal(read(value),undefined);
 assert.equal(read({...generation,fileFailureReason:'SECRET_REASON'}).fileFailureReason,undefined);
});

test('recoverable file failure copy matches its resume action while ordinary, cancelled and roleplay errors stay unchanged',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();
 const message={failure:{message:'模型等待超时，请重新发送。',cancelled:false},
  ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer}}};
 assert.equal(active.failureHeading(message),'文件尚未完成');assert.equal(active.failureDescription(message),'文件草稿已保存，可以继续完成。');
 const invalid={...message,ragMetadata:{generation:{...message.ragMetadata.generation,resumeFile:{...resumePointer,hash:'invalid'}}}};
 assert.equal(active.failureHeading(invalid),'回答未生成');assert.equal(active.failureDescription(invalid),message.failure.message);
 const cancelled={failure:{message:'已停止生成',cancelled:true}};
 assert.equal(active.failureHeading(cancelled),'已停止生成');assert.equal(active.failureDescription(cancelled),'');
 f.store.currentConversation={...f.store.currentConversation,conversationType:'ROLEPLAY'};
 assert.equal(active.failureHeading(message),'回答未生成');assert.equal(active.failureDescription(message),message.failure.message);active.unmount();
});

test('service-failed answer resumes the new server draft instead of resending its original question or old pointer',async()=>{
 for(const trigger of ['continue','retry']){
  const f=chatRecoveryFixture(),active=f.view();await active.mount();
  const newer={...resumePointer,revision:3,hash:'b'.repeat(64)};
  const message={id:-2,conversationId:11,role:'assistant',failure:{retryable:true},
   ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,fileFailureReason:'SERVICE_ERROR',resumeFile:newer}}};
  const question={content:'The original full task',ragMetadata:{resumeFile:resumePointer,messageAttachments:[attachment]}};
  f.store.failedAttempts[11]={question,reply:message};f.store.messages=[message];active.inputText.value=question.content;
  const operation=trigger==='continue'?active.continueAnswer(message):active.retryFailedAnswer(message);await tick();
  assert.equal(f.sentCalls.length,1);assert.equal(f.sentArguments()[0],'继续完成文件');assert.deepEqual(f.sentArguments()[9],newer);
  assert.deepEqual(f.sentArguments()[8].files,[],'Recovered original attachments cannot become fresh resume inputs');
  f.run.resolve(true);await operation;active.unmount();
 }
});

test('service-failed draft resume preserves a newer user draft and attachment choice',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();
 const message={id:-2,conversationId:11,role:'assistant',failure:{retryable:true},ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer}}};
 f.store.failedAttempts[11]={question:{content:'Original task',ragMetadata:{messageAttachments:[attachment]}},reply:message};f.store.messages=[message];
 active.inputText.value='A newer task';await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);assert.equal(active.inputText.value,'A newer task');
 active.inputText.value='Original task';f.store.draftAttachments[11]=[{...attachment,revision:2}];await active.continueAnswer(message);
 assert.equal(f.sentCalls.length,0);assert.equal(f.store.draftAttachments[11][0].revision,2);active.unmount();
});

test('a discovered file failure without its private question can be resumed explicitly from the real Chat.vue handler',async()=>{
 const f=chatRecoveryFixture(),active=f.view();await active.mount();f.store.draftAttachments[11]=[];
 const reply={id:-2,conversationId:11,role:'assistant',failure:{retryable:false},
  ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer}}};
 f.store.failedAttempts[11]={reply,runId:recoveredRunId};f.store.messages=[reply];active.inputText.value='';
 const operation=active.continueAnswer(reply);await tick();
 assert.equal(f.sentCalls.length,1);assert.equal(f.sentArguments()[0],'继续完成文件');assert.deepEqual(f.sentArguments()[9],resumePointer);
 assert.deepEqual(f.sentArguments()[8].files,[]);f.run.resolve(true);await operation;active.unmount();
});

test('failed-file resume cannot mutate its restored draft during upload or same-conversation admission',async()=>{
 for(const blocked of ['upload','admission']){
  const f=chatRecoveryFixture(),active=f.view();await active.mount();
  const message={id:-2,conversationId:11,role:'assistant',failure:{retryable:true},ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer}}};
  f.store.failedAttempts[11]={question:{content:'Original task',ragMetadata:{messageAttachments:[attachment]}},reply:message};f.store.messages=[message];active.inputText.value='Original task';
  if(blocked==='upload')active.uploadingFiles.value=true;else active.sendingLocks.add(11);
  await active.continueAnswer(message);assert.equal(f.sentCalls.length,0);assert.equal(active.inputText.value,'Original task');
  assert.deepEqual(f.store.draftAttachments[11],[attachment]);active.unmount();
 }
});

function durableStoreFixture({createWait,admitError}={}){
 const persisted=[],requests=[],waiters=[],saved=new Map(),recoveries=new Map(),pages=new Map(),pageReads=[];let runNumber=0,recoveredState={status:'RUNNING'};
 const original=draftConversation(),other=draftConversation(12);
 const request={get:async(path,options)=>{
  requests.push(['get',path]);
  if(path==='/chat/conversations')return[original,other];
  if(path.startsWith('/chat/runs/recovery?conversationId='))return recoveries.get(Number(path.split('=')[1]))||[];
  if(path.startsWith('/chat/runs/'))return recoveredState;
  const pageId=Number(path.split('/')[3]);if(pages.has(pageId)){pageReads.push(options?.params);return pages.get(pageId)(options?.params||{});}
  return saved.get(Number(path.split('/')[3]))||[];
 },post:async(path,input)=>{requests.push(['post',path,input]);
  if(path==='/chat/conversations')return createWait?createWait.promise:draftConversation(13);
  if(admitError)throw admitError;
  return{id:'run-'+(++runNumber),status:'RUNNING'};},delete:async path=>requests.push(['delete',path])};
 const storage={getItem:()=>null,setItem:(...args)=>persisted.push(args),removeItem(){}};
 const navigationModule={exports:{}};
 new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/chat-navigation.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(navigationModule,navigationModule.exports);
 const imports={pinia:{defineStore:(_name,setup)=>()=>vue.reactive(setup())},vue, '@/utils/request':request,
  '@/utils/chat-stream':{watchChatRun:(id,signal,onDelta,onProgress)=>{const wait=deferred();waiters.push({...wait,id,signal,onDelta,onProgress});return wait.promise;}},
  '@/utils/local-workspace':{disconnectLocalWorkspace(){}},'@/utils/chat-navigation':navigationModule.exports,
  '@/utils/chat-files':load(request),'@/utils/chat-model-selection':{selectedChatModel:()=> 'fixture-model'},
  '@/utils/roleplay-defaults':roleplayDefaultsModule.exports,'@/utils/file-resume':fileResumeModule.exports};
 const mod={exports:{}},code=ts.transpileModule(readFileSync(join(__dirname,'../src/stores/chat.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('require','module','exports','localStorage','sessionStorage',code)(name=>{
  if(Object.hasOwn(imports,name))return imports[name];throw Error(name);
 },mod,mod.exports,storage,storage);
 const store=mod.exports.useChatStore();store.conversations=[original,other];store.currentConversation=original;
 return{store,original,other,requests,persisted,waiters,saved,pageReads,setPages:(cid,fn)=>pages.set(cid,fn),setState:value=>{recoveredState=value;},setRecovery:(cid,value)=>recoveries.set(cid,value)};
}

test('seek pages load only the latest window then prepend unique older messages',async()=>{
 const f=durableStoreFixture();f.setPages(11,params=>params.before?
  {items:[{id:1,role:'USER',content:'old',conversationId:11},{id:2,role:'ASSISTANT',content:'middle',conversationId:11}],hasMore:false,olderCursor:null}:
  {items:[{id:2,role:'ASSISTANT',content:'middle',conversationId:11},{id:3,role:'USER',content:'new',conversationId:11}],hasMore:true,olderCursor:'signed-cursor'});
 await f.store.selectConversation(f.original);assert.deepEqual(f.store.messages.map(row=>row.id),[2,3]);assert.equal(f.store.hasOlderMessages,true);
 assert.equal(await f.store.loadOlderMessages(),1);assert.deepEqual(f.store.messages.map(row=>row.id),[1,2,3]);assert.equal(f.store.hasOlderMessages,false);
 assert.deepEqual(f.pageReads,[{pagination:'seek',limit:40},{pagination:'seek',limit:40,before:'signed-cursor'}]);
});
test('a late old-page result cannot change another conversation or an account reset',async()=>{
 for(const reset of [false,true]){
  const f=durableStoreFixture(),wait=deferred();f.setPages(11,params=>params.before?wait.promise:
   {items:[{id:3,role:'USER',content:'new',conversationId:11}],hasMore:true,olderCursor:'signed'});
  await f.store.selectConversation(f.original);const loading=f.store.loadOlderMessages();await tick();
  if(reset)f.store.resetForUser();else await f.store.selectConversation(f.other);
  wait.resolve({items:[{id:1,role:'USER',content:'private old',conversationId:11}],hasMore:false,olderCursor:null});
  assert.equal(await loading,0);assert.deepEqual(f.store.messages,[]);
 }
});
test('source navigation uses the bounded around API and respects the selected conversation',async()=>{
 const f=durableStoreFixture();f.setPages(11,params=>({items:[{id:params.around||90,role:'USER',content:'source',conversationId:11}],hasMore:true,olderCursor:'signed'}));
 await f.store.selectConversation(f.original);assert.equal(await f.store.loadAroundMessage(20),true);
 assert.deepEqual(f.pageReads.at(-1),{pagination:'seek',limit:40,around:20});assert.deepEqual(f.store.messages.map(row=>row.id),[20]);
});
test('waiting approval stops the spinner but locks the conversation and approval resumes the exact existing run',async()=>{
 const f=durableStoreFixture(),sending=f.store.sendMessage('Subscribe to this topic');await tick();
 f.waiters[0].onDelta('discarded pre-approval prefix');
 f.waiters[0].resolve({status:'WAITING_APPROVAL'});await sending;
 assert.equal(f.store.isStreaming,true);assert.equal(f.store.isConversationAwaitingApproval(11),true);
 assert.equal(f.store.messages.at(-1).pending,false);assert.equal(f.store.messages.at(-1).waitingApproval,true);assert.equal(f.store.messages.at(-1).content,'');
 assert.equal(Object.keys(f.store.failedAttempts).length,0);assert.equal(await f.store.sendMessage('new task'),false);
 f.store.onToolApprovalChanged({runId:'run-1',status:'QUEUED'});assert.equal(f.waiters.length,2);assert.equal(f.waiters[1].id,'run-1');
 f.waiters[1].onDelta('post-approval answer');assert.equal(f.store.messages.at(-1).content,'post-approval answer');
 assert.equal(f.requests.filter(([method])=>method==='post').length,1);f.store.resetForUser();f.waiters[1].resolve({status:'CANCELLED'});await tick();
});
test('refresh discovers waiting approval without opening a paid task or a pointless SSE subscription',async()=>{
 const f=durableStoreFixture();f.setRecovery(11,[{id:'10000000-0000-4000-8000-000000000001',status:'WAITING_APPROVAL'}]);
 await f.store.selectConversation(f.original);assert.equal(f.store.isConversationAwaitingApproval(11),true);assert.equal(f.waiters.length,0);
 assert.deepEqual(f.store.messages.map(message=>message.role),['assistant']);assert.equal(f.store.messages[0].waitingApproval,true);
 assert.equal(f.requests.filter(([method])=>method==='post').length,0);f.store.resetForUser();
});

const recoveredRunId='10000000-0000-4000-8000-000000000001';
test('refresh discovers and subscribes to an existing task without posting a second run or inventing a user message',async()=>{
 const f=durableStoreFixture();f.store.currentConversation=null;
 f.setRecovery(11,[{id:recoveredRunId,status:'RUNNING'}]);
 await f.store.selectConversation(f.original);
 assert.equal(f.store.isStreaming,true);assert.equal(f.waiters.length,1);assert.equal(f.waiters[0].id,recoveredRunId);
 assert.deepEqual(f.store.messages.map(m=>m.role),['assistant']);assert.equal(f.store.messages[0].pending,true);
 assert.equal(f.requests.filter(([method])=>method==='post').length,0);
 f.waiters[0].onDelta('replayed public text');f.waiters[0].onProgress({elapsedMs:42000});
 assert.equal(f.store.messages[0].content,'replayed public text');
 await f.store.selectConversation(f.other);await f.store.selectConversation(f.original);
 assert.deepEqual(f.store.messages.map(m=>m.role),['assistant']);assert.equal(f.waiters.length,1);
 f.saved.set(11,[{id:10,role:'USER',content:'Real server question',conversationId:11},{id:11,role:'ASSISTANT',content:'Completed',conversationId:11}]);
 f.setRecovery(11,[]);f.waiters[0].resolve({status:'COMPLETED',result:{content:'Completed'}});await tick();await tick();
 assert.equal(f.store.isStreaming,false);assert.deepEqual(f.store.messages.map(m=>m.id),[10,11]);
 assert.equal(f.requests.filter(([method])=>method==='post').length,0);
});
test('refresh restores only a safe file resume card, never its original request or a new composer draft',async()=>{
 const f=durableStoreFixture();f.store.currentConversation=null;f.store.drafts[11]='A new draft';f.store.draftAttachments[11]=[attachment];
 f.setRecovery(11,[{id:recoveredRunId,status:'FAILED',progress:{elapsedMs:47000},result:{
   privateState:{content:'PRIVATE_SOURCE'},ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer,privatePrefix:'PRIVATE_CODE'}}}}]);
 await f.store.selectConversation(f.original);
 assert.deepEqual(f.store.messages.map(m=>m.role),['assistant']);assert.equal(f.store.messages[0].failure.elapsedMs,47000);
 assert.deepEqual(f.store.messages[0].ragMetadata.generation.resumeFile,resumePointer);assert.equal(f.store.messages[0].failure.retryable,false);
 assert.equal(f.store.failedAttempts[11].question,undefined);assert(!JSON.stringify(f.store.messages).includes('PRIVATE_'));
 assert.equal(f.store.drafts[11],'A new draft');assert.deepEqual(f.store.draftAttachments[11],[attachment]);
 assert.equal(f.requests.filter(([method])=>method==='post').length,0);
 f.store.dismissFailedAttempt(11);await f.store.selectConversation(f.original);assert.deepEqual(f.store.messages,[]);
});
test('no-source failures, revoked resume pointers and roleplay file metadata do not invent a retry action after refresh',async()=>{
 for(const state of [
   {id:recoveredRunId,status:'FAILED',error:'Original failed request is private'},
   {id:recoveredRunId,status:'FAILED',result:{ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:false,resumeFile:resumePointer}}}},
 ]){
  const f=durableStoreFixture();f.setRecovery(11,[state]);await f.store.selectConversation(f.original);assert.deepEqual(f.store.messages,[]);assert.equal(f.waiters.length,0);
 }
 const f=durableStoreFixture(),role={...f.original,conversationType:'ROLEPLAY',personaKey:'kato_megumi_persona'};
 f.setRecovery(11,[{id:recoveredRunId,status:'FAILED',result:{ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer}}}}]);
 await f.store.selectConversation(role);assert.deepEqual(f.store.messages,[]);assert.equal(f.waiters.length,0);
});
test('late discovery cannot hydrate another selected conversation or a reset account epoch',async()=>{
 for(const accountChange of [false,true]){
  const f=durableStoreFixture(),wait=deferred();f.setRecovery(11,wait.promise);
  const pending=f.store.selectConversation(f.original);await tick();
  if(accountChange){f.store.resetForUser();const other=draftConversation(21,8);f.store.conversations=[other];await f.store.selectConversation(other);}
  else await f.store.selectConversation(f.other);
  wait.resolve([{id:recoveredRunId,status:'RUNNING'}]);await pending;
  assert.equal(f.waiters.length,0);assert.deepEqual(f.store.messages,[]);assert.equal(f.store.isStreaming,false);
 }
});
test('late recovered stream output is discarded on logout or same-id login reset',async()=>{
 const f=durableStoreFixture();f.setRecovery(11,[{id:recoveredRunId,status:'RUNNING'}]);await f.store.selectConversation(f.original);
 f.store.resetForUser();f.store.conversations=[f.original];f.store.currentConversation=f.original;
 f.waiters[0].onDelta('PRIVATE_OLD_ACCOUNT');f.waiters[0].resolve({status:'FAILED',result:{ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:resumePointer}}}});
 await tick();assert.deepEqual(f.store.messages,[]);assert.deepEqual(f.store.failedAttempts,{});assert.equal(f.store.isStreaming,false);
});
test('a recovered subscription failure with a still-running HTTP state cannot recursively subscribe again',async()=>{
 const f=durableStoreFixture();f.setRecovery(11,[{id:recoveredRunId,status:'RUNNING'}]);await f.store.selectConversation(f.original);
 f.waiters[0].reject(Error('Synthetic connection failure'));await tick();await tick();
 assert.equal(f.waiters.length,1);assert.equal(f.store.isStreaming,false);assert.equal(f.store.messages[0].failure.retryable,false);
 assert.match(f.store.messages[0].failure.message,/可能仍在生成/);assert.equal(f.requests.filter(([method])=>method==='post').length,0);
 await f.store.selectConversation(f.original);assert.equal(f.waiters.length,2,'Only explicitly reopening the conversation reattaches');
 f.setState({status:'CANCELLED'});f.setRecovery(11,[]);f.waiters[1].resolve({status:'CANCELLED'});await tick();await tick();
 assert.equal(f.store.messages[0].failure.retryable,false,'No original question means no ordinary resend action');
});
test('discovery racing an explicit new send never replaces that new in-memory attempt',async()=>{
 const f=durableStoreFixture(),wait=deferred();f.setRecovery(11,wait.promise);
 const pending=f.store.selectConversation(f.original);await tick();
 const sending=f.store.sendMessage('New explicit request');await tick();
 wait.resolve([{id:recoveredRunId,status:'RUNNING'}]);await pending;
 assert.equal(f.waiters.length,1);assert.equal(f.store.messages[0].content,'New explicit request');
 f.waiters[0].resolve({status:'CANCELLED'});await sending;
 assert.equal(f.requests.filter(([method])=>method==='post').length,1);
});

test('failed durable task retains its question, attachments, error and elapsed time across conversation reloads without persisting history',async()=>{
 const f=durableStoreFixture(),sending=f.store.sendConfigured(failed.text,'normal',[],undefined,undefined,undefined,undefined,undefined,{files:[attachment]});
 await tick();assert.equal(f.waiters.length,1);
 let visible;const stop=vue.watchEffect(()=>{const reply=f.store.messages.at(-1);visible={elapsed:reply?.ragMetadata?.performance?.elapsedMs,content:reply?.content};});
 f.waiters[0].onProgress({elapsedMs:205123});f.waiters[0].onDelta('Unfinished public answer');await vue.nextTick();
 assert.deepEqual(visible,{elapsed:205123,content:'Unfinished public answer'},'Streaming callbacks must update the reactive UI');stop();
 f.waiters[0].resolve({status:'FAILED',error:'Generic failure',result:{failure:{code:'MODEL_REQUEST_TIMEOUT',message:'模型等待超时，请重新发送'}}});
 assert.equal(await sending,false);
 assert.equal(f.store.messages.length,2);assert.equal(f.store.messages[0].content,failed.text);
 assert.deepEqual(f.store.messages[0].ragMetadata.messageAttachments,[attachment]);
 assert.equal(f.store.messages[1].failure.message,'模型等待超时，请重新发送');
 assert.equal(f.store.messages[1].failure.elapsedMs,205123);assert.equal(f.store.messages[1].failure.retryable,true);
 assert(f.store.messages.every(message=>message.localAttempt&&!message.pending));
 await f.store.selectConversation(f.other);assert.deepEqual(f.store.messages,[]);
 await f.store.selectConversation(f.original);assert.equal(f.store.messages.length,2);
 assert.equal(f.requests.filter(([method,path])=>method==='post'&&path==='/chat/runs').length,1,'No automatic paid retry');
 assert(f.persisted.every(([,value])=>!String(value).includes(failed.text)),'Failed question does not enter browser persistence');
 assert.equal(f.saved.size,0,'No server message write for a failed answer');
});

test('explicit new send replaces a local failure and completed server history replaces pending state once',async()=>{
 const f=durableStoreFixture(),one=f.store.sendMessage('First failed question');await tick();
 f.waiters[0].resolve({status:'FAILED',error:'Synthetic failure'});await one;
 const next=f.store.sendMessage('Explicit retry');await tick();
 assert.equal(f.store.messages.length,2);assert.equal(f.store.messages[0].content,'Explicit retry');
 assert.equal(Object.keys(f.store.failedAttempts).length,0);
 f.saved.set(11,[{id:101,role:'USER',content:'Explicit retry',conversationId:11},{id:102,role:'ASSISTANT',content:'Done',conversationId:11}]);
 f.waiters[1].resolve({status:'COMPLETED',result:{content:'Done'}});assert.equal(await next,true);
 assert.deepEqual(f.store.messages.map(message=>message.id),[101,102]);
 assert(f.store.messages.every(message=>!message.localAttempt&&!message.failure));
});

test('transport failure checks the existing durable run and cannot offer a duplicate paid retry while it is still running',async()=>{
 const f=durableStoreFixture(),sending=f.store.sendMessage('Network interrupted question');await tick();
 f.waiters[0].reject(Error('SSE disconnected'));assert.equal(await sending,false);
 assert.equal(f.store.messages.length,2);assert.equal(f.store.messages[1].failure.retryable,false);
 assert.match(f.store.messages[1].failure.message,/可能仍在生成/);
 assert(f.requests.some(([method,path])=>method==='get'&&path==='/chat/runs/run-1'));
 assert.equal(f.requests.filter(([method])=>method==='post').length,1);
 f.saved.set(11,[{id:91,role:'USER',content:'Network interrupted question',conversationId:11},{id:92,role:'ASSISTANT',content:'Finished after disconnect',conversationId:11}]);
 f.setState({status:'COMPLETED',result:{content:'Finished after disconnect'}});
 await f.store.selectConversation(f.other);await f.store.selectConversation(f.original);
 assert.deepEqual(f.store.messages.map(message=>message.id),[91,92]);assert.equal(Object.keys(f.store.failedAttempts).length,0);
 const g=durableStoreFixture(),recovery=g.store.sendMessage('Completed while disconnected');await tick();
 g.saved.set(11,[{id:1,role:'USER',content:'Completed while disconnected',conversationId:11},{id:2,role:'ASSISTANT',content:'Recovered result',conversationId:11}]);
 g.setState({status:'COMPLETED',result:{content:'Recovered result'}});g.waiters[0].reject(Error('SSE disconnected'));
 assert.equal(await recovery,true);assert.equal(g.store.messages[1].content,'Recovered result');assert.equal(Object.keys(g.store.failedAttempts).length,0);
});

test('late failed run from an expired account epoch cannot remove the new account pending answer or reintroduce old question',async()=>{
 const f=durableStoreFixture(),old=f.store.sendMessage('Old account question');await tick();
 f.store.resetForUser();const replacement=draftConversation(21,8);f.store.conversations=[replacement];f.store.currentConversation=replacement;
 const next=f.store.sendMessage('New account question');await tick();assert.equal(f.store.isStreaming,true);
 f.waiters[0].resolve({status:'FAILED',error:'Old session failed'});await old;
 assert.equal(f.store.isStreaming,true);assert.equal(f.store.messages[0].content,'New account question');assert.equal(f.store.messages[1].pending,true);
 assert.deepEqual(Object.keys(f.store.failedAttempts),[]);f.waiters[1].resolve({status:'CANCELLED'});await next;
 assert.equal(f.store.messages[1].failure.cancelled,true);assert.equal(f.store.messages[1].failure.retryable,true);
 f.store.dismissFailedAttempt(21);assert.deepEqual(f.store.messages,[]);
});

test('different conversations stream concurrently, retain only their own pending turns, and stop independently',async()=>{
 const f=durableStoreFixture(),first=f.store.sendMessage('Question A');await tick();
 assert.equal(f.store.isStreaming,true);assert.equal(await f.store.sendMessage('Duplicate A'),false);
 f.waiters[0].onProgress({elapsedMs:1000});f.waiters[0].onDelta('A partial');
 await f.store.selectConversation(f.other);assert.equal(f.store.isStreaming,false);assert.equal(f.store.abortController,null);
 assert.equal(f.waiters[0].signal.aborted,false);const second=f.store.sendMessage('Question B');await tick();
 assert.equal(f.waiters.length,2);assert.equal(f.store.isStreaming,true);
 f.waiters[0].onDelta(' background');f.waiters[1].onDelta('B partial');
 assert.deepEqual(f.store.messages.map(message=>message.content),['Question B','B partial']);
 await f.store.selectConversation(f.original);
 assert.deepEqual(f.store.messages.map(message=>message.content),['Question A','A partial background']);
 assert.equal(f.store.messages[1].ragMetadata.performance.elapsedMs,1000);
 f.store.stopGeneration();assert.equal(f.waiters[0].signal.aborted,true);assert.equal(f.waiters[1].signal.aborted,false);
 assert(f.requests.some(([method,path])=>method==='delete'&&path==='/chat/runs/run-1'));
 assert(!f.requests.some(([method,path])=>method==='delete'&&path==='/chat/runs/run-2'));
 await f.store.selectConversation(f.other);f.waiters[0].resolve({status:'CANCELLED'});await first;
 assert.equal(f.store.currentConversation.id,12);assert.equal(f.store.isStreaming,true);
 assert.deepEqual(f.store.messages.map(message=>message.content),['Question B','B partial']);
 f.saved.set(12,[{id:31,role:'USER',content:'Question B',conversationId:12},{id:32,role:'ASSISTANT',content:'B complete',conversationId:12}]);
 f.waiters[1].resolve({status:'COMPLETED',result:{content:'B complete'}});assert.equal(await second,true);
 assert.equal(f.store.isStreaming,false);await f.store.selectConversation(f.original);
 assert.equal(f.store.messages[0].content,'Question A');assert.equal(f.store.messages[1].failure.cancelled,true);
 assert.equal(f.requests.filter(([method])=>method==='post').length,2);
});

test('deleting a background conversation cancels that run without blocking or cancelling the selected conversation',async()=>{
 const f=durableStoreFixture(),first=f.store.sendMessage('Deleted A');await tick();await f.store.selectConversation(f.other);
 const second=f.store.sendMessage('Keep B');await tick();await f.store.deleteConversation(11);
 assert.equal(f.waiters[0].signal.aborted,true);assert.equal(f.waiters[1].signal.aborted,false);
 assert.equal(f.store.currentConversation.id,12);assert.equal(f.store.isStreaming,true);
 f.waiters[0].resolve({status:'CANCELLED'});await first;assert(!f.store.failedAttempts[11]);
 f.waiters[1].resolve({status:'CANCELLED'});await second;
});

test('account reset aborts every conversation reader and late results cannot revive any old pending turn',async()=>{
 const f=durableStoreFixture(),first=f.store.sendMessage('A old');await tick();await f.store.selectConversation(f.other);
 const second=f.store.sendMessage('B old');await tick();f.store.resetForUser();
 assert(f.waiters.every(wait=>wait.signal.aborted));assert.equal(f.store.isStreaming,false);assert.equal(f.store.abortController,null);
 f.waiters[0].resolve({status:'FAILED',error:'old'});f.waiters[1].resolve({status:'COMPLETED',result:{content:'old'}});await Promise.all([first,second]);
 assert.deepEqual(f.store.messages,[]);assert.deepEqual(Object.keys(f.store.failedAttempts),[]);
 assert.equal(f.store.currentConversation,null);
});

test('creating a new conversation cannot redirect an in-flight send into a subsequently selected conversation',async()=>{
 const createWait=deferred(),f=durableStoreFixture({createWait});f.store.clearSelection();
 const created=f.store.sendMessage('New conversation A');await tick();assert.equal(f.store.isStreaming,true);
 assert.equal(await f.store.sendMessage('Duplicate blank send'),false);
 await f.store.selectConversation(f.other);assert.equal(f.store.isStreaming,false);
 const existing=f.store.sendMessage('Existing conversation B');await tick();
 createWait.resolve(draftConversation(13));await tick();
 assert.equal(f.store.currentConversation.id,12);assert.deepEqual(f.store.messages.map(message=>message.content),['Existing conversation B','']);
 assert.deepEqual(f.requests.filter(([method,path])=>method==='post'&&path==='/chat/runs').map(([, ,input])=>input.conversationId),[12,13]);
 assert.equal(f.waiters.length,2);f.store.resetForUser();f.waiters.forEach(wait=>wait.resolve({status:'CANCELLED'}));await Promise.all([created,existing]);
});

test('real store sends a resume pointer separately, renders the action name and retains it on a failed local question',async()=>{
 const f=durableStoreFixture(),operation=f.store.sendConfigured('','normal',[],undefined,undefined,undefined,undefined,undefined,{files:[]},
  {...resumePointer,source:'SECRET_DRAFT_SOURCE',originalQuestion:'SECRET_ORIGINAL_TASK'});await tick();
 const input=f.requests.find(([method,path])=>method==='post'&&path==='/chat/runs')[2];
 assert.equal(input.question,'继续完成文件');assert.deepEqual(input.resumeFile,resumePointer);assert(!JSON.stringify(input).includes('SECRET_'));
 assert.equal(f.store.messages[0].content,'继续完成文件');assert.deepEqual(f.store.messages[0].ragMetadata.resumeFile,resumePointer);
 f.waiters[0].resolve({status:'FAILED',error:'Synthetic interrupted resume'});assert.equal(await operation,false);
 assert.deepEqual(f.store.failedAttempts[11].question.ragMetadata.resumeFile,resumePointer);
 assert.equal(f.requests.filter(([method,path])=>method==='post'&&path==='/chat/runs').length,1,'Failure does not automatically buy another task');
});

test('outdated draft conflict does not auto-retry or replace the version pointer',async()=>{
 const f=durableStoreFixture({admitError:Object.assign(Error('草稿版本已更新，请刷新后继续'),{response:{status:409}})});
 assert.equal(await f.store.sendConfigured('继续完成文件','normal',[],undefined,undefined,undefined,undefined,undefined,{files:[]},resumePointer),false);
 assert.equal(f.waiters.length,0);assert.equal(f.requests.filter(([method,path])=>method==='post'&&path==='/chat/runs').length,1);
 assert.deepEqual(f.store.failedAttempts[11].question.ragMetadata.resumeFile,resumePointer);
 assert.match(f.store.failedAttempts[11].reply.failure.message,/草稿版本已更新/);
});

test('store refuses malformed or roleplay resume input before submitting a model task',async()=>{
 const f=durableStoreFixture();await assert.rejects(f.store.sendConfigured('继续完成文件','normal',[],undefined,undefined,undefined,undefined,undefined,{files:[]},{...resumePointer,hash:'BAD'}),/草稿信息无效/);
 f.store.currentConversation={...f.original,conversationType:'ROLEPLAY'};
 await assert.rejects(f.store.sendConfigured('继续完成文件','normal',[],undefined,undefined,undefined,undefined,undefined,{files:[]},resumePointer),/原普通 AI 会话/);
 assert.equal(f.requests.filter(([method])=>method==='post').length,0);
});

test('terminal service failure preserves the server-created draft separately from the original question',async()=>{
 const f=durableStoreFixture(),operation=f.store.sendMessage('The original full task');await tick();
 const generation={fileIncomplete:true,truncated:true,canContinue:true,fileFailureReason:'SERVICE_ERROR',resumeFile:resumePointer};
 f.waiters[0].resolve({status:'FAILED',result:{failure:{code:'MODEL_CONNECTION_FAILED',message:'Synthetic connection failure'},
  ragMetadata:{generation:{...generation,privatePrefix:'SECRET_SOURCE'},raw:'SECRET_INTERNAL'}}});
 assert.equal(await operation,false);
 const attempt=f.store.failedAttempts[11];assert.equal(attempt.question.content,'The original full task');assert.equal(attempt.question.ragMetadata?.resumeFile,undefined);
 assert.deepEqual(attempt.reply.ragMetadata.generation,generation);assert(!JSON.stringify(attempt.reply).includes('SECRET_'));
 assert.equal(f.requests.filter(([method,path])=>method==='post'&&path==='/chat/runs').length,1);
});

test('reading failed durable state after a broken connection also retains its public recovery pointer',async()=>{
 const f=durableStoreFixture(),operation=f.store.sendMessage('Interrupted original task');await tick();
 const generation={fileIncomplete:true,truncated:true,canContinue:true,fileFailureReason:'SERVICE_ERROR',resumeFile:resumePointer};
 f.setState({status:'FAILED',error:'Synthetic failure',result:{ragMetadata:{generation}}});f.waiters[0].reject(Error('SSE disconnected'));
 assert.equal(await operation,false);assert.deepEqual(f.store.failedAttempts[11].reply.ragMetadata.generation,generation);
 const g=durableStoreFixture(),later=g.store.sendMessage('Unknown original task');await tick();g.waiters[0].reject(Error('SSE disconnected'));await later;
 g.setState({status:'FAILED',error:'Synthetic failure',result:{ragMetadata:{generation}}});await g.store.selectConversation(g.other);await g.store.selectConversation(g.original);
 assert.deepEqual(g.store.failedAttempts[11].reply.ragMetadata.generation,generation);
});

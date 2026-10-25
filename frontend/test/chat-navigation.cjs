const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/chat-navigation.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);
const {emptyChatNavigation,readChatNavigation,initialChat}=mod.exports;
const conversations=[{id:1,userId:8,conversationType:'LEGACY'},{id:2,userId:8,conversationType:'ROLEPLAY'},
  {id:3,userId:8,conversationType:'ASSISTANT'},{id:4,userId:9,conversationType:'ASSISTANT'}];
test('first AI visit ignores pinned legacy/roleplay and chooses ordinary AI only',()=>{
  assert.equal(initialChat(conversations,emptyChatNavigation(8)).conversation.id,3);
  for(const records of [[],conversations.slice(0,2),[{id:1,userId:8}]])
    assert.deepEqual(initialChat(records,emptyChatNavigation(8)),{space:'ASSISTANT',conversation:undefined});
});
test('explicit selection is restored, including intentionally opened legacy history',()=>{
  for(const record of conversations.slice(0,3))
    assert.equal(initialChat(conversations,{...emptyChatNavigation(8),conversationId:record.id}).conversation.id,record.id);
  assert.deepEqual(initialChat(conversations,{...emptyChatNavigation(8),space:'ROLEPLAY'}),{space:'ROLEPLAY',conversation:undefined});
});
test('deleted or other-account selection falls back to ordinary AI, never legacy',()=>{
  for(const conversationId of [4,99]) {
    const result=initialChat(conversations,{...emptyChatNavigation(8),space:'LEGACY',conversationId});
    assert.equal(result.space,'ASSISTANT');assert.equal(result.conversation.id,3);
  }
});
test('tab navigation restores only same-account IDs and valid bounded scroll positions, no message content',()=>{
  const input={userId:8,space:'ROLEPLAY',conversationId:2,scroll:{1:100,2:300,3:-1,4:'123',bad:8},draft:'not navigation data'};
  assert.deepEqual(readChatNavigation(JSON.stringify(input),8),{userId:8,space:'ROLEPLAY',conversationId:2,scroll:{1:100,2:300}});
  for(const raw of [null,'{invalid',JSON.stringify({...input,userId:9}),JSON.stringify({...input,space:'UNKNOWN'})])
    assert.deepEqual(readChatNavigation(raw,8),emptyChatNavigation(8));
  assert.equal(Object.keys(readChatNavigation(JSON.stringify({...input,scroll:Object.fromEntries(Array.from({length:150},(_,i)=>[i+1,i]))}),8).scroll).length,100);
});

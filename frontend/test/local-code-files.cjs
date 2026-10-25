const {test}=require('node:test'),assert=require('node:assert/strict'),ts=require('typescript'),fs=require('node:fs'),path=require('node:path');
const mod={exports:{}};new Function('module','exports',ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/utils/local-code-files.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);
const {LocalCodeFiles,localPath,textHash}=mod.exports;
function fixture(initial={}){
 const files=new Map(Object.entries(initial));let writes=0,permission='granted',active=true;
 const missing=()=>{throw Object.assign(Error('not found'),{name:'NotFoundError'});};
 function dir(prefix=''){return {queryPermission:async()=>permission,
  resolve:async h=>h.path.split('/'),
  getDirectoryHandle:async(name,{create}={})=>{if(!create&&![...files.keys()].some(p=>p.startsWith(prefix+name+'/')))missing();return dir(prefix+name+'/');},
  async *entries(){const seen=new Set();for(const p of files.keys()){if(!p.startsWith(prefix))continue;const name=p.slice(prefix.length).split('/')[0];if(seen.has(name))continue;seen.add(name);yield [name,p.slice(prefix.length).includes('/')?{kind:'directory',...dir(prefix+name+'/')}:{kind:'file'}];}},
  getFileHandle:async(name,{create}={})=>{const p=prefix+name;if(!files.has(p)){if(!create)missing();files.set(p,'');}return {path:p,getFile:async()=>new Blob([files.get(p)]),createWritable:async()=>{let value;return {write:async s=>value=s,close:async()=>{writes++;files.set(p,value);},abort:async()=>{}};}};}
 };}
 return {files,api:new LocalCodeFiles(dir(),()=>active),get writes(){return writes;},revoke:()=>permission='denied',disconnect:()=>active=false};
}
test('rejects escape, reserved, hidden, credential and binary paths',()=>{
 for(const p of ['../a.ts','C:/a.ts','/a.ts','a\\x.ts','.env','a/.git/config.json','node_modules/a.ts','secrets.json','credentials.json','CON.txt','a./x.ts','a.png'])assert.throws(()=>localPath(p),p);
 assert.equal(localPath('src/你好.ts'),'src/你好.ts');
});
test('fresh read, exact patch and nested create directly persist files',async()=>{
 const f=fixture({'main.ts':'const answer = 1;'}),read=await f.api.execute({action:'read',path:'main.ts'});
 assert.equal(read.hash,await textHash('const answer = 1;'));assert.match(read.content,/1: const/);
 const saved=await f.api.execute({action:'write',path:'main.ts',expectedHash:read.hash,oldText:'= 1',newText:'= 2'});
 assert.equal(saved.saved,true);assert.equal(f.files.get('main.ts'),'const answer = 2;');
 await f.api.execute({action:'write',path:'src/new.ts',expectedHash:'absent',content:'export const x = 3;'});
 assert.equal(f.files.get('src/new.ts'),'export const x = 3;');assert.equal(f.writes,2);
});
test('prevents stale revision, duplicate retry and changes during authorization',async()=>{
 const f=fixture({'a.ts':'one'}),hash=await textHash('one'),args={action:'write',path:'a.ts',expectedHash:hash,content:'two'};
 await f.api.execute(args);await assert.rejects(f.api.execute(args),/外部修改/);assert.equal(f.writes,1);
 await assert.rejects(f.api.execute({...args,expectedHash:await textHash('two')},async()=>{f.files.set('a.ts','external');}),/保存前文件已变化/);
 assert.equal(f.files.get('a.ts'),'external');assert.equal(f.writes,1);
});
test('disconnect/cancellation/revoked permissions cannot write; no shell or deletion',async()=>{
 const f=fixture({'a.ts':'one'});
 await assert.rejects(f.api.execute({action:'write',path:'a.ts',expectedHash:await textHash('one'),content:'two'},async()=>f.disconnect()),/未连接/);
 assert.equal(f.writes,0);
 const g=fixture({'a.ts':'one'});g.revoke();await assert.rejects(g.api.execute({action:'read',path:'a.ts'}),/授权已撤销/);
 for(const action of ['shell','delete','propose'])await assert.rejects(fixture().api.execute({action,path:'a.ts'}),/不支持/);
});
test('hidden files and obvious secrets never enter listing/read/search results',async()=>{
 const f=fixture({'.env':'secret','node_modules/a.ts':'secret','ok.ts':'hello','.git/a.json':'secret','credentials.json':'secret','key.txt':['-----BEGIN','PRIVATE KEY-----'].join(' ')});
 assert.deepEqual((await f.api.list()).paths,['key.txt','ok.ts']);
 await assert.rejects(f.api.execute({action:'read',path:'key.txt'}),/疑似密钥/);
 assert.equal((await f.api.execute({action:'search',query:'secret'})).hits.length,0);
});
test('malformed edits fail closed and JSON check never executes JS',async()=>{
 const f=fixture({'a.ts':'same same','data.json':'{"x":1}'}),hash=await textHash('same same');
 await assert.rejects(f.api.execute({action:'write',path:'a.ts',expectedHash:hash,oldText:'same',newText:'x'}),/不唯一/);
 await assert.rejects(f.api.execute({action:'write',path:'a.ts',expectedHash:hash,content:'x',oldText:'same same',newText:'x'}),/不能混用/);
 assert.equal((await f.api.execute({action:'check',path:'a.ts'})).checked,false);
 assert.equal((await f.api.execute({action:'check',path:'data.json'})).checked,true);assert.equal(f.writes,0);
});

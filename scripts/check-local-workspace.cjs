// Synthetic API/model; real browser OPFS handles stand in for the user-picked directory.
// Never accesses user folders, real accounts, code or paid models.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const base=process.env.LOCAL_CODE_TEST_BASE||'http://127.0.0.1:4173/',origin=new URL(base).origin;
const api=(process.env.LOCAL_CODE_TEST_API||origin+'/api').replace(/\/$/,'');
const user={id:99063,username:'文件验收',email:'files@example.test',role:'USER',level:1,points:0};
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{for(const width of [320,390,1440]){
 const page=await browser.newPage({viewport:{width,height:950},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(18000);
 const errors=[],receipts=[],sends=[];let conversations=[],messages=[],pending=null,resolveDone,connected=false;
 const id=randomUUID(),runId=randomUUID(),done=new Promise(r=>resolveDone=r);
 const queue=args=>({id:randomUUID(),workspaceId:id,runId,args,expiresAt:Date.now()+60000});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(({user,supported})=>{
  localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-file-test',refreshToken:''}));
  window.showDirectoryPicker=async()=>{
   const root=await navigator.storage.getDirectory();
   const file=await root.getFileHandle('main.ts',{create:true}),stream=await file.createWritable();await stream.write('const answer = 1;');await stream.close();
   return {name:'fixture-project',queryPermission:async()=> 'granted',entries:root.entries.bind(root),getDirectoryHandle:root.getDirectoryHandle.bind(root),getFileHandle:root.getFileHandle.bind(root),resolve:root.resolve.bind(root)};
  };
  if(!supported)window.showDirectoryPicker=undefined;
 },{user,supported:width!==320});
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url()),p=url.pathname,method=req.method();
  if(!req.url().startsWith(api+'/'))return url.origin===origin?route.continue():route.abort();
  const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,DELETE,PUT,OPTIONS'};
  if(method==='OPTIONS')return route.fulfill({status:204,headers});
  const body=req.postData()?req.postDataJSON():null;let data=[];
  if(p.endsWith('/chat/config'))data={configured:true,defaultModelId:'deepseek-v4-pro',models:[{id:'deepseek-v4-pro',label:'测试模型',available:true}]};
  if(p.endsWith('/agent/skills'))data=[{name:'code_workspace',enabled:false}];
  if(p.endsWith('/chat/conversations')){if(method==='POST'){conversations=[{id:1,userId:user.id,title:'虚构文件任务',conversationType:'ASSISTANT'}];data=conversations[0];}else data=conversations;}
  if(p.endsWith('/chat/conversations/1/messages'))data=messages;
  if(p.endsWith('/coding/1/local')){connected=true;data={id,token:'a'.repeat(64),name:'fixture-project'};}
  if(p.endsWith('/local/'+id)){assert.equal(req.headers()['x-workspace-token'],'a'.repeat(64));if(method==='DELETE')connected=false;data={operation:connected?pending:null};}
  if(p.endsWith('/authorize')){assert(connected);data={authorized:true};}
  if(/\/operations\/[^/]+$/.test(p)){
   assert.equal(body.success,true,body.error);receipts.push(body);data={received:true};
   if(receipts.length===1)pending=queue({action:'write',path:'main.ts',expectedHash:body.data.hash,oldText:'= 1',newText:'= 2'});
   else if(receipts.length===2)pending=queue({action:'write',path:'src/new.ts',expectedHash:'absent',content:'export const created = true;'});
   else {pending=null;resolveDone();}
  }
  if(p.endsWith('/chat/runs')){sends.push(body);assert.equal(body.codingWorkspaceId,id);assert(body.enabledSkills.includes('code_workspace'));pending=queue({action:'read',path:'main.ts'});data={id:runId,status:'RUNNING'};}
  if(p.endsWith('/events')){await done;const content='已修改 main.ts，并新建 src/new.ts。代码尚未运行。';messages=[{id:2,conversationId:1,role:'ASSISTANT',content}];return route.fulfill({contentType:'text/event-stream',headers,body:'event: complete\ndata: '+JSON.stringify({status:'COMPLETED',result:{content,ragMetadata:{state:'general'}}})+'\n\n'});}
  return route.fulfill({contentType:'application/json',headers,body:JSON.stringify({success:true,data})});
 });
 await page.goto(base.replace(/\/?$/,'/')+(process.env.LOCAL_CODE_TEST_HASH==='1'?'#/':'')+'chat');
 await page.getByRole('button',{name:'打开编程 Agent 工作区',exact:true}).click();
 const drawer=page.locator('.local-code-workspace');await drawer.waitFor();
 assert.equal(await drawer.getByRole('button',{name:'选择本机文件夹'}).isDisabled(),true);
 if(width===320){await drawer.getByText(/当前浏览器不支持目录读写授权/).waitFor();await drawer.locator('.el-checkbox__label').click();assert.equal(await drawer.getByRole('button',{name:'选择本机文件夹'}).isDisabled(),true);assert.equal(sends.length,0);console.log('PASS unsupported browser: explicit limitation, no false local connection');await page.close();continue;}
 await drawer.locator('.el-checkbox__label').click();await drawer.getByRole('button',{name:'选择本机文件夹'}).click();
 await drawer.getByRole('heading',{name:'fixture-project',exact:true}).waitFor();
 await drawer.getByRole('button',{name:'main.ts',exact:true}).click();await drawer.locator('pre').getByText('1: const answer = 1;', {exact:true}).waitFor();
 await page.screenshot({path:`.local/local-workspace-${width}.png`});
 await drawer.getByRole('button',{name:/close|关闭/i}).click();
 await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('请修改 answer 为 2 并新建 src/new.ts');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.getByText('已修改 main.ts，并新建 src/new.ts。代码尚未运行。',{exact:true}).waitFor();
 assert.equal(sends.length,1);assert.equal(receipts.length,3);
 const actual=await page.evaluate(async()=>{const root=await navigator.storage.getDirectory();return {main:await(await(await root.getFileHandle('main.ts')).getFile()).text(),created:await(await(await(await root.getDirectoryHandle('src')).getFileHandle('new.ts')).getFile()).text()};});
 assert.equal(actual.main,'const answer = 2;');assert.equal(actual.created,'export const created = true;');
 await page.getByRole('button',{name:'打开编程 Agent 工作区',exact:true}).click();await drawer.getByText('已保存到本机',{exact:true}).first().waitFor();
 await drawer.locator('pre').getByText('1: const answer = 2;', {exact:true}).waitFor();
 await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:`.local/local-workspace-saved-${width}.png`});
 await drawer.getByRole('button',{name:'断开连接',exact:true}).click();await drawer.getByRole('heading',{name:'选择你的项目文件夹'}).waitFor();
 await page.reload();assert.equal(await page.getByText('本机 · fixture-project',{exact:true}).count(),0);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: explicit consent, folder connection, real browser filesystem read/modify/create, receipts, no overflow, disconnect, refresh clears handle`);await page.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

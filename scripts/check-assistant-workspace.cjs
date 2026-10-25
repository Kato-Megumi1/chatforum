// Synthetic browser fixtures only: no real accounts, user files or model calls.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.ASSISTANT_TEST_BASE||'http://127.0.0.1:4173/';
const origin=new URL(base).origin,hash=process.env.ASSISTANT_TEST_HASH==='1';
const api=(process.env.ASSISTANT_TEST_API||new URL('/api',base).href).replace(/\/$/,'');
const user={id:99043,username:'UI 验收',email:'ui@example.test',role:'USER',level:1,points:0};
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(15000);
 const errors=[],sends=[];let convs=[{id:2,userId:user.id,title:'虚构角色会话',conversationType:'ROLEPLAY',personaKey:'kato_megumi_persona',personaLabel:'加藤惠'}],files=[],changes=[],messages=[],serial=1,fileSerial=50,failNext=false;
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(user=>{if(!localStorage.getItem('chatforum-user'))localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-ui-token',refreshToken:''}));
   if(!localStorage.getItem('chatforum-chat'))localStorage.setItem('chatforum-chat',JSON.stringify({preferredModelId:'deepseek-v4-pro',conversationSettings:{1:{modelId:'deepseek-v4-pro'}}}));},user);
 const headers={'Access-Control-Allow-Origin':'*'};
 await page.route('**/*',async r=>{const url=new URL(r.request().url());
  if(r.request().url().startsWith(api+'/')){
   const p=url.pathname,method=r.request().method();let data=[];
   if(method==='OPTIONS')return r.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'}});
   const multipart=r.request().headers()['content-type']?.includes('multipart/form-data');
   const body=['GET','DELETE'].includes(method)||multipart?null:r.request().postDataJSON();
   if(p==='/api/chat/config')data={configured:true,defaultModelId:'qwen3.8-max',models:[{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',available:false,unavailableReason:'管理员已停用此模型'},{id:'qwen3.8-max',label:'Qwen3.8-Max',available:true}]};
   if(p==='/api/agent/skills')data=[{name:'code_workspace',category:'编程',enabled:false},{name:'forum_recent_posts',category:'论坛',enabled:true}];
   if(p==='/api/chat/conversations'){
     if(method==='POST'){data={id:1,userId:user.id,title:'New Conversation',conversationType:body.conversationType};convs.push(data);}else data=convs;
   }
   if(p==='/api/chat/conversations/1/messages')data=messages;
   if(p==='/api/chat/conversations/2/messages')data=[{id:10,conversationId:2,role:'ASSISTANT',content:'这是一条虚构角色布局测试消息。'}];
   if(p==='/api/coding/1')data={files:files.map(f=>({path:f.path,revision:f.revision,kind:f.kind,id:f.id,bytes:f.bytes,needsVision:f.needsVision})),changes};
   if(p==='/api/coding/1/attachments'){
     const name=/filename="([^"]+)"/.exec(r.request().postDataBuffer().toString('utf8'))?.[1];assert(name);
     const file={path:name,revision:1,kind:'image',id:++fileSerial,bytes:128,needsVision:true};files.push(file);data={...file,name};
   }
   if(/\/api\/coding\/1\/changes\/\d+\/download$/.test(p))return r.fulfill({contentType:'application/octet-stream',headers,body:'const answer = 2;'});
   if(/\/api\/coding\/1\/(attachments|files)\/\d+\/download$/.test(p)){
     const id=Number(p.split('/').at(-2)),file=files.find(f=>f.id===id);
     if(!file)return r.fulfill({status:404,contentType:'application/json',headers,body:JSON.stringify({message:'文件已删除'})});
     return r.fulfill({contentType:'application/octet-stream',headers,body:file.content||'synthetic-binary-download'});
   }
   if(p==='/api/coding/1/files'){
     if(method==='POST'){const saved=body.files.map(f=>({...f,id:++fileSerial,revision:1,bytes:Buffer.byteLength(f.content)}));files.push(...saved);data={imported:saved.length,files:saved.map(f=>({...f,kind:'text'}))};}else data=files;
   }
   if(method==='DELETE'&&/\/api\/coding\/1\/files\/\d+$/.test(p)){
     const file=files.find(f=>f.id===Number(p.split('/').at(-1)));assert(file);assert.equal(url.searchParams.get('revision'),String(file.revision));
     assert.equal(url.searchParams.get('kind'),file.kind?'attachment':'text');files=files.filter(f=>f!==file);changes=changes.filter(c=>c.path!==file.path);data={deleted:true};
   }
   const change=p.match(/^\/api\/coding\/1\/changes\/(\d+)(\/decision)?$/);
   if(change){const item=changes.find(c=>c.id===Number(change[1]));if(change[2]){item.status=body.decision==='apply'?'APPLIED':'REJECTED';if(item.status==='APPLIED'){const file=files.find(f=>f.path===item.path);file.content=item.after;file.revision++;}}data=item;}
   if(p==='/api/chat/runs'){
     if(failNext){failNext=false;return r.fulfill({status:503,headers,contentType:'application/json',body:JSON.stringify({message:'合成发送失败，请重试'})});}
     sends.push(body);data={id:'coding-fixture-'+serial,status:'RUNNING'};
     const attached=(body.attachments||[]).map(ref=>{assert.deepEqual(Object.keys(ref).sort(),['id','kind','revision']);const f=files.find(f=>f.id===ref.id);assert(f);return {id:f.id,path:f.path,revision:f.revision,kind:f.kind||'text',bytes:f.bytes};});
     messages.push({id:serial*100,conversationId:1,role:'USER',content:body.question,...(attached.length?{ragMetadata:{messageAttachments:attached}}:{})});
     if(serial===1)changes=[{id:11,path:'main.js',baseRevision:1,before:files[0].content,after:'const answer = 2;',description:'修正返回值',status:'PENDING'}];
   }
   if(/\/api\/chat\/runs\/coding-fixture-\d+\/events/.test(p)){
     const first=serial===1,content=first?'修改版已生成，可直接下载。':'合成回答 '+serial;
     const ragMetadata={state:'general',...(first?{fileArtifacts:[{changeId:11,path:'main.js'}]}:{})};
     messages.push({id:serial++*100+1,conversationId:1,role:'ASSISTANT',content,ragMetadata});
     return r.fulfill({contentType:'text/event-stream',headers,body:'event: delta\ndata: '+JSON.stringify({text:content,offset:content.length})+'\n\nevent: complete\ndata: '+JSON.stringify({status:'COMPLETED',result:{content,ragMetadata}})+'\n\n'});
   }
   return r.fulfill({contentType:'application/json',headers,body:JSON.stringify({success:true,data})});
  }
  return url.origin===origin?r.continue():r.abort();
 });
 const textbox=page.getByRole('textbox',{name:'消息输入',exact:true});
 const drawer=page.locator('.code-workspace'),confirmation=page.locator('.el-message-box');
 const closeDrawer=async()=>{await drawer.getByRole('button',{name:/close|关闭/i}).click();await drawer.waitFor({state:'hidden'});};
 const openLibrary=async()=>{await page.getByRole('button',{name:'添加文件',exact:true}).click();await page.getByRole('button',{name:/^会话文件/}).click();await drawer.waitFor();};
 const pending=()=>page.locator('.attachment-chip');
 await page.goto(base.replace(/\/?$/,'/')+(hash?'#/':'')+'chat');
 await page.getByRole('heading',{name:'有什么我能帮你的吗？'}).waitFor();assert.equal(await page.locator('.chat-toolbar').count(),0);
 await page.getByRole('button',{name:'添加文件',exact:true}).click();await page.getByRole('button',{name:'上传文件',exact:true}).waitFor();assert.equal(await page.locator('.upload-file-hint').count(),0);
 await page.locator('.assistant-composer input[type=file]').setInputFiles({name:'main.js',mimeType:'text/javascript',buffer:Buffer.from('const answer = 1;\n// <img src=x onerror="window.__unsafe=1">')});
 await pending().filter({hasText:'main.js'}).waitFor();await textbox.click();await page.locator('.attachment-open').click();await drawer.waitFor();
 await drawer.getByRole('button',{name:/main.js/}).click();await drawer.locator('.file-view pre').getByText('const answer = 1;', {exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.__unsafe),undefined);await closeDrawer();assert.equal(await page.getByRole('button',{name:'普通',exact:true}).getAttribute('aria-pressed'),'true');
 await textbox.fill('请把 answer 改成 2');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.getByText('修改版已生成，可直接下载。',{exact:true}).waitFor();await pending().waitFor({state:'hidden'});
 assert.equal(sends[0].mode,'normal');assert.equal(sends[0].modelId,'qwen3.8-max');assert(sends[0].enabledSkills.includes('code_workspace'));assert.equal(sends[0].attachments.length,1);
 assert.equal(await page.locator('.message-attachments').count(),1);assert.equal(await page.locator('.coding-attached').count(),0);assert.equal(await page.getByText('回答依据',{exact:true}).count(),0);
 const original=page.waitForEvent('download');await page.getByRole('button',{name:'下载消息附件 main.js',exact:true}).click();assert.equal((await original).suggestedFilename(),'main.js');
 const modified=page.waitForEvent('download');await page.getByRole('button',{name:'下载修改版 main.js',exact:true}).click();assert.equal((await modified).suggestedFilename(),'main.js');
 await textbox.fill('再解释一下刚才的文件');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('合成回答 2',{exact:true}).waitFor();
 assert.equal(sends[1].attachments,undefined);assert(sends[1].enabledSkills.includes('code_workspace'));
 await page.getByRole('button',{name:'模型设置',exact:true}).filter({visible:true}).first().click();
 const settings=page.locator('.settings-drawer');await settings.locator('.el-select__wrapper').click();await page.getByRole('option',{name:'Qwen3.8-Max',exact:true}).click();
 await settings.getByRole('button',{name:/close|关闭/i}).click();await settings.waitFor({state:'hidden'});
 await page.reload();await page.getByText('合成回答 2',{exact:true}).waitFor();assert.equal(await pending().count(),0);assert.equal(await page.locator('.message-attachments').count(),1);
 assert.equal(await textbox.evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','保持普通粘贴');const e=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});el.dispatchEvent(e);return e.defaultPrevented;}),false);
 await textbox.evaluate(el=>{const data=new DataTransfer();data.items.add(new File(['synthetic screenshot'],'image.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 await pending().filter({hasText:'粘贴图片-'}).waitFor();const imageFile=files.find(f=>f.kind==='image');assert(imageFile);
 await page.getByRole('button',{name:'移除待发送附件 '+imageFile.path,exact:true}).click();await pending().waitFor({state:'hidden'});assert(files.includes(imageFile));
 await openLibrary();await drawer.getByRole('tab',{name:/文件 ·/}).click();await drawer.getByRole('button',{name:new RegExp(imageFile.path)}).click();
 await drawer.getByRole('button',{name:'添加到消息',exact:true}).click();await drawer.waitFor({state:'hidden'});await pending().waitFor();assert.equal(await pending().count(),1);assert.equal(await textbox.inputValue(),'');
 failNext=true;await textbox.fill('失败保留草稿');await page.getByRole('button',{name:'发送消息',exact:true}).click();
 await page.getByText('合成发送失败，请重试',{exact:true}).first().waitFor();assert.equal(await textbox.inputValue(),'失败保留草稿');assert.equal(await pending().count(),1);
 await textbox.fill('');await page.getByRole('button',{name:'发送消息',exact:true}).click();await page.getByText('合成回答 3',{exact:true}).waitFor();await pending().waitFor({state:'hidden'});
 assert.equal(sends[2].modelId,'qwen3.8-max');assert.equal(sends[2].question,'');assert.deepEqual(sends[2].attachments,[{id:imageFile.id,kind:'attachment',revision:1}]);assert.equal(await page.locator('.message-attachments').count(),2);
 await openLibrary();await drawer.getByRole('tab',{name:/变更审查/}).click();await drawer.getByRole('button',{name:'main.js 修正返回值',exact:true}).click();
 await drawer.getByRole('button',{name:'确认应用这项修改',exact:true}).click();await drawer.getByText('已应用',{exact:true}).waitFor();assert.equal(files[0].revision,2);
 await drawer.getByRole('tab',{name:/文件 ·/}).click();await drawer.getByRole('button',{name:new RegExp(imageFile.path)}).click();
 await drawer.getByRole('button',{name:'删除此文件',exact:true}).click();await confirmation.getByRole('button',{name:'取消',exact:true}).click();await confirmation.waitFor({state:'hidden'});assert(files.includes(imageFile));
 await drawer.getByRole('button',{name:'删除此文件',exact:true}).click();await confirmation.getByRole('button',{name:'删除',exact:true}).click();
 await drawer.getByText('选择文件查看',{exact:true}).waitFor();assert(!files.includes(imageFile));await closeDrawer();assert.equal(await page.locator('.message-attachments').count(),2);assert.equal(await pending().count(),0);
 const layout=await page.locator('.assistant-composer').boundingBox(),textLayout=await textbox.boundingBox();assert(textLayout.height>=85);if(width>900)assert(layout.width>=1000);else assert(layout.width<=width);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('.el-message').first().waitFor({state:'hidden'});await page.screenshot({path:`.local/assistant-message-attachments-${width}.png`});
 if(width<900)await page.getByRole('button',{name:'对话列表',exact:true}).click();await page.getByRole('tab',{name:'角色对话',exact:true}).click();
 if(width<900)await page.getByRole('button',{name:'关闭对话列表',exact:true}).click({position:{x:width-10,y:100}});
 await page.getByText('这是一条虚构角色布局测试消息。',{exact:true}).waitFor();assert.equal(await page.locator('.assistant-composer').count(),0);assert.equal(await page.locator('.chat-toolbar').count(),1);assert.equal(await page.locator('.persona-bar').count(),1);
 assert.deepEqual(errors,[]);console.log(`PASS ${width}px: message-scoped files, model switch/reload/followup, paste/remove/reattach, failed send restore, attachment-only, download/review/delete, preserved roleplay`);await page.close();
}
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

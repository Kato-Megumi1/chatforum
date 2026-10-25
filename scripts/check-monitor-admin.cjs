// Synthetic local-only UI test; no real account, SMTP, database or model requests.
const {createServer}=require('node:http'),{readFileSync}=require('node:fs'),{join}=require('node:path');
const assert=require('node:assert/strict'),{chromium}=require('playwright');
const files={'/':'index.html','/monitor.js':'monitor.js','/monitor.css':'monitor.css'};
(async()=>{const server=createServer((req,res)=>{const name=files[req.url];if(!name){res.writeHead(404);return res.end();}res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(readFileSync(join(__dirname,'../backend/monitor-public',name)));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
let browser;try{browser=await chromium.launch({channel:'msedge',headless:true});for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:950}}),errors=[],writes=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  const actor={id:99187,username:'本机验收管理员',email:'admin@example.test',role:'ADMIN'};
  const settings={locked:false,smtp:{enabled:false,host:'smtp.example.test',port:465,user:'sender@example.test',from:'sender@example.test',passwordConfigured:false},models:{defaultModelId:'qwen3.8-max',enabled:{'qwen3.8-max':true,'deepseek-v4-pro':false},catalog:[{id:'qwen3.8-max',label:'Qwen3.8-Max',configured:true,available:true},{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',configured:false,available:false,unavailableReason:'凭据未配置'}]}};
  let postStatus='PENDING',commentStatus='ACTIVE';
  await page.route('**/ops-api/**',async route=>{const req=route.request(),u=new URL(req.url()),p=u.pathname.replace('/ops-api',''),method=req.method();let data;
    assert.equal(u.origin,base);if(method!=='GET'){assert.equal(req.headers()['x-ops-csrf'],'synthetic-csrf');writes.push({p,method,body:req.postDataJSON()});}
    if(p==='/me')data={user:actor,csrf:'synthetic-csrf'};
    else if(p==='/summary')data={totals:{totalTokens:130,inputTokens:100,outputTokens:30,embeddingTokens:0,calls:1,unreportedCalls:0,partialRecords:0,unpricedRecords:1},users:2,banned:0,logins:1,tasks:[],failedLogins:0,models:[],daily:[],backfill:'complete',untrackedTasks:0};
    else if(p==='/settings')data=settings;
    else if(p==='/settings/smtp'&&method==='PUT'){const b=req.postDataJSON();assert.equal(b.password,'synthetic-smtp-authorization');Object.assign(settings.smtp,{enabled:b.enabled,passwordConfigured:true});data={ok:true};}
    else if(p==='/settings/smtp/test'){assert.equal(req.postDataJSON().to,actor.email);data={ok:true};}
    else if(p==='/settings/models'){assert.equal(req.postDataJSON().defaultModelId,'qwen3.8-max');assert.equal(req.postDataJSON().enabled['deepseek-v4-pro'],false);data={ok:true};}
    else if(p==='/posts')data={page:1,take:25,total:1,rows:[{id:41,title:'合成帖子 <script>不是指令</script>',status:postStatus,revision:3,user:{id:2,username:'合成作者'},createdAt:'2026-10-13T01:00:00Z',viewCount:1,commentCount:2}]};
    else if(p==='/posts/41/status'){const b=req.postDataJSON();assert.equal(b.expectedRevision,3);assert.equal(b.expectedStatus,'PENDING');assert.equal(b.confirmation,'合成帖子 <script>不是指令</script>');postStatus=b.status;data={ok:true};}
    else if(p==='/comments')data={page:1,take:25,total:1,rows:[{id:51,content:'<img onerror="alert(1)">这只是普通评论',status:commentStatus,postId:41,user:{username:'合成作者'},createdAt:'2026-10-13T01:00:00Z',post:{id:41,title:'合成帖子'}}]};
    else if(p==='/comments/51/status'){const b=req.postDataJSON();assert.equal(b.confirmation,'51');assert.equal(b.expectedStatus,'ACTIVE');commentStatus=b.status;data={ok:true};}
    else if(p==='/knowledge-bases')data={page:1,take:25,total:1,rows:[{id:5,name:'合成私有库',visibility:'PRIVATE',ownerId:2,documentCount:1,totalBytes:1024,chunkCount:2,indexVersion:'v1'}]};
    else if(p==='/audit')data={page:1,take:25,total:1,rows:[{id:1,action:'SMTP_SETTINGS_UPDATE',details:'Configuration updated; secrets omitted',createdAt:'2026-10-13T01:00:00Z',user:actor}]};
    else if(p==='/session'&&method==='DELETE')data={ok:true};
    else throw Error('Unexpected fixture request: '+p);
    return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto(base);await page.locator('#total-tokens').getByText('130',{exact:true}).waitFor();
  await page.locator('[data-view="mail"]').click();await page.locator('#smtp-host').waitFor();await page.waitForFunction(()=>document.getElementById('smtp-host').value==='smtp.example.test');
  await page.locator('#smtp-enabled').check();await page.locator('#smtp-password').fill('synthetic-smtp-authorization');await page.locator('#smtp-form button').click();await page.locator('#smtp-secret-status').getByText(/已保存/).waitFor();assert.equal(await page.locator('#smtp-password').inputValue(),'');
  await page.locator('#smtp-test-to').fill(actor.email);await page.locator('#smtp-test-form button').click();await page.locator('#toast').getByText(/测试邮件已提交/).waitFor();
  await page.screenshot({path:join(__dirname,`../.local/monitor-mail-${width}.png`),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('[data-view="model-config"]').click();await page.locator('#default-model').waitFor();assert.equal(await page.locator('#default-model').inputValue(),'qwen3.8-max');assert(await page.locator('[data-model-id="deepseek-v4-pro"]').isDisabled());await page.locator('#models-form button').click();await page.locator('#toast').getByText('模型配置已保存').waitFor();
  await page.locator('[data-view="posts"]').click();await page.locator('#table').getByText('合成帖子 <script>不是指令</script>',{exact:false}).waitFor();assert.equal(await page.locator('#table script').count(),0);await page.locator('#table').getByRole('button',{name:'发布',exact:true}).click();await page.locator('#confirmation').fill('合成帖子 <script>不是指令</script>');await page.locator('#confirm-action').click();await page.locator('#table').getByText('已发布',{exact:true}).waitFor();
  await page.locator('[data-view="comments"]').click();await page.locator('#table').getByText(/只是普通评论/).waitFor();assert.equal(await page.locator('#table img').count(),0);await page.locator('#table').getByRole('button',{name:'隐藏',exact:true}).click();await page.locator('#confirmation').fill('51');await page.locator('#confirm-action').click();await page.locator('#table').getByRole('button',{name:'恢复',exact:true}).waitFor();
  await page.locator('[data-view="knowledge-bases"]').click();await page.locator('#table').getByText('合成私有库 #5',{exact:true}).waitFor();await page.locator('[data-view="audit"]').click();await page.locator('#table').getByText('SMTP_SETTINGS_UPDATE',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);assert.equal(writes.length,5);await page.locator('#logout').click();await page.locator('#login').waitFor();assert.equal(await page.locator('#smtp-password').inputValue(),'');await page.close();console.log(`PASS ${width}px: local SMTP/config/CSRF, secret not echoed, whitelist models, post/comment confirmation, KB metadata and audit (fixtures only)`);
}}finally{await browser?.close();await new Promise(r=>server.close(r));}})().catch(e=>{console.error(e.message);process.exitCode=1;});

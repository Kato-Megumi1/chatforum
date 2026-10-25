// Entirely synthetic browser data: no real account, server mutation or model call.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdirSync}=require('node:fs'),{join}=require('node:path');
const base=process.env.TOOL_APPROVAL_TEST_BASE||'http://127.0.0.1:5177/',origin=new URL(base).origin;
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Local fixture only');
const output=join(__dirname,'../.local/tool-approvals');mkdirSync(output,{recursive:true});
const user={id:99271,username:'操作确认验收',email:'tool-ui@example.test',role:'USER'};
const conversation={id:11,userId:user.id,title:'虚构操作确认',conversationType:'ASSISTANT',personaKey:'assistant'};
const runId='10000000-0000-4000-8000-000000000011',stepId='20000000-0000-4000-8000-000000000011';
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});
  const writes=[],streams=[],errors=[];let status='WAITING_APPROVAL',decision,fail=true;
  page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-tool-session',refreshToken:''})),user);
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),path=url.pathname;
   if(url.origin!==origin)return route.abort();if(!path.startsWith('/api/'))return route.continue();
   const ok=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
   if(req.method()!=='GET')writes.push({path,body:req.postDataJSON()});
   if(path==='/api/chat/config')return ok({configured:true,defaultModelId:'qwen3.8-max',models:[{id:'qwen3.8-max',label:'Qwen',available:true}]});
   if(path==='/api/chat/conversations')return ok([conversation]);
   if(path==='/api/chat/conversations/11/messages')return ok({items:status==='COMPLETED'?[
    {id:1,conversationId:11,role:'USER',content:'持续追踪虚构校园新帖'},
    {id:2,conversationId:11,role:'ASSISTANT',content:decision?'已按确认完成追踪。':'好的，没有执行这项操作。'}]:[],hasMore:false,olderCursor:null});
   if(path==='/api/chat/runs/recovery')return ok(status==='COMPLETED'?[]:[{id:runId,status,createdAt:'2026-01-01T00:00:00Z'}]);
   if(path==='/api/chat/tool-runs/approvals'){
    if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({success:false,message:'fixture unavailable'})});}
    return ok(status==='WAITING_APPROVAL'?[{id:stepId,runId,toolName:'manage_forum_tracking',state:status,argsHash:'a'.repeat(64),policyVersion:'tool-execution-v1',
     title:'新增追踪',details:{kind:'NEW_POSTS',query:'校园活动 '+'long-query'.repeat(12),cooldownSeconds:3600}}]:[]);
   }
   if(path===`/api/chat/tool-runs/${runId}/steps/${stepId}/decision`){decision=req.postDataJSON().approved;status='QUEUED';return ok({runId,status});}
   if(path===`/api/chat/runs/${runId}`)return ok({id:runId,status});
   if(path===`/api/chat/runs/${runId}/events`){
    streams.push(url.searchParams.get('offset'));status='COMPLETED';
    const text=decision?'已按确认完成追踪。':'好的，没有执行这项操作。';
    return route.fulfill({contentType:'text/event-stream',body:'event: delta\ndata: '+JSON.stringify({text,offset:text.length})+'\n\n'+
     'event: complete\ndata: '+JSON.stringify({status:'COMPLETED',result:{content:text}})+'\n\n'});
   }
   if(path==='/api/forum/notifications/unread-count')return ok({unreadCount:0});
   if(path==='/api/direct-messages/unread-count')return ok({inbox:0,requests:0,total:0});
   return ok([]);
  });
  await page.goto(base+'chat?conversationId=11');
  await page.getByText('操作确认暂时加载失败',{exact:true}).waitFor();await page.getByRole('button',{name:'重试',exact:true}).click();
  await page.locator('[data-testid="tool-approval-card"]').waitFor();
  assert.equal(writes.length,0,'opening/retrying a pending operation must not create a task');
  await page.reload();await page.locator('[data-testid="tool-approval-card"]').waitFor();
  const bounds=await page.locator('[data-testid="tool-approval-card"]').evaluate(el=>{const r=el.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth,overflow:el.scrollWidth>el.clientWidth+1};});
  assert(bounds.left>=-1&&bounds.right<=bounds.width+1&&!bounds.overflow,JSON.stringify(bounds));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(output,`approval-${width}.png`),fullPage:true});
  await page.getByRole('button',{name:'确认执行',exact:true}).click();await page.getByText('已按确认完成追踪。',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.deepEqual(writes[0].body,{approved:true,argsHash:'a'.repeat(64),policyVersion:'tool-execution-v1'});
  assert(writes.every(row=>row.path.endsWith('/decision')),'never post a replacement paid chat run');
  assert.deepEqual(streams,['0']);
  status='WAITING_APPROVAL';await page.reload();await page.locator('[data-testid="tool-approval-card"]').waitFor();
  await page.getByRole('button',{name:'不执行',exact:true}).click();await page.getByText('好的，没有执行这项操作。',{exact:true}).waitFor();
  assert.equal(writes.length,2);assert.equal(writes[1].body.approved,false);assert.deepEqual(streams,['0','0']);
  assert.deepEqual(errors,[]);await page.close();console.log(`Tool approval retry/refresh/confirm/decline ${width}px passed`);
 }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

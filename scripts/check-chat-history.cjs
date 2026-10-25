// Synthetic local UI regression only. Never uses real accounts, histories or models.
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const {mkdirSync}=require('node:fs');
const {join}=require('node:path');
const base=process.env.CHAT_HISTORY_TEST_BASE||'http://127.0.0.1:5177/';
const origin=new URL(base).origin;
assert(['localhost','127.0.0.1'].includes(new URL(base).hostname),'Local fixture preview only');
const output=join(__dirname,'../.local/chat-history');mkdirSync(output,{recursive:true});
const user={id:99117,username:'历史分页验收',email:'history@example.test',role:'USER'};
const conversation={id:11,userId:user.id,title:'虚构长会话',conversationType:'ASSISTANT',personaKey:'assistant',createdAt:'2026-01-01T00:00:00Z'};
const rows=(from,to)=>Array.from({length:to-from+1},(_,i)=>({id:from+i,conversationId:11,role:(from+i)%2?'USER':'ASSISTANT',
  content:`虚构历史消息 #${from+i}。\n`+'这是仅用于分页与滚动位置验收的段落。'.repeat(4),createdAt:'2026-01-01T00:00:00Z'}));

(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});
    const reads=[],writes=[],errors=[];let releaseOld;
    page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-history',refreshToken:''})),user);
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),path=url.pathname;
      if(url.origin!==origin)return route.abort();
      if(!path.startsWith('/api/'))return route.continue();
      if(route.request().method()!=='GET')writes.push(path);
      const ok=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
      if(path==='/api/chat/config')return ok({configured:true,defaultModelId:'qwen3.8-max',models:[{id:'qwen3.8-max',label:'Qwen',available:true}]});
      if(path==='/api/chat/conversations')return ok([conversation]);
      if(path==='/api/chat/conversations/11/messages'){
        assert.equal(url.searchParams.get('pagination'),'seek');assert.equal(url.searchParams.get('limit'),'40');
        const params=Object.fromEntries(url.searchParams);reads.push(params);
        if(params.before){await new Promise(resolve=>{releaseOld=resolve;});return ok({items:rows(61,100),hasMore:false,olderCursor:null});}
        if(params.around)return ok({items:rows(1,40),hasMore:false,olderCursor:null,anchorId:Number(params.around)});
        return ok({items:rows(101,140),hasMore:true,olderCursor:'fixture-signed-101'});
      }
      if(path==='/api/forum/notifications/unread-count')return ok({unreadCount:0});
      if(path==='/api/direct-messages/unread-count')return ok({inbox:0,requests:0,total:0});
      return ok([]);
    });
    await page.goto(base+'chat?conversationId=11');
    await page.locator('[data-message-id="140"]').waitFor();await page.waitForTimeout(350);
    assert.equal(await page.locator('[data-message-id]').count(),40);assert.equal(reads.length,1);
    const before=await page.locator('.chat-messages').evaluate(element=>{
      element.style.scrollBehavior='auto';element.scrollTop=30;
      return element.querySelector('[data-message-id="101"]').getBoundingClientRect().top;
    });
    await page.waitForFunction(()=>document.querySelector('.history-pagination button')?.classList.contains('is-loading'));
    assert.equal(reads.length,2);assert.equal(reads[1].before,'fixture-signed-101');releaseOld();
    await page.locator('[data-message-id="61"]').waitFor();await page.waitForTimeout(150);
    const after=await page.locator('[data-message-id="101"]').evaluate(element=>element.getBoundingClientRect().top);
    assert(Math.abs(after-before)<3,`${width}px prepend shifted visible anchor by ${after-before}px`);
    assert.equal(await page.locator('[data-message-id]').count(),80);
    await page.screenshot({path:join(output,`history-prepend-${width}.png`),fullPage:true});
    await page.goto(base+'chat?conversationId=11&messageId=20');
    await page.locator('[data-message-id="20"]').waitFor();await page.waitForTimeout(350);
    const anchor=await page.locator('[data-message-id="20"]').evaluate(element=>{
      const r=element.getBoundingClientRect(),parent=element.closest('.chat-messages').getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,containerTop:parent.top,containerBottom:parent.bottom};
    });
    await page.screenshot({path:join(output,`history-source-${width}.png`),fullPage:true});
    assert(anchor.bottom>anchor.containerTop&&anchor.top<anchor.containerBottom,'source anchor must be visible: '+JSON.stringify(anchor));
    assert(reads.some(read=>read.around==='20'));assert.equal(writes.length,0,'reading history cannot create a paid task');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(errors,[]);
    await page.screenshot({path:join(output,`history-source-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'回到最新消息',exact:true}).click();
    await page.locator('[data-message-id="140"]').waitFor();
    assert.equal(new URL(page.url()).searchParams.has('messageId'),false);
    assert.equal(await page.locator('[data-message-id]').count(),40);
    assert.equal(writes.length,0,'returning to the latest page is still a read');
    await page.close();console.log(`Chat seek/anchor/source ${width}px passed`);
  }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

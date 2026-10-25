// Intercepted APIs and fictional histories only. No account creation, model calls or real messages.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.NAV_TEST_BASE||'http://127.0.0.1:4173/';
const hash=process.env.NAV_TEST_HASH==='1',origin=new URL(base).origin;
const api=new URL(process.env.NAV_TEST_API||'/api',base).href.replace(/\/$/,'');
const route=path=>base.replace(/\/?$/,'/')+(hash?'#/':'')+path;
const user={id:99041,username:'导航验收',email:'navigation@example.test',role:'USER',level:1,points:0};
const conversations=[{id:1,conversationType:'LEGACY',title:'置顶旧历史',isPinned:true},
  {id:2,conversationType:'ROLEPLAY',title:'角色会话',personaKey:'kato_megumi_persona',personaLabel:'加藤惠'},
  {id:3,conversationType:'ASSISTANT',title:'普通 AI 会话'},{id:4,conversationType:'ASSISTANT',title:'另一条 AI 会话'}]
  .map(c=>({...c,userId:user.id,updatedAt:'2026-09-22T10:00:00Z'}));
const post={id:991,title:'虚构帖子',content:'仅用于导航验收的帖子内容',user,category:{id:1,name:'测试分类'},tags:[],createdAt:'2026-09-22T10:00:00Z',viewCount:1,likeCount:0,commentCount:0};
const storageKey='chatforum-chat-navigation-v1';
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(15000);
 const errors=[],requests=[],writes=[];let records=conversations;
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async r=>{const url=new URL(r.request().url());
  if(r.request().url().startsWith(api+'/')){const p=url.pathname;requests.push(p);let data=[];
   if(r.request().method()==='OPTIONS')return r.fulfill({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'}});
   if(r.request().method()!=='GET')writes.push(p);
   if(p==='/api/auth/login')data={user,accessToken:'synthetic-navigation',refreshToken:''};
   if(p==='/api/chat/config')data={configured:true,defaultModelId:'deepseek-v4-pro',models:[{id:'deepseek-v4-pro',available:true}]};
   if(p==='/api/chat/conversations')data=records;
   const messages=p.match(/^\/api\/chat\/conversations\/(\d+)\/messages$/);
   if(messages){const id=Number(messages[1]);data=Array.from({length:36},(_,i)=>({id:id*100+i,conversationId:id,role:i%2?'ASSISTANT':'USER',
     content:i%2?`会话 ${id} 第 ${i} 条虚构回复。\n\n[查看帖子 ${i}](/forum/post/991)\n\n仅用于测试恢复阅读位置，不是真实聊天。`:`会话 ${id} 第 ${i} 条虚构问题。`}));}
   if(p==='/api/forum/posts')data={data:[post],total:1};
   if(p==='/api/forum/posts/991')data=post;
   if(p==='/api/forum/posts/991/comments')data={data:[],total:0,activeCount:0};
   return r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:true,data})});
  }
  return url.origin===origin?r.continue():r.abort();
 });
 const nav=async name=>{if(width<900)await page.locator('.mobile-tabbar a').filter({hasText:name==='AI 对话'?'对话':'社区'}).click();
   else await page.getByRole('menuitem',{name,exact:true}).click();};
 const sidebar=async()=>{if(width<900 && !(await page.locator('.chat-sidebar').getAttribute('class')).includes('mobile-open'))await page.getByRole('button',{name:'对话列表',exact:true}).click();};
 const closeSidebar=async()=>{if(width<900 && (await page.locator('.chat-sidebar').getAttribute('class')).includes('mobile-open'))await page.getByRole('button',{name:'关闭对话列表',exact:true}).click({position:{x:width-10,y:100}});};
 const selected=async(id,space)=>{await page.waitForFunction(({id,space,key})=>{const saved=JSON.parse(sessionStorage.getItem(key)||'{}');
   return saved.conversationId===id&&saved.space===space&&!!document.querySelector('.message-text')?.textContent?.includes(`会话 ${id} `);},{id,space,key:storageKey});};
 await page.goto(route(''));await page.locator('.forum-container').waitFor();assert.equal(page.url(),route('forum'));assert.equal(requests.some(p=>p.includes('/chat/conversations')),false);
 await page.goto(route('login'));await page.getByPlaceholder('请输入邮箱',{exact:true}).fill(user.email);
 await page.getByPlaceholder('请输入密码',{exact:true}).fill('Synthetic-pass-123');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.locator('.forum-container').waitFor();assert.equal(page.url(),route('forum'));
 await nav('AI 对话');await selected(3,'ASSISTANT');assert(!requests.includes('/api/chat/conversations/1/messages'));
 await sidebar();await page.getByRole('tab',{name:'角色对话',exact:true}).click();await selected(2,'ROLEPLAY');await closeSidebar();
 await page.locator('.chat-textarea textarea').fill('暂未发送的虚构草稿');
 const link=page.getByRole('link',{name:'查看帖子 13',exact:true});await link.scrollIntoViewIfNeeded();
 // Wait for the browser's smooth scroll to settle before recording the position.
 await page.waitForFunction(()=>{const n=document.querySelector('.chat-messages').scrollTop,now=performance.now();
   const previous=window.__navScrollProbe;
   if(!previous||previous.n!==n){window.__navScrollProbe={n,at:now};return false;}
   return n>0&&now-previous.at>150;});
 let top=await page.locator('.chat-messages').evaluate(el=>el.scrollTop);await page.evaluate(()=>window.__spaNavigationMarker='retained');
 await link.click();await page.getByText(post.content,{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__spaNavigationMarker),'retained','post link should not reload document');
 const savedTop=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).scroll[2],storageKey);
 // Focusing/clicking the link can adjust the source scroller a few pixels. Assert that
 // the departure point is still the same reading position, then restore that exact point.
 assert(Math.abs(savedTop-top)<24,'opening a post must not jump away from the source message');top=savedTop;
 await page.locator('.el-page-header__left').click();await selected(2,'ROLEPLAY');
 try { await page.waitForFunction(top=>Math.abs(document.querySelector('.chat-messages').scrollTop-top)<3,top); }
 catch(e) { console.log('Scroll diagnostics', {expected:top,...await page.evaluate(key=>({top:document.querySelector('.chat-messages').scrollTop,saved:JSON.parse(sessionStorage.getItem(key))}),storageKey)});throw e; }
 assert.equal(await page.locator('.chat-textarea textarea').inputValue(),'暂未发送的虚构草稿');
 await page.getByRole('link',{name:'查看帖子 13',exact:true}).click();await page.getByText(post.content,{exact:true}).waitFor();
 top=await page.evaluate(key=>JSON.parse(sessionStorage.getItem(key)).scroll[2],storageKey);
 await nav('AI 对话');await selected(2,'ROLEPLAY');await page.waitForFunction(top=>Math.abs(document.querySelector('.chat-messages').scrollTop-top)<3,top);
 await page.reload();await selected(2,'ROLEPLAY');await page.waitForFunction(top=>Math.abs(document.querySelector('.chat-messages').scrollTop-top)<3,top);
 assert.equal(await page.locator('.chat-textarea textarea').inputValue(),'','drafts must not persist to browser storage');
 await sidebar();await page.getByRole('tab',{name:'旧历史',exact:true}).click();await selected(1,'LEGACY');await closeSidebar();
 await nav('社区论坛');await page.locator('.forum-container').waitFor();await nav('AI 对话');await selected(1,'LEGACY'); // Explicit history is still accessible.
 // Separate first visits: legacy-only and empty accounts must show an ordinary-AI empty state without creating a conversation.
 for(const remaining of [conversations.slice(0,1),[]]){
   await nav('社区论坛');await page.locator('.forum-container').waitFor();
   records=remaining;requests.length=0;await page.evaluate(key=>sessionStorage.removeItem(key),storageKey);await page.reload();await page.locator('.forum-container').waitFor();await page.goto(route('chat'));
   await page.getByRole('heading',{name:'有什么我能帮你的吗？',exact:true}).waitFor();assert(!requests.includes('/api/chat/conversations/1/messages'));
 }
 records=conversations;
 for(const saved of [{userId:user.id,space:'LEGACY',conversationId:999,scroll:{}},{userId:123,space:'LEGACY',conversationId:1,scroll:{}}]){
   await nav('社区论坛');await page.locator('.forum-container').waitFor();
   await page.evaluate(({key,saved})=>sessionStorage.setItem(key,JSON.stringify(saved)),{key:storageKey,saved});await page.reload();await page.locator('.forum-container').waitFor();await page.goto(route('chat'));await selected(3,'ASSISTANT');
 }
 assert.deepEqual(writes,['/api/auth/login']);assert.deepEqual(errors,[]);
 console.log(`PASS ${width}px ${hash?'Pages':'Docker'}: forum landing/login, AI default, in-app post navigation, back/tab/refresh scroll restoration, in-memory draft, explicit legacy, empty/stale/cross-user safeguards`);
 await page.close();
}
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

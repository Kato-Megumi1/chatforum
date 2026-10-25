// Every API request is intercepted. Fixtures contain no real accounts or user content.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.FORUM_TEST_BASE||'http://127.0.0.1:4175/',hash=process.env.FORUM_TEST_HASH==='1';
const origin=new URL(base).origin;
const user={id:99081,username:'论坛体验验收',email:'forum@example.test',role:'USER',level:1,points:0,bio:'虚构账号，仅用于验收'};
const category=[{id:1,name:'校园生活',_count:{posts:80}},{id:2,name:'学习交流',_count:{posts:60}}];
const makePost=(id)=>({id,user,userId:user.id,title:'论坛验收帖子 '+id,summary:'这是纯文本摘要，用于验证手机和桌面的阅读层级。'.repeat(3),content:'正常输入的帖子正文。\n第二段保留换行。',contentFormat:'plain',revision:2,categoryId:1,category:category[0],tags:[],createdAt:'2026-10-13T01:00:00Z',lastReplyAt:'2026-10-13T02:00:00Z',viewCount:8,commentCount:7,likeCount:0,status:'APPROVED'});
const headers={'Access-Control-Allow-Origin':'*'},dest=path=>base+(hash?'#':'')+path.replace(/^\//,'');
const edgesOnly=process.env.FORUM_TEST_CASES==='edges';
const securityOnly=process.env.FORUM_TEST_CASES==='security';
function response(data){return {contentType:'application/json',headers,body:JSON.stringify({success:true,data})};}
async function navigate(page,path,leaveDraft=false){
 if(!hash||page.url()==='about:blank')return page.goto(dest(path));
 const navigation=page.evaluate(path=>document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path).then(()=>true),path).then(()=>null,error=>error);
 if(leaveDraft)await page.getByRole('dialog').filter({hasText:'离开编辑页面？'}).getByRole('button',{name:'离开',exact:true}).click();
 const error=await navigation;if(error)throw error;
 if(leaveDraft)await page.waitForFunction(()=>[...document.querySelectorAll('.el-message-box')].every(element=>element.getClientRects().length===0));
}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900}); page.setDefaultTimeout(10000);
 const errors=[],queries=[],writes=[];let serial=30,unread=2,commentAdds=0,replyAdds=0,failEdit=true,createdId=0,slowRepliesNext=false,slowCommentsNext=false;
 let deleteStartedResolve;const deleteStarted=new Promise(resolve=>deleteStartedResolve=resolve);
 const replies=Array.from({length:5},(_,i)=>({id:11+i,user,content:'已有回复 '+(i+1),createdAt:'2026-10-13T02:00:00Z',status:'ACTIVE',canDelete:true,parentId:1}));
 const root={id:1,user,content:'这是已有讨论',createdAt:'2026-10-13T01:00:00Z',status:'ACTIVE',canDelete:true,replyCount:5,replies:replies.slice(0,3)};
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(user=>{localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-forum-token',refreshToken:''}));},user);
 await page.route('**/*',async r=>{const req=r.request(),url=new URL(req.url());
  if(url.pathname.startsWith('/api/')){
   const p=url.pathname,m=req.method(),body=['GET','OPTIONS','DELETE'].includes(m)?null:req.postDataJSON();
   if(m==='OPTIONS')return r.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS'}});
   if(m!=='GET')writes.push({p,m,body});let data=[];
   if(p==='/api/forum/categories')data=category;if(p==='/api/forum/tags')data=[{id:1,name:'校园讨论'},{id:2,name:'学习'}];
   if(p==='/api/forum/tag-options')data={data:[{id:1,name:'校园讨论'},{id:2,name:'学习'}],hasMore:false,nextCursor:null,limit:30};
   if(p==='/api/forum/feed'&&m==='GET'){
    queries.push(Object.fromEntries(url.searchParams));const cat=url.searchParams.get('categoryId'),cursor=url.searchParams.get('cursor')||'synthetic-start';
    if(cat==='1')await new Promise(resolve=>setTimeout(resolve,450));
    data={data:Array.from({length:20},(_,i)=>({...makePost(i+1),title:(cat==='1'?'旧分类':cat==='2'?'新分类':'论坛验收帖子')+' '+(i+1)})),hasMore:true,nextCursor:cursor==='synthetic-start'?'synthetic-page-2':'synthetic-page-3',pageCursor:cursor,asOf:'2026-10-14T01:00:00Z',snapshot:null,total:null};
   }
   if(p==='/api/forum/posts'&&m==='GET'){
    queries.push(Object.fromEntries(url.searchParams));
    const cat=url.searchParams.get('categoryId');
    if(cat==='1')await new Promise(resolve=>setTimeout(resolve,450));
    data={data:Array.from({length:20},(_,i)=>({...makePost(i+1),title:(cat==='1'?'旧分类':cat==='2'?'新分类':'论坛验收帖子')+' '+(i+1)})),total:140};
   }
   if(p==='/api/forum/posts'&&m==='POST'){assert.equal(body.contentFormat,'plain');createdId=101;data={...makePost(createdId),...body};}
   if(/^\/api\/forum\/posts\/\d+$/.test(p)){
    const id=Number(p.split('/').at(-1));data=makePost(id);
    if(edgesOnly&&id===1)data={...data,contentFormat:'markdown',content:'[另一个帖子](/forum/post/2)'};
    if(id===77)data={...data,contentFormat:'markdown',content:'# 旧帖排版\n\n[查看另一帖](/forum/post/1)\n\n![旧帖图片](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)\n\n<img src="x" onerror="window.__legacyXss=1"><script>window.__legacyXss=1</script>\n\n[恶意链接](javascript:alert(1))'};
    if(m==='PUT'){assert.equal(body.expectedRevision,2);assert.equal(body.contentFormat,id===77?'markdown':'plain');if(failEdit){failEdit=false;return r.fulfill({status:409,contentType:'application/json',headers,body:JSON.stringify({message:'帖子已更新，请合并最新内容'})});}data={...data,...body,revision:3};}
   }
   if(/^\/api\/forum\/posts\/\d+\/view$/.test(p))data={counted:false,viewCount:8,viewerToken:'synthetic-signed-viewer'};
   if(/^\/api\/forum\/posts\/\d+\/comments$/.test(p)){
    if(url.searchParams.get('commentId')==='999')return r.fulfill({status:404,contentType:'application/json',headers,body:JSON.stringify({message:'评论不存在'})});
    if(m==='POST'){data={id:++serial,user,content:body.content,parentId:body.parentId||null,postId:1,createdAt:'2026-10-13T03:00:00Z',status:'ACTIVE',canDelete:true,replies:[],replyCount:0,likeCount:0};if(body.parentId)replyAdds++;else commentAdds++;}
    else if(url.searchParams.has('parentId')){data={data:structuredClone(replies),total:5,page:1};if(slowRepliesNext){slowRepliesNext=false;await new Promise(resolve=>setTimeout(resolve,500));}}
    else {data={data:[structuredClone(root)],total:1,activeCount:7,page:1,focusId:url.searchParams.has('commentId')?13:null};if(edgesOnly&&p.includes('/posts/2/')){data.data[0].content='第二帖当前讨论';await new Promise(resolve=>setTimeout(resolve,500));}if(slowCommentsNext){slowCommentsNext=false;await new Promise(resolve=>setTimeout(resolve,500));}}
   }
   if(p==='/api/forum/comments/1'&&m==='DELETE'){deleteStartedResolve();await new Promise(resolve=>setTimeout(resolve,250));data={deleted:true};}
   if(p==='/api/forum/notifications/unread-count')data={unreadCount:unread};
   if(p==='/api/forum/notifications')data={data:[{id:1,title:'有人回复了你',content:'社区成员回复了你的讨论。',createdAt:'2026-10-13T02:00:00Z',isRead:!unread,url:'/forum/post/1?comment=13'}],total:41,unreadCount:unread};
   if(p==='/api/forum/notifications/read-all'){unread=0;data={updated:2};}
   if(/^\/api\/forum\/notifications\/\d+\/read$/.test(p)){unread=Math.max(0,unread-1);data={id:1,isRead:true};}
   if(p==='/api/forum/me/posts'||p==='/api/forum/me/favorites')data={data:[makePost(1)],total:1};
   if(p==='/api/forum/me/replies')data={data:[{...root,post:{id:1,title:'我参与的帖子',status:'APPROVED'}}],total:1};
   if(p==='/api/forum/me/following')data={data:[{...user,id:99082,username:'关注验收成员'}],total:1};
   if(/^\/api\/users\/\d+$/.test(p))data={...user,_count:{posts:20,followers:0,following:1}};
   return r.fulfill(response(data));
  }
  // Only public same-origin static GETs reach the network; every API call above is synthetic.
  if(url.origin===origin&&req.method()==='GET')return r.continue();return r.abort();
 });
 try {
 if(securityOnly){
  await page.goto(dest('/forum/post/77'));await page.locator('.legacy-content h1').waitFor();assert.equal(await page.locator('.legacy-content h1').innerText(),'旧帖排版');
  assert.equal(await page.locator('.legacy-content img').count(),2,'legacy images preserved');assert.equal(await page.locator('.legacy-content script, .legacy-content [onerror], .legacy-content a[href^="javascript:"]').count(),0,'legacy HTML sanitized');assert.equal(await page.evaluate(()=>window.__legacyXss),undefined);
  await page.getByRole('link',{name:'查看另一帖',exact:true}).click();await page.getByRole('heading',{name:'论坛验收帖子 1',exact:true}).waitFor();
  assert.deepEqual(errors,[]);console.log('PASS '+width+'px: patched Vue/DOMPurify preserves legacy headings/images/internal navigation and removes script/onerror/javascript; synthetic APIs only');await page.close();continue;
 }
 if(edgesOnly){
  await page.goto(dest('/forum/post/1'));await page.locator('#comment-1').waitFor();await page.locator('#comment-1 > .comment-body > .comment-actions').getByRole('button',{name:'删除',exact:true}).click();
  await page.getByRole('dialog').getByRole('button',{name:'删除',exact:true}).click();await deleteStarted;
  await page.getByRole('link',{name:'另一个帖子',exact:true}).click();await page.getByText('第二帖当前讨论',{exact:true}).waitFor();
  assert.equal(await page.locator('.discussion-heading h2 span').innerText(),'7','late DELETE cannot decrement the new post count or invalidate its comments GET');
  await page.locator('.comments > .el-loading-mask').waitFor({state:'hidden'});
  await page.goto(dest('/forum/post/1?comment=999'));await page.getByText('这条评论已不可访问，以下是帖子的当前讨论。',{exact:true}).waitFor();await page.getByText('这是已有讨论',{exact:true}).waitFor();
  await page.locator('.comments > .el-loading-mask').waitFor({state:'hidden'});
  assert.deepEqual(errors,[]);console.log('PASS '+width+'px: pending DELETE route change isolation, deleted notification anchor 404 fallback, synthetic APIs only');await page.close();continue;
 }
 await page.goto(dest('/forum?page=3'));await page.locator('.post-card').first().waitFor();
 await page.locator('.category-item').filter({hasText:'校园生活'}).click();await page.locator('.category-item').filter({hasText:'学习交流'}).click();
 await page.getByRole('link',{name:/新分类 1 /}).first().waitFor();await page.waitForTimeout(550);
 assert(await page.locator('.post-title').first().innerText()==='新分类 1','stale category request must not overwrite results');
 assert(queries.filter(q=>q.categoryId).every(q=>!q.page&&!q.cursor),'category changes reset seek cursors without OFFSET');
 await page.goto(dest('/forum'));await page.locator('.post-card').nth(7).waitFor();await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('第 2 页',{exact:true}).waitFor();await page.locator('.post-card').nth(7).waitFor();
 await page.locator('.forum-container').evaluate(el=>el.scrollTop=700);await page.waitForTimeout(100);
 await page.locator('.post-card').nth(7).click();await page.locator('.discussion').waitFor();
 const saved=await page.evaluate(id=>JSON.parse(sessionStorage.getItem('chatforum-forum-navigation-v1:'+id)),user.id);
 await page.locator('.el-page-header__left').click();await page.locator('.post-card').nth(7).waitFor();
 await page.waitForFunction(scroll=>Math.abs(document.querySelector('.forum-container').scrollTop-scroll)<4,saved.scroll);
 assert(new URL(page.url()).searchParams.get('page')==='2'||new URL(page.url()).hash.includes('page=2'),'return restores page');
 await page.getByRole('button',{name:'上一页',exact:true}).click();await page.getByText('第 1 页',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.forum-container').scrollTop===0);
 await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByText('第 2 页',{exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('.forum-container').scrollTop===0);
 await page.goto(dest('/forum/post/1'));await page.getByRole('button',{name:'查看全部 5 条回复'}).click();await page.getByText('已有回复 5',{exact:true}).waitFor();
 await page.getByRole('textbox',{name:'评论内容'}).fill('**正常论坛输入**\n第二行');await page.getByRole('button',{name:'发表评论',exact:true}).click();
 await page.getByText('**正常论坛输入**',{exact:false}).waitFor();assert.equal(await page.getByText('已有回复 5',{exact:true}).count(),1,'new comment preserves expanded replies');
 await page.getByRole('button',{name:'回复',exact:true}).last().click();await page.getByRole('textbox',{name:'回复内容'}).fill('我的新回复');await page.getByRole('button',{name:'发送回复',exact:true}).click();await page.getByText('我的新回复',{exact:true}).waitFor();
 assert.equal(await page.getByText('已有回复 5',{exact:true}).count(),1);assert.equal(commentAdds,1);assert.equal(replyAdds,1);
 // A slow pre-mutation reply snapshot must never erase a newly posted reply.
 await page.goto(dest('/forum/post/1'));slowRepliesNext=true;await page.getByRole('button',{name:'查看全部 5 条回复'}).click();
 await page.getByRole('button',{name:'回复',exact:true}).click();await page.getByRole('textbox',{name:'回复内容'}).fill('并发回复不会消失');await page.getByRole('button',{name:'发送回复',exact:true}).click();await page.getByText('并发回复不会消失',{exact:true}).waitFor();await page.waitForTimeout(600);
 assert.equal(await page.getByText('并发回复不会消失',{exact:true}).count(),1,'late reply GET does not overwrite mutation');await page.getByRole('button',{name:'查看全部 6 条回复'}).waitFor();
 // A successful fast POST invalidates an old comment GET and clears its loading mask.
 slowCommentsNext=true;await page.locator('.discussion-heading .el-select').click();await page.getByRole('option',{name:'最早优先',exact:true}).click();
 await page.getByRole('textbox',{name:'评论内容'}).fill('并发评论验收');await page.getByRole('button',{name:'发表评论',exact:true}).click();await page.getByText('并发评论验收',{exact:true}).waitFor();await page.waitForTimeout(600);
 assert.equal(await page.locator('.comments > .el-loading-mask').count(),0,'invalidated read cannot leave a permanent loading mask');assert.equal(await page.getByText('并发评论验收',{exact:true}).count(),1);
 await page.getByRole('button',{name:'编辑帖子',exact:true}).click();await page.getByRole('textbox',{name:'帖子内容'}).fill('编辑内容\n保留换行');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.getByText('帖子已被其他页面修改，你的草稿仍在。请先查看最新内容再决定如何合并。').waitFor();
 assert.equal(await page.getByRole('textbox',{name:'帖子内容'}).inputValue(),'编辑内容\n保留换行','409 preserves draft');
 await navigate(page,'/forum/create',true);
 await page.getByRole('heading',{name:'发布帖子',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('chatforum-post-draft-v1:99081:1')||'null')?.postId),'1','edit draft retains its original post after leaving for create');
 await page.getByPlaceholder('请输入帖子标题').fill('自动草稿验收');await page.getByRole('textbox',{name:'帖子内容'}).fill('无需Markdown，直接写帖子。\n换行就会保留。');
 await page.getByText(/草稿已保存/).waitFor();await page.reload();await page.getByText('已恢复上次草稿').waitFor();assert.equal(await page.getByRole('textbox',{name:'帖子内容'}).inputValue(),'无需Markdown，直接写帖子。\n换行就会保留。');
 await page.locator('.post-form .el-select').first().click();await page.getByRole('option',{name:'校园生活',exact:true}).click();await page.getByRole('button',{name:'预览',exact:true}).click();assert(await page.locator('.plain-preview').innerText()==='无需Markdown，直接写帖子。\n换行就会保留。');
 await page.getByRole('button',{name:'发布帖子',exact:true}).click();await page.locator('.discussion').waitFor();assert.equal(createdId,101);
 assert.equal(await page.evaluate(id=>localStorage.getItem('chatforum-post-draft-v1:'+id+':new'),user.id),null,'success removes saved draft');
 await page.goto(dest('/forum/post/77'));await page.locator('.legacy-content h1').waitFor();assert.equal(await page.locator('.legacy-content h1').innerText(),'旧帖排版');
 assert.equal(await page.locator('.legacy-content img').count(),2,'legacy images preserved');assert.equal(await page.locator('.legacy-content script, .legacy-content [onerror], .legacy-content a[href^="javascript:"]').count(),0,'legacy HTML sanitized');assert.equal(await page.evaluate(()=>window.__legacyXss),undefined);
 await page.getByRole('button',{name:'编辑帖子',exact:true}).click();await page.getByRole('textbox',{name:'帖子内容'}).fill('# 修改旧帖\n原有格式保留');await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.locator('.legacy-content').waitFor();
 await page.getByRole('link',{name:'查看另一帖',exact:true}).click();await page.locator('.post-card h1').filter({hasText:'论坛验收帖子 1'}).waitFor();
 await page.goto(dest('/notifications'));await page.getByText('有人回复了你',{exact:true}).waitFor();await page.getByRole('button',{name:'查看详情',exact:true}).click();await page.locator('#comment-13.new-comment').waitFor();
 await page.goto(dest('/notifications'));await page.getByRole('button',{name:'全部已读',exact:true}).click();await page.getByText('0 条未读',{exact:true}).waitFor();
 await page.goto(dest('/user/profile'));await page.getByRole('link',{name:/论坛验收帖子 1/}).waitFor();await page.getByRole('tab',{name:'我的回复',exact:true}).click();await page.getByRole('link',{name:/我参与的帖子/}).waitFor();await page.getByRole('tab',{name:'我的收藏',exact:true}).click();await page.getByRole('link',{name:/论坛验收帖子 1/}).waitFor();await page.getByRole('tab',{name:'我的关注',exact:true}).click();await page.getByText('关注验收成员',{exact:true}).waitFor();
 for(const path of ['/forum','/notifications','/user/profile','/user/99081']){
  await page.goto(dest(path));await page.locator('.main-content').waitFor();await page.waitForTimeout(100);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),path+' horizontal overflow at '+width);
 }
 await page.goto(dest('/forum'));await page.locator('.post-card').first().waitFor();await page.addStyleTag({content:'*{transition:none!important;animation:none!important}'});
 await page.screenshot({path:'.local/forum-experience-'+width+'.png'});
 assert.deepEqual(errors,[],'browser has no uncaught errors');assert(writes.every(w=>w.p.startsWith('/api/forum/')),'every simulated write stays inside the intercepted forum fixture');assert(!writes.some(w=>w.p.startsWith('/api/chat')),'never calls models');
 console.log('PASS '+width+'px: filter race/page/scroll, plain comments/replies, edit conflict, auto-draft, notification anchor/read-all, personal collections, no real APIs');await page.close();
 } catch(error) {
  console.error('SYNTHETIC_DIAGNOSTIC '+JSON.stringify(await page.evaluate(()=>({url:location.href,label:document.querySelector('.draft-state')?.textContent,title:document.querySelector('.post-form input')?.value,content:document.querySelector('.post-form textarea')?.value,drafts:['new','1'].map(post=>({post,value:JSON.parse(localStorage.getItem('chatforum-post-draft-v1:99081:'+post)||'null')})),dialogs:[...document.querySelectorAll('[role="dialog"]')].map(el=>el.textContent)}))));
  console.error('SYNTHETIC_PAGE_ERRORS '+JSON.stringify(errors));console.error('SYNTHETIC_ROUTER '+JSON.stringify(await page.evaluate(()=>document.querySelector('#app').__vue_app__.config.globalProperties.$router.currentRoute.value.fullPath)));
  await page.screenshot({path:'.local/forum-experience-failure-'+width+'.png'});throw error;
 }
}
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

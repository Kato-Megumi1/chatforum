// Synthetic accounts/messages and intercepted API calls only; no models or live user content.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.FORUM_LINK_TEST_BASE||'http://127.0.0.1:4173/';
const hash=process.env.FORUM_LINK_TEST_HASH==='1',origin=new URL(base).origin;
const api=new URL(process.env.FORUM_LINK_TEST_API||'/api',base).href.replace(/\/$/,'');
const route=path=>base.replace(/\/?$/,'/')+(hash?'#/':'')+path;
const user={id:99031,username:'论坛工具虚构验收',email:'forum@example.test',role:'USER'};
const post={id:991,title:'虚构热帖详情',content:'虚构帖子内容',user,category:{id:1,name:'测试分类'},tags:[],createdAt:new Date().toISOString(),viewCount:1,likeCount:0,commentCount:0};
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const width of [390,1440]){const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-forum-link-token',refreshToken:''})),user);
await page.route('**/*',async r=>{const url=new URL(r.request().url());if(r.request().url().startsWith(api+'/')){const p=url.pathname;let data=[];
if(p==='/api/chat/config')data={configured:true,defaultModelId:'deepseek-v4-pro',models:[{id:'deepseek-v4-pro',available:true}]};
if(p==='/api/chat/conversations')data=[{id:991,userId:user.id,title:'虚构论坛查询',conversationType:'ASSISTANT',personaKey:'assistant'}];
if(p==='/api/chat/conversations/991/messages')data=[{id:1,conversationId:991,role:'USER',content:'看看热帖'},
{id:2,conversationId:991,role:'ASSISTANT',content:'[虚构热帖详情](/forum/post/991)\n\n[外部参考](https://example.test/article)\n\n[非法链接](javascript:alert(1))',ragMetadata:{state:'general'}}];
if(p==='/api/forum/posts/991')data=post;
if(p==='/api/forum/posts/991/comments')data={data:[],total:0,activeCount:0};
return r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:true,data})});}
return url.origin===origin?r.continue():r.abort();});
await page.goto(route('chat'));await page.locator('.conversation-item').filter({hasText:'虚构论坛查询'}).waitFor();
if(width<900)await page.getByRole('button',{name:'对话列表',exact:true}).click();
await page.locator('.conversation-item').filter({hasText:'虚构论坛查询'}).click();
const link=page.locator('.message-text a').filter({hasText:'虚构热帖详情'});await link.waitFor();
const target=await link.getAttribute('href');assert.equal(new URL(target,base).href,route('forum/post/991'));
assert.equal(await page.locator('.message-text a').filter({hasText:'外部参考'}).getAttribute('href'),'https://example.test/article');
assert.equal(await page.locator('.message-text a[href^="javascript:"]').count(),0);
await link.click();await page.getByText('虚构帖子内容',{exact:true}).waitFor();assert.equal(page.url(),route('forum/post/991'));
assert.deepEqual(errors,[]);console.log(`PASS ${width}px ${hash?'Pages':'Docker'}: safe clickable forum source opens matching detail; external URL unchanged`);await page.close();}
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

// Browser contract regression with synthetic accounts. Every API request is intercepted.
// Production must ignore poisoned overrides; development must retain its local editor.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.CONNECTION_TEST_BASE||'http://127.0.0.1:4173/';
const dev=process.env.CONNECTION_TEST_DEV==='1',hash=process.env.CONNECTION_TEST_HASH==='1';
const expected=process.env.CONNECTION_TEST_API||'/api',origin=new URL(base).origin;
const poison='https://untrusted.fixture.invalid/api',debug='http://127.0.0.1:39999/api';
const expectedApi=new URL(dev?debug:expected,base).href.replace(/\/$/,'');
const url=path=>base.replace(/\/?$/, '/')+(hash?'#/':'')+path;
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const width of [390,1440]){const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(20000);
const calls=[],errors=[],untrusted=[];let role='USER';
const user=()=>({id:99001,username:'连接回归用户',email:'connection@example.test',role,level:1,points:0});
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(({override})=>{localStorage.setItem('chatforum-api-base',override);},{override:dev?debug:poison});
await page.route('**/*',async r=>{const requestUrl=r.request().url(),u=new URL(requestUrl);
if(requestUrl.startsWith(poison)){untrusted.push(requestUrl);return r.abort();}
if(requestUrl.startsWith(expectedApi+'/')){
calls.push({path:u.pathname,method:r.request().method()});let data=[];
if(u.pathname==='/api/auth/login')data={user:user(),accessToken:'synthetic-session',refreshToken:''};
if(u.pathname==='/api/users/profile')data=user();
if(u.pathname==='/api/chat/config')data={configured:true,defaultModelId:'deepseek-v4-pro',models:[{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',available:true}]};
if(u.pathname==='/api/health')data={status:'ok'};
return r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:true,data})});}
if(u.origin===origin)return r.continue();return r.abort();});
for(const name of ['login','register']){await page.goto(url(name),{waitUntil:'domcontentloaded'});await page.locator('.'+name+'-card').waitFor();
if(dev){await page.getByRole('button',{name:'连接设置',exact:true}).click();await page.getByRole('dialog',{name:'后端连接',exact:true}).waitFor();
assert.equal(await page.getByRole('dialog').getByRole('textbox').inputValue(),debug);
await page.getByRole('dialog').getByRole('button',{name:'测试连接',exact:true}).click();await page.getByText('连接成功',{exact:true}).waitFor();
await page.getByRole('dialog').getByRole('button',{name:/close|关闭/i}).click();}
else{assert.equal(await page.getByRole('button',{name:/连接设置/}).count(),0);await page.evaluate(()=>window.dispatchEvent(new Event('chatforum:connection-settings')));assert.equal(await page.getByRole('dialog',{name:'后端连接',exact:true}).count(),0);}}
await page.goto(url('login'));await page.getByPlaceholder('请输入邮箱',{exact:true}).fill('connection@example.test');await page.getByPlaceholder('请输入密码',{exact:true}).fill('synthetic-password-not-real');
await page.getByRole('button',{name:'登录',exact:true}).click();await page.locator('.chat-empty').waitFor();assert(calls.some(x=>x.path==='/api/auth/login'));assert(calls.some(x=>x.path==='/api/chat/config'));
for(const accountRole of ['USER','ADMIN']){role=accountRole;await page.evaluate(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-session',refreshToken:''})),user());
for(const name of ['chat','user/profile']){await page.goto(url(name));await page.locator(name==='chat'?'.chat-empty':'.profile-main').waitFor();
if(!dev){assert.equal(await page.locator('.connection,.mobile-connection-button,.mobile-profile-connection').count(),0);assert.equal(await page.getByRole('button',{name:/连接设置/}).count(),0);}
else if(width<900){if(name==='chat')await page.getByRole('button',{name:'对话列表',exact:true}).click();
await page.getByRole('button',{name:name==='chat'?'连接设置':'后端连接设置',exact:true}).click();await page.getByRole('dialog',{name:'后端连接',exact:true}).waitFor();
await page.getByRole('dialog').getByRole('button',{name:/close|关闭/i}).click();}}}
assert.deepEqual(untrusted,[]);assert.deepEqual(errors,[]);console.log(`PASS ${dev?'DEV':'PROD'} ${width}px: login/register/chat/profile, visitor/member/admin, ${calls.length} intercepted API requests, no untrusted requests`);await page.close();}
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

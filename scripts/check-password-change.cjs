// All API traffic is intercepted; no production account or credential is used.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.PASSWORD_TEST_BASE||'http://127.0.0.1:4176/',hash=process.env.PASSWORD_TEST_HASH==='1';
const origin=new URL(base).origin,api=(process.env.PASSWORD_TEST_API||new URL('/api',base).href).replace(/\/$/,'');
const user={id:99113,username:'改密验收虚构用户',email:'password@example.test',role:'USER',level:1,points:0,bio:'仅用于界面验收'};
const dest=path=>base+(hash?'#':'')+path.replace(/^\//,'');
const headers={'Access-Control-Allow-Origin':'*'},response=data=>({contentType:'application/json',headers,body:JSON.stringify({success:true,data})});
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(10000);
  const errors=[],writes=[];let denyOld=true,refreshCalls=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-password-token',refreshToken:'synthetic-password-refresh'})),user);
  await page.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(req.url().startsWith(api+'/')){
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}});
    if(url.pathname==='/api/auth/refresh'){refreshCalls++;throw Error('Wrong old password must not trigger token refresh');}
    if(url.pathname==='/api/auth/password'){
     assert.equal(req.method(),'POST');assert.equal(req.headers().authorization,'Bearer synthetic-password-token');
     const body=req.postDataJSON();assert.deepEqual(Object.keys(body).sort(),['confirmPassword','newPassword','oldPassword']);writes.push(body);
     if(denyOld)return route.fulfill({status:400,contentType:'application/json',headers,body:JSON.stringify({message:'当前密码不正确'})});
     return route.fulfill(response({requiresLogin:true,message:'密码已修改，请重新登录'}));
    }
    if(url.pathname==='/api/users/profile')return route.fulfill(response(user));
    if(url.pathname==='/api/forum/notifications/unread-count')return route.fulfill(response({unreadCount:0}));
    if(url.pathname.startsWith('/api/forum/me/'))return route.fulfill(response({data:[],total:0}));
    return route.fulfill(response([]));
   }
   if(url.origin===origin)return route.continue();return route.abort();
  });
  await page.goto(dest('/user/profile'));await page.getByRole('tab',{name:'账号安全'}).click();await page.getByRole('button',{name:'修改密码',exact:true}).click();
  const dialog=page.getByRole('dialog'),old=dialog.getByRole('textbox',{name:'当前密码',exact:true}),fresh=dialog.getByRole('textbox',{name:'新密码',exact:true}),confirm=dialog.getByRole('textbox',{name:'确认新密码',exact:true});
  await dialog.waitFor();await dialog.getByRole('button',{name:'确认修改'}).click();await page.getByText('请输入当前密码',{exact:true}).waitFor();assert.equal(writes.length,0);
  await old.fill('Fixture current secret');await fresh.fill('12345');await confirm.fill('12345');await dialog.getByRole('button',{name:'确认修改'}).click();await page.getByText(/密码至少6个字符/).waitFor();assert.equal(writes.length,0);
  await fresh.fill('中'.repeat(25));await confirm.fill('中'.repeat(25));await dialog.getByRole('button',{name:'确认修改'}).click();await page.getByText(/不能超过72字节/).waitFor();assert.equal(writes.length,0);
  await fresh.fill('  Fixture new secret  ');await confirm.fill('different fixture');await dialog.getByRole('button',{name:'确认修改'}).click();await page.getByText('两次输入的新密码不一致',{exact:true}).waitFor();assert.equal(writes.length,0);
  await confirm.fill('  Fixture new secret  ');await dialog.getByRole('button',{name:'确认修改'}).click();await page.getByText('当前密码不正确',{exact:true}).waitFor();
  assert.equal(writes.length,1);assert.equal(writes[0].newPassword,'  Fixture new secret  ');assert.equal(await old.inputValue(),'Fixture current secret');assert.equal(refreshCalls,0);
  assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('chatforum-user')).token),'synthetic-password-token');
  denyOld=false;await dialog.getByRole('button',{name:'确认修改'}).click();await page.waitForURL(url=>url.pathname==='/login'||url.hash==='#/login');
  assert.equal(writes.length,2);assert.equal(await page.getByRole('dialog').count(),0);
  await page.waitForFunction(()=>!JSON.parse(localStorage.getItem('chatforum-user')).token);
  assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));
  console.log('PASS '+width+'px: profile password dialog, input/UTF-8/equality validation, precise old-password error, literal password and safe logout; synthetic API only');await page.close();
 }
 }finally{await browser.close();}})().catch(error=>{console.error(error.message);process.exitCode=1;});

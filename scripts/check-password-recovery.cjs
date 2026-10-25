// All API calls are intercepted; emails, OTP and passwords are synthetic test values only.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.RECOVERY_TEST_BASE||'http://127.0.0.1:4175/',hash=process.env.RECOVERY_TEST_HASH==='1';
const origin=new URL(base).origin,api=(process.env.RECOVERY_TEST_API||new URL('/api',base).href).replace(/\/$/,'');
const headers={'Access-Control-Allow-Origin':'*'},dest=base+(hash?'#':'')+'login';
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(10000);
 let codeRequests=0,resetRequests=0,refreshRequests=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async r=>{const req=r.request(),url=new URL(req.url());if(req.url().startsWith(api+'/')){
  if(req.method()==='OPTIONS')return r.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST,GET,OPTIONS'}});
  const fail=(status,message)=>r.fulfill({status,contentType:'application/json',headers,body:JSON.stringify({success:false,message})});
  const ok=data=>r.fulfill({contentType:'application/json',headers,body:JSON.stringify({success:true,data})});
  if(url.pathname==='/api/auth/login')return fail(401,'邮箱或密码不正确');
  if(url.pathname==='/api/auth/refresh'){refreshRequests++;return fail(401,'不应刷新登录请求');}
  if(url.pathname==='/api/auth/password-recovery/code'){
   codeRequests++;if(codeRequests===1)return fail(503,'邮箱验证码服务尚未配置，请联系站点管理员');
   assert.equal(req.postDataJSON().email,'recovery@example.test');return ok({message:'请求已受理。若该邮箱关联可用账号，将尝试发送验证码；本响应不代表送达，未收到请稍后重试或联系管理员。',retryAfterSeconds:60,expiresInSeconds:600});
  }
  if(url.pathname==='/api/auth/password-recovery/reset'){
   resetRequests++;const body=req.postDataJSON();assert.deepEqual(Object.keys(body).sort(),['code','confirmPassword','email','newPassword']);assert.equal(body.code,'123456');assert.equal(body.newPassword,body.confirmPassword);
   if(resetRequests===1)return fail(400,'验证码无效或已过期，请重新获取');return ok({requiresLogin:true,message:'密码已重置，请使用新密码重新登录'});
  }
  return ok([]);
 }if(url.origin===origin)return r.continue();return r.abort();});
 await page.goto(dest);await page.getByPlaceholder('请输入邮箱',{exact:true}).fill('recovery@example.test');await page.getByPlaceholder('请输入密码',{exact:true}).fill('wrong synthetic password');await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.getByText('邮箱或密码不正确',{exact:true}).waitFor();assert.equal(await page.getByPlaceholder('请输入邮箱',{exact:true}).inputValue(),'recovery@example.test');assert.equal(refreshRequests,0);assert.equal(await page.getByText('登录已过期，请重新登录',{exact:true}).count(),0);
 await page.getByRole('button',{name:'忘记密码？',exact:true}).click();const dialog=page.getByRole('dialog',{name:'找回密码'});await dialog.waitFor();
 assert.equal(await dialog.getByPlaceholder('请输入注册邮箱').inputValue(),'recovery@example.test');
 await dialog.getByRole('button',{name:'获取验证码',exact:true}).click();await page.getByText('邮箱验证码服务尚未配置，请联系站点管理员',{exact:true}).waitFor();
 await dialog.getByRole('button',{name:'获取验证码',exact:true}).waitFor();assert.equal(await dialog.getByRole('button',{name:'获取验证码',exact:true}).isDisabled(),false,'503 must not pretend an OTP was sent');
 await dialog.getByRole('button',{name:'获取验证码',exact:true}).click();await dialog.getByText('请求已受理。若该邮箱关联可用账号，将尝试发送验证码；本响应不代表送达，未收到请稍后重试或联系管理员。',{exact:true}).waitFor();
 assert.equal(await dialog.getByRole('button',{name:/秒后重发/}).isDisabled(),true);
 await dialog.getByPlaceholder('6位验证码').fill('123456');await dialog.getByPlaceholder('至少6个字符').fill('new synthetic password');await dialog.getByPlaceholder('再次输入新密码').fill('different');await dialog.getByRole('button',{name:'重置密码',exact:true}).click();
 await dialog.getByText('两次输入的新密码不一致',{exact:true}).waitFor();assert.equal(resetRequests,0);
 await dialog.getByPlaceholder('再次输入新密码').fill('new synthetic password');await dialog.getByRole('button',{name:'重置密码',exact:true}).click();await page.getByText('验证码无效或已过期，请重新获取',{exact:true}).waitFor();assert.equal(await dialog.isVisible(),true);
 await page.screenshot({path:'.local/password-recovery-'+width+'.png'});
 const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth}));assert(size.scroll<=size.client,'no horizontal overflow');
 await dialog.getByRole('button',{name:'重置密码',exact:true}).click();await page.getByText('密码已重置，请使用新密码重新登录',{exact:true}).waitFor();await dialog.waitFor({state:'hidden'});
 assert.equal(await page.getByPlaceholder('请输入密码',{exact:true}).inputValue(),'');assert(new URL(page.url()).pathname.endsWith('/login')||new URL(page.url()).hash==='#/login','reset cannot silently log in');
 await page.getByRole('button',{name:'忘记密码？',exact:true}).click();await dialog.waitFor();assert.equal(await dialog.getByPlaceholder('6位验证码').inputValue(),'');assert.equal(await dialog.getByPlaceholder('至少6个字符').inputValue(),'');
 assert.deepEqual(errors,[]);console.log('PASS '+width+'px: login recovery entry, unavailable mail503, uniform send acknowledgement/cooldown, confirm validation, invalid OTP, success clears secrets without auto-login; synthetic APIs only');await page.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});

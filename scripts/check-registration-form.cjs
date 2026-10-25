// Only synthetic form values and intercepted API requests; never registers real users.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const base=process.env.REGISTER_TEST_BASE||'http://127.0.0.1:4173/';
const hash=process.env.REGISTER_TEST_HASH==='1',origin=new URL(base).origin;
const api=new URL(process.env.REGISTER_TEST_API||'/api',base).href.replace(/\/$/,'');
const registerUrl=base.replace(/\/?$/,'/')+(hash?'#/':'')+'register';
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
for(const width of [390,1440]){const page=await browser.newPage({viewport:{width,height:1000},isMobile:width<900,hasTouch:width<900});page.setDefaultTimeout(15000);
const submitted=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async r=>{const u=new URL(r.request().url());
if(r.request().url().startsWith(api+'/')){let data=[];
if(u.pathname==='/api/auth/register'&&r.request().method()==='POST'){submitted.push(r.request().postDataJSON());await new Promise(resolve=>setTimeout(resolve,300));data={user:{id:99002,username:'注册表单测试',email:'registration@example.test',role:'USER',level:1,points:0},accessToken:'synthetic-registration',refreshToken:''};}
if(u.pathname==='/api/chat/config')data={configured:true,models:[{id:'deepseek-v4-pro',available:true}],defaultModelId:'deepseek-v4-pro'};
if(u.pathname==='/api/forum/posts')data={data:[],total:0};
return r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:true,data})});}
return u.origin===origin?r.continue():r.abort();});
async function open(){await page.goto(registerUrl);await page.locator('.register-card').waitFor();await page.getByPlaceholder('请输入邮箱',{exact:true}).fill('registration@example.test');await page.getByPlaceholder('请输入用户名',{exact:true}).fill('注册表单测试');}
await open();const item=label=>page.locator('.el-form-item').filter({has:page.locator('label').filter({hasText:new RegExp('^'+label+'$')})});
const phone=page.getByPlaceholder('请输入11位手机号（可选）',{exact:true}),password=page.getByPlaceholder('请输入密码（至少6位）',{exact:true}),confirm=page.getByPlaceholder('请再次输入密码',{exact:true}),submit=page.getByRole('button',{name:'注册',exact:true});
await password.fill('Abc123');await confirm.fill('Abc123');
for(const value of ['1380013800','138001380001','12345678901','1380013800a']){await phone.fill(value);await submit.click();await item('手机号').getByText('请输入11位中国大陆手机号',{exact:true}).waitFor();assert.equal(submitted.length,0);}
await phone.fill('');await password.fill('12345');await confirm.fill('12345');await submit.click();await item('密码').getByText('密码至少6个字符',{exact:true}).waitFor();assert.equal(submitted.length,0);
await password.fill('中'.repeat(25));await confirm.fill('中'.repeat(25));await submit.click();await item('密码').getByText(/不能超过72字节/).waitFor();assert.equal(submitted.length,0);
await password.fill('Abc123');await confirm.fill('');await submit.click();await item('确认密码').getByText('请再次输入密码',{exact:true}).waitFor();assert.equal(submitted.length,0);
await confirm.fill('Different');await submit.click();await item('确认密码').getByText('两次输入的密码不一致',{exact:true}).waitFor();assert.equal(submitted.length,0);
await confirm.fill('Abc123');await password.fill('Changed456');await item('确认密码').getByText('两次输入的密码不一致',{exact:true}).waitFor();
await confirm.fill('Changed456');await page.waitForFunction(()=>![...document.querySelectorAll('.el-form-item__error')].some(e=>e.textContent.includes('两次输入')));
for(const field of [item('密码'),item('确认密码')]){const input=field.locator('input');assert.equal(await input.getAttribute('type'),'password');const value=await input.inputValue();await field.locator('.el-input__password').click();assert.equal(await input.getAttribute('type'),'text');assert.equal(await input.inputValue(),value);await field.locator('.el-input__password').click();assert.equal(await input.getAttribute('type'),'password');}
await phone.fill('   ');await page.locator('form.el-form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await page.locator('.forum-container').waitFor();assert.equal(submitted.length,1);assert(!Object.hasOwn(submitted[0],'phone'));assert.equal(submitted[0].password,'Changed456');assert(!Object.hasOwn(submitted[0],'confirmPassword'));
await page.evaluate(()=>localStorage.removeItem('chatforum-user'));await page.reload();await open();await phone.fill(' 13800138000 ');await password.fill('  Valid pass  ');await confirm.fill('  Valid pass  ');await confirm.press('Enter');await page.locator('.forum-container').waitFor();
assert.equal(submitted.length,2);assert.equal(submitted[1].phone,'13800138000');assert.equal(submitted[1].password,'  Valid pass  ');assert.deepEqual(errors,[]);
console.log(`PASS ${width}px: invalid phone/password blocked, confirmation revalidated, reveal toggles, Enter and duplicate submit, optional phone omitted (mock APIs only)`);await page.close();}
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

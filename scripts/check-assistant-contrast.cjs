// Synthetic visual check for the ordinary assistant palette and the distinct roleplay theme.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.CONTRAST_BASE||'http://127.0.0.1:4173/';
const api=(process.env.CONTRAST_API||new URL('/api',base).href).replace(/\/$/,''),origin=new URL(base).origin;
const baseline=process.env.CONTRAST_BASELINE==='1',hash=process.env.CONTRAST_HASH==='1';
const user={id:99046,username:'样式验收',email:'contrast@example.test',role:'USER',level:1,points:0};
const conversations=[{id:1,title:'讨论一个新想法',conversationType:'ASSISTANT'},
 {id:2,title:'虚构角色会话',conversationType:'ROLEPLAY',personaKey:'kato_megumi_persona',personaLabel:'加藤惠'}].map(c=>({...c,userId:user.id,updatedAt:'2026-09-23T00:00:00Z'}));
const messages=[{id:1,role:'USER',content:'能帮我整理一下这个项目的下一步吗？'},
 {id:2,role:'ASSISTANT',content:'可以。先把目标缩小到一个能实际体验的版本，再逐步完善。\n\n### 先做这三件事\n\n1. 明确最重要的使用场景。\n2. 做通核心流程，并保留错误提示。\n3. 根据真实反馈调整，而不是一口气增加功能。\n\n**建议先从第一步开始。** 如果需要，也可以[看看社区里的讨论](/forum/post/991)。'},
 {id:3,role:'USER',content:'那就先从最常用的对话场景开始吧。'},
 {id:4,role:'ASSISTANT',content:'好。可以先验证输入、回复和返回历史这三个环节，再检查手机上的阅读体验。'}];
const luminance=c=>{const rgb=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return(Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
async function styles(page,selector){return page.locator(selector).first().evaluate(el=>{const s=getComputedStyle(el);return{color:s.color,background:s.backgroundColor,border:s.borderColor,fontSize:s.fontSize};});}
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 for(const width of [320,390,1440]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width<=900,hasTouch:width<=900});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-palette-token',refreshToken:''})),user);
  await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  await page.route(api+'/**',async r=>{
   const p=new URL(r.request().url()).pathname;let data=[];
   if(p==='/api/chat/config')data={configured:true,defaultModelId:'deepseek-v4-pro',models:[{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',available:true}]};
   if(p==='/api/chat/conversations')data=conversations;
   if(p==='/api/chat/conversations/1/messages')data=messages;
   if(p==='/api/chat/conversations/2/messages')data=[{id:10,role:'ASSISTANT',content:'这是一条虚构的角色页面对比消息。'}];
   return r.fulfill({contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({success:true,data})});
  });
  await page.goto(base.replace(/\/?$/,'/')+(hash?'#/':'')+'chat');
  await page.getByText('好。可以先验证输入、回复和返回历史这三个环节，再检查手机上的阅读体验。',{exact:true}).waitFor();
  const canvas=await styles(page,'.assistant-main'),sidebar=await styles(page,'.chat-sidebar'),composer=await styles(page,'.assistant-composer');
  const ink=await styles(page,'.chat-message.assistant .message-text');
  assert.equal(await page.locator('.assistant-footnote').count(),0,'Removed fixed disclaimer must not remain hidden in the DOM');
  const placeholder=await page.locator('.assistant-composer textarea').evaluate(el=>getComputedStyle(el,'::placeholder').color);
  const ratios={body:contrast(ink.color,canvas.background),placeholder:contrast(placeholder,composer.background)};
  if(!baseline){
   for(const [label,ratio] of Object.entries(ratios))assert(ratio>=4.5,`${label} text contrast ${ratio}`);
   assert.equal(ink.fontSize,'16px');assert.notEqual(canvas.background,'rgb(255, 255, 255)');
   assert(luminance(sidebar.background)<luminance(canvas.background));assert(luminance(canvas.background)<luminance(composer.background));
  }
  const unfocused=composer.border;
  await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('这是一条未发送的虚构草稿');
  const focused=await styles(page,'.assistant-composer');assert.notEqual(focused.border,unfocused);
  const send=page.getByRole('button',{name:'发送消息',exact:true});assert(await send.isEnabled());
  const box=await send.boundingBox();assert(box.x>=0&&box.x+box.width<=width&&box.y+box.height<=900);
  await page.getByRole('button',{name:'Agent',exact:true}).click();assert.equal(await page.getByRole('button',{name:'Agent',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('textbox',{name:'消息输入',exact:true}).fill('');await page.getByRole('textbox',{name:'消息输入',exact:true}).blur();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:`.local/assistant-contrast-${baseline?'before':'after'}-${width}.png`});
  if(width<=900)await page.getByRole('button',{name:'对话列表',exact:true}).click();
  await page.getByRole('tab',{name:'角色对话',exact:true}).click();
  if(width<=900)await page.getByRole('button',{name:'关闭对话列表',exact:true}).click({position:{x:width-10,y:100}});
  await page.getByText('这是一条虚构的角色页面对比消息。',{exact:true}).waitFor();
  const role={};for(const selector of ['.chat-main','.chat-sidebar','.persona-bar','.chat-toolbar','.message-bubble','.message-text'])role[selector]=await styles(page,selector);
  const fixture=`.local/role-palette-baseline-${width}.json`;
  if(baseline)fs.writeFileSync(fixture,JSON.stringify(role));else{
   assert.notEqual(role['.chat-main'].background,canvas.background,'roleplay must keep its distinct themed canvas');
   assert.notEqual(role['.message-bubble'].background,'rgba(0, 0, 0, 0)','roleplay bubble must remain readable over the background image');
   assert(contrast(role['.message-text'].color,role['.message-bubble'].background)>=4.5,'roleplay message contrast');
   const identity=width<=900
    ? page.locator('.mobile-conversation-title').getByText('角色扮演',{exact:true})
    : page.locator('.persona-bar').getByText('角色对话',{exact:true});
   assert.equal(await identity.isVisible(),true,'roleplay identity label');
  }
  assert.deepEqual(errors,[]);console.log(`PASS ${width}px: ${baseline?'baseline captured':'text contrast, separate surfaces, focus, send position, mode switch, distinct readable roleplay theme'} ${JSON.stringify(ratios)}`);await page.close();
 }
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exitCode=1;});

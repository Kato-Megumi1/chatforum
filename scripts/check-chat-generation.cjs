// Synthetic browser verification. All account/chat/model APIs are intercepted.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
const base = process.env.ASSISTANT_TEST_BASE || 'http://127.0.0.1:4173/';
const api = (process.env.ASSISTANT_TEST_API || new URL('/api', base).href).replace(/\/$/, '');
const hash = process.env.ASSISTANT_TEST_HASH === '1';
const user = {id:99146,username:'生成测试',email:'generation@example.test',role:'USER'};
(async()=>{
  const browser = await chromium.launch({channel:'msedge',headless:true});
  try { for (const width of [390,1440]) {
    const page = await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});
    const messages=[],sends=[],errors=[]; let serial=0;
    const conversation={id:1,userId:user.id,title:'虚构生成会话',conversationType:'ASSISTANT',createdAt:new Date().toISOString()};
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(user=>{
      localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-token',refreshToken:''}));
      localStorage.setItem('chatforum-chat',JSON.stringify({preferredModelId:'deepseek-v4-pro',conversationSettings:{1:{modelId:'deepseek-v4-pro'}}}));
    },user);
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if (!route.request().url().startsWith(api+'/')) return url.origin===new URL(base).origin?route.continue():route.abort();
      const path=url.pathname,method=route.request().method(),headers={'Access-Control-Allow-Origin':'*'};
      if(method==='OPTIONS')return route.fulfill({status:204,headers:{...headers,'Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'*'}});
      let data=[];
      if(path.endsWith('/chat/config'))data={configured:true,defaultModelId:'qwen3.8-max',models:[{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro',available:false,unavailableReason:'管理员已停用此模型'},{id:'qwen3.8-max',label:'Qwen3.8-Max',available:true}]};
      if(path.endsWith('/chat/conversations'))data=[conversation];
      if(path.endsWith('/chat/conversations/1/messages'))data=messages;
      if(path.endsWith('/chat/runs')){
        const input=route.request().postDataJSON();sends.push(input);serial++;
        assert.equal(input.modelId,'qwen3.8-max');
        messages.push({id:serial*2,role:'USER',content:input.question,conversationId:1});
        data={id:'generation-'+serial,status:'RUNNING'};
      }
      if(path.endsWith('/events')){
        const content=serial===1?'这是因输出长度中断的虚构回答。':'这是继续生成的虚构回答。';
        const performance={stage:'completed',elapsedMs:2300,firstTokenMs:700,stages:[{stage:'preparing',durationMs:300},{stage:'generating',durationMs:2000}]};
        const ragMetadata={state:'general',performance,generation:{finishReason:serial===1?'length':'stop',truncated:serial===1,canContinue:serial===1}};
        messages.push({id:serial*2+1,role:'ASSISTANT',conversationId:1,content,ragMetadata});
        return route.fulfill({contentType:'text/event-stream',headers,body:'event: progress\ndata: '+JSON.stringify({...performance,stage:'generating'})+'\n\nevent: delta\ndata: '+JSON.stringify({text:content,offset:content.length})+'\n\nevent: complete\ndata: '+JSON.stringify({status:'COMPLETED',result:{content,ragMetadata}})+'\n\n'});
      }
      return route.fulfill({headers,contentType:'application/json',body:JSON.stringify({success:true,data})});
    });
    await page.goto(base.replace(/\/?$/,'/')+(hash?'#/':'')+'chat');
    const textbox=page.getByRole('textbox',{name:'消息输入',exact:true});await textbox.fill('写一个较长回答');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    const continuation=page.getByRole('button',{name:'继续生成',exact:true});await continuation.waitFor();
    assert.equal(sends.length,1,'truncation must not silently start a second paid request');
    const process=page.locator('.generation-process').first();await process.locator('summary').click();await process.locator('.process-phases').waitFor();
    assert.equal(await process.locator('.process-description,.process-metrics,.model-active').count(),0);
    await continuation.click();await page.getByText('这是继续生成的虚构回答。',{exact:true}).waitFor();
    assert.equal(sends.length,2);assert.match(sends[1].question,/继续上一条回答/);
    assert.equal(await page.locator('.chat-message.assistant').count(),2);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: default Qwen despite cached DeepSeek, separate latency metadata, length detected, manual-only continuation`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error=>{console.error(error.message);process.exitCode=1;});

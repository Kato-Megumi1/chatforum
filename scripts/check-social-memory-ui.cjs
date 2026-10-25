// Fully mocked mobile/desktop UI acceptance. No real user data or model requests.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const {mkdirSync}=require('node:fs'),{join}=require('node:path');
const base=process.env.SOCIAL_MEMORY_TEST_BASE||'http://127.0.0.1:5177/',origin=new URL(base).origin;
assert(['127.0.0.1','localhost'].includes(new URL(base).hostname));
const output=join(__dirname,'../.local/social-memory-ui');mkdirSync(output,{recursive:true});
const user={id:99118,username:'虚构体验验收',email:'social@example.test',role:'USER'};
const conversation={id:11,userId:user.id,title:'虚构长会话',conversationType:'ASSISTANT',personaKey:'assistant'};
const version='a'.repeat(64),entries=[{kind:'pin',id:300,text:'用户曾说：周日想去看蓝海电影。\n助手当时回应：可以到时候再商量。',sourceIds:[19,20],pinned:true,version},
  {kind:'episode',id:22,text:'用户曾说：长文字与来源排版。\n'+('long-unbroken-memory-'.repeat(20)),sourceIds:[21,22],pinned:false,version}];
const report={id:101,revision:1,type:'POST',targetId:31,status:'RESOLVED',decision:'HIDE',reason:'疑似垃圾信息，需要管理员复核。',
  decisionReason:'包含重复发布的推广信息。',createdAt:'2026-10-25T08:30:00Z',post:{title:'虚构举报主题，仅用于页面验收'}};

async function fits(page,selector){
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'document horizontal overflow');
  const boxes=await page.locator(selector).evaluateAll(elements=>elements.filter(element=>element.getClientRects().length).map(element=>{
    const r=element.getBoundingClientRect();return{left:r.left,right:r.right,width:innerWidth};
  }));
  assert(boxes.length);assert(boxes.every(r=>r.left>=-1&&r.right<=r.width+1),selector+' overflow '+JSON.stringify(boxes));
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try{for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:900},isMobile:width<900,hasTouch:width<900});
    const errors=[],calls=[];let appealed=false,pinned=false,forgotten=false;
    page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(user=>localStorage.setItem('chatforum-user',JSON.stringify({user,token:'synthetic-social',refreshToken:''})),user);
    await page.route('**/*',route=>{
      const url=new URL(route.request().url()),path=url.pathname,method=route.request().method();
      if(url.origin!==origin)return route.abort();if(!path.startsWith('/api/'))return route.continue();
      calls.push({path,method,body:method==='POST'?route.request().postDataJSON():undefined});
      const ok=data=>route.fulfill({contentType:'application/json',body:JSON.stringify({success:true,data})});
      if(path==='/api/chat/memory/conversations')return ok({items:[conversation],nextBefore:null});
      if(path==='/api/chat/memory/11')return ok({items:forgotten?entries.slice(0,1):entries.map((entry,i)=>i===1&&pinned?{...entry,kind:'pin',id:301,pinned:true}:entry),nextBefore:null,rebuildStatus:'READY'});
      if(path==='/api/chat/memory/11/sources')return ok({messages:[{id:19,role:'user',content:'虚构来源：周日想去看蓝海电影。',truncated:false},
        {id:20,role:'assistant',content:'虚构来源：可以到时候再商量。',truncated:false}]});
      if(path==='/api/chat/memory/11/pin'){pinned=true;return ok({id:301,pinned:true});}
      if(path==='/api/chat/memory/11/forget'){forgotten=true;return ok({forgotten:true});}
      if(path==='/api/forum/reports')return ok({rows:[{...report,id:100,status:'PENDING',decision:null,decisionReason:null}],nextCursor:null});
      if(path==='/api/forum/reports/decisions')return ok({rows:[{...report,...(appealed?{appeal:{status:'PENDING',reason:'虚构申诉：请核查重复发布的判定。'}}:{})}],nextCursor:null});
      if(path==='/api/forum/reports/101/appeal'){appealed=true;return ok({id:501,status:'PENDING'});}
      if(path==='/api/forum/notifications/unread-count')return ok({unreadCount:0});
      if(path==='/api/direct-messages/unread-count')return ok({inbox:0,requests:0,total:0});
      return ok([]);
    });
    await page.goto(base+'user/memory');await page.locator('.memory-card').nth(1).waitFor();
    await page.waitForTimeout(350); // Settle Element Plus tag entry animations before visual capture.
    await fits(page,'.memory-page,.memory-toolbar,.memory-card');
    await page.screenshot({path:join(output,`my-memory-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'查看来源',exact:true}).first().click();
    await page.getByText('虚构来源：周日想去看蓝海电影。',{exact:true}).waitFor();await page.waitForTimeout(350);
    await fits(page,'.el-dialog,.memory-source');await page.screenshot({path:join(output,`memory-sources-${width}.png`),fullPage:true});
    await page.locator('.el-dialog__headerbtn').click();
    await page.getByRole('button',{name:'固定',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.memory-card .el-tag').length===2);
    await page.getByRole('button',{name:'删除记忆',exact:true}).last().click();
    await page.getByRole('button',{name:'删除记忆',exact:true}).last().click();
    await page.waitForFunction(()=>document.querySelectorAll('.memory-card').length===1);
    await page.goto(base+'reports');await page.locator('#report-100').waitFor();
    await fits(page,'.reports-page,.reports-card,.report-tabs');
    await page.getByRole('button',{name:'我的处理与申诉',exact:true}).click();await page.locator('#report-101').waitFor();await page.waitForTimeout(350);
    await page.screenshot({path:join(output,`report-decisions-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'提交申诉',exact:true}).click();await page.waitForTimeout(350);
    await page.getByRole('textbox',{name:'申诉原因'}).fill('虚构申诉：请核查重复发布的判定。');
    await fits(page,'.el-dialog');await page.screenshot({path:join(output,`report-appeal-${width}.png`),fullPage:true});
    await page.getByRole('dialog',{name:'提交申诉'}).getByRole('button',{name:'提交申诉',exact:true}).click();
    await page.getByText('申诉待处理',{exact:true}).waitFor();
    assert.equal(calls.some(call=>call.path==='/api/chat/runs'),false,'memory/report actions cannot create a model task');
    assert.deepEqual(errors,[]);await page.close();console.log(`My Memory / reports ${width}px passed`);
  }}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

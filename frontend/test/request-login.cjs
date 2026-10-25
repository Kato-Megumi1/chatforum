const {test}=require('node:test'),assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
const authData=id=>({user:{id,username:'Synthetic '+id},accessToken:'rotated-'+id,refreshToken:'next-refresh-'+id});
const success=id=>({data:{success:true,data:authData(id)}});
function compile(file,imports){
 const mod={exports:{}},code=ts.transpileModule(readFileSync(join(__dirname,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 new Function('require','module','exports','localStorage',code)(name=>{if(Object.hasOwn(imports,name))return imports[name];throw Error(name);},mod,mod.exports,{getItem:()=>null,setItem(){},removeItem(){}});return mod.exports;
}
function fixture(options={}){
 const actions=[],messages=[],dispatches=[],invalidations=[];let rejected,fulfilled,requested,epoch=0;
 const store={user:{id:1},token:'account-token-1',refreshToken:'account-refresh-1',
  getAuthSession:()=>({userId:store.user?.id??null,epoch}),
  clearAuth:()=>{actions.push('clear');epoch++;store.user=null;store.token=store.refreshToken='';},
  setToken:(token,refresh)=>{actions.push(['token',token,refresh]);store.token=token;store.refreshToken=refresh;},
  setUser:user=>{actions.push(['user',user.id]);if(store.user?.id!==user.id)epoch++;store.user=user;}};
 const switchAccount=id=>{epoch++;store.user=id===null?null:{id};store.token=id===null?'':'account-token-'+id;store.refreshToken=id===null?'':'account-refresh-'+id;};
 const http=config=>{try{const sent=requested(config);actions.push(['retry',sent.url,sent.headers.Authorization]);return Promise.resolve('retried');}catch(error){return Promise.reject(error);}};
 for(const verb of ['get','post','put','patch','delete'])http[verb]=(url,...args)=>{dispatches.push({url,...args[verb==='get'||verb==='delete'?0:1]});return Promise.resolve('scheduled');};
 http.interceptors={request:{use(handler){requested=handler;}},response:{use(ok,error){fulfilled=ok;rejected=error;}}};
 const axios={create:()=>http,post:async(url,body)=>{actions.push(['refresh',body.refreshToken]);return options.refresh?options.refresh(body):success(store.user.id);}};
 const request=compile('../src/utils/request.ts',{'axios':axios,'./api':{API_BASE:'/api',apiUrl:p=>'/api'+p,normalizeMedia:v=>v},
  'element-plus':{ElMessage:{error:message=>messages.push(message)}},'@/stores/user':{useUserStore:()=>store},
  './forum-feed-cache':{invalidateForumFeedCache:()=>invalidations.push(true)}});
 const stamp=(url='/direct-messages/conversations/17/messages')=>requested({url,headers:{}});
 const error=(config,status=401,message)=>({config,response:{status,data:message?{message}:{}}});
 return{rejected,fulfilled,requested,stamp,error,actions,messages,store,switchAccount,request:request.default,dispatches,invalidations};
}

test('cancelled background reads do not show a toast or rotate authentication',async()=>{
 const f=fixture(),error={config:f.stamp('/forum/feed'),code:'ERR_CANCELED',message:'canceled'};
 await assert.rejects(f.rejected(error),e=>e===error);assert.deepEqual(f.actions,[]);assert.deepEqual(f.messages,[]);
});

test('quiet reads keep inline errors quiet but still enforce expired-session handling',async()=>{
 const f=fixture(),config={...f.stamp('/forum/feed'),_quiet:true};
 const error=f.error(config,503,'temporarily unavailable');await assert.rejects(f.rejected(error));
 await assert.rejects(f.fulfilled({config,data:{success:false,message:'business failure'}}));assert.deepEqual(f.messages,[]);
 const g=fixture({refresh:()=>Promise.reject(new Error('expired'))});
 await assert.rejects(g.rejected(g.error({...g.stamp('/forum/feed'),_quiet:true})));
 assert.deepEqual(g.actions,[['refresh','account-refresh-1'],'clear']);assert.deepEqual(g.messages,['登录已过期，请重新登录']);
});

test('confirmed forum writes invalidate summaries, while views, reads, and failed writes do not',async()=>{
 const f=fixture();
 for(const [method,url,invalidates] of [['post','/forum/posts',true],['put','/forum/posts/4',true],['delete','/forum/comments/3',true],['post','/users/2/follow',true],['post','/forum/posts/4/view',false],['get','/forum/feed',false],['put','/forum/notifications/3/read',false]]){
  const before=f.invalidations.length;f.fulfilled({config:{...f.stamp(url),method},data:{success:true,data:{}}});assert.equal(f.invalidations.length-before,Number(invalidates),url);
 }
 const count=f.invalidations.length;await assert.rejects(f.fulfilled({config:{...f.stamp('/forum/posts'),method:'post',_quiet:true},data:{success:false}}));assert.equal(f.invalidations.length,count);
});
test('incorrect login credentials never rotate or clear a separately stored session',async()=>{
 const f=fixture(),error=f.error(f.stamp('/auth/login'),401,'Invalid credentials');
 await assert.rejects(f.rejected(error),e=>e===error);assert.deepEqual(f.actions,[]);assert.deepEqual(f.messages,['邮箱或密码不正确']);
});
test('protected API still refreshes and retries; registration errors preserve authentication',async()=>{
 const f=fixture();assert.equal(await f.rejected(f.error(f.stamp('/forum/me/posts'))),'retried');
 assert.deepEqual(f.actions,[['refresh','account-refresh-1'],['token','rotated-1','next-refresh-1'],['user',1],['retry','/forum/me/posts','Bearer rotated-1']]);assert.deepEqual(f.messages,[]);
 const g=fixture(),error=g.error(g.stamp('/auth/register'),409,'邮箱、用户名或手机号已被使用');
 await assert.rejects(g.rejected(error),e=>e===error);assert.deepEqual(g.actions,[]);
});
test('same-session concurrent401 requests share one refresh and both retry',async()=>{
 const wait=deferred(),f=fixture({refresh:()=>wait.promise}),one=f.rejected(f.error(f.stamp('/one'))),two=f.rejected(f.error(f.stamp('/two')));
 assert.equal(f.actions.filter(a=>a[0]==='refresh').length,1);wait.resolve(success(1));
 assert.deepEqual(await Promise.all([one,two]),['retried','retried']);assert.equal(f.actions.filter(a=>a[0]==='retry').length,2);
});
test('old401 after switching accounts never refreshes or replays as the new participant',async()=>{
 const f=fixture(),config=f.stamp();f.switchAccount(2);
 await assert.rejects(f.rejected(f.error(config)),{code:'AUTH_SESSION_CHANGED'});
 assert.deepEqual(f.actions,[]);assert.equal(f.store.user.id,2);assert.deepEqual(f.messages,[]);
});
test('refresh queues are scoped by session; late A success cannot restore A or retry A requests as B',async()=>{
 const a=deferred(),b=deferred(),f=fixture({refresh:body=>body.refreshToken==='account-refresh-1'?a.promise:b.promise});
 const old=Promise.allSettled([f.rejected(f.error(f.stamp('/a-one'))),f.rejected(f.error(f.stamp('/a-two')))]);
 f.switchAccount(2);const next=f.rejected(f.error(f.stamp('/b-one')));b.resolve(success(2));assert.equal(await next,'retried');
 a.resolve(success(1));const stale=await old;assert(stale.every(r=>r.status==='rejected'&&r.reason.code==='AUTH_SESSION_CHANGED'));
 assert.deepEqual(f.actions.filter(a=>a[0]==='retry'),[['retry','/b-one','Bearer rotated-2']]);
 assert.deepEqual(f.actions.filter(a=>a[0]==='token'),[['token','rotated-2','next-refresh-2']]);assert.equal(f.store.user.id,2);assert.deepEqual(f.messages,[]);
});
test('late A refresh failure never clears B or shows an expired-login warning for B',async()=>{
 const wait=deferred(),f=fixture({refresh:()=>wait.promise}),pending=Promise.allSettled([f.rejected(f.error(f.stamp()))]);
 f.switchAccount(2);wait.reject(new Error('A refresh failed'));const [result]=await pending;
 assert.equal(result.status,'rejected');assert.equal(result.reason.code,'AUTH_SESSION_CHANGED');assert.equal(f.store.user.id,2);
 assert(!f.actions.includes('clear'));assert.deepEqual(f.messages,[]);
});
test('logout and login to the same account still invalidate the old epoch',async()=>{
 const f=fixture(),config=f.stamp();f.switchAccount(null);f.switchAccount(1);
 await assert.rejects(f.rejected(f.error(config)),{code:'AUTH_SESSION_CHANGED'});assert.deepEqual(f.actions,[]);
 assert.throws(()=>f.requested(config),{code:'AUTH_SESSION_CHANGED'});
});
test('all request wrappers pin identity synchronously before Axios interceptor scheduling',async()=>{
 for(const verb of ['get','post','put','patch','delete']){
  const f=fixture();await f.request[verb]('/private',{});f.switchAccount(2);
  assert.equal(f.dispatches.length,1);assert.equal(f.dispatches[0]._authSession.userId,1);
  assert.throws(()=>f.requested(f.dispatches[0]),{code:'AUTH_SESSION_CHANGED'});assert.deepEqual(f.actions,[]);
 }
});
test('late successful text or blob replies do not deliver previous-account content',()=>{
 const f=fixture(),config=f.stamp();f.switchAccount(2);
 assert.throws(()=>f.fulfilled({config,data:{success:true,data:{content:'fictional private A text'}}}),{code:'AUTH_SESSION_CHANGED'});
 assert.throws(()=>f.fulfilled({config:{...config,responseType:'blob'},data:new Blob(['fictional A attachment'])}),{code:'AUTH_SESSION_CHANGED'});
});
test('an unstamped protected401 is rejected instead of guessing a current account',async()=>{
 const f=fixture();await assert.rejects(f.rejected(f.error({url:'/private',headers:{}})),{code:'AUTH_SESSION_CHANGED'});assert.deepEqual(f.actions,[]);
});
test('current-session refresh failure clears only that session once',async()=>{
 const wait=deferred(),f=fixture({refresh:()=>wait.promise}),pending=Promise.allSettled([f.rejected(f.error(f.stamp('/one'))),f.rejected(f.error(f.stamp('/two')))]);
 wait.reject(new Error('invalid refresh'));await pending;assert.equal(f.actions.filter(a=>a==='clear').length,1);assert.equal(f.messages.length,1);assert.equal(f.store.user,null);
});
test('refresh cannot switch to a different response account',async()=>{
 const f=fixture({refresh:()=>success(2)});await assert.rejects(f.rejected(f.error(f.stamp())));
 assert(!f.actions.some(a=>a[0]==='token'||a[0]==='user'));assert.equal(f.store.user,null);
});
function userFixture(request){
 let instance;const resets=[];
 const mod=compile('../src/stores/user.ts',{'vue':{ref:value=>({value})},'pinia':{defineStore:(_name,setup)=>()=>instance??=setup()},
  '@/utils/request':request,'./chat':{useChatStore:()=>({resetForUser:()=>resets.push('reset')})}});
 return{store:mod.useUserStore(),resets};
}
test('user auth epoch is closure-only and survives ordinary refresh/profile updates',async()=>{
 const f=userFixture({post:async()=>authData(1),put:async()=>authData(1).user}),store=f.store;
 assert.equal('authEpoch' in store,false);store.setUser(authData(1).user);store.setToken('old','refresh');const first=store.getAuthSession();
 await store.refresh();await store.updateProfile({bio:'synthetic'});assert.deepEqual(store.getAuthSession(),first);
 await store.login('synthetic@example.test','not-a-real-password');assert(store.getAuthSession().epoch>first.epoch);assert.equal(store.getAuthSession().userId,1);
});
test('late logout finally does not clear a newly selected account',async()=>{
 const wait=deferred(),{store}=userFixture({post:()=>wait.promise});store.setUser(authData(1).user);store.setToken('a','refresh-a');const pending=store.logout();
 store.setUser(authData(2).user);store.setToken('b','refresh-b');wait.resolve({});await pending;
 assert.equal(store.user.value.id,2);assert.equal(store.token.value,'b');
});
test('late login/profile results cannot overwrite the new account even after the HTTP promise resolves',async()=>{
 for(const operation of ['login','register','refresh','updateProfile']){
  const wait=deferred(),{store}=userFixture({post:()=>wait.promise,put:()=>wait.promise});store.setUser(authData(1).user);store.setToken('a','refresh-a');
  const pending=store[operation]('synthetic@example.test','synthetic','synthetic');store.setUser(authData(2).user);store.setToken('b','refresh-b');
  wait.resolve(operation==='updateProfile'?authData(1).user:authData(1));await assert.rejects(pending,{code:'AUTH_SESSION_CHANGED'});
  assert.equal(store.user.value.id,2);assert.equal(store.token.value,'b');
 }
});

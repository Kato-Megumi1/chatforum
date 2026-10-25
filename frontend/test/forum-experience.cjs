const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const mod={exports:{}};
const code=ts.transpileModule(readFileSync(join(__dirname,'../src/utils/forum-experience.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const entries=new Map(); const storage={getItem:key=>entries.get(key)||null,setItem:(key,val)=>entries.set(key,val)};
new Function('module','exports','sessionStorage',code)(mod,mod.exports,storage);
const {forumFilters,forumQuery,forumFilterKey,forumDraftKey,readForumNavigation,saveForumNavigation,notificationTarget}=mod.exports;
test('forum query round-trips filter state and rejects malformed pagination',()=>{
 const f=forumFilters({category:'7',q:'中文搜索',sort:'popular',period:'today',page:'3',limit:'10'});
 assert.deepEqual(forumFilters(forumQuery(f)),f);
 const invalid=forumFilters({category:'../x',tag:['2'],page:'-5',limit:'1000',sort:'random',period:'random'});
 assert.equal(invalid.page,1);assert.equal(invalid.limit,20);assert.equal(invalid.categoryId,'');assert.equal(invalid.sortBy,'createdAt');
});
test('forum navigation and drafts cannot cross accounts',()=>{
 saveForumNavigation(1,'/forum?category=7&page=3',432);assert.equal(readForumNavigation(1).scroll,432);assert.equal(readForumNavigation(2),null);
 assert.notEqual(forumDraftKey(1),forumDraftKey(2));assert.notEqual(forumDraftKey(1),forumDraftKey(1,'3'));
 saveForumNavigation(1,'https://evil.example',100);assert.equal(readForumNavigation(1),null);
});
test('notification fallback only creates numeric internal destinations',()=>{
 assert.equal(notificationTarget({postId:3,commentId:11}),'/forum/post/3?comment=11');
 assert.equal(notificationTarget({postId:'javascript:alert(1)'}),null);assert.equal(notificationTarget({actorId:7}),'/user/7');
});
test('seek cursors round-trip while filter fingerprints exclude pagination',()=>{
 const first=forumFilters({q:'中文',limit:'10'}),second=forumFilters({q:'中文',limit:'10',page:'2',cursor:'signed.payload_cursor-2'});
 assert.deepEqual(forumFilters(forumQuery(second)),second);assert.equal(forumFilterKey(first),forumFilterKey(second));
 assert.notEqual(forumFilterKey(first),forumFilterKey({...first,tagId:'8'}));
 assert.equal(forumFilters({cursor:['bad']}).cursor,'');assert.equal(forumFilters({cursor:'a'.repeat(16001)}).cursor,'');
 assert.equal(forumFilters({cursor:'a'.repeat(16000)}).cursor.length,16000);
});
test('large PIT tokens keep only bounded nearby navigation pages',()=>{
 const cursors=Object.fromEntries(Array.from({length:100},(_,i)=>[String(i+1),'x'.repeat(16000)]));
 saveForumNavigation(3,'/forum?page=80',123,{filterKey:'long-tokens',cursors});
 const value=readForumNavigation(3);assert.equal(Object.keys(value.feed.cursors).length,32);
 assert.equal(value.feed.cursors['80'].length,16000);assert.equal(value.feed.cursors['1'].length,16000);
});
test('saved feed navigation contains account-isolated cursor history, never post content',()=>{
 saveForumNavigation(1,'/forum?page=2&cursor=next',740,{filterKey:'filters',cursors:{1:'start',2:'next'},data:[{content:'must not persist'}]});
 const value=readForumNavigation(1);assert.deepEqual(value.feed,{filterKey:'filters',cursors:{1:'start',2:'next'}});assert.equal(readForumNavigation(2),null);
 assert(![...entries.values()].some(value=>value.includes('must not persist')));
 entries.set('chatforum-forum-navigation-v1:1',JSON.stringify({userId:1,path:'/forum',scroll:0,feed:{filterKey:'filters',cursors:{1:{content:'bad'}}}}));
 assert.equal(readForumNavigation(1).feed,undefined);
});

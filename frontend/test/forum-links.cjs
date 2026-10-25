const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const mod={exports:{}};
const code=ts.transpileModule(readFileSync(join(__dirname,'../src/utils/forum-links.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('module','exports',code)(mod,mod.exports);
test('only internal numeric forum routes are candidates for Pages router resolution',()=>{
  assert.equal(mod.exports.forumPostPath('/forum/post/123'),'/forum/post/123');
  for(const input of ['//evil.test/forum/post/1','https://evil.test/forum/post/1','javascript:alert(1)','/forum/post/1/../admin','/forum/post/0','/forum/post/<img>','/api/admin'])
    assert.equal(mod.exports.forumPostPath(input),undefined);
});

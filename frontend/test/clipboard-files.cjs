const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/clipboard-files.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);
const {clipboardFiles}=mod.exports;
const item=f=>({kind:'file',getAsFile:()=>f});
test('ordinary text/HTML paste has no file and remains native',()=>{
  assert.deepEqual(clipboardFiles(null),[]);
  assert.deepEqual(clipboardFiles({items:[{kind:'string',getAsFile:()=>null}],files:[]}),[]);
});
test('screenshot gets a unique filename, preserves bytes, does not double-upload files/items',async()=>{
  const f=new File(['synthetic-image'],'image.png',{type:'image/png',lastModified:1});
  const [a]=clipboardFiles({items:[item(f)],files:[f]});
  assert.match(a.name,/^粘贴图片-.*\.png$/);assert.equal(a.type,'image/png');assert.equal(a.lastModified,1);
  assert.equal(await a.text(),'synthetic-image');
  const next=clipboardFiles({items:[item(f)],files:[f]});assert.equal(next.length,1);assert.notEqual(next[0].name,a.name);
});
test('PDF/Word keep their names and collision suffixes do not overwrite originals',()=>{
  const pdf=new File(['pdf'],'说明.pdf',{type:'application/pdf'}),docx=new File(['word'],'方案.docx');
  const files=clipboardFiles({files:[pdf,pdf,docx]},['说明.pdf']);
  assert.deepEqual(files.map(f=>f.name),['说明 (2).pdf','说明 (3).pdf','方案.docx']);assert.equal(files[2],docx);
});
test('null clipboard items fall back to files; no filesystem path interpretation',()=>{
  const f=new File(['code'],'main.ts');
  assert.deepEqual(clipboardFiles({items:[{kind:'file',getAsFile:()=>null}],files:[f]}),[f]);
  assert.deepEqual(clipboardFiles({items:[{kind:'string'}],files:[],getData:()=> 'C:\\private\\file.pdf'}),[]);
});

const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const mod={exports:{}};
new Function('module','exports',ts.transpileModule(readFileSync(join(__dirname,'../src/utils/code-workspace.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(mod,mod.exports);
const {codeDiff,codeArchive}=mod.exports;
test('diff shows precise changed block without executing markup',()=>{
  assert.deepEqual(codeDiff('a\nb\nc','a\n<script>x</script>\nc'),{startLine:2,removed:'b',added:'<script>x</script>'});
  assert.deepEqual(codeDiff('a\nb','a\nb'),{startLine:3,removed:'',added:''});
  assert.equal(codeDiff('','hello').added,'hello');
});
test('ZIP contains exact UTF-8 files, valid CRC and directory offsets',async()=>{
  const files=[{path:'src/你好.txt',content:'123456789'},{path:'empty.ts',content:''}];
  const bytes=Buffer.from(await codeArchive(files).arrayBuffer());let offset=0,offsets=[];
  for(const [i,file] of files.entries()){
    offsets.push(offset);assert.equal(bytes.readUInt32LE(offset),0x04034b50);assert.equal(bytes.readUInt16LE(offset+6),0x800);
    const len=bytes.readUInt32LE(offset+18),nameLen=bytes.readUInt16LE(offset+26);
    assert.equal(bytes.subarray(offset+30,offset+30+nameLen).toString(),file.path);
    assert.equal(bytes.subarray(offset+30+nameLen,offset+30+nameLen+len).toString(),file.content);
    assert.equal(bytes.readUInt32LE(offset+14),i===0?0xcbf43926:0);offset+=30+nameLen+len;
  }
  const centralOffset=offset;
  for(const local of offsets){assert.equal(bytes.readUInt32LE(offset),0x02014b50);assert.equal(bytes.readUInt32LE(offset+42),local);offset+=46+bytes.readUInt16LE(offset+28);}
  assert.equal(bytes.readUInt32LE(offset),0x06054b50);assert.equal(bytes.readUInt16LE(offset+10),2);assert.equal(bytes.readUInt32LE(offset+16),centralOffset);
});
test('ZIP refuses traversal paths',()=>{
  for(const path of ['../x.ts','/x.ts','a\\x.ts','C:/x.ts','a//x.ts'])assert.throws(()=>codeArchive([{path,content:''}]));
});

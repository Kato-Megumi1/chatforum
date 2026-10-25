const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),ts=require('typescript');
const mod={exports:{}};
const code=ts.transpileModule(readFileSync(join(__dirname,'../src/utils/registration-validation.ts'),'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('module','exports',code)(mod,mod.exports);
const {normalizeRegistrationPhone,registrationPhoneError,registrationPasswordError}=mod.exports;
test('optional phone normalizes blank values and accepts only 11-digit mainland format',()=>{
  for(const phone of ['', '   ','13800138000',' 19912345678 '])assert.equal(registrationPhoneError(phone),undefined);
  for(const phone of ['123','1380013800','138001380001','12345678901','23800138000','1380013800a','+8613800138000','１３８００１３８０００','138 00138000'])assert.match(registrationPhoneError(phone),/11位/);
  assert.equal(normalizeRegistrationPhone('   '),undefined);assert.equal(normalizeRegistrationPhone(' 13800138000 '),'13800138000');
});
test('password matches backend Unicode character and UTF-8 byte limits, preserving literal spaces',()=>{
  for(const value of ['','12345','😀'.repeat(5)])assert(registrationPasswordError(value));
  for(const value of ['123456','a'.repeat(72),'中'.repeat(24),'😀'.repeat(18),' pass word '])assert.equal(registrationPasswordError(value),undefined);
  for(const value of ['a'.repeat(73),'中'.repeat(25),'😀'.repeat(19)])assert.match(registrationPasswordError(value),/72字节/);
});

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {readFileSync}=require('node:fs'),{join}=require('node:path'),vm=require('node:vm');
const read=path=>readFileSync(join(__dirname,'..',path),'utf8');
const html=read('backend/monitor-public/index.html'),script=read('backend/monitor-public/monitor.js');
test('admin pages remove persistent explanatory chrome but keep authentication and action confirmations',()=>{
  assert.doesNotMatch(html,/page-description|local-note|login-foot|setting-intro|<footer|class="eyebrow"/);
  assert.doesNotMatch(html,/请先完成并保存启用的 SMTP 配置/);
  for(const id of ['login-error','confirm-dialog','confirm-description','confirmation','smtp-secret-status','smtp-test-status','settings-lock','coverage'])assert(html.includes('id="'+id+'"'));
  new vm.Script(script);
  for(const [,id]of script.matchAll(/\$\('([^']+)'\)/g))assert(html.includes('id="'+id+'"'),'DOM reference missing: '+id);
});
function overview(data){
  const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,{textContent:'',hidden:false});return elements.get(id);};
  const body=script.slice(script.indexOf('function renderOverview(d)'),script.indexOf('function drawChart('));
  vm.runInNewContext(body+';renderOverview(data)',{$,data,fmt:v=>v==null?'未上报':String(v),text:()=>({append(){}}),table(){},drawChart(){}});
  return elements;
}
const sample=()=>({totals:{totalTokens:0,calls:0,unreportedCalls:0,partialRecords:0,unpricedRecords:0},tasks:[],models:[],daily:[],backfill:'complete',untrackedTasks:0});
test('complete metering does not render a permanent statistics explanation',()=>{
  const result=overview(sample()).get('coverage');assert.equal(result.textContent,'');assert.equal(result.hidden,true);
});
test('incomplete metering stays explicit and does not silently become zero or a complete bill',()=>{
  const data=sample();data.untrackedTasks=3;data.totals.unreportedCalls=2;data.totals.unpricedRecords=1;data.backfill='running';
  const result=overview(data).get('coverage');assert.equal(result.hidden,false);
  assert.match(result.textContent,/3个任务未计量/);assert.match(result.textContent,/2次调用未完整上报/);assert.match(result.textContent,/1条缺少费率/);assert.match(result.textContent,/回填中/);
});

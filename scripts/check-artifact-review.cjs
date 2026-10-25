// Local container fixtures only; no accounts, model credentials, production data or paid APIs.
'use strict';
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {Script}=require('node:vm');
const {runJob,dockerArgs}=require('./artifact-review-daemon.cjs');
const make=html=>({id:randomUUID(),sourceHash:createHash('sha256').update(html).digest('hex'),html,
  viewports:[{width:390,height:844},{width:1280,height:900}]});
async function main(){
  if(process.argv.includes('--worker-probe')){
    const job=make('<!doctype html><h1>Synthetic preview</h1>'),args=dockerArgs(job);args.splice(args.length-1,0,'-e','ARTIFACT_REVIEW_DEBUG=1','-e','DEBUG=pw:browser');
    const r=spawnSync('docker',args,{input:JSON.stringify(job),encoding:'utf8',windowsHide:true,timeout:22000});
    console.log(r.status);try{const parsed=JSON.parse(r.stdout);console.log({status:parsed.status,error:parsed.error});}catch{console.log('No JSON result');}
    console.log(r.stderr.split('\n').filter(line=>!/launching|starting temporary|cleanup/i.test(line)&&/FATAL|Check failed|pthread|SIGABRT|thread constructor|Failed to create|Target page|GPU|sandbox|egl|Vulkan|exit_code/i.test(line)).slice(0,25).join('\n'));return;
  }
  if(process.argv.includes('--probe')){
    const args=dockerArgs(make('synthetic'));args.splice(args.length-1,0,'--entrypoint','node');
    args.push('-e',"require('playwright-core').chromium.launch({executablePath:'/usr/bin/chromium',headless:true,chromiumSandbox:true,args:['--disable-setuid-sandbox']}).then(async b=>{console.log('SANDBOX_OK');await b.close()}).catch(e=>{console.error(e.message);process.exitCode=1})");
    const r=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:20000});
    console.log(r.status);console.log(r.stdout);console.log(r.stderr);return;
  }
  const good=await runJob(make('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><h1>离线页面验收</h1><button onclick="this.textContent=\'已点击\'">测试按钮</button>'));
  assert.equal(good.status,'rendered',JSON.stringify(good));assert.equal(good.views.length,2);
  for(const view of good.views){assert.equal(Buffer.from(view.png,'base64').subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(view.overflow,false);assert.deepEqual(view.pageErrors,[]);}
  console.log('PASS non-root Chromium sandbox, fixed phone/desktop PNGs, inline JavaScript renders');
  const attacks=String.raw`
    const mark=label=>setTimeout(()=>{throw new Error('attempt:'+label)},20);
    fetch('https://example.org/secret').catch(()=>{});mark('fetch');
    try{new WebSocket('ws://127.0.0.1:8091/')}catch{};mark('socket');
    try{new Worker('data:text/javascript,'+encodeURIComponent('fetch("https://example.org")'))}catch{};mark('worker');
    const frame=document.createElement('iframe');frame.src='file:///etc/passwd';document.body.append(frame);mark('file');
    const image=new Image();image.src='http://127.0.0.1:8091/';document.body.append(image);mark('localhost');
    if(typeof RTCPeerConnection!=='undefined')throw new Error('webrtc-not-disabled');mark('webrtc-disabled');`;
  new Script(attacks); // Parse only: none of this untrusted fixture executes on the host.
  const malicious=await runJob(make('<!doctype html><h1>隔离拦截测试</h1><script>'+attacks+'</script>'));
  assert.equal(malicious.status,'rendered');
  for(const view of malicious.views){
    for(const label of ['fetch','socket','worker','file','localhost','webrtc-disabled'])assert(view.pageErrors.some(s=>s.includes('attempt:'+label)),label+' fixture did not execute');
    assert(!view.pageErrors.some(s=>s.includes('webrtc-not-disabled')));
  }
  console.log('PASS attack code really executes; external/localhost/file/worker/socket attempts remain in network-none/CSP sandbox; runtime errors captured');
  const broken=await runJob(make('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="width:1800px">过宽布局</div>'));
  assert.equal(broken.status,'rendered');assert(broken.views.every(view=>view.overflow));
  console.log('PASS real horizontal-overflow evidence on both viewports');
  const started=Date.now(),loop=await runJob(make('<script>while(true){}</script>'),{timeoutMs:7000});
  assert.equal(loop.status,'failed');assert.equal(loop.error,'RENDER_TIMEOUT');assert(Date.now()-started<14000);
  console.log('PASS infinite-loop job kills only its temporary container on deadline');
  const state=spawnSync('docker',['ps','-a','--filter','name=cf-artifact-review-','--format','{{.Names}}'],{encoding:'utf8',windowsHide:true});
  assert.equal(state.stdout.trim(),'');console.log('PASS no temporary review containers left');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

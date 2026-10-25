// Real offline rendering + synthetic model decisions. Never contacts a paid model or real DB.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {spawn}=require('node:child_process'),{randomUUID,createHash}=require('node:crypto');
const {ArtifactReviewService}=require('../backend/dist/src/modules/coding/artifact-review.service');
const {withChatModel}=require('../backend/dist/src/modules/chat/chat-models');
async function main(){
  const root=path.resolve(__dirname,'../.local/artifact-review-proof-'+randomUUID());await fs.mkdir(root,{recursive:true});
  const previous=process.env.ARTIFACT_REVIEW_QUEUE_DIR;process.env.ARTIFACT_REVIEW_QUEUE_DIR=root;
  const broker=spawn(process.execPath,[path.resolve(__dirname,'artifact-review-daemon.cjs'),'--queue',root],{stdio:'ignore',windowsHide:true,shell:false});
  const original='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><div style="width:1800px;background:#cde">虚构过宽页面</div>';
  const repaired='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><style>body{margin:20px;font:18px sans-serif}main{max-width:900px;margin:auto;padding:24px;background:#eef3fc;border-radius:18px;box-sizing:border-box}</style><main><h1>响应式演示</h1><p>虚构页面已适配手机与桌面。</p></main>';
  const changes=new Map([[1,{id:1,path:'demo.html',after:original,baseRevision:0,status:'PENDING'}]]);let reviews=0,repairs=0;
  const coding={change:async(id,scope)=>{assert.equal(scope.userId,99011);assert.equal(scope.conversationId,88011);assert(changes.has(id));return changes.get(id);},
    tool:async args=>{assert.equal(args.path,'demo.html');assert.equal(args.expectedRevision,0);assert.equal(args.content,repaired);changes.set(2,{id:2,path:args.path,after:args.content,baseRevision:0,status:'PENDING'});return {proposalId:2,path:args.path,status:'PENDING',applied:false};}};
  const model={reviewPage:async views=>{reviews++;assert.equal(views.length,2);assert(views.every(v=>v.data.subarray(0,8).toString('hex')==='89504e470d0a1a0a'));
      return views.some(v=>v.overflow)?{passed:false,issues:['页面横向溢出，应改为响应式宽度。']}:{passed:true,issues:[]};},
    json:async(_system,input)=>{repairs++;assert.equal(input.html,original);assert(input.observedIssues.length);return {content:repaired,description:'修复固定宽度，适配手机和桌面'};}};
  try{
    const service=new ArtifactReviewService(coding,model),scope={userId:99011,conversationId:88011,runId:'synthetic'};
    const result=await withChatModel({id:'qwen3.8-max',label:'Synthetic',defaultModel:'fixture',defaultApiKey:'fixture-only',defaultApiBase:'https://fixture.invalid',bodyOptions:{},pricingPrefix:'TEST'},()=>service.reviewAndRepair(changes.get(1),scope,'生成响应式演示页面'));
    assert.equal(result.visualReview.status,'passed');assert.equal(result.repairAttempted,true);assert.equal(result.proposalResult.proposalId,2);
    assert.equal(reviews,2);assert.equal(repairs,1);assert.equal(changes.get(1).after,original);assert.equal(result.records[0].review.status,'issues');
    for(const record of result.records){const report=await service.getReport(record.changeId,record.review.reviewId,scope);assert.equal(report.views.length,2);
      assert.equal(report.sourceHash,createHash('sha256').update(changes.get(record.changeId).after).digest('hex'));
      for(const view of report.views)await fs.writeFile(path.join(root,`${record.changeId===1?'before':'after'}-${view.width}.png`),await service.getImage(record.changeId,record.review.reviewId,view.index,scope));}
    console.log('PASS real offline render → observed overflow → one synthetic model repair → new immutable proposal → real re-render → report/PNG source hashes');
    console.log('Synthetic screenshots: '+root);
  }finally{broker.kill('SIGTERM');await new Promise(resolve=>{broker.once('exit',resolve);setTimeout(resolve,2500).unref();});
    if(previous===undefined)delete process.env.ARTIFACT_REVIEW_QUEUE_DIR;else process.env.ARTIFACT_REVIEW_QUEUE_DIR=previous;}
}
main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});

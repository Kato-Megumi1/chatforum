import { ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ArtifactReviewService } from './artifact-review.service';
import { CodingSkill } from '../agent/skills/coding.skill';
import { withChatModel } from '../chat/chat-models';
import { RagModelService } from '../agent/rag-model.service';

// Synthetic queue/PNG-header fixtures, not a claim that a browser or paid model was exercised.
function png(width:number,height:number){
  const data=Buffer.alloc(33);Buffer.from('89504e470d0a1a0a','hex').copy(data);data.writeUInt32BE(13,8);
  data.write('IHDR',12,'ascii');data.writeUInt32BE(width,16);data.writeUInt32BE(height,20);return data.toString('base64');
}
const views=()=>[{width:390,height:844,png:png(390,844),overflow:false,pageErrors:[],consoleErrors:[],blockedRequests:0},
  {width:1280,height:900,png:png(1280,900),overflow:false,pageErrors:[],consoleErrors:[],blockedRequests:0}];
const scope={userId:1,conversationId:2,runId:'synthetic-run'};
const modelConfig=(id='qwen3.8-max')=>({id,label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-only',
  defaultApiBase:'https://invalid.test',bodyOptions:{enable_thinking:false},pricingPrefix:'TEST',deepThinking:true});
describe('private immutable HTML artifact visual review',()=>{
  let root:string, changes:Map<number,any>, coding:any, model:any, service:ArtifactReviewService;
  const oldEnv=process.env.ARTIFACT_REVIEW_QUEUE_DIR, oldFetch=global.fetch;
  beforeEach(async()=>{
    root=await mkdtemp(resolve(process.cwd(),'../.local/artifact-review-test-'));process.env.ARTIFACT_REVIEW_QUEUE_DIR=root;
    changes=new Map([[8,{id:8,path:'index.html',after:'<h1>synthetic page</h1>',baseRevision:0}]]);
    coding={change:jest.fn(async(id,s)=>{if(s.userId!==1||s.conversationId!==2)throw new ForbiddenException();
      const row=changes.get(id);if(!row)throw Error('Deleted proposal');return row;})};
    model={reviewPage:jest.fn().mockResolvedValue({passed:true,issues:[]}),json:jest.fn()};service=new ArtifactReviewService(coding,model);
  });
  afterEach(async()=>{
    global.fetch=oldFetch;jest.restoreAllMocks();
    if(oldEnv===undefined)delete process.env.ARTIFACT_REVIEW_QUEUE_DIR;else process.env.ARTIFACT_REVIEW_QUEUE_DIR=oldEnv;
    const safePrefix=resolve(process.cwd(),'../.local/artifact-review-test-');
    if(!resolve(root).startsWith(safePrefix))throw Error('Refusing fixture cleanup outside generated test directory');
    await rm(root,{recursive:true,force:true});
  });
  async function job(excluding?:string){
    for(let attempt=0;attempt<100;attempt++){
      const names=await readdir(join(root,'in')).catch(()=>[]);const name=names.find(value=>/^[a-f0-9-]+\.json$/.test(value)&&value!==excluding+'.json');
      if(name)return JSON.parse(await readFile(join(root,'in',name),'utf8'));await delay(10);
    }
    throw Error('No synthetic renderer job');
  }
  async function answer(input:any,override:any={}){
    const path=join(root,'out',input.id+'.json');
    await writeFile(path+'.tmp',JSON.stringify({id:input.id,sourceHash:input.sourceHash,rendererVersion:'offline-html-v1',status:'rendered',views:views(),...override}));
    await rename(path+'.tmp',path);
  }
  async function review(override:any={}){
    const operation=withChatModel(modelConfig(),()=>service.review(changes.get(8),scope,'private synthetic task'));
    const input=await job();await answer(input,override);return operation;
  }
  test('ties both screenshots to exact immutable proposal bytes and exposes only owner-scoped report metadata',async()=>{
    const operation=withChatModel(modelConfig(),()=>service.review(changes.get(8),scope,'private synthetic task'));
    const input=await job();expect(input).toEqual({id:expect.any(String),sourceHash:createHash('sha256').update(changes.get(8).after).digest('hex'),
      html:changes.get(8).after,viewports:[{width:390,height:844},{width:1280,height:900}]});
    await answer(input);const result=await operation;expect(result.status).toBe('passed');
    const report=await service.getReport(8,result.reviewId!,scope);
    expect(report).toMatchObject({status:'passed',sourceHash:input.sourceHash,views:[{index:0,width:390,height:844},{index:1,width:1280,height:900}]});
    expect(JSON.stringify(report)).not.toMatch(/synthetic page|private synthetic task|base64|89504e/);
    expect(await service.getImage(8,result.reviewId!,0,scope)).toEqual(Buffer.from(views()[0].png,'base64'));
    await expect(service.getReport(8,result.reviewId!,{userId:9,conversationId:2})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getImage(8,result.reviewId!,0,{userId:1,conversationId:9})).rejects.toBeInstanceOf(ForbiddenException);
    changes.set(8,{...changes.get(8),after:'new bytes'});
    await expect(service.getReport(8,result.reviewId!,scope)).rejects.toThrow('当前文件版本');
  });
  test('missing renderer and selected non-Qwen return explicitly unreviewed outcomes, never switch models',async()=>{
    delete process.env.ARTIFACT_REVIEW_QUEUE_DIR;
    expect(await withChatModel(modelConfig(),()=>service.review(changes.get(8),scope,'task'))).toMatchObject({status:'unavailable'});
    process.env.ARTIFACT_REVIEW_QUEUE_DIR=root;
    expect(await withChatModel(modelConfig('deepseek-v4-pro'),()=>service.review(changes.get(8),scope,'task'))).toMatchObject({status:'unavailable'});
    expect(model.reviewPage).not.toHaveBeenCalled();expect(await readdir(root)).toEqual([]);
  });
  test('a queue configured under public uploads is refused instead of publishing private evidence',async()=>{
    process.env.ARTIFACT_REVIEW_QUEUE_DIR=resolve(process.cwd(),'uploads/private-review');
    const result=await withChatModel(modelConfig(),()=>service.review(changes.get(8),scope,'task'));
    expect(result.status).toBe('unavailable');expect(model.reviewPage).not.toHaveBeenCalled();
  });
  test.each(['hash','viewport','png','failed'])('untrusted or incomplete renderer %s cannot become a passing review',async kind=>{
    const override:any={};
    if(kind==='hash')override.sourceHash='0'.repeat(64);
    if(kind==='viewport')override.views=[{...views()[0],width:100},views()[1]];
    if(kind==='png')override.views=[{...views()[0],png:'not base64'},views()[1]];
    if(kind==='failed'){override.status='failed';override.error='RENDER_FAILED';override.views=[];}
    expect(await review(override)).toMatchObject({status:'unavailable'});expect(model.reviewPage).not.toHaveBeenCalled();
  });
  test('deterministic renderer failures cannot be masked by a model saying passed',async()=>{
    const modified=views();modified[0].overflow=true;modified[1].blockedRequests=1;modified[1].pageErrors=['synthetic error'];
    const result=await review({views:modified});expect(result).toMatchObject({status:'issues',issues:expect.any(Array)});expect(result.issues).toHaveLength(3);
  });
  test('cancellation removes only this queued job and never asks a model to approve it',async()=>{
    const controller=new AbortController();
    const operation=withChatModel(modelConfig(),()=>service.review(changes.get(8),scope,'task',controller.signal));
    const input=await job();const rejected=expect(operation).rejects.toThrow();controller.abort();await rejected;
    expect(await readdir(join(root,'in'))).toEqual([]);expect(await readdir(join(root,'out'))).toEqual([]);
    await expect(service.getReport(8,input.id,scope)).rejects.toThrow();expect(model.reviewPage).not.toHaveBeenCalled();
  });
  test('late output after the bounded renderer deadline never upgrades an unavailable report',async()=>{
    let now=1000;jest.spyOn(Date,'now').mockImplementation(()=>now);
    const operation=withChatModel(modelConfig(),()=>service.review(changes.get(8),scope,'task'));const input=await job();now+=30001;
    const result=await operation;expect(result.status).toBe('unavailable');await answer(input);
    expect((await service.getReport(8,input.id,scope)).status).toBe('unavailable');expect(model.reviewPage).not.toHaveBeenCalled();
  });
  test('one model-guided fix creates a separate proposal and review; the third same-path version is not falsely reviewed',async()=>{
    changes.set(9,{...changes.get(8),id:9,after:'<h1>fixed page</h1>'});changes.set(10,{...changes.get(8),id:10,after:'<h1>third page</h1>'});
    coding.tool=jest.fn().mockResolvedValueOnce({proposalId:8,path:'index.html'}).mockResolvedValueOnce({proposalId:9,path:'index.html'}).mockResolvedValueOnce({proposalId:10,path:'index.html'});
    model.reviewPage.mockResolvedValueOnce({passed:false,issues:['人物主体在手机上被遮挡。']}).mockResolvedValueOnce({passed:true,issues:[]});
    model.json.mockResolvedValue({content:changes.get(9).after,description:'修正主体遮挡'});
    const context:any={...scope,fileArtifacts:[],artifactReviews:[],artifactReviewAttempts:new Map(),fileQuestionContext:{question:'synthetic task',history:[]}};
    const skill=new CodingSkill(coding,undefined,service);
    const operation=withChatModel(modelConfig(),()=>skill.execute({action:'propose'},context));
    const first=await job();await answer(first);const second=await job(first.id);await answer(second);
    const result:any=await operation;expect(result.result.visualReview.status).toBe('passed');expect(result.result.proposalId).toBe(9);
    expect(result.result.repairAttempted).toBe(true);expect(result.result.previousChangeId).toBe(8);
    const third:any=await withChatModel(modelConfig(),()=>skill.execute({action:'propose'},context));
    expect(third.result.visualReview.status).toBe('not_reviewed');expect(context.fileArtifacts.map((row:any)=>row.changeId)).toEqual([10]);
    expect(context.artifactReviews[0].review.status).toBe('issues');expect(context.artifactReviews[1].review.status).toBe('passed');
    expect(changes.get(8).after).toBe('<h1>synthetic page</h1>');expect(model.reviewPage).toHaveBeenCalledTimes(2);
  });
  test('reviewPage uses exactly two native images with non-thinking options and discards raw reasoning',async()=>{
    const seen:any[]=[];
    global.fetch=jest.fn(async(_url,init)=>{seen.push(JSON.parse(init.body as string));return {ok:true,json:async()=>({choices:[{
      message:{content:'{"passed":true,"issues":[]}',reasoning_content:'private reasoning'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:5}})};}) as any;
    const pageViews=views().map(view=>({...view,data:Buffer.from(view.png,'base64')}));
    const verdict=await withChatModel(modelConfig(),()=>new RagModelService().reviewPage(pageViews,'synthetic task'));
    expect(verdict).toEqual({passed:true,issues:[]});expect(seen[0].enable_thinking).toBe(false);
    expect(seen[0].messages[1].content.filter((part:any)=>part.type==='image_url')).toHaveLength(2);
    expect(JSON.stringify(verdict)).not.toContain('private reasoning');
  });
  test('failed repair JSON preserves the original downloadable proposal and observed issues',async()=>{
    model.reviewPage.mockResolvedValue({passed:false,issues:['主体被遮挡。']});model.json.mockRejectedValue(Error('synthetic format failure'));
    coding.tool=jest.fn();
    const operation=withChatModel(modelConfig(),()=>service.reviewAndRepair(changes.get(8),scope,'task'));
    const input=await job();await answer(input);const result=await operation;
    expect(result).toMatchObject({proposalResult:{proposalId:8},visualReview:{status:'issues'},repairAttempted:true,repairError:'REPAIR_UNAVAILABLE'});
    expect(coding.tool).not.toHaveBeenCalled();expect(changes.get(8).after).toBe('<h1>synthetic page</h1>');
  });
  test.each(['reread','review'])('a saved repair remains the downloadable proposal when its later %s fails',async failure=>{
    const repaired={...changes.get(8),id:9,after:'<h1>saved repaired page</h1>'};changes.set(9,repaired);
    coding.tool=jest.fn().mockResolvedValue({proposalId:9,path:'index.html',status:'PENDING',applied:false});
    model.json.mockResolvedValue({content:repaired.after,description:'修复主体布局'});
    const first={status:'issues' as const,sourceHash:createHash('sha256').update(changes.get(8).after).digest('hex'),issues:['主体被遮挡。']};
    const reviewer=jest.spyOn(service,'review').mockResolvedValueOnce(first);
    if(failure==='reread')coding.change.mockImplementation(async(id:number)=>{if(id===9)throw Error('synthetic re-read failure');return changes.get(id);});
    else reviewer.mockRejectedValueOnce(Error('synthetic re-review failure'));
    const result=await withChatModel(modelConfig(),()=>service.reviewAndRepair(changes.get(8),scope,'task'));
    expect(result).toMatchObject({proposalResult:{proposalId:9,path:'index.html'},visualReview:{status:'unavailable',sourceHash:createHash('sha256').update(repaired.after).digest('hex')},
      repairAttempted:true,previousChangeId:8,repairError:'REVIEW_UNAVAILABLE'});
    expect(result.records.map(row=>({id:row.changeId,status:row.review.status}))).toEqual([{id:8,status:'issues'},{id:9,status:'unavailable'}]);
    expect(result.visualReview.reviewId).toBeUndefined();expect(changes.get(8).after).toBe('<h1>synthetic page</h1>');
    expect(changes.get(9).after).toBe('<h1>saved repaired page</h1>');expect(coding.tool).toHaveBeenCalledTimes(1);
  });
  test('reviewPage rejects malformed pass flags and unsupported selected models without fabricated approval',async()=>{
    const pageViews=views().map(view=>({...view,data:Buffer.from(view.png,'base64')}));
    const fetch=jest.fn(async()=>({ok:true,json:async()=>({choices:[{message:{content:'{"passed":true,"issues":["broken"]}'},finish_reason:'stop'}]})}));
    global.fetch=fetch as any;
    await expect(withChatModel(modelConfig(),()=>new RagModelService().reviewPage(pageViews,'task'))).rejects.toThrow();
    fetch.mockClear();await expect(withChatModel(modelConfig('deepseek-v4-pro'),()=>new RagModelService().reviewPage(pageViews,'task'))).rejects.toThrow('未自动换模型');
    expect(fetch).not.toHaveBeenCalled();
  });
});

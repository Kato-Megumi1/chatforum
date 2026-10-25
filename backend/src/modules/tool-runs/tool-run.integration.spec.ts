import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { ToolRunService } from './tool-run.service';
import { currentToolWriteApproval, ToolApprovalPendingError, ToolStepUncertainError, TOOL_POLICY_VERSION } from './tool-run.policy';
import { CodingService } from '../coding/coding.service';
import { CodingSkill } from '../agent/skills/coding.skill';
import { CharacterDialogueService } from '../agent/character-dialogue.service';
import { SkillRegistry } from '../agent/skills/skill.registry';
import { FILE_OUTPUT_START, FILE_OUTPUT_END } from '../coding/file-output';
import { buildConversationMemory } from '../agent/conversation-memory.policy';
import { newRagUsage } from '../agent/rag-model.service';
import { runtimeState, withModelRuntime } from '../agent/model-runtime';
import { withChatModel } from '../chat/chat-models';
import { ForumSubscriptionsService } from '../forum/forum-subscriptions.service';
import { AttachmentService } from '../coding/attachment.service';

const fixtureDatabase='mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test';
const suite=process.env.RUN_TOOL_STEPS_INTEGRATION==='1'?describe:describe.skip;
suite('private tool ledger real MySQL persistence and consent CAS',()=>{
  let db:PrismaService,service:ToolRunService,owner:number,other:number;
  const prefix='toolledger_'+randomUUID().slice(0,8),createdRuns:string[]=[];
  const args={action:'create',kind:'NEW_POSTS',query:'虚构校园'};
  beforeAll(async()=>{
    if(process.env.DATABASE_URL!==fixtureDatabase)throw Error('Refusing non-fixture database');
    db=new PrismaService();await db.$connect();service=new ToolRunService(db);
    [owner,other]=await Promise.all([1,2].map(async n=>(await db.user.create({data:{username:prefix+n,
      email:prefix+n+'@example.test',password:'disabled-fixture-not-a-login'}})).id));
  });
  afterAll(async()=>{
    if(db){
      if(owner)await db.conversation.deleteMany({where:{userId:{in:[owner,other]},title:{startsWith:prefix}}});
      if(owner)await db.user.deleteMany({where:{id:{in:[owner,other]},username:{startsWith:prefix}}});
      await db.$disconnect();
    }
  });
  async function task(){
    const conversation=await db.conversation.create({data:{userId:owner,title:prefix+'-'+randomUUID().slice(0,8),
      conversationType:'ASSISTANT',personaKey:'assistant'}});
    const workerToken=randomUUID(),run=await db.chatRun.create({data:{userId:owner,conversationId:conversation.id,
      requestId:randomUUID(),input:{question:'private synthetic request'},status:'RUNNING',workerToken,leaseUntil:new Date(Date.now()+60000)}});
    createdRuns.push(run.id);
    return{run,conversation,scope:{userId:owner,conversationId:conversation.id,runId:run.id,workerToken,fileSourceEpoch:conversation.memoryEpoch}};
  }
  async function waiting(){
    const fixture=await task(),execute=jest.fn(async()=>'{"success":true,"data":{"id":1}}');
    await expect(service.invoke('manage_forum_tracking',{...args,confirmed:true},fixture.scope,execute)).rejects.toBeInstanceOf(ToolApprovalPendingError);
    expect(execute).not.toHaveBeenCalled();
    const step=await db.chatToolStep.findFirstOrThrow({where:{runId:fixture.run.id}});
    await service.pause(fixture.run.id,fixture.scope.workerToken,step.id);
    return{...fixture,step,execute};
  }
  async function claim(fixture:Awaited<ReturnType<typeof task>>){
    const workerToken=randomUUID();await db.chatRun.update({where:{id:fixture.run.id},data:{status:'RUNNING',workerToken,leaseUntil:new Date(Date.now()+60000)}});
    return{...fixture.scope,workerToken};
  }
  test('a waiting operation survives reconstruction, concurrent duplicate approvals queue the original run once, and write replay is idempotent',async()=>{
    const f=await waiting(),second=new ToolRunService(db);
    const decisions=await Promise.all([service,second].map(instance=>instance.decide(owner,f.run.id,f.step.id,true,f.step.argsHash,TOOL_POLICY_VERSION,0)));
    expect(decisions.map(row=>row.status)).toEqual(['QUEUED','QUEUED']);
    const scope=await claim(f),execute=jest.fn(async action=>{expect(currentToolWriteApproval(scope,action)).toBeDefined();return'{"success":true,"data":{"receiptId":17}}';});
    await service.invoke('manage_forum_tracking',args,scope,execute);
    expect(await second.invoke('manage_forum_tracking',{...args,confirmed:true},scope,execute)).toContain('17');
    expect(execute).toHaveBeenCalledTimes(1);expect(await db.chatRun.count({where:{id:f.run.id}})).toBe(1);
    const publicRows=await second.steps(owner,f.run.id,0);
    expect(publicRows[0].state).toBe('SUCCEEDED');expect(JSON.stringify(publicRows)).not.toContain('arguments');
  });
  test('a concurrently running write cannot be dispatched a second time from another service instance',async()=>{
    const f=await waiting();await service.decide(owner,f.run.id,f.step.id,true,f.step.argsHash,TOOL_POLICY_VERSION,0);
    const scope=await claim(f);let release:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    let started:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
    const execute=jest.fn(async()=>{started();await gate;return'{"success":true}';});
    const first=service.invoke('manage_forum_tracking',args,scope,execute);await began;
    await expect(new ToolRunService(db).invoke('manage_forum_tracking',args,scope,execute)).rejects.toBeInstanceOf(ToolStepUncertainError);
    release();await first;expect(execute).toHaveBeenCalledTimes(1);
  });
  test('unknown side effects are persisted and cannot be retried after reconstructing the service',async()=>{
    const f=await task(),execute=jest.fn(async()=>{throw Error('synthetic after-effect transport interruption');});
    await expect(service.invoke('code_workspace',{action:'propose',path:'fixture.txt',content:'private-source'},f.scope,execute)).rejects.toThrow();
    const row=await db.chatToolStep.findFirstOrThrow({where:{runId:f.run.id}});expect(row.state).toBe('UNCERTAIN');
    await expect(new ToolRunService(db).invoke('code_workspace',{action:'propose',path:'fixture.txt',content:'private-source'},f.scope,execute)).rejects.toBeInstanceOf(ToolStepUncertainError);
    expect(execute).toHaveBeenCalledTimes(1);
  });
  test('reject, cancel, cross-account and altered argument hashes never execute the action',async()=>{
    const f=await waiting();
    await expect(service.decide(other,f.run.id,f.step.id,true,f.step.argsHash,TOOL_POLICY_VERSION,0)).rejects.toThrow();
    await expect(service.decide(owner,f.run.id,f.step.id,true,'f'.repeat(64),TOOL_POLICY_VERSION,0)).rejects.toThrow();
    await service.decide(owner,f.run.id,f.step.id,false,f.step.argsHash,TOOL_POLICY_VERSION,0);
    const scope=await claim(f);expect(JSON.parse(await service.invoke('manage_forum_tracking',args,scope,f.execute)).data.code).toBe('USER_REJECTED');
    expect(f.execute).not.toHaveBeenCalled();
    const cancelled=await waiting();await db.chatRun.update({where:{id:cancelled.run.id},data:{status:'CANCELLED'}});
    await service.reconcileInterrupted([cancelled.run.id]);
    expect((await db.chatToolStep.findUniqueOrThrow({where:{id:cancelled.step.id}})).state).toBe('INVALIDATED');
    await expect(service.decide(owner,cancelled.run.id,cancelled.step.id,true,cancelled.step.argsHash,TOOL_POLICY_VERSION,0)).rejects.toThrow();
  });
  test('history deletion invalidates a pending action instead of keeping the conversation locked forever',async()=>{
    const f=await waiting();await db.conversation.update({where:{id:f.conversation.id},data:{memoryEpoch:{increment:1}}});
    await expect(service.decide(owner,f.run.id,f.step.id,true,f.step.argsHash,TOOL_POLICY_VERSION,0)).rejects.toThrow();
    await service.reconcileInterrupted([f.run.id]);
    expect((await db.chatRun.findUniqueOrThrow({where:{id:f.run.id}})).status).toBe('FAILED');
    expect(await service.approvals(owner,f.conversation.id,0)).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });
  test('password rotation invalidates the old approval version and old JWT readers',async()=>{
    const f=await waiting();await db.user.update({where:{id:owner},data:{authVersion:{increment:1}}});
    try{
      await expect(service.decide(owner,f.run.id,f.step.id,true,f.step.argsHash,TOOL_POLICY_VERSION,0)).rejects.toThrow();
      await service.reconcileInterrupted([f.run.id]);
      expect((await db.chatRun.findUniqueOrThrow({where:{id:f.run.id}})).status).toBe('FAILED');
    }finally{await db.user.update({where:{id:owner},data:{authVersion:0}});}
  });
  test('reads re-run current checks and never persist a private read blob or reasoning fields',async()=>{
    const f=await task(),execute=jest.fn().mockResolvedValueOnce('PRIVATE_OLD').mockResolvedValueOnce('PRIVATE_NEW');
    expect(await service.invoke('get_forum_post',{postId:1},f.scope,execute)).toBe('PRIVATE_OLD');
    expect(await new ToolRunService(db).invoke('get_forum_post',{postId:1},f.scope,execute)).toBe('PRIVATE_NEW');
    const step=await db.chatToolStep.findFirstOrThrow({where:{runId:f.run.id}});
    expect(JSON.stringify(step.result)).not.toContain('PRIVATE_');expect(execute).toHaveBeenCalledTimes(2);
  });
  test('the direct file channel restores a verified receipt without proposing twice, and rejects changed source versions',async()=>{
    const f=await task(),coding=new CodingService(db),skill=new CodingSkill(coding),old=SkillRegistry.getTool('code_workspace');
    const save=jest.spyOn(skill,'execute');
    SkillRegistry.register(skill,{name:'code_workspace',description:'fixture',category:'tool',enabled:true});
    const agent={executeWithTools:jest.fn(async()=>{
      runtimeState()!.steps.push({kind:'chat',finishReason:'stop'} as any);
      return{content:`${FILE_OUTPUT_START}{"path":"fixture.txt"}>>>\nprivate generated fixture${FILE_OUTPUT_END}`,toolOutputs:[]};
    })};
    const {snapshot}=buildConversationMemory([],'assistant');
    const run=async()=>{
      const context={...f.scope,fileArtifacts:[] as any[]};
      const character=new CharacterDialogueService(agent as any,{} as any,new ToolRunService(db),coding);
      const text=await withModelRuntime(new AbortController().signal,()=>withChatModel({id:'qwen3.8-max',label:'fixture',
        defaultModel:'fixture',defaultApiKey:'not-a-key',defaultApiBase:'https://invalid.example.test',bodyOptions:{},pricingPrefix:'TEST'},
        ()=>character.reply({persona:'',question:'生成独立文本文件',history:[],memory:snapshot,toolScope:context},[],newRagUsage())));
      return{text,context};
    };
    try{
      const first=await run(),second=await run();expect(first.text).toBe('文件已生成。');expect(second.text).toBe(first.text);
      expect(save).toHaveBeenCalledTimes(1);expect(second.context.fileArtifacts).toEqual(first.context.fileArtifacts);
      expect(await db.codingChange.count({where:{conversationId:f.conversation.id}})).toBe(1);
      await db.codingFile.create({data:{conversationId:f.conversation.id,path:'fixture.txt',content:'new source',bytes:10}});
      const changed=await run();expect(changed.text).toContain('未能保存');expect(changed.context.fileArtifacts).toEqual([]);
      expect(save).toHaveBeenCalledTimes(1);
      await db.conversation.update({where:{id:f.conversation.id},data:{memoryEpoch:{increment:1}}});
      await expect(coding.restoreToolProposal(first.context.fileArtifacts[0].changeId,'fixture.txt',f.scope)).rejects.toThrow();
    }finally{save.mockRestore();if(old)SkillRegistry.register(old,{name:'code_workspace',description:'fixture',category:'tool',enabled:true});}
  });
  test.each(['cancel','epoch','password'] as const)('the actual business transaction rechecks %s immediately before mutation',async change=>{
    const f=await waiting();await service.decide(owner,f.run.id,f.step.id,true,f.step.argsHash,TOOL_POLICY_VERSION,0);
    const scope=await claim(f),subscriptions=new ForumSubscriptionsService(db,{} as any);
    const before=await db.forumSubscription.count({where:{userId:owner}});
    try{
      await expect(service.invoke('manage_forum_tracking',args,scope,async()=>{
        if(change==='cancel')await db.chatRun.update({where:{id:f.run.id},data:{status:'CANCELLED'}});
        if(change==='epoch')await db.conversation.update({where:{id:f.conversation.id},data:{memoryEpoch:{increment:1}}});
        if(change==='password')await db.user.update({where:{id:owner},data:{authVersion:{increment:1}}});
        return JSON.stringify(await subscriptions.create(owner,{kind:'NEW_POSTS',query:'虚构校园'},f.conversation.id));
      })).rejects.toThrow();
      expect(await db.forumSubscription.count({where:{userId:owner}})).toBe(before);
    }finally{if(change==='password')await db.user.update({where:{id:owner},data:{authVersion:0}});}
  });
  test.each(['fixture.txt','fixture.pdf'])('private %s proposal transactions reject a task cancelled after ledger dispatch',async path=>{
    const f=await task(),attachments=new AttachmentService(db,{} as any),coding=new CodingService(db,attachments);
    const args={action:'propose',path,content:'private fixture',expectedRevision:0,description:'synthetic private proposal'};
    await expect(service.invoke('code_workspace',args,f.scope,async actual=>{
      await db.chatRun.update({where:{id:f.run.id},data:{status:'CANCELLED'}});
      return JSON.stringify(await coding.tool(actual,f.scope));
    })).rejects.toThrow();
    expect(await db.codingChange.count({where:{conversationId:f.conversation.id}})).toBe(0);
  });
});

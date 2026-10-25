import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request = require('supertest');
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { AdminSettingsService } from '../admin-settings/admin-settings.service';
import { ForumReceiptCleanupService } from '../forum/forum-receipt-cleanup.service';
import { AgentExecutorService } from '../agent/agent.executor';
import { CharacterDialogueService } from '../agent/character-dialogue.service';
import { ToolRunService } from './tool-run.service';
import { TOOL_POLICY_VERSION, ToolApprovalPendingError } from './tool-run.policy';

const suite=process.env.RUN_TOOL_STEPS_INTEGRATION==='1'?describe:describe.skip;
suite('real AppModule HTTP tool approval boundary',()=>{
  let app:INestApplication,db:PrismaService,tools:ToolRunService,owner:number,other:number,token:string,otherToken:string;
  const prefix='toolhttp_'+randomUUID().slice(0,8),secret='isolated-tool-approval-jwt-only-not-production-0001';
  const prior:Record<string,string|undefined>={};
  let configSpy:jest.SpyInstance,networkSpy:jest.SpyInstance;
  const flags={CHAT_WORKER_ENABLED:'false',MEMORY_WORKER_ENABLED:'false',RAG_WORKER_ENABLED:'false',LOCAL_MONITOR_ENABLED:'false',
    FORUM_EVENTS_WORKER_ENABLED:'false',FORUM_HOT_PRECOMPUTE_ENABLED:'false',FORUM_EVENT_RETENTION_ENABLED:'false',FORUM_SEARCH_ENABLED:'false',
    JWT_ACCESS_SECRET:secret,JWT_REFRESH_SECRET:'isolated-tool-approval-refresh-only-not-production-0002'};
  beforeAll(async()=>{
    if(process.env.DATABASE_URL!=='mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test')throw Error('Refusing non-fixture database');
    for(const [key,value]of Object.entries(flags)){prior[key]=process.env[key];process.env[key]=value;}
    // Keep real module wiring, guards and SQL. Do not load local .env or SMTP
    // storage, connect Redis, claim jobs or make any model/vector/HTTP request.
    const original=ConfigModule.forRoot.bind(ConfigModule);
    configSpy=jest.spyOn(ConfigModule,'forRoot').mockImplementation(options=>original({...options,ignoreEnvFile:true}));
    networkSpy=jest.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('External fetch forbidden in tool HTTP fixture');});
    const {AppModule}=await import('../../app.module');
    const moduleRef=await Test.createTestingModule({imports:[AppModule]})
      .overrideProvider(RedisService).useValue({getClient:()=>({eval:async()=>[1,60000]})})
      .overrideProvider(AdminSettingsService).useValue({smtp:()=>null,snapshot:()=>({locked:false})})
      .overrideProvider(ForumReceiptCleanupService).useValue({})
      .compile();
    app=moduleRef.createNestApplication({logger:false});app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));await app.init();
    db=app.get(PrismaService);tools=app.get(ToolRunService);
    expect((app.get(AgentExecutorService) as any).toolRuns).toBe(tools);
    expect((app.get(CharacterDialogueService) as any).toolRuns).toBe(tools);
    [owner,other]=await Promise.all([1,2].map(async n=>(await db.user.create({data:{username:prefix+n,email:prefix+n+'@example.test',password:'disabled-fixture-not-login'}})).id));
    const jwt=new JwtService();token=await jwt.signAsync({sub:owner,authVersion:0},{secret});otherToken=await jwt.signAsync({sub:other,authVersion:0},{secret});
  },30000);
  afterAll(async()=>{
    if(db&&owner){await db.conversation.deleteMany({where:{userId:owner,title:{startsWith:prefix}}});
      await db.user.deleteMany({where:{id:{in:[owner,other]},username:{startsWith:prefix}}});}
    await app?.close();configSpy?.mockRestore();networkSpy?.mockRestore();
    for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  });
  async function pending(){
    const conversation=await db.conversation.create({data:{userId:owner,title:prefix+'-approval',conversationType:'ASSISTANT',personaKey:'assistant'}});
    const workerToken=randomUUID(),run=await db.chatRun.create({data:{userId:owner,conversationId:conversation.id,requestId:randomUUID(),
      input:{question:'synthetic request'},status:'RUNNING',workerToken,leaseUntil:new Date(Date.now()+60000)}});
    await expect(tools.invoke('manage_forum_tracking',{action:'create',kind:'NEW_POSTS',query:'虚构'},
      {userId:owner,conversationId:conversation.id,runId:run.id,workerToken,fileSourceEpoch:0},async()=>{throw Error('Must not execute before consent');}))
      .rejects.toBeInstanceOf(ToolApprovalPendingError);
    const step=await db.chatToolStep.findFirstOrThrow({where:{runId:run.id}});await tools.pause(run.id,workerToken,step.id);
    return{conversation,run,step,path:`/api/chat/tool-runs/${run.id}/steps/${step.id}/decision`};
  }
  test('the actual app exposes only private allowlisted cards, rejects missing/cross-account JWT and strict DTO bypasses, resumes the original run',async()=>{
    const f=await pending(),url='/api/chat/tool-runs/approvals?conversationId='+f.conversation.id;
    await request(app.getHttpServer()).get(url).expect(401);
    await request(app.getHttpServer()).get(url).auth(otherToken,{type:'bearer'}).expect(404);
    const cards=await request(app.getHttpServer()).get(url).auth(token,{type:'bearer'}).expect(200);
    expect(cards.headers['cache-control']).toBe('private, no-store');expect(cards.body.data).toHaveLength(1);
    expect(cards.body.data[0]).toMatchObject({id:f.step.id,runId:f.run.id,state:'WAITING_APPROVAL'});
    expect(JSON.stringify(cards.body)).not.toMatch(/arguments|workerToken|reasoning|password|input|privateState/);
    await request(app.getHttpServer()).get('/api/chat/tool-runs/approvals?conversationId=1e2').auth(token,{type:'bearer'}).expect(400);
    const decision={approved:true,argsHash:f.step.argsHash,policyVersion:TOOL_POLICY_VERSION};
    await request(app.getHttpServer()).post(f.path).auth(token,{type:'bearer'}).send({...decision,confirmed:true}).expect(400);
    await request(app.getHttpServer()).post(f.path).auth(token,{type:'bearer'}).send({...decision,approved:'true'}).expect(400);
    await request(app.getHttpServer()).post(f.path).auth(token,{type:'bearer'}).send({...decision,argsHash:'0'.repeat(64)}).expect(409);
    const response=await request(app.getHttpServer()).post(f.path).auth(token,{type:'bearer'}).send(decision).expect(201);
    expect(response.body.data).toMatchObject({runId:f.run.id,status:'QUEUED'});
    expect(await db.chatRun.count({where:{conversationId:f.conversation.id}})).toBe(1);
    await db.user.update({where:{id:owner},data:{authVersion:1}});
    try{await request(app.getHttpServer()).get(url).auth(token,{type:'bearer'}).expect(401);}
    finally{await db.user.update({where:{id:owner},data:{authVersion:0}});}
    expect(networkSpy).not.toHaveBeenCalled();
  });
});

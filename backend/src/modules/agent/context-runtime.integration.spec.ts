import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { ChatService } from '../chat/chat.service';
import { ChatRunService } from '../chat/chat-run.service';
import { NovelGraphService } from './novel-graph.service';
import { NOVEL_GRAPH_VERSION } from './novel-graph.policy';
import { RedisService } from '../../common/redis.service';
import { RedisThrottlerStorage } from '../../common/redis-throttler.storage';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminSettingsService } from '../admin-settings/admin-settings.service';
import { sign } from 'jsonwebtoken';
import * as request from 'supertest';

const run=process.env.RUN_CONTEXT_INTEGRATION==='1'?describe:describe.skip;
run('isolated memory, identity, graph ranking and worker integration',()=>{
  let db:PrismaService, memory:ConversationMemoryService, chats:ChatService, owner:number, other:number;
  let capture=false;const reads:any[]=[];
  beforeAll(async()=>{
    if(process.env.DATABASE_URL!=='mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture DB');
    if(process.env.REDIS_HOST!=='127.0.0.1'||process.env.REDIS_PORT!=='36386'||process.env.QDRANT_URL!=='http://127.0.0.1:36336')
      throw Error('Refusing non-fixture Redis/vector dependencies');
    db=new PrismaService();await db.$connect();memory=new ConversationMemoryService(db);chats=new ChatService(db,memory);
    db.$use(async(params,next)=>{if(capture&&params.model==='ChatMessage'&&params.action==='findMany')reads.push(params.args);return next(params);});
    for(let i=0;i<2;i++) { const id=randomUUID();const u=await db.user.create({data:{username:id,email:id+'@example.test',password:'disabled-fixture'}});if(i)other=u.id;else owner=u.id; }
  });
  afterAll(async()=>{
    try{if(db&&owner&&other){
      await db.knowledgeBase.deleteMany({where:{ownerId:{in:[owner,other]}}});
      await db.conversation.deleteMany({where:{userId:{in:[owner,other]}}});
      await db.user.deleteMany({where:{id:{in:[owner,other]}}});
    }}finally{await db?.$disconnect();}
  });
  const append=async(cid:number,user:string,answer:string,persona='assistant')=>{
    await db.chatMessage.createMany({data:[{conversationId:cid,role:'USER',content:user},
      {conversationId:cid,role:'ASSISTANT',content:answer,ragMetadata:{state:persona==='assistant'?'general':'roleplay',personaKey:persona}}]});
  };
  const rebuild=async(cid:number)=>{
    for(let i=0;i<20;i++){
      const job=await db.memoryRebuildJob.findUnique({where:{conversationId:cid}});
      if(!job||job.status==='READY')return;
      const token=randomUUID();
      await db.memoryRebuildJob.update({where:{conversationId:cid},data:{status:'RUNNING',workerToken:token,leaseUntil:new Date(Date.now()+30000)}});
      await (memory as any).rebuildBatch(job,token);
    }
    throw new Error('fixture rebuild did not finish within its synthetic bound');
  };
  test('hot memory reads only new messages; old two-sided episodes survive; deletion invalidates summaries',async()=>{
    const c=await chats.createConversation(owner,'fixture');
    await append(c.id,'我叫小舟。周日看蓝海电影好吗？','先别订票，我还不确定。');
    for(let i=0;i<32;i++) await append(c.id,'日常话题'+i,'简短回应'+i);
    let frame=await memory.prepare(c.id,owner,'assistant','助手','还记得蓝海电影的约定吗？');
    await rebuild(c.id);frame=await memory.prepare(c.id,owner,'assistant','助手','还记得蓝海电影的约定吗？');
    expect(frame.history).toHaveLength(60);expect(frame.memory.summary.text).toContain('先别订票');
    reads.length=0;capture=true;
    frame=await memory.prepare(c.id,owner,'assistant','助手','你好');
    capture=false;expect(reads).toHaveLength(1);expect(reads[0].take).toBe(62);
    await append(c.id,'我叫阿青。','你好阿青');
    expect((await memory.prepare(c.id,owner,'assistant','助手','你好')).memory.state.name?.value).toBe('阿青');
    const last=await db.chatMessage.findFirst({where:{conversationId:c.id,role:'USER'},orderBy:{id:'desc'}});
    await chats.deleteMessage(c.id,last!.id,owner);
    await memory.prepare(c.id,owner,'assistant','助手','你好');await rebuild(c.id);
    expect((await memory.prepare(c.id,owner,'assistant','助手','你好')).memory.state.name?.value).toBe('小舟');
    await expect(memory.prepare(c.id,other,'assistant','助手','你好')).rejects.toThrow('对话不可访问');
  },30000);
  test('cross-conversation sharing is opt-in and cannot cross owner, mode or character',async()=>{
    const role=await chats.createConversation(owner,'role',{persona:'kato_megumi_persona'});
    const ai=await chats.createConversation(owner,'ai');
    const stranger=await chats.createConversation(other,'stranger');
    const same=await chats.createConversation(owner,'same');
    const destination=await chats.createConversation(owner,'destination');
    const otherRole=await chats.createConversation(owner,'other-role',{persona:'yukinoshita_yukino_persona'});
    const roleDestination=await chats.createConversation(owner,'role-destination',{persona:'kato_megumi_persona'});
    for(const [c,who,text,key] of [[role,owner,'蓝海角色私有约定','kato_megumi_persona'],[ai,owner,'蓝海未授权约定','assistant'],
      [stranger,other,'蓝海别人私有约定','assistant'],[same,owner,'蓝海任务请写报告','assistant']] as const){
      await append(c.id,text,'记下了',key);if(c.id!==ai.id)await chats.updateConversation(c.id,who,{sharedMemory:true});
      await memory.prepare(c.id,who,key,'测试','蓝海');
    }
    let f=await memory.prepare(destination.id,owner,'assistant','助手','蓝海');expect(f.memory.summary.text).toBe('');
    await chats.updateConversation(destination.id,owner,{sharedMemory:true});
    for(const c of [role,ai,stranger,same,destination])await rebuild(c.id);
    f=await memory.prepare(destination.id,owner,'assistant','助手','蓝海');
    expect(f.memory.summary.text).toContain('蓝海任务请写报告');
    for(const forbidden of ['角色私有','未授权约定','别人私有'])expect(f.memory.summary.text).not.toContain(forbidden);
    await append(otherRole.id,'蓝海另一个角色约定','记下了','yukinoshita_yukino_persona');
    await chats.updateConversation(otherRole.id,owner,{sharedMemory:true});
    await chats.updateConversation(roleDestination.id,owner,{sharedMemory:true});
    const roleFrame=await memory.prepare(roleDestination.id,owner,'kato_megumi_persona','角色','蓝海');
    expect(roleFrame.memory.summary.text).toContain('蓝海角色私有约定');
    for(const forbidden of ['另一个角色约定','任务请写报告','别人私有'])expect(roleFrame.memory.summary.text).not.toContain(forbidden);
    await chats.updateConversation(same.id,owner,{sharedMemory:false});
    expect((await memory.prepare(destination.id,owner,'assistant','助手','蓝海')).memory.summary.text).not.toContain('蓝海任务请写报告');
  });
  test('identity changes only on empty conversations, never re-label existing history',async()=>{
    const c=await chats.createConversation(owner,'identity');
    await chats.configureIdentity(c.id,owner,{persona:'kato_megumi_persona'});
    await append(c.id,'你好','你好','kato_megumi_persona');
    await expect(chats.configureIdentity(c.id,owner,{conversationType:'ASSISTANT'})).rejects.toThrow('不能换角色');
    await expect(memory.prepare(c.id,owner,'assistant','助手','你好')).rejects.toThrow('身份不匹配');
  });
  test.each([true,false])('independent conversations run concurrently (same owner: %s); same-conversation and idempotency guards remain',async sameOwner=>{
    const secondOwner=sameOwner?owner:other;
    const a=await chats.createConversation(owner,'worker-a'), b=await chats.createConversation(secondOwner,'worker-b');
    let release!:()=>void;const pause=new Promise<void>(r=>{release=r;});let active=0,peak=0;
    const novel={answer:jest.fn(async()=>{active++;peak=Math.max(peak,active);await pause;active--;return {content:'fixture',metadata:{state:'general',personaKey:'assistant'}};})};
    const rag={principal:jest.fn().mockResolvedValue({}),authorize:jest.fn(),citation:jest.fn()};
    const coding={messageContext:jest.fn().mockResolvedValue({current:[],library:[]})};
    const runs=new ChatRunService(db,novel as any,rag as any,{} as any,memory,coding as any);
    const input={conversationId:a.id,requestId:randomUUID(),question:'你好',mode:'normal' as const,modelId:'deepseek-v4-pro'};
    const [first,second]=await Promise.all([runs.create(owner,input),
      runs.create(secondOwner,{...input,conversationId:b.id,requestId:randomUUID()})]);
    expect((await runs.create(owner,input)).id).toBe(first.id);
    await expect(runs.create(owner,{...input,requestId:randomUUID()})).rejects.toThrow('正在生成');
    await expect(runs.create(owner,{...input,requestId:randomUUID(),persona:'kato_megumi_persona'})).rejects.toThrow('切换身份');
    await runs.tick();
    for(let i=0;i<100&&peak<2;i++)await new Promise(r=>setTimeout(r,20));
    expect(peak).toBe(2);release();
    for(let i=0;i<100;i++){if(await db.chatRun.count({where:{id:{in:[first.id,second.id]},status:'COMPLETED'}})===2)break;await new Promise(r=>setTimeout(r,20));}
    expect(await db.chatRun.count({where:{id:{in:[first.id,second.id]},status:'COMPLETED'}})).toBe(2);
    for(const c of [a,b])await rebuild(c.id);
    for(let i=0;i<100;i++){if(await db.conversationEpisode.count({where:{conversationId:{in:[a.id,b.id]}}})===2)break;await new Promise(r=>setTimeout(r,20));}
    expect(await db.conversationEpisode.count({where:{conversationId:{in:[a.id,b.id]}}})).toBe(2);
    expect(await db.chatMessage.count({where:{conversationId:{in:[a.id,b.id]}}})).toBe(4);runs.onModuleDestroy();
  },15000);
  test('graph ranks relevant facts BEFORE truncating, excludes inaccessible documents and wrong chapters',async()=>{
    const kb=await db.knowledgeBase.create({data:{name:randomUUID(),ownerId:owner}});
    const index=await db.ragIndexVersion.create({data:{knowledgeBaseId:kb.id,version:1,status:'READY',collectionName:randomUUID(),graphVersion:NOVEL_GRAPH_VERSION}});
    const doc=await db.knowledgeBaseDocument.create({data:{knowledgeBaseId:kb.id,ownerId:owner,fileName:'fixture.txt',filePath:'fixture-only',fileType:'txt',fileSize:10}});
    const chunk=await db.knowledgeChunk.create({data:{id:randomUUID(),knowledgeBaseId:kb.id,indexVersionId:index.id,documentId:doc.id,documentVersion:1,chunkIndex:0,
      content:'加藤惠把眼镜送给安艺伦也。',contentHash:'fixture',vectorId:randomUUID(),chapter:'第一卷 第一章'}});
    const scene=await db.novelGraphScene.create({data:{id:randomUUID(),indexVersionId:index.id,graphVersion:NOVEL_GRAPH_VERSION,status:'READY'}});
    await db.novelGraphFact.createMany({data:Array.from({length:130},(_,i)=>({id:('a'+i.toString().padStart(3,'0')+randomUUID()).slice(0,36),sceneId:scene.id,indexVersionId:index.id,
      chunkId:chunk.id,subjectKey:'megumi',targetKey:'tomoya',predicate:'ACTION',objectText:'加藤惠看书',quote:'加藤惠在图书馆读一本书。'}))});
    const relevant=await db.knowledgeChunk.create({data:{...chunk,id:randomUUID(),vectorId:randomUUID(),chunkIndex:1}});
    await db.novelGraphFact.create({data:{id:('z'+randomUUID()).slice(0,36),sceneId:scene.id,indexVersionId:index.id,chunkId:relevant.id,
      subjectKey:'megumi',targetKey:'tomoya',predicate:'ACTION',objectText:'加藤惠把眼镜送给安艺伦也',quote:chunk.content}});
    const graph=new NovelGraphService(db,{} as any);
    const hits=await graph.candidates(index.id,'加藤惠为什么送眼镜给安艺伦也',{id:doc.id},['第一卷 第一章']);
    expect(hits[0]).toBe(relevant.id);
    expect(await graph.candidates(index.id,'加藤惠眼镜',{id:-1})).toEqual([]);
    expect(await graph.candidates(index.id,'加藤惠眼镜',{id:doc.id},['第二卷'])).toEqual([]);
  },15000);
  test('HTTP rate counters are shared across instances and report retry time',async()=>{
    const redis=new RedisService();redis.onModuleInit();
    try {const a=new RedisThrottlerStorage(redis),b=new RedisThrottlerStorage(redis),key=randomUUID();
      expect((await a.increment(key,60000)).totalHits).toBe(1);
      const next=await b.increment(key,60000);expect(next.totalHits).toBe(2);expect(next.timeToExpire).toBeGreaterThan(0);
    } finally {redis.onModuleDestroy();}
  });
  test('real Nest HTTP contracts validate identities and expose independent liveness/readiness',async()=>{
    const original=ConfigModule.forRoot.bind(ConfigModule);
    const configSpy=jest.spyOn(ConfigModule,'forRoot').mockImplementation(options=>original({...options,ignoreEnvFile:true}));
    const {AppModule}=await import('../../app.module');
    const module=await Test.createTestingModule({imports:[AppModule]})
      .overrideProvider(AdminSettingsService).useValue({smtp:()=>null,snapshot:()=>({locked:false})}).compile();
    const app=module.createNestApplication();app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    try {
      await app.init();const http=request(app.getHttpServer());
      await http.get('/api/health/live').expect(200);await http.get('/api/health/ready').expect(200);
      const redis=module.get(RedisService);
      const ping=jest.spyOn(redis.getClient(),'ping').mockRejectedValueOnce(new Error('fixture unavailable'));
      await http.get('/api/health/ready').expect(503);ping.mockRestore();
      const bearer='Bearer '+sign({sub:owner,role:'USER'},process.env.JWT_ACCESS_SECRET!,{algorithm:'HS256'});
      await http.post('/api/chat/conversations').set('Authorization',bearer).send({title:{bad:'input'}}).expect(400);
      await http.post('/api/chat/conversations').set('Authorization',bearer).send({conversationType:'LEGACY'}).expect(400);
      const result=await http.post('/api/chat/conversations').set('Authorization',bearer).send({title:'api-fixture'}).expect(201);
      expect(result.body.data).toMatchObject({conversationType:'ASSISTANT',personaKey:'assistant',sharedMemory:false});
      const id=result.body.data.id;
      await http.put('/api/chat/conversations/'+id).set('Authorization',bearer).send({personaKey:'kato_megumi_persona'}).expect(400);
      await http.put('/api/chat/conversations/'+id+'/identity').set('Authorization',bearer).send({persona:'kato_megumi_persona'}).expect(200);
      await append(id,'虚构接口验收','角色回应','kato_megumi_persona');
      await http.put('/api/chat/conversations/'+id+'/identity').set('Authorization',bearer).send({conversationType:'ASSISTANT'}).expect(409);
    } finally {await app.close();configSpy.mockRestore();}
  },30000);
});

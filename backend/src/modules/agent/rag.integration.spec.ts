import { Test } from '@nestjs/testing';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request = require('supertest');
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../common/prisma.service';
import { RagService } from './rag.service';
import { RagIndexService } from './rag-index.service';
import { RagModelService } from './rag-model.service';
import { AgentExecutorService } from './agent.executor';
import { QdrantVectorService } from './qdrant-vector.service';
import { ChatRunService } from '../chat/chat-run.service';
import { ForumService } from '../forum/forum.service';
import { AuthService } from '../auth/auth.service';
import { NovelGraphService } from './novel-graph.service';
import { currentChatModel } from '../chat/chat-models';

const run = process.env.RUN_RAG_INTEGRATION === '1' ? describe : describe.skip;
run('isolated MySQL + Qdrant integration', () => {
  let app: INestApplication, db: PrismaService, rag: RagService, indexes: RagIndexService, vectors: QdrantVectorService;
  let admin: number, reader: number, outsider: number, kb: number, doc1: number, doc2: number, chunk1: string;
  let adminToken: string, readerToken: string;
  const embed = jest.fn(async (texts: string[]) => texts.map(() => [1,0,0,0]));
  const json = jest.fn(async () => ({ intent:'chat', reply:'你好，测试角色。' }));
  const fakeAgent = { executeWithTools: jest.fn(async(..._args: any[])=>({content:'测试回答',toolOutputs:[]})) };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.endsWith('/chatforum_test') || process.env.QDRANT_URL !== 'http://127.0.0.1:36336')
      throw new Error('Integration tests require dedicated chatforum_test database and port 36336');
    process.env.CHAT_WORKER_ENABLED='false'; process.env.RAG_WORKER_ENABLED='false';
    process.env.REDIS_PASSWORD='';
    process.env.DEFAULT_MODEL_API_KEY='test-only-no-network';
    process.env.DEFAULT_MODEL_API_BASE='https://api.deepseek.com';
    process.env.DASHSCOPE_API_KEY='test-only-qwen-no-network';
    const module = await Test.createTestingModule({imports:[AppModule]})
      .overrideProvider(RagModelService).useValue({embed,json})
      .overrideProvider(AgentExecutorService).useValue(fakeAgent).compile();
    app=module.createNestApplication();
    app.setGlobalPrefix('api'); app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
    await app.init();
    db=app.get(PrismaService); rag=app.get(RagService); indexes=app.get(RagIndexService); vectors=app.get(QdrantVectorService);
    for (const role of ['ADMIN','USER','USER'] as const) {
      const id=randomUUID();
      const user=await db.user.create({data:{username:id,email:id+'@example.test',password:'test-disabled',role}});
      if (!admin) admin=user.id; else if (!reader) reader=user.id; else outsider=user.id;
    }
    const jwt=new JwtService();
    adminToken=await jwt.signAsync({sub:admin,role:'ADMIN'},{secret:process.env.JWT_ACCESS_SECRET});
    readerToken=await jwt.signAsync({sub:reader,role:'ADMIN'},{secret:process.env.JWT_ACCESS_SECRET}); // stale elevated claim
    kb=(await rag.createKnowledgeBase({name:'Fixture-'+randomUUID(),visibility:'SHARED'},{userId:admin})).id;
    await rag.setAcl(kb,reader,'READ',{userId:admin});
  },60000);
  afterAll(async()=>{ if(app) await app.close(); });

  test('ownership and current DB roles trump forged/stale JWT role',async()=>{
    await expect(rag.authorize(kb,{userId:outsider})).rejects.toThrow();
    await request(app.getHttpServer()).get('/api/rag/knowledge-bases/'+kb).expect(401);
    await request(app.getHttpServer()).put('/api/rag/knowledge-bases/'+kb).set('Authorization','Bearer '+readerToken)
      .send({visibility:'PUBLIC'}).expect(403);
    await request(app.getHttpServer()).put('/api/users/profile').set('Authorization','Bearer '+readerToken)
      .send({role:'ADMIN',username:'safe-'+randomUUID().slice(0,12)}).expect(400);
    await request(app.getHttpServer()).put('/api/users/profile').set('Authorization','Bearer '+readerToken)
      .send({username:'safe-'+randomUUID().slice(0,12)}).expect(200);
    expect((await db.user.findUnique({where:{id:reader}})).role).toBe('USER');
  });
  test('ordinary users create private KBs and complete upload/build/publish without managing other users KBs', async () => {
    const made = await request(app.getHttpServer()).post('/api/rag/knowledge-bases').set('Authorization','Bearer '+readerToken)
      .send({name:'Personal-'+randomUUID()}).expect(201);
    const id = made.body.data.id;
    expect(made.body.data).toMatchObject({ownerId:reader,permission:'ADMIN',visibility:'PRIVATE',chatReady:false});
    expect((await rag.listKnowledgeBases({userId:outsider})).some(b=>b.id===id)).toBe(false);
    const conversation = await db.conversation.create({data:{conversationType:'ASSISTANT',personaKey:'assistant',userId:reader,title:'Private KB test'}});
    await request(app.getHttpServer()).post('/api/chat/runs').set('Authorization','Bearer '+readerToken)
      .send({requestId:randomUUID(),conversationId:conversation.id,question:'测试',mode:'normal',knowledgeBaseId:id,modelId:'deepseek-v4-pro'}).expect(409);
    await request(app.getHttpServer()).post('/api/rag/knowledge-bases/'+id+'/documents').set('Authorization','Bearer '+readerToken)
      .attach('file',Buffer.from('阿青把蓝色雨伞放在图书馆。小舟在这里等阿青，两人约定明天一起读书。'),{filename:'personal.txt',contentType:'text/plain'}).expect(201);
    await indexes.enqueue(id,{userId:reader});await indexes.tick();await indexes.publish(id,1,{userId:reader});
    expect((await rag.getKnowledgeBase(id,{userId:reader})).chatReady).toBe(true);
    await expect(indexes.enqueue(id,{userId:outsider})).rejects.toThrow();
    await rag.updateKnowledgeBase(id,{visibility:'PUBLIC'},{userId:reader});
    expect((await rag.getKnowledgeBase(id,{userId:outsider}))).toMatchObject({permission:'READ',chatReady:true});
    await expect(rag.updateKnowledgeBase(id,{name:'hijacked'},{userId:outsider})).rejects.toThrow();
    // A selected KB keeps the shared assistant identity and the request-scoped model.
    const modelsUsed: string[] = [];
    fakeAgent.executeWithTools.mockImplementationOnce(async()=>{modelsUsed.push(currentChatModel().id);return {content:'已走知识库路径',toolOutputs:[]};});
    const jobs=app.get(ChatRunService);
    const job=await jobs.create(reader,{requestId:randomUUID(),conversationId:conversation.id,question:'你好',mode:'normal',knowledgeBaseId:id,modelId:'qwen3.8-max'});
    await jobs.tick();
    expect((await jobs.get(reader,job.id)).result).toMatchObject({ragMetadata:{knowledgeBaseId:id,modelId:'qwen3.8-max'}});
    expect(modelsUsed).toEqual(['qwen3.8-max']); // The shared assistant engine remains ACL/model scoped.
    json.mockImplementation(async()=>({intent:'chat',reply:'你好，测试角色。'}));
    await rag.updateKnowledgeBase(id,{visibility:'PRIVATE'},{userId:reader});
    await expect(rag.getKnowledgeBase(id,{userId:outsider})).rejects.toThrow();
  },60000);
  test('browser may select known models but cannot configure providers or forge owner fields', async () => {
    const conversation=await db.conversation.create({data:{conversationType:'ASSISTANT',personaKey:'assistant',userId:reader,title:'Model selection test'}});
    const input={requestId:randomUUID(),conversationId:conversation.id,question:'测试',mode:'normal',modelId:'qwen3.8-max'};
    for(const forbidden of [{apiKey:'bad'},{apiBase:'https://attacker.invalid'},{model:'anything'},{modelId:'not-in-menu'}])
      await request(app.getHttpServer()).post('/api/chat/runs').set('Authorization','Bearer '+readerToken).send({...input,...forbidden}).expect(400);
    await request(app.getHttpServer()).post('/api/rag/knowledge-bases').set('Authorization','Bearer '+readerToken)
      .send({name:'Bad owner',ownerId:admin}).expect(400);
    const jobs=app.get(ChatRunService), start=fakeAgent.executeWithTools.mock.calls.length;
    const job=await jobs.create(reader,input as any);await jobs.tick();
    expect(fakeAgent.executeWithTools.mock.calls[start][3]).toBe('qwen3.8-max-0902');
    expect(fakeAgent.executeWithTools.mock.calls[start][9]).toEqual({enable_thinking:false});
    expect((await jobs.get(reader,job.id)).result).toMatchObject({ragMetadata:{modelId:'qwen3.8-max'}});
    fakeAgent.executeWithTools.mockClear();
  });
  test('upload one novel, durable build, validation, explicit activation',async()=>{
    const buffer=Buffer.from('阿青把蓝色雨伞交给小舟，然后独自回家。小舟在学校图书馆等候阿青。他们约定明天再见。');
    doc1=(await rag.addDocument(kb,{originalname:'novel.txt',buffer,size:buffer.length,mimetype:'text/plain'},{userId:admin})).id;
    await expect(rag.addDocument(kb,{originalname:'other.txt',buffer,size:buffer.length,mimetype:'text/plain'},{userId:admin})).rejects.toThrow();
    const admissions=await Promise.allSettled([indexes.enqueue(kb,{userId:admin}),indexes.enqueue(kb,{userId:admin})]);
    expect(admissions.filter(a=>a.status==='fulfilled')).toHaveLength(1);
    await indexes.tick();
    expect((await indexes.list(kb,{userId:admin}))[0]).toMatchObject({status:'READY',chunkCount:1});
    expect((await rag.search(kb,'蓝色雨伞',{userId:reader})).passages).toHaveLength(0);
    await indexes.publish(kb,1,{userId:admin});
    const result=await rag.search(kb,'蓝色雨伞',{userId:reader});
    expect(result.degraded).toBe(false);
    expect(result.passages[0]).toMatchObject({citation:{documentId:doc1,documentVersion:1,indexVersion:1},semanticScore:1});
    expect(result.passages.some(p=>p.lexicalScore>0)).toBe(true);
    chunk1=result.passages[0].citation.chunkId;
    expect(await rag.citation(kb,chunk1,{userId:reader})).toMatchObject({documentId:doc1});
  },60000);
  test('explicit EPUB chapter scope is applied to semantic AND lexical retrieval',async()=>{
    const Zip=require('adm-zip'),zip=new Zip();
    zip.addFile('META-INF/container.xml',Buffer.from('<rootfile full-path="book.opf"/>'));
    zip.addFile('book.opf',Buffer.from('<package><manifest><item id="a" href="a.html"/><item id="b" href="b.html"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'));
    zip.addFile('a.html',Buffer.from('<head><title>第八卷 第六章</title></head><p>加藤惠把蓝色雨伞交给小舟，然后独自回家。他们明天还要见面。</p>'));
    zip.addFile('b.html',Buffer.from('<head><title>第九卷 第六章</title></head><p>加藤惠把红色雨伞交给小舟，然后独自回家。他们明天还要见面。</p>'));
    const scoped=(await rag.createKnowledgeBase({name:'Scoped-'+randomUUID(),visibility:'SHARED'},{userId:admin})).id;
    await rag.setAcl(scoped,reader,'READ',{userId:admin});
    const buffer=zip.toBuffer();
    await rag.addDocument(scoped,{originalname:'scope.epub',buffer,size:buffer.length,mimetype:'application/epub+zip'},{userId:admin});
    await indexes.enqueue(scoped,{userId:admin});await indexes.tick();await indexes.publish(scoped,1,{userId:admin});
    const result=await rag.search(scoped,'第8卷第6章，加藤惠的雨伞',{userId:reader});
    expect(result.degraded).toBe(false);expect(result.passages).toHaveLength(1);
    expect(result.passages[0].citation.chapter).toBe('第八卷 第六章');
    expect(result.passages[0].semanticScore).toBe(1);expect(result.passages[0].lexicalScore).toBeGreaterThan(0);
    expect((await rag.search(scoped,'第十卷第六章的雨伞',{userId:reader})).passages).toHaveLength(0);
  });
  test('document ACL is enforced in BOTH branches and citation lookup',async()=>{
    await rag.documentAccess(kb,doc1,'PRIVATE',{userId:admin});
    expect((await rag.search(kb,'蓝色雨伞',{userId:reader})).passages).toHaveLength(0);
    await expect(rag.citation(kb,chunk1,{userId:reader})).rejects.toThrow();
    await rag.documentAcl(kb,doc1,reader,'READ',{userId:admin});
    expect((await rag.search(kb,'蓝色雨伞',{userId:reader})).passages).toHaveLength(1);
  });
  test('graph caches are source-scoped, adjacent context stays in chapter, and revoked ACL hides facts',async()=>{
    const book=(await rag.createKnowledgeBase({name:'Graph-'+randomUUID(),visibility:'SHARED'},{userId:admin})).id;
    await rag.setAcl(book,reader,'READ',{userId:admin});
    const document=await db.knowledgeBaseDocument.create({data:{knowledgeBaseId:book,ownerId:admin,
      fileName:'graph.epub',fileType:'epub',fileSize:100,filePath:'fixture-only',status:'COMPLETED'}});
    const index=await db.ragIndexVersion.create({data:{knowledgeBaseId:book,version:1,collectionName:'unused-'+randomUUID(),status:'ACTIVE'}});
    await db.knowledgeBase.update({where:{id:book},data:{activeIndexVersion:1}});
    const chunks=[];
    for(const [i,content] of ['加藤惠是社团副代表，安艺伦也与她商量工作。','安艺伦也说这次要先征求加藤惠的意见。','安艺伦也在另一卷遇见英梨梨。'].entries()){
      const id=randomUUID();chunks.push(await db.knowledgeChunk.create({data:{id,vectorId:id,knowledgeBaseId:book,indexVersionId:index.id,
        documentId:document.id,documentVersion:1,chunkIndex:i,content,contentHash:'fixture',chapter:i<2?'第八卷 第六章':'第九卷 第一章'}}));
    }
    await expect(rag.buildGraph(book,1,{userId:reader})).rejects.toThrow();
    const first=await rag.buildGraph(book,1,{userId:admin});await rag.buildGraph(book,1,{userId:admin});
    expect(await db.novelEntityMention.count({where:{indexVersionId:index.id}})).toBe(first.mentions);
    const vectorsBefore=embed.mock.calls.length;
    const p=await rag.citation(book,chunks[0].id,{userId:reader});
    const decision:any={passages:[{content:p.content,citation:p,score:1,acl:{visibility:'INHERIT'}}],indexVersion:1,graph:{version:first.version},confidence:1,needsExpertReview:false};
    const oldCalls=json.mock.calls.length;
    (json as jest.Mock).mockResolvedValueOnce({facts:[{subject:'megumi',predicate:'ROLE',target:'blessing',object:'加藤惠是社团副代表',sourceId:1,quote:'加藤惠是社团副代表'}]});
    // Unknown target is not in this evidence window, so nothing is persisted.
    expect(await rag.graphEvidence(book,decision,{userId:reader},{inputTokens:0,outputTokens:0,embeddingTokens:0,calls:0,latencyMs:0,costCny:null,usageComplete:true})).toHaveLength(0);
    expect(decision.passages.map(p=>p.citation.chunkId)).toEqual([chunks[0].id,chunks[1].id]);
    expect(embed.mock.calls.length).toBe(vectorsBefore);
    // Separate immutable window has a valid edge, checked once and cached.
    const graph=app.get(NovelGraphService),usage={inputTokens:0,outputTokens:0,embeddingTokens:0,calls:0,latencyMs:0,costCny:null,usageComplete:true};
    (json as jest.Mock).mockResolvedValueOnce({facts:[{subject:'megumi',predicate:'ROLE',object:'加藤惠是社团副代表',sourceId:1,quote:'加藤惠是社团副代表'}]});
    (json as jest.Mock).mockResolvedValueOnce({supported:[true]});
    const saved=await graph.sceneFacts(index.id,decision.passages.slice(0,1),usage);expect(saved.facts).toHaveLength(1);
    expect((await graph.sceneFacts(index.id,decision.passages.slice(0,1),usage)).cached).toBe(true);
    expect(json.mock.calls.length-oldCalls).toBe(3);
    for(const call of (json as jest.Mock).mock.calls.slice(oldCalls))expect(String(call[0])).toMatch(/JSON/);
    expect((await rag.graphView(book,{userId:reader})).facts).toHaveLength(1);
    await rag.documentAccess(book,document.id,'PRIVATE',{userId:admin});
    expect((await rag.graphView(book,{userId:reader})).facts).toHaveLength(0);
    expect((await rag.graphView(book,{userId:reader})).entities).toHaveLength(0);
    await expect(rag.graphEvidence(book,decision,{userId:reader},usage)).rejects.toThrow();
  });
  test('version failure preserves old collection and pointer; canary and rollback',async()=>{
    const buffer=Buffer.from('阿青把绿色雨伞交给小舟，这是修订版的故事。小舟在学校图书馆等候阿青。他们约定明天再见。');
    doc2=(await rag.addDocument(kb,{originalname:'novel-v2.txt',buffer,size:buffer.length,mimetype:'text/plain'},{userId:admin},doc1)).id;
    await indexes.enqueue(kb,{userId:admin}); embed.mockRejectedValueOnce(new Error('test embedding outage'));
    await indexes.tick();
    expect((await indexes.list(kb,{userId:admin}))[0].status).toBe('FAILED');
    await expect(indexes.publish(kb,2,{userId:admin})).rejects.toThrow();
    expect((await rag.search(kb,'蓝色雨伞',{userId:reader})).indexVersion).toBe(1);
    await indexes.enqueue(kb,{userId:admin}); await indexes.tick();
    await indexes.publish(kb,3,{userId:admin},100);
    expect((await rag.search(kb,'绿色雨伞',{userId:reader})).passages[0].citation).toMatchObject({documentId:doc2,indexVersion:3,documentVersion:2});
    await indexes.publish(kb,3,{userId:admin});
    await indexes.publish(kb,1,{userId:admin});
    expect((await rag.search(kb,'蓝色雨伞',{userId:reader})).indexVersion).toBe(1);
    const old=await db.ragIndexVersion.findFirst({where:{knowledgeBaseId:kb,version:1}});
    expect(await vectors.count(old.collectionName)).toBe(1);
    await rag.documentAcl(kb,doc1,reader,null,{userId:admin});
    expect((await rag.search(kb,'蓝色雨伞',{userId:reader})).passages).toHaveLength(0);
    await expect(rag.citation(kb,chunk1,{userId:reader})).rejects.toThrow();
  },60000);
  test('durable chat idempotency, single save, owner access and cancellation',async()=>{
    const jobs=app.get(ChatRunService);
    const conversation=await db.conversation.create({data:{conversationType:'ASSISTANT',personaKey:'assistant',title:'Job test',userId:reader}});
    const input={requestId:randomUUID(),conversationId:conversation.id,question:'你好',mode:'normal' as const};
    const [a,b]=await Promise.all([jobs.create(reader,input),jobs.create(reader,input)]);
    expect(a.id).toBe(b.id);
    await expect(jobs.create(reader,{...input,requestId:randomUUID()})).rejects.toThrow();
    await expect(jobs.get(outsider,a.id)).rejects.toThrow();
    await jobs.tick(); await jobs.tick();
    expect((await jobs.get(reader,a.id)).status).toBe('COMPLETED');
    expect(await db.chatMessage.count({where:{conversationId:conversation.id}})).toBe(2);
    const c=await jobs.create(reader,{...input,requestId:randomUUID()});
    await jobs.cancel(reader,c.id); await jobs.tick();
    expect(await db.chatMessage.count({where:{conversationId:conversation.id}})).toBe(2);
    expect(fakeAgent.executeWithTools.mock.calls[0][6]).toEqual([]);
  });
  test('SSE authenticates, resumes without duplicate saves, and exposes no request input',async()=>{
    const jobs=app.get(ChatRunService);
    const conversation=await db.conversation.create({data:{conversationType:'ASSISTANT',personaKey:'assistant',title:'SSE fixture',userId:reader}});
    const job=await jobs.create(reader,{requestId:randomUUID(),conversationId:conversation.id,question:'你好',mode:'normal'});
    await jobs.tick();
    const result=await jobs.get(reader,job.id);
    expect((result as any).input).toBeUndefined();
    await request(app.getHttpServer()).get('/api/chat/runs/'+job.id+'/events').expect(401);
    await request(app.getHttpServer()).get('/api/chat/runs/'+job.id+'/events').set('Authorization','Bearer '+adminToken).expect(404);
    await request(app.getHttpServer()).get('/api/chat/runs/'+job.id+'/events?offset=-1').set('Authorization','Bearer '+readerToken).expect(400);
    const collect=(res:any,done:any)=>{let text='';res.setEncoding('utf8');res.on('data',(chunk:string)=>text+=chunk);res.on('end',()=>done(null,{text}));};
    const full=await request(app.getHttpServer()).get('/api/chat/runs/'+job.id+'/events')
      .set('Authorization','Bearer '+readerToken).buffer(true).parse(collect).expect(200);
    expect(full.headers['content-type']).toMatch(/text\/event-stream/);
    expect(full.headers['x-accel-buffering']).toBe('no');
    expect(full.body.text).toContain('event: delta');expect(full.body.text).toContain('event: complete');
    const again=await request(app.getHttpServer()).get('/api/chat/runs/'+job.id+'/events?offset=2')
      .set('Authorization','Bearer '+readerToken).buffer(true).parse(collect).expect(200);
    expect(again.body.text).toContain('"text":"回答"');
    expect(await db.chatMessage.count({where:{conversationId:conversation.id}})).toBe(2);
  });
  test('live partial output is visible before completion; cancel clears it and prevents saving',async()=>{
    const jobs=app.get(ChatRunService),conversation=await db.conversation.create({data:{conversationType:'ASSISTANT',personaKey:'assistant',title:'Cancel SSE',userId:reader}});
    let partialReady:()=>void, finish:()=>void;
    const ready=new Promise<void>(r=>partialReady=r),gate=new Promise<void>(r=>finish=r);
    fakeAgent.executeWithTools.mockImplementationOnce(async(...args:any[])=>{
      // Allow the documented 120 ms persistence batching interval before observing a partial.
      await new Promise(resolve=>setTimeout(resolve,150));
      await args[10].onToken('尚未结束的回答'); partialReady(); await gate;
      return {content:'最终回答',toolOutputs:[]};
    });
    const job=await jobs.create(reader,{requestId:randomUUID(),conversationId:conversation.id,question:'测试取消',mode:'normal'});
    const work=jobs.tick();
    try {
      await ready;
      expect(await jobs.get(reader,job.id)).toMatchObject({status:'RUNNING',result:{content:'尚未结束的回答'}});
      expect(await db.chatMessage.count({where:{conversationId:conversation.id}})).toBe(0);
      await jobs.cancel(reader,job.id);
    } finally { finish(); await work; }
    expect(await jobs.get(reader,job.id)).toMatchObject({status:'CANCELLED',result:null});
    expect(await db.chatMessage.count({where:{conversationId:conversation.id}})).toBe(0);
  });
  test('completed RAG results cannot bypass a subsequently revoked document ACL',async()=>{
    const jobs=app.get(ChatRunService),conversation=await db.conversation.create({data:{conversationType:'ASSISTANT',personaKey:'assistant',title:'RAG replay ACL',userId:reader}});
    const book=(await rag.createKnowledgeBase({name:'SSE-ACL-'+randomUUID(),visibility:'SHARED'},{userId:admin})).id;
    await rag.setAcl(book,reader,'READ',{userId:admin});
    const doc=await db.knowledgeBaseDocument.create({data:{knowledgeBaseId:book,ownerId:admin,fileName:'sse.txt',
      fileType:'txt',fileSize:40,filePath:'fixture-only',status:'COMPLETED',visibility:'PRIVATE'}});
    await rag.documentAcl(book,doc.id,reader,'READ',{userId:admin});
    const index=await db.ragIndexVersion.create({data:{knowledgeBaseId:book,version:1,collectionName:'sse-'+randomUUID(),status:'ACTIVE'}});
    const chunkId=randomUUID();
    await db.knowledgeChunk.create({data:{id:chunkId,vectorId:chunkId,knowledgeBaseId:book,indexVersionId:index.id,
      documentId:doc.id,documentVersion:1,chunkIndex:0,content:'测试原文。',contentHash:'fixture'}});
    const job=await db.chatRun.create({data:{userId:reader,conversationId:conversation.id,requestId:randomUUID(),status:'COMPLETED',
      input:{knowledgeBaseId:book},result:{content:'已核验的答案',ragMetadata:{citations:[{chunkId}]}}}});
    await jobs.get(reader,job.id);
    await db.knowledgeDocumentAcl.deleteMany({where:{documentId:doc.id,userId:reader}});
    await expect(jobs.get(reader,job.id)).rejects.toThrow();
    await request(app.getHttpServer()).get('/api/chat/runs/'+job.id+'/events').set('Authorization','Bearer '+readerToken).expect(404);
  });
  test('forum writes and counters remain atomic under duplicate actions',async()=>{
    const forum=app.get(ForumService);
    const category=await db.category.create({data:{name:'Test-'+randomUUID()}});
    const post=await forum.createPost(admin,{title:'测试',content:'原文讨论',categoryId:category.id,tags:['fixture']});
    await Promise.all([forum.likePost(post.id,reader),forum.likePost(post.id,reader)]);
    expect((await db.post.findUnique({where:{id:post.id}})).likeCount).toBe(1);
    await expect(forum.createComment(post.id,reader,{content:'reply',parentId:2147483647})).rejects.toThrow();
    expect((await db.post.findUnique({where:{id:post.id}})).commentCount).toBe(0);
    const comment=await forum.createComment(post.id,reader,{content:'评论'.repeat(200)});
    expect(comment.content.length).toBe(400);
    const listing=await forum.getPosts({search:'原文',limit:20},reader);
    expect(listing.data.find(p=>p.id===post.id).isLiked).toBe(true);
    await Promise.all([forum.unlikePost(post.id,reader),forum.unlikePost(post.id,reader)]);
    expect((await db.post.findUnique({where:{id:post.id}})).likeCount).toBe(0);
  });
  test('bounded comments, reply pagination, ownership and idempotent soft deletion',async()=>{
    const forum=app.get(ForumService);
    const category=await db.category.create({data:{name:'Comments-'+randomUUID()}});
    const post=await forum.createPost(admin,{title:'评论分页',content:'测试',categoryId:category.id});
    const root=await forum.createComment(post.id,reader,{content:'原评论正文不可在删除后返回'});
    for(let i=0;i<12;i++)await forum.createComment(post.id,admin,{content:'回复'+i,parentId:root.id});
    const page=await forum.getComments(post.id,reader,{limit:1});
    expect(page.data).toHaveLength(1); expect(page.data[0].replies).toHaveLength(3);
    expect(page.data[0].replyCount).toBe(12);
    expect((await forum.getComments(post.id,reader,{parentId:root.id,page:2,limit:10})).data).toHaveLength(2);
    await expect(forum.deleteComment(root.id,outsider)).rejects.toThrow();
    await Promise.all([forum.deleteComment(root.id,reader),forum.deleteComment(root.id,reader)]);
    const deleted=await forum.getComments(post.id,reader);
    expect(deleted.data[0].content).toBe('这条评论已删除');
    expect(deleted.data[0].canDelete).toBe(false);
    expect(deleted.activeCount).toBe(12);
    expect((await db.post.findUnique({where:{id:post.id}})).commentCount).toBe(12);
    await expect(forum.createComment(post.id,reader,{content:'新回复',parentId:root.id})).rejects.toThrow();
    await request(app.getHttpServer()).post('/api/forum/posts/'+post.id+'/comments').set('Authorization','Bearer '+readerToken).send({content:'  '}).expect(400);
    await request(app.getHttpServer()).get('/api/forum/posts/'+post.id+'/comments?limit=100000').expect(400);
  });
  test('refresh is single-use; old token logout does not revoke rotated session',async()=>{
    const auth=app.get(AuthService),id=randomUUID();
    const account=await auth.register({email:id+'@example.test',username:id,password:'safe-test-password'});
    const rotated=await auth.refreshTokens(account.refreshToken);
    expect(rotated.refreshToken).not.toBe(account.refreshToken);
    await expect(auth.refreshTokens(account.refreshToken)).rejects.toThrow();
    await auth.logout(account.refreshToken);
    expect((await auth.refreshTokens(rotated.refreshToken)).accessToken).toBeTruthy();
  });
  test('multipart upload works with patched parser; fake image bytes are rejected',async()=>{
    const created=await request(app.getHttpServer()).post('/api/rag/knowledge-bases').set('Authorization','Bearer '+adminToken)
      .send({name:'HTTP-'+randomUUID()}).expect(201);
    await request(app.getHttpServer()).post('/api/rag/knowledge-bases/'+created.body.data.id+'/documents')
      .set('Authorization','Bearer '+adminToken).attach('file',Buffer.from('小说原文测试内容'),{filename:'test.txt',contentType:'text/plain'}).expect(201);
    const avatar=await request(app.getHttpServer()).post('/api/users/avatar').set('Authorization','Bearer '+readerToken)
      .attach('file',Buffer.from('<html>not an image</html>'),{filename:'fake.png',contentType:'image/png'});
    expect(avatar.body.success).toBe(false);
  });
  test('DTO rejects mass-assignment and SQL sort fields',async()=>{
    await request(app.getHttpServer()).post('/api/forum/posts').set('Authorization','Bearer '+readerToken)
      .send({title:'hi',content:'hello',categoryId:1,isTop:true,viewCount:100}).expect(400);
    await request(app.getHttpServer()).get('/api/forum/posts?sortBy=password&limit=9999').expect(400);
    await request(app.getHttpServer()).get('/api/health').expect(200);
    const config=await request(app.getHttpServer()).get('/api/chat/config').expect(200);
    expect(config.body.data.apiKey).toBeUndefined();
  });
});

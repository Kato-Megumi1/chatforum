import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../common/prisma.service';
import { CodingService } from './coding.service';
import { CodingController } from './coding.controller';
import { AttachmentService } from './attachment.service';
import { ChatRunController } from '../chat/chat-run.controller';
import { ChatRunService } from '../chat/chat-run.service';
import { NovelAnswerService } from '../agent/novel-answer.service';
import { RagService } from '../agent/rag.service';
import { AgentExecutorService } from '../agent/agent.executor';
import { ConversationMemoryService } from '../agent/conversation-memory.service';
import { buildConversationMemory } from '../agent/conversation-memory.policy';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { RagModelService } from '../agent/rag-model.service';
import { resolveChatModel, withChatModel } from '../chat/chat-models';

const suite = process.env.RUN_CODING_INTEGRATION === '1' ? describe : describe.skip;
suite('per-message attachments: real admission, storage and downloads', () => {
  let app: INestApplication, db: PrismaService, coding: CodingService, runs: ChatRunService;
  let owner: number, other: number, cid: number, otherCid: number, roleCid: number, token: string, otherToken: string;
  let first: any, second: any, latestFrame: any, beforeAnswer: (() => Promise<void>) | undefined;
  const prefix = 'messagefiles_' + randomUUID().slice(0, 8);
  const scope = () => ({ userId: owner, conversationId: cid });
  const post = (data: any, auth = token) => request(app.getHttpServer()).post('/api/chat/runs').set('Authorization', 'Bearer ' + auth).send(data);
  const payload = (attachments?: any[]) => ({ requestId: randomUUID(), conversationId: cid, question: '读这份文件', mode: 'normal', modelId: 'deepseek-v4-pro', ...(attachments ? { attachments } : {}) });
  const ref = (file: any) => ({ id: file.id, kind: 'text', revision: file.revision });
  const download = (file: any, auth = token, conversationId = cid, revision = file.revision) => request(app.getHttpServer()).get(`/api/coding/${conversationId}/files/${file.id}/download?revision=${revision}`).set('Authorization', 'Bearer ' + auth);
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture database');
    process.env.CHAT_WORKER_ENABLED = 'false'; process.env.DEEPSEEK_API_KEY = 'fixture-no-network'; process.env.DASHSCOPE_API_KEY = 'fixture-no-network'; process.env.JWT_ACCESS_SECRET = 'fixture-message-files';
    const module = await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [CodingController, ChatRunController], providers: [
      PrismaService, CodingService, ChatRunService,
      AttachmentService, { provide: RagModelService, useValue: { vision: jest.fn(() => { throw Error('Unexpected delegated vision request'); }) } }, { provide: AgentExecutorService, useValue: {} },
      { provide: RagService, useValue: { principal: async (id: number) => { if (!(await db.user.findFirst({ where: { id, status: 'ACTIVE' } }))) throw Error('inactive'); } } },
      { provide: NovelAnswerService, useValue: { answer: async (...args: any[]) => { latestFrame = args[5].conversation; await beforeAnswer?.(); return { content: '合成回答', metadata: { state: 'general' } }; } } },
      { provide: ConversationMemoryService, useValue: { prepare: async (id: number, _user: number, key: string, persona: string, question: string) => {
        const rows = await db.chatMessage.findMany({ where: { conversationId: id }, orderBy: { id: 'asc' } });
        const memory = buildConversationMemory(rows.map(m => ({ ...m, messageId: m.id, role: m.role.toLowerCase() })), key);
        return { persona, question, history: memory.history, memory: memory.snapshot };
      } } },
    ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })); await app.init();
    db = app.get(PrismaService); coding = app.get(CodingService); runs = app.get(ChatRunService);
    [owner, other] = await Promise.all([1, 2].map(async n => (await db.user.create({ data: { username: prefix + n, email: prefix + n + '@example.test', password: 'not-a-login-hash' } })).id));
    [cid, otherCid, roleCid] = await Promise.all(['ASSISTANT', 'ASSISTANT', 'ROLEPLAY'].map(async type => (await db.conversation.create({ data: { userId: owner, title: prefix, conversationType: type as any, personaKey: type === 'ASSISTANT' ? 'assistant' : 'kato_megumi_persona' } })).id));
    const jwt = app.get(JwtService); token = jwt.sign({ sub: owner }, { secret: process.env.JWT_ACCESS_SECRET }); otherToken = jwt.sign({ sub: other }, { secret: process.env.JWT_ACCESS_SECRET });
    [first, second] = (await coding.upload({ files: [{ path: 'first.txt', content: 'first synthetic file' }, { path: 'second.txt', content: 'second synthetic file' }] }, scope())).files;
  });
  afterAll(async () => {
    if (db && owner) { await db.conversation.deleteMany({ where: { userId: owner, title: prefix } }); await db.user.deleteMany({ where: { id: { in: [owner, other] }, username: { startsWith: prefix } } }); }
    if (app) await app.close();
  });
  async function finish(id: string, expectedStatus = 'COMPLETED') {
    const workerToken = randomUUID();
    const record = await db.chatRun.update({ where: { id }, data: { status: 'RUNNING', workerToken, leaseUntil: new Date(Date.now() + 60000) } });
    await withChatModel(resolveChatModel((record.input as any).modelId), () => (runs as any).executeSelected(record, workerToken, new AbortController().signal));
    expect((await db.chatRun.findUnique({ where: { id } })).status).toBe(expectedStatus);
  }
  test('strict refs, ownership, persona and version are checked before enqueue', async () => {
    expect((await post({ ...payload(), question: '' })).status).toBe(409);
    expect((await post(payload([{ ...ref(first), path: 'spoof.txt' }]))).status).toBe(400);
    expect((await post(payload([{ ...ref(first), revision: 77 }]))).status).toBe(409);
    expect((await post({ ...payload([ref(first)]), conversationId: otherCid })).status).toBe(409);
    expect((await post(payload([ref(first)]), otherToken)).status).toBe(404);
    expect((await post({ ...payload([ref(first)]), conversationId: roleCid, persona: 'kato_megumi_persona' })).status).toBe(409);
    expect(await db.chatRun.count({ where: { conversationId: cid } })).toBe(0);
  });
  test('attachment-only message, order, idempotency and canonical persisted manifest', async () => {
    const data = { ...payload([ref(second), ref(first)]), question: '' };
    const result = await post(data); expect(result.status).toBe(201);
    expect((await post(data)).body.data.id).toBe(result.body.data.id);
    expect((await post({ ...data, attachments: [ref(first), ref(second)] })).status).toBe(409);
    await finish(result.body.data.id);
    expect(latestFrame.messageFiles.current).toEqual([second, first]);
    const saved = await db.chatMessage.findFirst({ where: { conversationId: cid, role: 'USER' } });
    expect(saved.content).toBe(''); expect(saved.ragMetadata).toEqual({ messageAttachments: [second, first] });
  });
  test('next turn does not reattach entire library; previous manifest survives reload', async () => {
    const result = await post({ ...payload(), question: '第二份刚才说什么？' });
    expect(result.status).toBe(201); await finish(result.body.data.id);
    expect(latestFrame.messageFiles.current).toEqual([]);
    expect(latestFrame.messageFiles.previous.files.map((f: any) => f.path)).toEqual(['second.txt', 'first.txt']);
    expect(latestFrame.messageFiles.library).toHaveLength(2);
    const newest = await db.chatMessage.findFirst({ where: { conversationId: cid, role: 'USER' }, orderBy: { id: 'desc' } });
    expect(newest.ragMetadata).toBeNull();
    expect((await coding.messageContext({ userId: owner, conversationId: otherCid }, [])).previous).toBeUndefined();
  });
  test('original download is scoped and revision guarded; same-name reupload never substitutes old file', async () => {
    expect((await download(first)).status).toBe(200);
    expect((await download(first, otherToken)).status).toBe(403);
    expect((await download(first, token, otherCid)).status).toBe(404);
    expect((await download(first, token, cid, 99)).status).toBe(409);
    await coding.remove(first.id, 'text', 1, scope());
    const replacement = (await coding.upload({ files: [{ path: 'first.txt', content: 'new namesake' }] }, scope())).files[0];
    expect(replacement.id).not.toBe(first.id); expect((await download(first)).status).toBe(404);
    const context = await coding.messageContext(scope(), []);
    expect(context.previous.files.find(f => f.id === first.id).available).toBe(false);
    expect(context.library.some(f => f.id === replacement.id)).toBe(true);
    expect((await post(payload([ref(first)]))).status).toBe(409);
  });
  test('a text version changed during generation cannot be delivered under an old manifest', async () => {
    const count = await db.chatMessage.count({ where: { conversationId: cid } });
    const result = await post(payload([ref(second)])); expect(result.status).toBe(201);
    beforeAnswer = async () => { await db.codingFile.update({ where: { id: second.id }, data: { content: 'changed during generation', revision: { increment: 1 } } }); };
    try { await finish(result.body.data.id, 'FAILED'); } finally { beforeAnswer = undefined; }
    expect(await db.chatMessage.count({ where: { conversationId: cid } })).toBe(count);
  });
  test('model switching loads private prior images natively; revoked image cannot be delivered', async () => {
    const attachments=app.get(AttachmentService);
    const imageCid=(await db.conversation.create({data:{userId:owner,title:prefix,conversationType:'ASSISTANT',personaKey:'assistant'}})).id;
    const imageScope={userId:owner,conversationId:imageCid};
    const data=await require('sharp')({create:{width:32,height:32,channels:3,background:'#ef2020'}}).png().toBuffer();
    const image=await attachments.upload('synthetic.png',data,imageScope),imageRef={id:image.id,kind:'attachment',revision:1};
    const firstRun=await post({...payload([imageRef]),conversationId:imageCid,question:'图片是什么颜色？'});
    expect(firstRun.status).toBe(201);await finish(firstRun.body.data.id);expect(latestFrame.inlineImages).toBeUndefined();
    const followup=()=>({...payload(),conversationId:imageCid,question:'继续识别任务',modelId:'qwen3.8-max'});
    const next=await post(followup());expect(next.status).toBe(201);await finish(next.body.data.id);
    expect(latestFrame.inlineImages).toEqual([expect.objectContaining({id:image.id,url:expect.stringMatching(/^data:image\/jpeg;base64,/),path:'synthetic.png'})]);
    expect(latestFrame.messageFiles.current).toEqual([]);expect(latestFrame.messageFiles.previous.question).toBe('图片是什么颜色？');
    await withChatModel(resolveChatModel('qwen3.8-max'),async()=>{
      for(const denied of [{userId:other,conversationId:imageCid},{userId:owner,conversationId:roleCid},{userId:owner,conversationId:otherCid}])
        await expect(attachments.imageInput(image.id,denied)).rejects.toThrow();
    });
    const count=await db.chatMessage.count({where:{conversationId:imageCid}}),last=await post(followup());
    beforeAnswer=async()=>{await db.chatAttachment.delete({where:{id:image.id}});};
    try {await finish(last.body.data.id,'FAILED');}finally{beforeAnswer=undefined;}
    expect(await db.chatMessage.count({where:{conversationId:imageCid}})).toBe(count);
    expect(app.get(RagModelService).vision).not.toHaveBeenCalled();
  });
});

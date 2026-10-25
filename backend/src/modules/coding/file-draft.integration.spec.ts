import { randomUUID } from 'node:crypto';
import { ForbiddenException, INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { PrismaService } from '../../common/prisma.service';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { AgentExecutorService } from '../agent/agent.executor';
import { ConversationMemoryService } from '../agent/conversation-memory.service';
import { NovelAnswerService } from '../agent/novel-answer.service';
import { RagService } from '../agent/rag.service';
import { ChatRunController } from '../chat/chat-run.controller';
import { ChatRunService } from '../chat/chat-run.service';
import { ChatService } from '../chat/chat.service';
import { CodingService } from './coding.service';
import { FileDraftRef, FileDraftService } from './file-draft.service';

const FIXTURE_DATABASE = 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test';
const suite = process.env.RUN_FILE_DRAFT_INTEGRATION === '1' ? describe : describe.skip;
suite('private file drafts: real persistence, admission, API privacy and invalidation', () => {
  let app: INestApplication, db: PrismaService, drafts: FileDraftService, runs: ChatRunService, chats: ChatService;
  let owner: number, other: number, token: string, otherToken: string;
  const prefix = 'filedraft_' + randomUUID().slice(0, 8);
  const originalQuestion = '生成一个虚构的单文件演示页面';
  const source = '<!doctype html>\n<html><body><main id="fixture-private-file-source">';
  const modelCall = jest.fn(async () => { throw new Error('Fixture must never invoke a model'); });
  const envKeys = ['CHAT_WORKER_ENABLED', 'DEEPSEEK_API_KEY', 'DASHSCOPE_API_KEY', 'QWEN_API_KEY',
    'QWEN_API_BASE', 'DEEPSEEK_API_BASE', 'DEEPSEEK_CHAT_ENABLED', 'QWEN_CHAT_ENABLED', 'JWT_ACCESS_SECRET'] as const;
  const savedEnv = new Map<string, string | undefined>();
  const post = (data: any, auth = token) => request(app.getHttpServer()).post('/api/chat/runs')
    .set('Authorization', 'Bearer ' + auth).send(data).timeout({ response: 2500, deadline: 3500 });
  const payload = (conversationId: number, resumeFile?: FileDraftRef) => ({ requestId: randomUUID(), conversationId,
    question: resumeFile ? '' : originalQuestion, mode: 'normal', modelId: 'qwen3.8-max', ...(resumeFile ? { resumeFile } : {}) });

  beforeAll(async () => {
    // A flag alone never authorizes writes to another database, including production localhost ports.
    if (process.env.DATABASE_URL !== FIXTURE_DATABASE) throw new Error('Refusing non-fixture database');
    for (const key of envKeys) savedEnv.set(key, process.env[key]);
    Object.assign(process.env, { CHAT_WORKER_ENABLED: 'false', DEEPSEEK_API_KEY: 'fixture-no-network',
      DASHSCOPE_API_KEY: 'fixture-no-network', QWEN_API_KEY: 'fixture-no-network',
      QWEN_API_BASE: 'http://127.0.0.1:9/fixture-no-network', DEEPSEEK_API_BASE: 'http://127.0.0.1:9/fixture-no-network',
      DEEPSEEK_CHAT_ENABLED: 'true', QWEN_CHAT_ENABLED: 'true', JWT_ACCESS_SECRET: 'fixture-private-file-drafts' });
    const module = await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [ChatRunController],
      providers: [PrismaService, FileDraftService, CodingService, ChatRunService, ChatService, ConversationMemoryService,
        { provide: NovelAnswerService, useValue: { answer: modelCall } },
        { provide: AgentExecutorService, useValue: { executeWithTools: modelCall } },
        { provide: RagService, useValue: { principal: async (id: number) => {
          const user = await db.user.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true } });
          if (!user) throw new ForbiddenException('Fixture account inactive');
          return user;
        } } },
      ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    db = app.get(PrismaService); drafts = app.get(FileDraftService); runs = app.get(ChatRunService); chats = app.get(ChatService);
    await app.init();
    [owner, other] = await Promise.all([1, 2].map(async n => (await db.user.create({ data: {
      username: prefix + n, email: prefix + n + '@example.test', password: 'synthetic-not-a-login-hash',
    } })).id));
    const jwt = app.get(JwtService);
    token = jwt.sign({ sub: owner, authVersion: 0 }, { secret: process.env.JWT_ACCESS_SECRET });
    otherToken = jwt.sign({ sub: other, authVersion: 0 }, { secret: process.env.JWT_ACCESS_SECRET });
  }, 30000);

  afterAll(async () => {
    try {
      if (db && owner) {
        await db.conversation.deleteMany({ where: { userId: { in: [owner, other] }, title: { startsWith: prefix } } });
        await db.user.deleteMany({ where: { id: { in: [owner, other] }, username: { startsWith: prefix } } });
      }
      if (app) await app.close();
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  async function conversation(type = 'ASSISTANT', userId = owner) {
    return db.conversation.create({ data: { userId, title: prefix + '-' + randomUUID().slice(0, 8),
      conversationType: type, personaKey: type === 'ASSISTANT' ? 'assistant' : 'kato_megumi_persona' } });
  }
  async function running(conversationId: number) {
    const workerToken = randomUUID(), input = payload(conversationId);
    const run = await db.chatRun.create({ data: { id: randomUUID(), userId: owner, conversationId,
      requestId: input.requestId, input: JSON.parse(JSON.stringify(input)), status: 'RUNNING', workerToken, leaseUntil: new Date(Date.now() + 60000) } });
    const current = await db.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { memoryEpoch: true } });
    return { run, scope: { userId: owner, conversationId, runId: run.id, workerToken, conversationEpoch: current.memoryEpoch } };
  }
  async function terminalDraft(conversationId: number, content = source) {
    const state = await running(conversationId);
    const ref = await drafts.checkpoint(state.scope, { path: 'fixture-page.html', content, closed: false,
      originalQuestion, reason: 'OUTPUT_LIMIT' });
    await db.chatRun.update({ where: { id: state.run.id }, data: { status: 'COMPLETED',
      result: JSON.parse(JSON.stringify({ content: '文件草稿已保存。', ragMetadata: { generation: { fileIncomplete: true, fileDraft: ref } } })) } });
    return { ...state, ref };
  }

  test('source survives service reconstruction exactly, with version and hash guarded in MySQL', async () => {
    const c = await conversation(), state = await running(c.id);
    const first = await drafts.checkpoint(state.scope, { path: 'fixture-page.html', content: source,
      closed: false, originalQuestion, reason: 'STREAMING' });
    const content = source + '\n<h1>虚构演示</h1>';
    const last = await drafts.checkpoint(state.scope, { path: 'fixture-page.html', content,
      closed: false, originalQuestion, reason: 'OUTPUT_LIMIT' });
    expect(last.revision).toBe(first.revision + 1);
    await db.chatRun.update({ where: { id: state.run.id }, data: { status: 'FAILED' } });
    const reconstructed = new FileDraftService(db);
    expect(await reconstructed.read(owner, c.id, last)).toEqual({ ...last, path: 'fixture-page.html', content,
      closed: false, originalQuestion, reason: 'OUTPUT_LIMIT', conversationEpoch: 0 });
    await expect(reconstructed.read(owner, c.id, first)).rejects.toMatchObject({ status: 409 });
  });

  test('empty-question resume admission uses the owning transaction without self-locking; GET never leaks source', async () => {
    const c = await conversation(), { run, ref } = await terminalDraft(c.id);
    const data = payload(c.id, ref), admitted = await post(data);
    expect(admitted.status).toBe(201);
    const childId = admitted.body.data.id;
    expect(childId).not.toBe(run.id);
    expect((await post(data)).body.data.id).toBe(childId);
    const saved = await db.chatRun.findUniqueOrThrow({ where: { id: childId } });
    expect(saved.status).toBe('QUEUED'); expect((saved.input as any).resumeFile).toEqual(ref);
    for (const id of [run.id, childId]) {
      const response = await request(app.getHttpServer()).get('/api/chat/runs/' + id).set('Authorization', 'Bearer ' + token);
      expect(response.status).toBe(200);
      expect(response.body.data).not.toHaveProperty('privateState');
      expect(response.body.data).not.toHaveProperty('input');
      expect(JSON.stringify(response.body)).not.toContain(source);
      expect(JSON.stringify(response.body)).not.toContain('fixture-private-file-source');
      expect(JSON.stringify(response.body)).not.toContain('fixture-no-network');
    }
    expect(modelCall).not.toHaveBeenCalled();
  });

  test('cross-account, cross-conversation, ROLEPLAY and stale revision/hash refs are rejected before enqueue', async () => {
    const c = await conversation(), otherC = await conversation(), roleC = await conversation('ROLEPLAY');
    const { ref } = await terminalDraft(c.id);
    await expect(drafts.read(other, c.id, ref)).rejects.toMatchObject({ status: 403 });
    await expect(drafts.read(owner, otherC.id, ref)).rejects.toMatchObject({ status: 404 });
    await expect(drafts.read(owner, roleC.id, ref)).rejects.toMatchObject({ status: 403 });
    expect((await post(payload(c.id, ref), otherToken)).status).toBe(404);
    expect((await post(payload(otherC.id, ref))).status).toBe(404);
    expect((await post({ ...payload(roleC.id, ref), persona: 'kato_megumi_persona' })).status).toBe(409);
    expect((await post(payload(c.id, { ...ref, revision: ref.revision + 1 }))).status).toBe(409);
    expect((await post(payload(c.id, { ...ref, hash: '0'.repeat(64) }))).status).toBe(409);
    expect(await db.chatRun.count({ where: { conversationId: { in: [c.id, otherC.id, roleC.id] }, status: 'QUEUED' } })).toBe(0);
  });

  test('deleting a real source message advances memoryEpoch and invalidates continuation', async () => {
    const c = await conversation();
    const message = await db.chatMessage.create({ data: { conversationId: c.id, role: 'USER', content: originalQuestion } });
    const { ref } = await terminalDraft(c.id);
    await chats.deleteMessage(c.id, message.id, owner);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: c.id } })).memoryEpoch).toBe(1);
    await expect(drafts.read(owner, c.id, ref)).rejects.toMatchObject({ status: 409 });
    expect((await post(payload(c.id, ref))).status).toBe(409);
    expect(await db.chatRun.count({ where: { conversationId: c.id, status: 'QUEUED' } })).toBe(0);
  });

  test('a child checkpoint appends into its own run and cannot overwrite the immutable parent', async () => {
    const c = await conversation(), parent = await terminalDraft(c.id);
    const parentBefore = (await db.chatRun.findUniqueOrThrow({ where: { id: parent.run.id } })).privateState;
    const accepted = await runs.create(owner, payload(c.id, parent.ref) as any);
    const workerToken = randomUUID();
    await db.chatRun.update({ where: { id: accepted.id }, data: { status: 'RUNNING', workerToken,
      leaseUntil: new Date(Date.now() + 60000) } });
    const loaded = await drafts.read(owner, c.id, parent.ref), content = loaded.content + '\n<p>继续的内容</p>';
    const childRef = await drafts.checkpoint({ userId: owner, conversationId: c.id, runId: accepted.id,
      workerToken, conversationEpoch: loaded.conversationEpoch }, { path: loaded.path, content, closed: false,
      originalQuestion: loaded.originalQuestion, reason: 'OUTPUT_LIMIT' });
    expect(childRef.draftId).not.toBe(parent.ref.draftId);
    await db.chatRun.update({ where: { id: accepted.id }, data: { status: 'COMPLETED' } });
    expect((await drafts.read(owner, c.id, childRef)).content).toBe(content);
    expect((await drafts.read(owner, c.id, parent.ref)).content).toBe(source);
    expect((await db.chatRun.findUniqueOrThrow({ where: { id: parent.run.id } })).privateState).toEqual(parentBefore);
  });

  test('current worker token, live lease and ACTIVE principal are required for every checkpoint/read', async () => {
    const c = await conversation(), state = await running(c.id);
    const snapshot = { path: 'fixture-page.html', content: source, closed: false, originalQuestion, reason: 'OUTPUT_LIMIT' };
    await expect(drafts.checkpoint({ ...state.scope, workerToken: randomUUID() }, snapshot)).rejects.toMatchObject({ status: 409 });
    await db.chatRun.update({ where: { id: state.run.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });
    await expect(drafts.checkpoint(state.scope, snapshot)).rejects.toMatchObject({ status: 409 });
    expect((await db.chatRun.findUniqueOrThrow({ where: { id: state.run.id } })).privateState).toBeNull();
    await db.chatRun.update({ where: { id: state.run.id }, data: { leaseUntil: new Date(Date.now() + 60000) } });
    const ref = await drafts.checkpoint(state.scope, snapshot);
    await db.chatRun.update({ where: { id: state.run.id }, data: { status: 'COMPLETED' } });
    await db.user.update({ where: { id: owner }, data: { status: 'BANNED' } });
    try { await expect(drafts.read(owner, c.id, ref)).rejects.toMatchObject({ status: 403 }); }
    finally { await db.user.update({ where: { id: owner }, data: { status: 'ACTIVE' } }); }
    expect(modelCall).not.toHaveBeenCalled();
  });

  test('cancelling a live run preserves its source and returns only the terminal validated resume pointer', async () => {
    const c = await conversation(), state = await running(c.id);
    const ref = await drafts.checkpoint(state.scope, { path: 'fixture-page.html', content: source, closed: false,
      originalQuestion, reason: 'STREAMING' });
    const cancelled = await request(app.getHttpServer()).delete('/api/chat/runs/' + state.run.id)
      .set('Authorization', 'Bearer ' + token);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.result.ragMetadata.generation).toMatchObject({ canContinue: true, resumeFile: ref, fileFailureReason: 'STOPPED' });
    expect(JSON.stringify(cancelled.body)).not.toContain('fixture-private-file-source');
    expect(cancelled.body.data).not.toHaveProperty('privateState');
    const saved = await db.chatRun.findUniqueOrThrow({ where: { id: state.run.id } });
    expect((saved.input as any).question).toBe(originalQuestion);
    expect((saved.privateState as any).content).toBe(source);
    expect((await new FileDraftService(db).read(owner, c.id, ref)).content).toBe(source);
    expect((await post(payload(c.id, ref))).status).toBe(201);
    expect(modelCall).not.toHaveBeenCalled();
  });

  test('cancelling an admitted continuation before new output keeps the parent source available', async () => {
    const c = await conversation(), parent = await terminalDraft(c.id);
    const accepted = await post(payload(c.id, parent.ref));
    expect(accepted.status).toBe(201);
    const cancelled = await request(app.getHttpServer()).delete('/api/chat/runs/' + accepted.body.data.id)
      .set('Authorization', 'Bearer ' + token);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.result.ragMetadata.generation.resumeFile).toEqual(parent.ref);
    expect((await drafts.read(owner, c.id, parent.ref)).content).toBe(source);
    expect(JSON.stringify(cancelled.body)).not.toContain('fixture-private-file-source');
    expect(modelCall).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { MemoryControlsController } from '../chat/memory-controls.controller';
import { MemoryControlsService } from './memory-controls.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { buildConversationMemory, ConversationFrame } from './conversation-memory.policy';

const suite = process.env.RUN_MEMORY_CONTROLS_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated MySQL user-controlled source memory and protected API', () => {
  let db: PrismaService, controls: MemoryControlsService, memory: ConversationMemoryService;
  let owner: number, other: number, app: any, base: string, jwt: JwtService;
  const users: number[] = [], oldSecret = process.env.JWT_ACCESS_SECRET;
  const prefix = 'memory_controls_' + randomUUID().slice(0, 8);
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test')
      throw Error('Refusing non-fixture DB');
    process.env.JWT_ACCESS_SECRET = 'isolated-memory-controls-fixture-secret-32';
    db = new PrismaService(); await db.$connect();
    for (let i = 0; i < 2; i++) users.push((await db.user.create({ data: {
      username: prefix + i, email: prefix + i + '@example.test', password: 'disabled-fixture',
    } })).id);
    [owner, other] = users;
    controls = new MemoryControlsService(db); memory = new ConversationMemoryService(db, controls);
    const module = await Test.createTestingModule({ imports: [JwtModule.register({})],
      controllers: [MemoryControlsController], providers: [
        { provide: MemoryControlsService, useValue: controls }, { provide: PrismaService, useValue: db },
      ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    // No memory service is registered with Nest; no global worker is started.
    await app.listen(0, '127.0.0.1'); base = await app.getUrl(); jwt = module.get(JwtService);
  }, 30000);
  afterAll(async () => {
    try {
      await app?.close(); if (db && users.length) await db.user.deleteMany({ where: { id: { in: users } } });
    } finally {
      await db?.$disconnect();
      if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret;
    }
  }, 30000);
  const create = (userId = owner, personaKey = 'assistant', sharedMemory = false) => db.conversation.create({ data: {
    userId, title: prefix + ' synthetic conversation', personaKey, sharedMemory,
    conversationType: personaKey === 'assistant' ? 'ASSISTANT' : 'ROLEPLAY',
  } });
  const pair = async (conversationId: number, personaKey = 'assistant', userText = '我喜欢蓝色', n = 0) => {
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, n));
    const user = await db.chatMessage.create({ data: { conversationId, createdAt, role: 'USER', content: userText } });
    const assistant = await db.chatMessage.create({ data: { conversationId, createdAt, role: 'ASSISTANT',
      content: '这是虚构的历史回复 ' + n, reasoningContent: 'PRIVATE_PROVIDER_REASONING_DO_NOT_EXPOSE',
      ragMetadata: { personaKey, state: 'general', privateFixture: 'not public' } } });
    await db.conversationEpisode.create({ data: { conversationId, personaKey, lastMessageId: assistant.id,
      sourceIds: [user.id, assistant.id], text: '缓存摘录不能冒充原消息', evidence: { privateFixture: true } } });
    return [user, assistant];
  };
  const entries = (cid: number) => controls.entries(owner, cid);
  const action = (item: any) => ({ kind: item.kind, id: item.id, version: item.version });
  const http = async (cid: number, suffix = '', data?: any, userId = owner, version = 0) => fetch(base + '/api/chat/memory/' + cid + suffix,
    { method: data ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + await jwt.signAsync(
      { sub: userId, authVersion: version, role: 'ADMIN' }, { secret: process.env.JWT_ACCESS_SECRET }), 'Content-Type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}) });
  // Manual claim only touches this suite's own conversation; never consumes global queued jobs.
  const batch = async (cid: number) => {
    const job = await db.memoryRebuildJob.findUniqueOrThrow({ where: { conversationId: cid } }), token = randomUUID();
    await db.memoryRebuildJob.update({ where: { conversationId: cid }, data: {
      status: 'RUNNING', workerToken: token, leaseUntil: new Date(Date.now() + 30000) } });
    await (memory as any).rebuildBatch(job, token);
    return db.memoryRebuildJob.findUniqueOrThrow({ where: { conversationId: cid } });
  };

  test('API requires current ACTIVE/authVersion and owner even when JWT claims ADMIN', async () => {
    const c = await create(); await pair(c.id);
    expect((await fetch(base + '/api/chat/memory/' + c.id)).status).toBe(401);
    expect((await http(c.id)).status).toBe(200);
    expect((await http(c.id, '', undefined, other)).status).toBe(404);
    await db.user.update({ where: { id: owner }, data: { authVersion: 1 } });
    try { expect((await http(c.id)).status).toBe(401); expect((await http(c.id, '', undefined, owner, 1)).status).toBe(200); }
    finally { await db.user.update({ where: { id: owner }, data: { authVersion: 0 } }); }
    await db.user.update({ where: { id: owner }, data: { status: 'BANNED' } });
    try { expect((await http(c.id)).status).toBe(401); await expect(entries(c.id)).rejects.toThrow('账号不可用'); }
    finally { await db.user.update({ where: { id: owner }, data: { status: 'ACTIVE' } }); }
    expect((await http(c.id, '/sources', { kind: 'episode', id: 1, version: 'arbitrary', private: true })).status).toBe(400);
  });

  test('source viewing is exact, private fields never escape, and source or persona changes invalidate actions', async () => {
    const c = await create(), rows = await pair(c.id), item = (await entries(c.id)).items[0];
    const response = await http(c.id, '/sources', action(item)); expect(response.status).toBe(201);
    const body = await response.json(), serialized = JSON.stringify(body);
    expect(serialized).toContain('我喜欢蓝色'); expect(serialized).not.toContain('PRIVATE_PROVIDER_REASONING');
    expect(serialized).not.toContain('ragMetadata'); expect(serialized).not.toContain('privateFixture');
    await db.chatMessage.update({ where: { id: rows[0].id }, data: { content: '修改后的原文' } });
    await expect(controls.sources(owner, c.id, action(item))).rejects.toThrow('版本已改变');
    const changed = (await entries(c.id)).items[0];
    await db.chatMessage.update({ where: { id: rows[1].id }, data: { ragMetadata: { personaKey: 'another-role' } } });
    await expect(controls.pin(owner, c.id, action(changed))).rejects.toThrow('来源');
    expect((await entries(c.id)).items).toEqual([]);
    await db.conversation.update({ where: { id: c.id }, data: { conversationType: 'LEGACY' } });
    await expect(entries(c.id)).rejects.toThrow('旧历史');
  });

  test('fixed entries remain sourced historical excerpts, deduplicate and can be unpinned without deleting sources', async () => {
    const c = await create(), rows = await pair(c.id), item = (await entries(c.id)).items[0];
    const results = await Promise.all([controls.pin(owner, c.id, action(item)), controls.pin(owner, c.id, action(item))]);
    expect(results[0].id).toBe(results[1].id);
    const page = await entries(c.id); expect(page.items).toHaveLength(1); expect(page.items[0].kind).toBe('pin');
    const frame = await memory.prepare(c.id, owner, 'assistant', 'fixture', '继续聊聊');
    expect(frame.memory.summary.kind).toBe('extractive_not_canon');
    expect(frame.memory.summary.text).toContain('用户固定的历史摘录，非正史依据');
    expect(frame.memory.summary.text).not.toContain('缓存摘录不能冒充原消息');
    await controls.unpin(owner, c.id, action(page.items[0]));
    expect(await db.conversationMemoryPin.count({ where: { conversationId: c.id } })).toBe(0);
    expect(await db.chatMessage.count({ where: { conversationId: c.id, id: { in: rows.map(row => row.id) } } })).toBe(2);
    expect((await entries(c.id)).items[0].kind).toBe('episode');
  });

  test('concurrent requests for thirteen different sources cannot exceed twelve pins', async () => {
    const c = await create();
    for (let i = 0; i < 13; i++) await pair(c.id, 'assistant', '虚构偏好 ' + i, i);
    const items = (await entries(c.id)).items;
    const results = await Promise.allSettled(items.map(item => controls.pin(owner, c.id, action(item))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(12);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await db.conversationMemoryPin.count({ where: { conversationId: c.id } })).toBe(12);
  });

  test('forget retains chat original but excludes source Q/A and derived state, bumps epoch and rebuilds without it', async () => {
    const c = await create(), rows = await pair(c.id, 'assistant', '我叫小舟');
    const before = await memory.prepare(c.id, owner, 'assistant', 'fixture', '继续聊聊');
    expect(before.memory.state.name?.value).toBe('小舟');
    await db.conversationMemory.create({ data: { conversationId: c.id, personaKey: 'assistant', revision: 'fixture', snapshot: {} } });
    const item = (await entries(c.id)).items[0]; await controls.pin(owner, c.id, action(item));
    const pinned = (await entries(c.id)).items[0]; await controls.forget(owner, c.id, action(pinned));
    expect(await db.chatMessage.count({ where: { conversationId: c.id } })).toBe(2);
    expect(await db.conversationMemorySuppression.count({ where: { conversationId: c.id } })).toBe(2);
    expect(await db.conversationMemoryPin.count({ where: { conversationId: c.id } })).toBe(0);
    expect(await db.conversationEpisode.count({ where: { conversationId: c.id } })).toBe(0);
    expect((await db.conversation.findUniqueOrThrow({ where: { id: c.id } })).memoryEpoch).toBe(1);
    await expect(controls.applyToFrame(owner, c.id, before)).rejects.toThrow();
    const after = await memory.prepare(c.id, owner, 'assistant', 'fixture', '继续聊聊');
    expect(after.history).toEqual([]); expect(after.memory.state.name).toBeUndefined();
    expect(after.memory.summary.sourceIds.some(id => rows.some(row => row.id === id))).toBe(false);
    expect((await batch(c.id)).status).toBe('READY');
    expect(await db.conversationEpisode.count({ where: { conversationId: c.id } })).toBe(0);
    expect((await entries(c.id)).items).toEqual([]);
  });

  test('shared excerpts require both current opt-ins, same owner and persona, and forgotten sources remain excluded', async () => {
    const source = await create(owner, 'assistant', true), destination = await create(owner, 'assistant', true), rows = await pair(source.id);
    const built = buildConversationMemory([], 'assistant');
    const frame = (): ConversationFrame => ({ sourceEpoch: 0, history: [], persona: 'fixture', question: 'fixture',
      memory: { ...built.snapshot, summary: { ...built.snapshot.summary, topics: [{ text: '共享虚构摘录', sourceIds: rows.map(row => row.id) }],
        text: '共享虚构摘录', sourceIds: rows.map(row => row.id) } } });
    expect((await controls.applyToFrame(owner, destination.id, frame())).memory.summary.text).toContain('共享虚构摘录');
    await db.conversation.update({ where: { id: destination.id }, data: { sharedMemory: false } });
    expect((await controls.applyToFrame(owner, destination.id, frame())).memory.summary.text).not.toContain('共享虚构摘录');
    await db.conversation.update({ where: { id: destination.id }, data: { sharedMemory: true } });
    await db.conversation.update({ where: { id: source.id }, data: { sharedMemory: false } });
    expect((await controls.applyToFrame(owner, destination.id, frame())).memory.summary.text).not.toContain('共享虚构摘录');
    await db.conversation.update({ where: { id: source.id }, data: { sharedMemory: true, personaKey: 'another-role' } });
    expect((await controls.applyToFrame(owner, destination.id, frame())).memory.summary.text).not.toContain('共享虚构摘录');
    await db.conversation.update({ where: { id: source.id }, data: { personaKey: 'assistant', userId: other } });
    expect((await controls.applyToFrame(owner, destination.id, frame())).memory.summary.text).not.toContain('共享虚构摘录');
    await db.conversation.update({ where: { id: source.id }, data: { userId: owner } });
    await controls.forget(owner, source.id, action((await entries(source.id)).items[0]));
    expect((await controls.applyToFrame(owner, destination.id, frame())).memory.summary.text).not.toContain('共享虚构摘录');
  });

  test('forget between worker source read and commit prevents old-epoch cache or episodes from reappearing', async () => {
    const c = await create(); await pair(c.id); const item = (await entries(c.id)).items[0];
    const original = db.chatMessage.findMany.bind(db.chatMessage); let forgotten = false;
    const spy = jest.spyOn(db.chatMessage, 'findMany').mockImplementation((async (args: any) => {
      const rows = await original(args);
      if (!forgotten && args.where?.conversationId === c.id && args.take === 200) {
        forgotten = true; await controls.forget(owner, c.id, action(item));
      }
      return rows;
    }) as any);
    try { await batch(c.id); } finally { spy.mockRestore(); }
    expect(forgotten).toBe(true);
    expect(await db.conversationEpisode.count({ where: { conversationId: c.id } })).toBe(0);
    expect(await db.conversationMemory.count({ where: { conversationId: c.id } })).toBe(0);
    expect(await db.memoryRebuildJob.findUniqueOrThrow({ where: { conversationId: c.id } })).toMatchObject({ epoch: 1, status: 'QUEUED', workerToken: null });
  });
});

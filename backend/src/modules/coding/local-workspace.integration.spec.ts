import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { LocalWorkspaceController } from './local-workspace.controller';
import { LocalWorkspaceService } from './local-workspace.service';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { ChatService } from '../chat/chat.service';
const suite = process.env.RUN_CODING_INTEGRATION === '1' ? describe : describe.skip;
suite('local filesystem broker real HTTP / MySQL / Redis', () => {
  let app: INestApplication, db: PrismaService, service: LocalWorkspaceService, redis: RedisService;
  let owner: number, other: number, cid: number, roleId: number, categoryId: number, token: string, otherToken: string, connection: any, runId: string;
  const prefix = 'localcode_' + randomUUID().slice(0, 8);
  const scope = () => ({ userId: owner, conversationId: cid });
  const http = (method: 'get' | 'post' | 'delete', suffix = '', auth = token, id = cid, capability = connection?.token) => {
    const req = request(app.getHttpServer())[method](`/api/coding/${id}/local${suffix}`).set('Authorization', 'Bearer ' + auth);
    return capability ? req.set('X-Workspace-Token', capability) : req;
  };
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' || process.env.REDIS_PORT !== '36386') throw Error('Refusing non-fixture data services');
    process.env.JWT_ACCESS_SECRET = 'local-files-fixture-only';
    const module = await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [LocalWorkspaceController], providers: [PrismaService, RedisService, LocalWorkspaceService] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api'); app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    db = app.get(PrismaService); service = app.get(LocalWorkspaceService); redis = app.get(RedisService);
    [owner, other] = await Promise.all([1, 2].map(async n => (await db.user.create({ data: { email: `${prefix}${n}@example.test`, username: `${prefix}${n}`, password: 'fixture-not-login-hash' } })).id));
    [cid, roleId] = await Promise.all(['ASSISTANT', 'ROLEPLAY'].map(async type => (await db.conversation.create({ data: { userId: owner, title: prefix, conversationType: type } })).id));
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    const jwt = app.get(JwtService); token = jwt.sign({ sub: owner }, { secret: process.env.JWT_ACCESS_SECRET }); otherToken = jwt.sign({ sub: other }, { secret: process.env.JWT_ACCESS_SECRET });
  });
  afterAll(async () => {
    if (db && owner) { await db.post.deleteMany({ where: { userId: owner, title: { startsWith: prefix } } }); await db.conversation.deleteMany({ where: { userId: owner, title: prefix } }); await db.user.deleteMany({ where: { id: { in: [owner, other] }, username: { startsWith: prefix } } }); }
    if (redis && owner) await redis.del(`local-code:v1:${owner}:${cid}`);
    if (db && categoryId) await db.category.delete({ where: { id: categoryId } });
    if (app) await app.close();
  });
  test('only current ACTIVE assistant owner can connect; capability is required to poll', async () => {
    expect((await http('post', '', otherToken).send({ name: 'fixture' })).status).toBe(403);
    expect((await http('post', '', token, roleId).send({ name: 'fixture' })).status).toBe(403);
    expect((await http('post').send({ name: 'C:/private', userId: other })).status).toBe(400);
    const response = await http('post').send({ name: 'fixture-project' }); expect(response.status).toBe(201); connection = response.body.data;
    expect((await http('get', '/' + connection.id, token, cid, '0'.repeat(64))).status).toBe(409);
    expect((await http('get', '/' + connection.id)).body.data.operation).toBeNull();
    runId = (await db.chatRun.create({ data: { ...scope(), requestId: randomUUID(), status: 'RUNNING', input: { codingWorkspaceId: connection.id } } })).id;
    expect((await http('post').send({ name: 'replacement' })).status).toBe(409);
  });
  test('separate service instances share operation and idempotent acknowledgment', async () => {
    const worker = new LocalWorkspaceService(db, redis);
    const promise = worker.tool({ action: 'write', path: 'src/new.ts', expectedHash: 'absent', content: 'export const x = 1;' }, { ...scope(), runId, codingWorkspaceId: connection.id });
    let op: any;
    for (let i = 0; i < 30 && !op; i++) { op = (await http('get', '/' + connection.id)).body.data.operation; if (!op) await new Promise(r => setTimeout(r, 20)); }
    expect(op.args.path).toBe('src/new.ts');
    expect((await http('post', `/${connection.id}/operations/${op.id}/authorize`)).status).toBe(201);
    const result = { success: true, data: { path: 'src/new.ts', saved: true, hash: 'f'.repeat(64) } };
    expect((await http('post', `/${connection.id}/operations/${op.id}`).send(result)).status).toBe(201);
    expect((await promise).saved).toBe(true);
    expect(await redis.get(`local-code:operation:${connection.id}`)).toBeNull();
    expect(await redis.get(`local-code:result:${op.id}`)).toBeNull();
  });
  test('cancelled task and disabled account cannot authorize subsequent writes', async () => {
    const promise = service.tool({ action: 'read', path: 'main.ts' }, { ...scope(), runId, codingWorkspaceId: connection.id });
    const rejection = expect(promise).rejects.toThrow();
    let op: any; for (let i = 0; i < 30 && !op; i++) { op = (await http('get', '/' + connection.id)).body.data.operation; if (!op) await new Promise(r => setTimeout(r, 20)); }
    await db.chatRun.update({ where: { id: runId }, data: { status: 'CANCELLED' } });
    expect((await http('post', `/${connection.id}/operations/${op.id}/authorize`)).status).toBe(409); await rejection;
    await db.user.update({ where: { id: owner }, data: { status: 'BANNED' } });
    expect([401, 403]).toContain((await http('get', '/' + connection.id)).status);
    await db.user.update({ where: { id: owner }, data: { status: 'ACTIVE' } });
  });
  test('legacy bold titles recover only unique approved links without mutating stored text', async () => {
    const good = await db.post.create({ data: { userId: owner, categoryId, title: prefix + ' public', content: 'fixture', status: 'APPROVED' } });
    await db.post.create({ data: { userId: owner, categoryId, title: prefix + ' hidden', content: 'fixture', status: 'PENDING' } });
    await db.post.createMany({ data: [1, 2].map(() => ({ userId: owner, categoryId, title: prefix + ' duplicate', content: 'fixture', status: 'APPROVED' })) });
    const content = `1. **${good.title}**\n2. **${prefix} hidden**\n3. **${prefix} duplicate**`;
    const msg = await db.chatMessage.create({ data: { conversationId: cid, role: 'ASSISTANT', content } });
    const result = await new ChatService(db, {} as any).getConversation(cid, owner);
    expect(result.messages[0].content).toContain(`](/forum/post/${good.id})`);
    expect(result.messages[0].content.match(/\/forum\/post\//g)).toHaveLength(1);
    expect((await db.chatMessage.findUnique({ where: { id: msg.id } })).content).toBe(content);
  });
});

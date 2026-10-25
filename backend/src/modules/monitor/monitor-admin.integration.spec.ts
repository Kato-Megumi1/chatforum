import { randomBytes, randomUUID } from 'crypto';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { AdminSettingsService } from '../admin-settings/admin-settings.service';
import { MailService } from '../admin-settings/mail.service';
import { MonitorService } from './monitor.service';

const suite = process.env.RUN_MONITOR_INTEGRATION === '1' ? describe : describe.skip;
suite('local administration business ACL and CAS: isolated fixtures, no deliveries or model calls', () => {
  let db: PrismaService, redis: RedisService, settings: AdminSettingsService, monitor: MonitorService, app: any;
  let admin: any, member: any, category: any, post: any, comment: any, kb: any, dir: string;
  let cookie = '', csrf = '';
  const password = randomBytes(24).toString('hex'), prefix = 'ops_' + randomUUID().slice(0, 8);
  const ids: number[] = [], environment = new Map<string, string | undefined>();
  const mail = { validateHost: jest.fn(async () => undefined), sendTest: jest.fn(async () => ({ ok: true })) };
  const get = (path: string, session = cookie) => request(app).get('/ops-api' + path)
    .set('Host', '127.0.0.1:8091').set('Cookie', session);
  const mutate = (method: 'put' | 'patch' | 'post', path: string, data: any, token = csrf, origin = 'http://127.0.0.1:8091') =>
    request(app)[method]('/ops-api' + path).set('Host', '127.0.0.1:8091').set('Origin', origin)
      .set('Cookie', cookie).set('X-Ops-CSRF', token).send(data);
  const login = (identity: string) => request(app).post('/ops-api/session').set('Host', '127.0.0.1:8091')
    .set('Origin', 'http://127.0.0.1:8091').send({ identity, password });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' ||
      process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386' || process.env.REDIS_PASSWORD)
      throw Error('Refusing non-fixture DB or Redis');
    for (const key of ['JWT_REFRESH_SECRET', 'QWEN_CHAT_ENABLED', 'DEEPSEEK_CHAT_ENABLED', 'CHAT_DEFAULT_MODEL', 'QWEN_API_KEY', 'DASHSCOPE_API_KEY'])
      environment.set(key, process.env[key]);
    process.env.JWT_REFRESH_SECRET = 'fixture-ops-settings-secret-32-bytes-or-longer';
    process.env.QWEN_API_KEY = 'fixture-only-not-a-real-model-key'; process.env.DASHSCOPE_API_KEY = '';
    process.env.QWEN_CHAT_ENABLED = 'true'; process.env.DEEPSEEK_CHAT_ENABLED = 'false'; process.env.CHAT_DEFAULT_MODEL = 'qwen3.8-max';
    dir = await mkdtemp(join(tmpdir(), 'cf-ops-business-'));
    db = new PrismaService(); await db.$connect(); redis = new RedisService(); redis.onModuleInit();
    const hash = await bcrypt.hash(password, 4);
    for (const role of ['ADMIN', 'USER'] as const) {
      const user = await db.user.create({ data: { username: prefix + '_' + role, email: prefix + '_' + role + '@example.test', password: hash, role } });
      ids.push(user.id); if (role === 'ADMIN') admin = user; else member = user;
    }
    category = await db.category.create({ data: { name: prefix } });
    post = await db.post.create({ data: { title: prefix + ' test title', content: 'fixture-only post body', categoryId: category.id, userId: member.id, status: 'PENDING', commentCount: 1 } });
    comment = await db.comment.create({ data: { content: 'fixture-only comment', postId: post.id, userId: member.id } });
    kb = await db.knowledgeBase.create({ data: { name: prefix, ownerId: member.id, visibility: 'PRIVATE', embeddingApiKey: 'fixture-embedding-secret', embeddingApiBase: 'https://example.test/private' } });
    await db.knowledgeBaseDocument.createMany({ data: [
      { knowledgeBaseId: kb.id, fileName: 'current.txt', fileType: 'txt', filePath: 'fixture-only-current-path', fileSize: 12, chunkCount: 2 },
      { knowledgeBaseId: kb.id, fileName: 'old.txt', fileType: 'txt', filePath: 'fixture-only-old-path', fileSize: 99, chunkCount: 9, isCurrent: false },
      { knowledgeBaseId: kb.id, fileName: 'removed.txt', fileType: 'txt', filePath: 'fixture-only-removed-path', fileSize: 99, chunkCount: 9, isDeleted: true },
    ] });
    settings = new AdminSettingsService(); (settings as any).file = join(dir, 'admin-settings.enc');
    monitor = new MonitorService(db, redis, settings, mail as unknown as MailService); app = monitor.createApp(8091);
  });
  afterAll(async () => {
    if (cookie) await request(app).delete('/ops-api/session').set('Host', '127.0.0.1:8091').set('Origin', 'http://127.0.0.1:8091').set('Cookie', cookie).set('X-Ops-CSRF', csrf);
    if (db) {
      if (kb) await db.knowledgeBase.delete({ where: { id: kb.id } });
      if (category) await db.category.delete({ where: { id: category.id } });
      await db.operationLog.deleteMany({ where: { userId: { in: ids } } });
      await db.loginEvent.deleteMany({ where: { userId: { in: ids } } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
    if (redis) await redis.getClient().quit();
    if (dir && resolve(dir).startsWith(resolve(tmpdir()) + '\\')) await rm(dir, { recursive: true, force: true });
    for (const [key, value] of environment) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  test('all new routes require an independent local session; public JWT and USER login grant no access', async () => {
    for (const path of ['/settings', '/posts', '/comments', '/knowledge-bases']) expect((await get(path, '')).status).toBe(401);
    const publicToken = new JwtService().sign({ sub: admin.id, role: 'ADMIN', authVersion: admin.authVersion }, { secret: 'fixture-only-public-jwt-secret-32-bytes' });
    expect((await get('/settings', '').set('Authorization', 'Bearer ' + publicToken)).status).toBe(401);
    expect((await login(member.username)).status).toBe(401);
    const result = await login(admin.username); expect(result.status).toBe(200);
    cookie = result.headers['set-cookie'][0].split(';')[0]; csrf = result.body.csrf;
    expect((await get('/settings')).status).toBe(200);
    await db.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    try {
      for (const path of ['/settings', '/posts', '/comments', '/knowledge-bases']) expect((await get(path)).status).toBe(403);
      expect((await mutate('put', '/settings/models', {})).status).toBe(403);
    } finally { await db.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } }); }
  });
  test('Host, cross-site fetch, exact Origin and CSRF protect every business mutation', async () => {
    expect((await get('/settings').set('Host', 'evil.example:8091')).status).toBe(403);
    expect((await get('/posts').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    for (const [method, path] of [['put', '/settings/smtp'], ['put', '/settings/models'], ['post', '/settings/smtp/test'],
      ['patch', '/posts/' + post.id + '/status'], ['patch', '/comments/' + comment.id + '/status']] as const) {
      expect((await mutate(method, path, {}, '', 'http://127.0.0.1:8091')).status).toBe(403);
      expect((await mutate(method, path, {}, csrf, 'https://evil.example')).status).toBe(403);
    }
    expect(mail.sendTest).not.toHaveBeenCalled(); expect(mail.validateHost).not.toHaveBeenCalled();
  });
  test('post status uses exact title confirmation, expected state and revision; concurrent stale operations cannot both commit', async () => {
    const path = '/posts/' + post.id + '/status', body = { status: 'APPROVED', expectedStatus: 'PENDING', expectedRevision: 1, confirmation: post.title };
    expect((await mutate('patch', path, { ...body, expectedRevision: undefined })).status).toBe(400);
    expect((await mutate('patch', path, { ...body, confirmation: 'wrong title' })).status).toBe(400);
    expect((await mutate('patch', path, { ...body, expectedStatus: 'REJECTED' })).status).toBe(409);
    expect((await mutate('patch', path, { ...body, expectedRevision: 99 })).status).toBe(409);
    const responses = await Promise.all([mutate('patch', path, body), mutate('patch', path, body)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const actual = await db.post.findUniqueOrThrow({ where: { id: post.id } }); expect(actual.status).toBe('APPROVED'); expect(actual.revision).toBe(2);
    expect((await mutate('patch', path, body)).status).toBe(409);
    expect(await db.operationLog.count({ where: { userId: admin.id, action: 'POST_MODERATION' } })).toBe(1);
    const list = await get('/posts?q=' + encodeURIComponent(post.title)); expect(list.status).toBe(200);
    expect(list.body.rows.find((r: any) => r.id === post.id).revision).toBe(2); expect(JSON.stringify(list.body)).not.toContain(actual.content);
  });
  test('comment delete/restore is admin-only, stale-safe and preserves the active comment counter', async () => {
    const path = '/comments/' + comment.id + '/status', deletion = { status: 'DELETED', expectedStatus: 'ACTIVE', confirmation: String(comment.id) };
    expect((await mutate('patch', path, { ...deletion, confirmation: post.title })).status).toBe(400);
    const responses = await Promise.all([mutate('patch', path, deletion), mutate('patch', path, deletion)]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(0);
    expect((await mutate('patch', path, { ...deletion, expectedStatus: 'DELETED' })).status).toBe(200);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(0);
    const restoration = { status: 'ACTIVE', expectedStatus: 'DELETED', confirmation: String(comment.id) };
    await expect(monitor.moderateComment(member.id, comment.id, restoration)).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: admin.id }, data: { status: 'BANNED' } });
    try { expect((await mutate('patch', path, restoration)).status).toBe(403); }
    finally { await db.user.update({ where: { id: admin.id }, data: { status: 'ACTIVE' } }); }
    expect((await mutate('patch', path, restoration)).status).toBe(200);
    expect((await mutate('patch', path, restoration)).status).toBe(409);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(1);
    expect(await db.comment.count({ where: { postId: post.id, status: 'ACTIVE' } })).toBe(1);
  });
  test('SMTP secrets stay encrypted and absent from responses/audit; models accept only server catalog IDs', async () => {
    const smtp = { enabled: true, host: 'smtp.example.com', port: 465, user: 'sender@example.com', from: 'sender@example.com', password: 'fixture-smtp-authorization-code' };
    const saved = await mutate('put', '/settings/smtp', smtp); expect(saved.status).toBe(200); expect(saved.body.smtp.passwordConfigured).toBe(true);
    expect(mail.validateHost).toHaveBeenCalledWith(smtp.host);
    const snapshot = await get('/settings'); expect(snapshot.status).toBe(200);
    const { password: secret, ...unchanged } = smtp;
    expect((await mutate('put', '/settings/smtp', { ...unchanged, port: 587 })).status).toBe(200);
    expect(settings.smtp()?.password).toBe(secret);
    const logs = await db.operationLog.findMany({ where: { userId: admin.id, module: 'LOCAL_MONITOR' } });
    for (const data of [saved.body, snapshot.body, logs]) {
      expect(JSON.stringify(data)).not.toContain(secret); expect(JSON.stringify(data)).not.toContain('fixture-only-not-a-real-model-key');
    }
    expect(await readFile(join(dir, 'admin-settings.enc'), 'utf8')).not.toContain(secret);
    const models = { defaultModelId: 'qwen3.8-max', enabled: { 'qwen3.8-max': true, 'deepseek-v4-pro': false } };
    expect((await mutate('put', '/settings/models', { ...models, endpoint: 'http://127.0.0.1' })).status).toBe(400);
    expect((await mutate('put', '/settings/models', { ...models, apiKey: 'client-supplied-secret' })).status).toBe(400);
    expect((await mutate('put', '/settings/models', models)).status).toBe(200);
    expect(process.env.CHAT_DEFAULT_MODEL).toBe('qwen3.8-max'); expect(mail.sendTest).not.toHaveBeenCalled();
  });
  test('KB overview is metadata-only and read-only; lists reject invalid filters', async () => {
    const response = await get('/knowledge-bases'); expect(response.status).toBe(200);
    expect(response.body.rows.find((r: any) => r.id === kb.id)).toMatchObject({ visibility: 'PRIVATE', documentCount: 1, totalBytes: 12, chunkCount: 2 });
    expect(JSON.stringify(response.body)).not.toContain('fixture-embedding-secret'); expect(JSON.stringify(response.body)).not.toContain('fixture-only-current-path');
    expect((await mutate('post', '/knowledge-bases', { name: 'unexpected-write' })).status).toBe(404);
    for (const path of ['/posts?status=INVALID', '/comments?status=INVALID', '/comments?postId=nope', '/knowledge-bases?page=0'])
      expect((await get(path)).status).toBe(400);
  });
  test('password authVersion changes invalidate existing local sessions immediately', async () => {
    await db.user.update({ where: { id: admin.id }, data: { authVersion: { increment: 1 } } });
    const stale = await get('/settings'); expect(stale.status).toBe(401); expect(stale.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
    expect((await get('/posts')).status).toBe(401);
    const result = await login(admin.username); expect(result.status).toBe(200);
    cookie = result.headers['set-cookie'][0].split(';')[0]; csrf = result.body.csrf;
    expect((await get('/settings')).status).toBe(200);
  });
});

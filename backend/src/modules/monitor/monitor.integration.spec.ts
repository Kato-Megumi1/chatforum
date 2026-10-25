import { randomBytes, randomUUID } from 'crypto';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { MonitorService } from './monitor.service';
import { AuthService } from '../auth/auth.service';
import { recordUsageSnapshot, recordUsageStep } from '../../common/usage-ledger';
import { beginModelCall, withModelRuntime } from '../agent/model-runtime';

const suite = process.env.RUN_MONITOR_INTEGRATION === '1' ? describe : describe.skip;
suite('local monitor: isolated fixture DB, no paid models', () => {
  let db: PrismaService, redis: RedisService, monitor: MonitorService, app: any, admin: any, member: any, auth: AuthService;
  let cookie: string, csrf: string;
  const password = randomBytes(24).toString('hex'), ids: number[] = [], sourceId = randomUUID();
  const get = (path: string) => request(app).get('/ops-api' + path).set('Host', '127.0.0.1:8091').set('Cookie', cookie || '');
  const login = (email: string) => request(app).post('/ops-api/session').set('Host', '127.0.0.1:8091')
    .set('Origin', 'http://127.0.0.1:8091').send({ email, password });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture DB');
    db = new PrismaService(); await db.$connect(); redis = new RedisService(); redis.onModuleInit();
    const hash = await bcrypt.hash(password, 4);
    for (const role of ['ADMIN', 'USER'] as const) {
      const name = 'monitor_' + randomUUID().slice(0, 8);
      const u = await db.user.create({ data: { username: name, email: name + '@example.test', password: hash, role } });
      ids.push(u.id); if (role === 'ADMIN') admin = u; else member = u;
    }
    monitor = new MonitorService(db, redis); app = monitor.createApp(8091); auth = new AuthService(db, new JwtService(), redis);
  });
  afterAll(async () => {
    if (cookie) await request(app).delete('/ops-api/session').set('Host', '127.0.0.1:8091').set('Origin', 'http://127.0.0.1:8091').set('Cookie', cookie).set('X-Ops-CSRF', csrf);
    await db.modelUsageEntry.deleteMany({ where: { sourceId } });
    await db.operationLog.deleteMany({ where: { userId: { in: ids } } });
    await db.loginEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    for (const id of ids) await redis.del('refresh_token:' + id);
    redis.onModuleDestroy(); await db.$disconnect();
  });
  test('host/origin protection and member access fail closed; public tokens are not admin sessions', async () => {
    expect((await get('/users')).status).toBe(401);
    expect((await request(app).get('/').set('Host', 'evil.test:8091')).status).toBe(403);
    expect((await request(app).post('/ops-api/session').set('Host', '127.0.0.1:8091').send({ email: admin.email, password })).status).toBe(403);
    expect((await login(member.email)).status).toBe(401);
    await redis.set('refresh_token:' + admin.id, 'unrelated-public-session', 600);
    const signed = await login(admin.email); expect(signed.status).toBe(200);
    cookie = signed.headers['set-cookie'][0].split(';')[0]; csrf = signed.body.csrf;
    expect(signed.headers['set-cookie'][0]).toContain('HttpOnly'); expect(signed.headers['set-cookie'][0]).toContain('SameSite=Strict');
    expect(await redis.get('refresh_token:' + admin.id)).toBe('unrelated-public-session');
    expect((await get('/me')).body.user.id).toBe(admin.id);
  });
  test('per-call ledger is idempotent, includes failed/cancelled calls and never adds cache/reasoning twice', async () => {
    const owner = { scope: 'CHAT' as const, sourceId, userId: member.id, createdAt: new Date() };
    await withModelRuntime(new AbortController().signal, async () => {
      beginModelCall('chat', 'fixture-chat', 30, 20).finish({ prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40, completion_tokens_details: { reasoning_tokens: 8 } });
      beginModelCall('embedding', 'fixture-embed', 50, 0).finish({ total_tokens: 30 });
      beginModelCall('chat', 'fixture-chat', 40, 20).finish(undefined, true);
    }, async runtime => { await recordUsageSnapshot(db, owner, runtime); await recordUsageSnapshot(db, owner, runtime); }, (s, i) => recordUsageStep(db, owner, s, i));
    const rows = await db.modelUsageEntry.findMany({ where: { sourceId } });
    expect(rows).toHaveLength(3); expect(rows.reduce((n, r) => n + (r.inputTokens || 0) + (r.outputTokens || 0), 0)).toBe(150);
    expect(rows.filter(r => r.quality === 'UNREPORTED')).toHaveLength(1);
    const users = await get('/users?q=' + member.username + '&days=0'); expect(users.status).toBe(200);
    const user = users.body.rows[0]; expect(Number(user.usage.totalTokens)).toBe(150);
    expect(Number(user.usage.cachedInputTokens)).toBe(40); expect(Number(user.usage.reasoningTokens)).toBe(8);
    expect(Number(user.usage.unreportedCalls)).toBe(1);
    expect(JSON.stringify(users.body)).not.toContain(member.password);
    const summary = await get('/summary?days=0'); expect(summary.status).toBe(200); expect(Number(summary.body.totals.totalTokens)).toBeGreaterThanOrEqual(150);
    expect((await get('/usage?userId=' + member.id)).body.rows).toHaveLength(3);
  });
  test('normal login success/failure is audited without secrets or fabricated online state', async () => {
    const result = await auth.login({ email: member.email, password }, { ip: '127.0.0.1', userAgent: 'Fixture Browser' });
    expect(result.user.id).toBe(member.id);
    await expect(auth.login({ email: member.email, password: 'wrong' })).rejects.toThrow('Invalid credentials');
    const response = await get('/logins?userId=' + member.id);
    expect(response.status).toBe(200); expect(response.body.rows.some((r: any) => r.outcome === 'SUCCESS' && r.channel === 'WEB')).toBe(true);
    expect(response.body.rows.some((r: any) => r.outcome === 'FAILED')).toBe(true); expect(JSON.stringify(response.body)).not.toContain(password);
  });
  test('status changes require CSRF, exact confirmation and current status; self/admin protected; refresh revoked; audit written', async () => {
    const patch = (id: number, data: any, token = csrf) => request(app).patch('/ops-api/users/' + id + '/status')
      .set('Host', '127.0.0.1:8091').set('Origin', 'http://127.0.0.1:8091').set('Cookie', cookie).set('X-Ops-CSRF', token).send(data);
    const data = { status: 'BANNED', expectedStatus: 'ACTIVE', confirmation: member.username };
    expect((await patch(member.id, data, '')).status).toBe(403);
    expect((await patch(admin.id, { ...data, confirmation: admin.username })).status).toBe(403);
    expect((await patch(member.id, { ...data, confirmation: 'wrong' })).status).toBe(400);
    expect((await patch(member.id, data)).status).toBe(200);
    expect(await redis.get('refresh_token:' + member.id)).toBeNull();
    expect((await patch(member.id, data)).status).toBe(409);
    await expect(auth.login({ email: member.email, password })).rejects.toThrow('Invalid credentials');
    expect((await patch(member.id, { ...data, expectedStatus: 'BANNED', status: 'ACTIVE' })).status).toBe(200);
    expect((await get('/audit')).body.rows.filter((r: any) => r.userId === admin.id)).toHaveLength(2);
  });
  test('all data lists paginate and validate; deleted users retain anonymous usage; admin revocation is immediate', async () => {
    for (const path of ['/users?page=-1', '/usage?userId=abc', '/summary?days=999']) expect((await get(path)).status).toBe(400);
    expect((await get('/failures')).status).toBe(200);
    await db.user.delete({ where: { id: member.id } });
    const entries = await db.modelUsageEntry.findMany({ where: { sourceId } }); expect(entries).toHaveLength(3); expect(entries.every(r => r.userId === null)).toBe(true);
    await db.user.update({ where: { id: admin.id }, data: { role: 'USER' } });
    expect((await get('/users')).status).toBe(403);
    await db.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  });
});

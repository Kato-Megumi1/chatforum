import { createHash, randomUUID } from 'crypto';
import { Controller, Get, INestApplication, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { AuthModule } from './auth.module';
import { AuthService } from './auth.service';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../guards/optional-jwt-auth.guard';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { MonitorService } from '../monitor/monitor.service';
import { ChatRunService } from '../chat/chat-run.service';
import { runEvents } from '../chat/chat-run.events';

@Controller('fixture-identity')
class IdentityFixtureController {
  @Get() @UseGuards(JwtAuthGuard) current(@Req() req: any) { return { id: req.user.sub, role: req.user.role }; }
  @Get('optional') @UseGuards(OptionalJwtAuthGuard) optional(@Req() req: any) { return { id: req.user?.sub ?? null }; }
}

const suite = process.env.RUN_PASSWORD_CHANGE_INTEGRATION === '1' ? describe : describe.skip;
suite('password changes: real HTTP/JWT/Redis/DB using synthetic accounts only', () => {
  let app: INestApplication, db: PrismaService, redis: RedisService, auth: AuthService;
  const jwt = new JwtService(), ids: number[] = [], monitorSessions: string[] = [];
  const prefix = 'password_' + randomUUID().slice(0, 8), oldPassword = '  Fixture old password  ', newPassword = '  Fixture new password  ';
  let serial = 0;
  const fixture = async (role: 'ADMIN' | 'USER' = 'USER') => {
    const username = prefix + '_' + ++serial;
    const user = await db.user.create({ data: { username, email: username + '@example.test', password: await bcrypt.hash(oldPassword, 4), role } });
    ids.push(user.id); return user;
  };
  const login = (email: string, password = oldPassword) => request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
  const change = (token: string, body: any = {}) => request(app.getHttpServer()).post('/api/auth/password').set('Authorization', 'Bearer ' + token)
    .send({ oldPassword, newPassword, confirmPassword: newPassword, ...body });
  const identity = (token: string, optional = false) => request(app.getHttpServer()).get('/api/fixture-identity' + (optional ? '/optional' : '')).set('Authorization', 'Bearer ' + token);
  const legacy = (id: number, refresh = false) => jwt.signAsync({ sub: id, role: 'USER' }, { secret: refresh ? process.env.JWT_REFRESH_SECRET : process.env.JWT_ACCESS_SECRET, expiresIn: 600 });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' || process.env.REDIS_PORT !== '36386') throw Error('Refusing non-fixture services');
    const module = await Test.createTestingModule({ imports: [AuthModule], controllers: [IdentityFixtureController], providers: [PrismaService, JwtService] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    db = app.get(PrismaService); redis = app.get(RedisService); auth = app.get(AuthService);
  });
  afterAll(async () => {
    if (!db) return;
    await db.conversation.deleteMany({ where: { userId: { in: ids } } });
    await db.operationLog.deleteMany({ where: { userId: { in: ids } } });
    await db.loginEvent.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    for (const id of ids) { await redis.del('refresh_token:' + id); await redis.del(`login_xp:${id}:${new Date().toISOString().slice(0, 10)}`); }
    for (const key of monitorSessions) await redis.del(key);
    await app.close();
  });

  test('missing login, wrong old password, mismatch, forbidden ownership and UTF-8 boundaries do not mutate credentials', async () => {
    const user = await fixture(), signed = await login(user.email), token = signed.body.data.accessToken;
    expect((await request(app.getHttpServer()).post('/api/auth/password').send({ oldPassword, newPassword, confirmPassword: newPassword })).status).toBe(401);
    for (const body of [{ oldPassword: 'wrong-password' }, { confirmPassword: 'not-the-new-password' }, { userId: user.id + 1 },
      { newPassword: '12345', confirmPassword: '12345' }, { newPassword: '中'.repeat(25), confirmPassword: '中'.repeat(25) },
      { newPassword: '      ', confirmPassword: '      ' }, { newPassword: oldPassword, confirmPassword: oldPassword }]) expect((await change(token, body)).status).toBe(400);
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.password).toBe(user.password); expect(saved.authVersion).toBe(0);
    expect((await identity(token)).status).toBe(200);
    expect(await db.operationLog.count({ where: { userId: user.id, module: 'AUTH' } })).toBe(0);
  });

  test('real password change revokes old mandatory/optional JWT, refresh and local monitor; literal new password works', async () => {
    const user = await fixture('ADMIN'), signed = await login(user.email), oldAccess = signed.body.data.accessToken, oldRefresh = signed.body.data.refreshToken;
    const oldLegacy = await legacy(user.id); expect((await identity(oldLegacy)).status).toBe(200);
    const monitor = new MonitorService(db, redis), monitorApp = monitor.createApp(8091);
    const mLogin = await request(monitorApp).post('/ops-api/session').set('Host', '127.0.0.1:8091').set('Origin', 'http://127.0.0.1:8091').send({ email: user.email, password: oldPassword });
    expect(mLogin.status).toBe(200); const cookie = mLogin.headers['set-cookie'][0].split(';')[0];
    const key = 'ops:session:' + createHash('sha256').update(cookie.split('=')[1]).digest('hex'); monitorSessions.push(key);
    const legacySession = JSON.parse((await redis.get(key))!); delete legacySession.authVersion; await redis.set(key, JSON.stringify(legacySession), 600);
    expect((await request(monitorApp).get('/ops-api/me').set('Host', '127.0.0.1:8091').set('Cookie', cookie)).status).toBe(200);
    const result = await change(oldAccess); expect(result.status).toBe(200); expect(result.body.data.requiresLogin).toBe(true);
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(saved.authVersion).toBe(1); expect(bcrypt.getRounds(saved.password)).toBe(12);
    expect(await bcrypt.compare(newPassword, saved.password)).toBe(true); expect(await bcrypt.compare(newPassword.trim(), saved.password)).toBe(false);
    for (const token of [oldAccess, oldLegacy]) { expect((await identity(token)).status).toBe(401); expect((await identity(token, true)).body.id).toBeNull(); }
    expect((await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken: oldRefresh })).status).toBe(401);
    const revoked = await request(monitorApp).get('/ops-api/me').set('Host', '127.0.0.1:8091').set('Cookie', cookie);
    expect(revoked.status).toBe(401); expect(revoked.headers['set-cookie'][0]).toContain('cf_local_ops=;');
    expect((await login(user.email)).status).toBe(401);
    const current = await login(user.email, newPassword); expect(current.status).toBe(200);
    expect(jwt.decode(current.body.data.accessToken)).toMatchObject({ authVersion: 1 }); expect((await identity(current.body.data.accessToken)).status).toBe(200);
    const text = JSON.stringify([result.body, current.body]); expect(text).not.toContain(saved.password); expect(text).not.toContain(newPassword);
  }, 15000);

  test('two simultaneous old-password changes only succeed once and preserve a bcrypt-verified winner', async () => {
    const user = await fixture(), token = (await login(user.email)).body.data.accessToken;
    const winner = ['Fixture contender A', 'Fixture contender B'];
    const responses = await Promise.all(winner.map(password => change(token, { newPassword: password, confirmPassword: password })));
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    const saved = await db.user.findUniqueOrThrow({ where: { id: user.id } }); expect(saved.authVersion).toBe(1);
    expect(await bcrypt.compare(winner[responses.findIndex(r => r.status === 200)], saved.password)).toBe(true);
    expect(await db.operationLog.count({ where: { userId: user.id, action: 'PASSWORD_CHANGE' } })).toBe(1);
  }, 15000);

  test('no-version legacy refresh is accepted only at zero, even if an obsolete Redis entry reappears', async () => {
    const user = await fixture(), token = await legacy(user.id, true); await redis.set('refresh_token:' + user.id, token, 600);
    expect((await auth.refreshTokens(token)).user.id).toBe(user.id);
    const access = (await login(user.email)).body.data.accessToken; expect((await change(access)).status).toBe(200);
    await redis.set('refresh_token:' + user.id, token, 600); await expect(auth.refreshTokens(token)).rejects.toThrow('Invalid refresh token');
  });

  test('reset completion binds exact email, password hash and version; stale proof cannot change an account', async () => {
    const user = await fixture();
    await expect(auth.replaceVerifiedPassword(user.id, user.password, 0, newPassword, {}, 'PASSWORD_RESET', 'different@example.test')).rejects.toThrow('账号或密码已发生变化');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).authVersion).toBe(0);
    await auth.replaceVerifiedPassword(user.id, user.password, 0, newPassword, {}, 'PASSWORD_RESET', user.email);
    await expect(auth.replaceVerifiedPassword(user.id, user.password, 0, 'Another fixture password', {}, 'PASSWORD_RESET', user.email)).rejects.toThrow('账号或密码已发生变化');
    expect(await db.operationLog.count({ where: { userId: user.id, action: 'PASSWORD_RESET' } })).toBe(1);
  });

  test('refresh cleanup never deletes a newer login and failure does not undo database revocation', async () => {
    const user = await fixture(), token = (await login(user.email)).body.data.accessToken;
    const realDelete = redis.compareDelete.bind(redis);
    const cleanup = jest.spyOn(redis, 'compareDelete').mockImplementationOnce(async (key, expected) => {
      const fresh = await auth.login({ email: user.email, password: newPassword });
      await realDelete(key, expected); expect(await redis.get(key)).toBe(fresh.refreshToken); return 0;
    });
    try { expect((await change(token)).status).toBe(200); } finally { cleanup.mockRestore(); }
    const another = await fixture(), signed = await login(another.email);
    const failed = jest.spyOn(redis, 'compareDelete').mockRejectedValueOnce(new Error('Fixture cleanup outage'));
    try { expect((await change(signed.body.data.accessToken)).status).toBe(200); } finally { failed.mockRestore(); }
    expect((await identity(signed.body.data.accessToken)).status).toBe(401);
    expect((await db.user.findUniqueOrThrow({ where: { id: another.id } })).authVersion).toBe(1);
  }, 15000);

  test('an already-open SSE reader stops at next version check without cancelling its persisted generation', async () => {
    const user = await fixture(), conversation = await db.conversation.create({ data: { title: 'Synthetic SSE revocation', userId: user.id, conversationType: 'ASSISTANT', personaKey: 'assistant' } });
    const run = await db.chatRun.create({ data: { userId: user.id, conversationId: conversation.id, requestId: randomUUID(), status: 'RUNNING', input: {}, result: { content: 'Fixture partial answer' } } });
    const service = new ChatRunService(db, {} as any, { principal: async () => user } as any, {} as any, {} as any, {} as any);
    const events = runEvents(() => service.get(user.id, run.id, 0), 0, new AbortController().signal);
    expect((await events.next()).value.event).toBe('status');
    expect((await events.next()).value.event).toBe('delta'); // Drain the already-authorized initial snapshot.
    await auth.replaceVerifiedPassword(user.id, user.password, 0, newPassword);
    await expect(events.next()).rejects.toThrow('登录状态已改变');
    const saved = await db.chatRun.findUniqueOrThrow({ where: { id: run.id } }); expect(saved.status).toBe('RUNNING'); expect(saved.result).toEqual(run.result);
    expect((await service.get(user.id, run.id, 1)).status).toBe('RUNNING');
  });
});

import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { AuthModule } from './auth.module';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';

const suite = process.env.RUN_REGISTRATION_INTEGRATION === '1' ? describe : describe.skip;
suite('registration validation through real HTTP, isolated DB and Redis', () => {
  let app: INestApplication, db: PrismaService, redis: RedisService;
  const prefix = 'registration_' + randomUUID().slice(0, 8), ids: number[] = [];
  let serial = 0;
  const input = () => ({ email: `${prefix}_${++serial}@example.test`, username: `${prefix}_${serial}`, password: '  Example pass  ' });
  const register = (body: any) => request(app.getHttpServer()).post('/api/auth/register').send(body);
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' || process.env.REDIS_PORT !== '36386') throw Error('Refusing non-fixture services');
    const module = await Test.createTestingModule({ imports: [AuthModule] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
    db = app.get(PrismaService); redis = app.get(RedisService);
  });
  afterAll(async () => {
    const fixtures = await db.user.findMany({ where: { email: { startsWith: prefix + '_' } }, select: { id: true } });
    const userIds = fixtures.map(u => u.id);
    await db.loginEvent.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    for (const id of userIds) {
      await redis.del(`refresh_token:${id}`);
      await redis.del(`login_xp:${id}:${new Date().toISOString().slice(0, 10)}`);
    }
    await app.close();
  });
  test('invalid phones and password boundaries are rejected before any account is created', async () => {
    for (const phone of ['123', '1380013800', '138001380001', '12345678901', '1380013800a', '+8613800138000', 13800138000]) {
      const res = await register({ ...input(), phone }); expect(res.status).toBe(400);
    }
    for (const password of ['', '12345', '😀'.repeat(5), 'a'.repeat(73), '中'.repeat(25)]) {
      expect((await register({ ...input(), password })).status).toBe(400);
    }
    expect(await db.user.count({ where: { email: { startsWith: prefix + '_' } } })).toBe(0);
  });
  test('omitted, blank and whitespace phones all become NULL; passwords hash and log in literally', async () => {
    for (const phone of [undefined, '', '   ', null]) {
      const body = { ...input(), phone }, res = await register(body);
      expect(res.status).toBe(201); ids.push(res.body.data.user.id);
      const saved = await db.user.findUniqueOrThrow({ where: { id: res.body.data.user.id } });
      expect(saved.phone).toBeNull(); expect(saved.password).not.toBe(body.password);
      expect(await bcrypt.compare(body.password, saved.password)).toBe(true);
      expect(await bcrypt.compare(body.password.trim(), saved.password)).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(saved.password);
      if (phone === undefined) {
        const good = await request(app.getHttpServer()).post('/api/auth/login').send({ email: body.email, password: body.password });
        expect(good.status).toBe(200); expect(good.body.data.user.id).toBe(saved.id);
        expect((await request(app.getHttpServer()).post('/api/auth/login').send({ email: body.email, password: body.password.trim() })).status).toBe(401);
      }
    }
  }, 15000); // Real bcrypt cost=12 hashes/comparisons; this is only a test timeout.
  test('valid phone trims outer whitespace; duplicate/concurrent accounts receive 409, not 500', async () => {
    const phone = '199' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const body = { ...input(), phone: ` ${phone} ` };
    const one = await register(body); expect(one.status).toBe(201); ids.push(one.body.data.user.id);
    expect((await db.user.findUniqueOrThrow({ where: { id: one.body.data.user.id } })).phone).toBe(phone);
    expect((await register({ ...input(), phone })).status).toBe(409);
    const same = input(); const responses = await Promise.all([register(same), register(same)]);
    expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  });
  test('minimum length and maximum UTF-8 boundaries agree with the client', async () => {
    for (const password of ['123456', 'a'.repeat(72), '中'.repeat(24), '😀'.repeat(18)]) {
      const body = { ...input(), password }, res = await register(body); expect(res.status).toBe(201);
      const saved = await db.user.findUniqueOrThrow({ where: { id: res.body.data.user.id } });
      expect(await bcrypt.compare(password, saved.password)).toBe(true);
    }
  });
});

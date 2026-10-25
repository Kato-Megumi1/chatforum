import { randomUUID, createHash } from 'crypto';
import { Test } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { RedisService } from '../../common/redis.service';
import { HttpExceptionFilter } from '../../filters/http-exception.filter';
import { PasswordRecoveryService } from './password-recovery.service';
import { PasswordRecoveryController } from './password-recovery.controller';

// Real Redis executes the Lua atomicity checks. Accounts, credential replacement and outbound
// email are synthetic mocks; this suite never sends mail or touches any production account.
const suite = process.env.RUN_PASSWORD_RECOVERY_INTEGRATION === '1' ? describe : describe.skip;
suite('password recovery HTTP + isolated real Redis, synthetic account and email transport', () => {
  let app: INestApplication, redis: RedisService, service: PasswordRecoveryService;
  const prefix = 'recovery_' + randomUUID().slice(0, 8), keys = new Set<string>();
  const users = new Map<string, any>(), deliveries: { email: string; code: string }[] = [];
  const replace = jest.fn().mockResolvedValue({ requiresLogin: true, message: '密码已重置，请使用新密码重新登录' });
  let ready = true, deliveryFails = false, serial = 0;
  const mail = { isReady: async () => ready, sendPasswordResetCode: async (email: string, code: string) => {
    if (deliveryFails) throw new Error('provider error containing a secret'); deliveries.push({ email, code });
  } };
  const db = { user: { findUnique: jest.fn(async ({ where }: any) => {
    if ('email' in where) return users.get(where.email.toLowerCase()) || null;
    return [...users.values()].find(user => user.id === where.id) || null;
  }) } };
  const account = () => { const email = `${prefix}_${++serial}@example.test`; const user = { id: 98000 + serial, email, status: 'ACTIVE', authVersion: 3, password: 'synthetic-existing-hash' }; users.set(email, user); return user; };
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  const challengeKey = (email: string) => 'password_recovery:challenge:' + fingerprint(email);
  const context = () => ({ ip: `${prefix}-${serial}-${randomUUID()}` });
  const reset = (email: string, code: string, extra = {}) => ({ email, code, newPassword: 'new synthetic password', confirmPassword: 'new synthetic password', ...extra });
  beforeAll(async () => {
    if (process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386' || !process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32)
      throw Error('Refusing non-fixture Redis or missing fixture-only signing secret');
    redis = new RedisService(); redis.onModuleInit();
    const nativeEval = redis.getClient().eval.bind(redis.getClient());
    jest.spyOn(redis.getClient(), 'eval').mockImplementation(((script: string, count: number, ...args: any[]) => {
      for (const key of args.slice(0, count)) keys.add(String(key)); return nativeEval(script, count, ...args);
    }) as any);
    const nativeSet = redis.set.bind(redis); jest.spyOn(redis, 'set').mockImplementation((key, value, ttl) => { keys.add(key); return nativeSet(key, value, ttl); });
    service = new PasswordRecoveryService(db as any, redis, { replaceVerifiedPassword: replace } as any, mail as any);
    const module = await Test.createTestingModule({ controllers: [PasswordRecoveryController], providers: [{ provide: PasswordRecoveryService, useValue: service }] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionFilter()); await app.init();
  });
  afterAll(async () => { await service.onModuleDestroy(); for (const key of keys) await redis.del(key); await app.close(); await redis.getClient().quit(); });
  beforeEach(() => { ready = true; deliveryFails = false; deliveries.length = 0; replace.mockClear(); });

  test('configuration missing is a real 503 for known and unknown emails, with no secret or OTP response', async () => {
    ready = false; const user = account();
    for (const email of [user.email, `${prefix}_absent@example.test`]) {
      const result = await request(app.getHttpServer()).post('/api/auth/password-recovery/code').send({ email });
      expect(result.status).toBe(503); expect(result.body.message).toContain('尚未配置');
      expect(JSON.stringify(result.body)).not.toMatch(/SMTP|secret|password/);
      expect(result.body.code).toBe(503); expect(result.body.data).toBeUndefined();
    }
    expect(deliveries).toHaveLength(0);
  });
  test('known, missing, inactive and delivery-failing accounts receive the same generic acknowledgement', async () => {
    const user = account(), inactive = account(); inactive.status = 'DISABLED';
    const good = await service.requestCode(user.email, context()); expect(deliveries).toHaveLength(1);
    const missing = `${prefix}_missing@example.test`; const unknown = await service.requestCode(missing, context()); keys.add(challengeKey(missing));
    const disabled = await service.requestCode(inactive.email, context());
    expect(unknown).toEqual(good); expect(disabled).toEqual(good); expect(JSON.stringify(good)).not.toContain(deliveries[0].code);
    const saved = await redis.get(challengeKey(user.email)); expect(saved).not.toContain(deliveries[0].code); expect(saved).not.toContain('synthetic-existing-hash');
    expect(await redis.getClient().ttl(challengeKey(user.email))).toBeLessThanOrEqual(600);
    const failing = account(); deliveryFails = true; const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try { expect(await service.requestCode(failing.email, context())).toEqual(good); await service.onModuleDestroy(); expect(await redis.get(challengeKey(failing.email))).toBeNull(); expect(JSON.stringify(warn.mock.calls)).not.toMatch(/provider error|example\.test|secret/); }
    finally { warn.mockRestore(); }
  });
  test('cooldowns and hourly limits are atomic across concurrent workers, and never require an existing account', async () => {
    const user = account(), ip = context();
    const results = await Promise.allSettled([service.requestCode(user.email, ip), service.requestCode(user.email, ip)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(deliveries).toHaveLength(1);
    await expect(service.requestCode(account().email, ip)).rejects.toMatchObject({ status: 429 });
    const another = account(); const countKey = 'password_recovery:hour:email:' + fingerprint(another.email); keys.add(countKey); await redis.set(countKey, '5', 3600);
    await expect(service.requestCode(another.email, context())).rejects.toMatchObject({ status: 429 });
  });
  test('SMTP latency is not exposed by waiting only for existing-account delivery', async () => {
    const user = account(), original = mail.sendPasswordResetCode;
    let release: () => void, started = false;
    mail.sendPasswordResetCode = async () => { started = true; await new Promise<void>(resolve => release = resolve); };
    try {
      const accepted = await service.requestCode(user.email, context());
      expect(started).toBe(true); expect(accepted.message).toContain('不代表送达');
      expect((service as any).pendingDeliveries.size).toBe(1); release(); await service.onModuleDestroy();
      expect((service as any).pendingDeliveries.size).toBe(0);
    } finally { release?.(); mail.sendPasswordResetCode = original; }
  });
  test('five simultaneous wrong guesses expire the proof; correct proof can be consumed only once', async () => {
    const user = account(); await service.requestCode(user.email, context()); const code = deliveries[0].code;
    const wrong = code === '999999' ? '000000' : '999999';
    const failures = await Promise.allSettled(Array.from({ length: 5 }, () => service.resetPassword(reset(user.email, wrong), context())));
    expect(failures.every(result => result.status === 'rejected')).toBe(true); expect(await redis.get(challengeKey(user.email))).toBeNull();
    await expect(service.resetPassword(reset(user.email, code), context())).rejects.toMatchObject({ status: 400 }); expect(replace).not.toHaveBeenCalled();
    const next = account(); await service.requestCode(next.email, context()); const nextCode = deliveries.at(-1).code;
    const successes = await Promise.allSettled([service.resetPassword(reset(next.email, nextCode), context()), service.resetPassword(reset(next.email, nextCode), context())]);
    expect(successes.filter(result => result.status === 'fulfilled')).toHaveLength(1); expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0].slice(0, 4)).toEqual([next.id, 'synthetic-existing-hash', 3, 'new synthetic password']);
    expect(replace.mock.calls[0].slice(5)).toEqual(['PASSWORD_RESET', next.email]);
  });
  test('email/version/status changes and expired codes cannot authorize replacement', async () => {
    for (const mutation of ['email', 'authVersion', 'status', 'expire']) {
      const user = account(); await service.requestCode(user.email, context()); const originalEmail = user.email, code = deliveries.at(-1).code;
      if (mutation === 'email') user.email = `${prefix}_changed@example.test`;
      if (mutation === 'authVersion') user.authVersion++;
      if (mutation === 'status') user.status = 'DISABLED';
      if (mutation === 'expire') await redis.getClient().pexpire(challengeKey(originalEmail), 1);
      if (mutation === 'expire') await new Promise(resolve => setTimeout(resolve, 5));
      await expect(service.resetPassword(reset(originalEmail, code), context())).rejects.toMatchObject({ status: 400 });
    }
    expect(replace).not.toHaveBeenCalled();
  });
  test('HTTP validation rejects weak/over-byte/mismatched passwords and client-supplied identity before consuming a code', async () => {
    const user = account(); await service.requestCode(user.email, context()); const code = deliveries[0].code;
    for (const extra of [{ newPassword: '12345', confirmPassword: '12345' }, { newPassword: '中'.repeat(25), confirmPassword: '中'.repeat(25) },
      { newPassword: '      ', confirmPassword: '      ' }, { confirmPassword: 'not the same' }, { userId: user.id }, { authVersion: 3 }, { code: '123' }]) {
      const result = await request(app.getHttpServer()).post('/api/auth/password-recovery/reset').send(reset(user.email, code, extra)); expect(result.status).toBe(400);
      expect(await redis.get(challengeKey(user.email))).not.toBeNull();
    }
    const result = await request(app.getHttpServer()).post('/api/auth/password-recovery/reset').send(reset(user.email.toUpperCase(), code));
    expect(result.status).toBe(200); expect(result.body.data.requiresLogin).toBe(true); expect(result.body.data.accessToken).toBeUndefined();
    expect(replace).toHaveBeenCalledTimes(1); expect(await redis.get(challengeKey(user.email))).toBeNull();
  });
});

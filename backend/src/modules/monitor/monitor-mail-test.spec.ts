import * as request from 'supertest';
import { MonitorService } from './monitor.service';

describe('local administrator test mail: synthetic HTTP and mocked delivery only', () => {
  const origin = 'http://127.0.0.1:8091', token = 'a'.repeat(64), csrf = 'b'.repeat(64);
  let db: any, redis: any, mail: any, app: any;
  const recipient = 'owner-test@example.net';
  const post = (body: object, options: { host?: string; origin?: string; csrf?: string; cookie?: string } = {}) => request(app)
    .post('/ops-api/settings/smtp/test').set('Host', options.host || '127.0.0.1:8091')
    .set('Origin', options.origin || origin).set('Cookie', options.cookie ?? 'cf_local_ops=' + token)
    .set('X-Ops-CSRF', options.csrf ?? csrf).send(body);
  beforeEach(() => {
    db = { user: { findUnique: jest.fn(async () => ({ id: 99171, username: 'fixture-admin', email: 'placeholder@example.invalid',
      role: 'ADMIN', status: 'ACTIVE', authVersion: 0 })) }, operationLog: { create: jest.fn(async () => ({})) } };
    redis = { get: jest.fn(async () => JSON.stringify({ userId: 99171, csrf, authVersion: 0 })), del: jest.fn(),
      getClient: () => client };
    const client = { eval: jest.fn(async () => 0) };
    mail = { isReady: jest.fn(async () => true), sendTest: jest.fn(async () => ({ ok: true })) };
    app = new MonitorService(db, redis, undefined, mail).createApp(8091);
  });
  test('an administrator may send a fixed test to one valid address unrelated to their placeholder mailbox', async () => {
    const response = await post({ to: recipient });
    expect(response.status).toBe(200); expect(response.body).toEqual({ ok: true });
    expect(mail.sendTest).toHaveBeenCalledWith(recipient);
    expect(redis.getClient().eval).toHaveBeenCalledWith(expect.any(String), 3,
      'ops:smtp-test:cooldown:99171', 'ops:smtp-test:window:99171', 'ops:smtp-test:window:all');
    expect(db.operationLog.create).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(db.operationLog.create.mock.calls)).not.toContain(recipient);
    expect(db.operationLog.create.mock.calls[1][0].data.action).toBe('SMTP_TEST_ACCEPTED');
  });
  test('anonymous/public JWT, non-admin, banned or password-version-invalid sessions cannot send', async () => {
    expect((await post({ to: recipient }, { cookie: '' })).status).toBe(401);
    expect((await post({ to: recipient }, { cookie: '' }).set('Authorization', 'Bearer fixture-only-public-jwt')).status).toBe(401);
    for (const change of [{ role: 'USER' }, { status: 'BANNED' }, { authVersion: 1 }]) {
      db.user.findUnique.mockResolvedValue({ id: 99171, role: 'ADMIN', status: 'ACTIVE', authVersion: 0, ...change });
      expect((await post({ to: recipient })).status).toBe(change.authVersion ? 401 : 403);
    }
    expect(mail.sendTest).not.toHaveBeenCalled(); expect(redis.getClient().eval).not.toHaveBeenCalled();
  });
  test('Host, Origin, cross-site fetch and CSRF checks run before delivery or throttling', async () => {
    for (const options of [{ host: 'evil.example:8091' }, { origin: 'https://evil.example' }, { csrf: '' }])
      expect((await post({ to: recipient }, options)).status).toBe(403);
    expect((await post({ to: recipient }).set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect(mail.sendTest).not.toHaveBeenCalled(); expect(redis.getClient().eval).not.toHaveBeenCalled();
  });
  test('multiple recipients, header injection, non-strings and caller-defined content fail before SMTP', async () => {
    for (const body of [{}, [], { to: [recipient] }, { to: null }, { to: recipient + ',other@example.net' },
      { to: recipient + '\r\nBcc:other@example.net' }, { to: recipient, subject: 'not allowed' },
      { to: recipient, html: '<b>not allowed</b>' }, { to: recipient, attachments: [] }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(mail.isReady).not.toHaveBeenCalled(); expect(mail.sendTest).not.toHaveBeenCalled();
    expect(redis.getClient().eval).not.toHaveBeenCalled();
  });
  test('missing/disabled configuration does not consume rate limits and returns a save-first instruction', async () => {
    mail.isReady.mockResolvedValue(false);
    const response = await post({ to: recipient }); expect(response.status).toBe(503);
    expect(response.body.message).toContain('先保存并启用');
    expect(redis.getClient().eval).not.toHaveBeenCalled(); expect(mail.sendTest).not.toHaveBeenCalled();
  });
  test('rate limits return Retry-After and do not reach SMTP; Redis errors fail closed', async () => {
    redis.getClient().eval.mockResolvedValue(59999);
    const limited = await post({ to: recipient }); expect(limited.status).toBe(429); expect(limited.headers['retry-after']).toBe('60');
    expect(limited.body.message).toContain('60秒'); expect(mail.sendTest).not.toHaveBeenCalled();
    redis.getClient().eval.mockRejectedValue(new Error('fixture-redis-unavailable'));
    const unavailable = await post({ to: recipient }); expect(unavailable.status).toBe(503);
    expect(unavailable.body.message).not.toContain('fixture-redis-unavailable'); expect(mail.sendTest).not.toHaveBeenCalled();
  });
  test('SMTP rejection is not reported as accepted and does not expose provider secrets', async () => {
    mail.sendTest.mockRejectedValue(Object.assign(new Error('邮件发送失败，请检查SMTP配置或稍后重试'), { status: 503 }));
    const response = await post({ to: recipient }); expect(response.status).toBe(503); expect(response.body.ok).toBeUndefined();
    expect(db.operationLog.create).toHaveBeenCalledTimes(1);
    expect(db.operationLog.create.mock.calls[0][0].data.action).toBe('SMTP_TEST_ATTEMPT');
  });
});

import { randomInt } from 'crypto';
import { RedisService } from '../../common/redis.service';
import { MonitorService } from './monitor.service';

const suite = process.env.RUN_MONITOR_MAIL_LIMIT_INTEGRATION === '1' ? describe : describe.skip;
suite('SMTP test throttling: isolated Redis only, no database or SMTP', () => {
  const actor = 1700000000 + randomInt(1000000);
  const keys = [`ops:smtp-test:cooldown:${actor}`, `ops:smtp-test:window:${actor}`, 'ops:smtp-test:window:all'];
  let redis: RedisService, monitor: MonitorService, owned = false;
  beforeAll(async () => {
    if (process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386' || process.env.REDIS_PASSWORD)
      throw Error('Refusing non-isolated Redis');
    redis = new RedisService(); redis.onModuleInit();
    // Do not erase state belonging to another integration run.
    if (await redis.getClient().exists(...keys)) throw Error('Fixture keys already in use');
    owned = true; monitor = new MonitorService(undefined as any, redis);
  });
  beforeEach(async () => { if (owned) await redis.getClient().del(...keys); });
  afterAll(async () => {
    if (owned) await redis.getClient().del(...keys);
    if (redis) await redis.getClient().quit();
  });
  const attempt = () => (monitor as any).smtpTestRetryAfter(actor) as Promise<number>;
  test('simultaneous sessions atomically allow only one test attempt', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, attempt));
    expect(results.filter(wait => wait === 0)).toHaveLength(1);
    expect(results.filter(wait => wait > 0).every(wait => wait <= 60)).toBe(true);
    expect(await redis.get(keys[1])).toBe('1'); expect(await redis.get(keys[2])).toBe('1');
    expect(await redis.getClient().pttl(keys[0])).toBeGreaterThan(59000);
  });
  test('rejected clicks preserve counters and do not extend the cooldown', async () => {
    expect(await attempt()).toBe(0); await redis.getClient().pexpire(keys[0], 12500);
    expect(await attempt()).toBe(13); expect(await redis.getClient().pttl(keys[0])).toBeLessThanOrEqual(12500);
    expect(await redis.get(keys[1])).toBe('1'); expect(await redis.get(keys[2])).toBe('1');
  });
  test('an administrator with five attempts waits for their window without changing global counts', async () => {
    await redis.getClient().set(keys[1], '5', 'EX', 380);
    expect(await attempt()).toBeGreaterThanOrEqual(379);
    expect(await redis.get(keys[0])).toBeNull(); expect(await redis.get(keys[2])).toBeNull();
    expect(await redis.get(keys[1])).toBe('5');
  });
  test('global testing limits also apply across administrators', async () => {
    await redis.getClient().set(keys[2], '20', 'EX', 450);
    expect(await attempt()).toBeGreaterThanOrEqual(449);
    expect(await redis.get(keys[0])).toBeNull(); expect(await redis.get(keys[1])).toBeNull();
    expect(await redis.get(keys[2])).toBe('20');
  });
});

import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../common/prisma.service';
import { UserService } from './user.service';
import { UserController } from './user.controller';

const suite = process.env.RUN_USER_SOCIAL_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated social graph SQL and HTTP', () => {
  let db: PrismaService, service: UserService, app: any, base: string, ids: number[] = [], categoryId: number;
  const prefix = 'social_' + randomUUID().slice(0, 8), secret = 'isolated-social-fixture-access-secret-32', oldSecret = process.env.JWT_ACCESS_SECRET;
  let token: string;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw new Error('Refusing non-fixture database');
    process.env.JWT_ACCESS_SECRET = secret;
    db = new PrismaService(); await db.$connect(); service = new UserService(db);
    for (let n = 0; n < 5; n++) ids.push((await db.user.create({ data: { username: prefix + n, email: prefix + n + '@example.test', password: 'fixture-disabled-login' } })).id);
    await db.user.update({ where: { id: ids[4] }, data: { status: 'BANNED' } });
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    await db.post.createMany({ data: ['APPROVED', 'PENDING'].map((status: 'APPROVED' | 'PENDING') => ({ userId: ids[1], categoryId, title: prefix, content: 'fixture only', status })) });
    app = (await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [UserController], providers: [
      { provide: UserService, useValue: service }, { provide: PrismaService, useValue: db },
    ] }).compile()).createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
    token = new JwtService().sign({ sub: ids[0], role: 'ADMIN', authVersion: 0 }, { secret, expiresIn: '10m' });
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    if (db) { if (categoryId) await db.category.delete({ where: { id: categoryId } }); if (ids.length) await db.user.deleteMany({ where: { id: { in: ids } } }); await db.$disconnect(); }
    if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret;
  });
  const call = (path: string, method = 'GET', body?: any, auth = true) => fetch(base + '/api/users/' + path, {
    method, headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  test('parallel repeated follow commits one edge and one notification, followed by idempotent cancellation', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => service.followUser(ids[0], ids[1])));
    expect(results.every(value => value.isFollowing)).toBe(true);
    expect(await db.follow.count({ where: { followerId: ids[0], followingId: ids[1] } })).toBe(1);
    expect(await db.notification.count({ where: { userId: ids[1], type: 'FOLLOW', relatedId: ids[0] } })).toBe(1);
    await Promise.all(Array.from({ length: 4 }, () => service.unfollowUser(ids[0], ids[1])));
    expect(await db.follow.count({ where: { followerId: ids[0], followingId: ids[1] } })).toBe(0);
  });
  test('public counts and cursor lists have correct graph direction and never disclose private/disabled records', async () => {
    await db.follow.createMany({ data: [
      { followerId: ids[0], followingId: ids[1] }, { followerId: ids[2], followingId: ids[1] },
      { followerId: ids[3], followingId: ids[1] }, { followerId: ids[4], followingId: ids[1] },
      { followerId: ids[1], followingId: ids[0] },
    ], skipDuplicates: true });
    const profile = await service.getUserProfile(ids[1], ids[0]);
    expect(profile._count).toEqual({ posts: 1, followers: 3, following: 1 }); expect(profile.isFollowing).toBe(true);
    const first = await service.getUserFollowers(ids[1], { limit: 2 }, ids[0]);
    expect(first.data).toHaveLength(2); expect(first.hasMore).toBe(true);
    const second = await service.getUserFollowers(ids[1], { limit: 2, cursor: first.nextCursor! }, ids[0]);
    expect([...first.data, ...second.data].map(row => row.id).sort()).toEqual([ids[0], ids[2], ids[3]].sort());
    expect(first.data.every(person => !('email' in person) && !('password' in person) && !('role' in person))).toBe(true);
    expect((await service.getUserFollowing(ids[1])).data.map(row => row.id)).toEqual([ids[0]]);
  });
  test('HTTP validates ids/page limits, defaults to bounded public responses and requires current active account for mutation', async () => {
    expect((await call('not-a-number')).status).toBe(400);
    expect((await call(ids[1] + '/followers?limit=51', 'GET', undefined, false)).status).toBe(400);
    const publicPage = await call(ids[1] + '/following', 'GET', undefined, false);
    expect(publicPage.status).toBe(200); const publicData: any = await publicPage.json();
    expect(publicData.data ?? publicData).toHaveProperty('hasMore');
    expect((await call(ids[1] + '/follow', 'POST', undefined, false)).status).toBe(401);
    expect((await call(ids[4] + '/follow', 'POST')).status).toBe(404);
    expect((await call('profile', 'PUT', { role: 'ADMIN' })).status).toBe(400);
    await db.user.update({ where: { id: ids[0] }, data: { status: 'BANNED' } });
    expect((await call(ids[1] + '/follow', 'POST')).status).toBe(401);
    await expect(service.followUser(ids[0], ids[1])).rejects.toMatchObject({ status: 403 });
  });
});

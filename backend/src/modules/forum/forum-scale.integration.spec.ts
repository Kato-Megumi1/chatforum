import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { ForumService } from './forum.service';
import { ForumSnapshotService } from './forum-snapshot.service';
import { ForumDiscoveryService } from './forum-discovery.service';
import { ForumReceiptCleanupService } from './forum-receipt-cleanup.service';
import { ForumController } from './forum.controller';
import { Test } from '@nestjs/testing';
import { JwtModule } from '@nestjs/jwt';
import { ValidationPipe } from '@nestjs/common';

const suite = process.env.RUN_FORUM_SCALE_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated scalable forum SQL and HTTP contracts (10,000 synthetic posts)', () => {
  let db: PrismaService, redis: RedisService, service: ForumService, snapshots: ForumSnapshotService, app: any, base: string;
  let owner: number, categoryId: number, publicIds: number[], pendingId: number, oldId: number;
  const prefix = 'scale_' + randomUUID().slice(0, 10), tagIds: number[] = [];
  const oldSecret = process.env.JWT_ACCESS_SECRET;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' ||
      process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386' || process.env.REDIS_PASSWORD) throw Error('Refusing non-fixture DB or Redis');
    process.env.JWT_ACCESS_SECRET = 'forum-scale-isolated-secret-at-least-32';
    db = new PrismaService(); await db.$connect(); redis = new RedisService(); redis.onModuleInit();
    snapshots = new ForumSnapshotService(db, redis); service = new ForumService(db, snapshots);
    owner = (await db.user.create({ data: { username: prefix, email: prefix + '@example.test', password: 'disabled-fixture' } })).id;
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    const at = Date.now() - 20 * 86400000;
    for (let start = 0; start < 10000; start += 500) await db.post.createMany({ data: Array.from({ length: 500 }, (_, n) => {
      const i = start + n; return { title: prefix + '_' + i, content: 'synthetic fixture only', contentFormat: 'plain', categoryId, userId: owner,
        status: 'APPROVED' as const, createdAt: new Date(at + Math.floor(i / 3) * 1000) };
    }) });
    publicIds = (await db.post.findMany({ where: { categoryId }, orderBy: { id: 'asc' }, select: { id: true } })).map(p => p.id);
    pendingId = (await db.post.create({ data: { title: 'pending fixture', content: 'not public', categoryId, userId: owner, status: 'PENDING' } })).id;
    oldId = (await db.post.create({ data: { title: 'old fixture', content: 'old fixture', categoryId, userId: owner, status: 'APPROVED', createdAt: new Date('2020-01-01T00:00:00Z') } })).id;
    for (let n = 0; n < 36; n++) {
      const tag = await db.tag.create({ data: { name: prefix + '_' + String(n).padStart(2, '0') } }); tagIds.push(tag.id);
      await db.postTag.create({ data: { tagId: tag.id, postId: n === 35 ? pendingId : publicIds[n] } });
    }
    await db.postTag.createMany({ data: [1, 2, 3].map(n => ({ tagId: tagIds[0], postId: publicIds[n] })) });
    app = (await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [ForumController], providers: [
      { provide: ForumService, useValue: service }, { provide: PrismaService, useValue: db },
    ] }).compile()).createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  }, 120000);
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      if (categoryId) await db.category.delete({ where: { id: categoryId } });
      await db.tag.deleteMany({ where: { id: { in: tagIds } } });
      if (owner) await db.user.delete({ where: { id: owner } });
      await db.$disconnect();
    }
    if (redis) await redis.getClient().quit();
    if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret;
  }, 120000);
  const call = (path: string) => fetch(base + '/api/forum/' + path);
  test('latest seek/replay fixes insertion bounds, stable equal-time order and all-history scope without mandatory totals', async () => {
    const query = { categoryId, limit: 7 }, first = await service.getFeed(query);
    expect(first.data).toHaveLength(7); expect(first.total).toBeNull(); expect(first.hasMore).toBe(true);
    const inserted = await db.post.create({ data: { title: 'new backdated insertion', content: 'fixture only', categoryId, userId: owner,
      status: 'APPROVED', createdAt: new Date(Date.now() - 21 * 86400000) } });
    const replay = await service.getFeed({ ...query, cursor: first.pageCursor });
    expect(replay.data.map(p => p.id)).toEqual(first.data.map(p => p.id)); expect(replay.asOf).toBe(first.asOf);
    const second = await service.getFeed({ ...query, cursor: first.nextCursor });
    expect(second.data).toHaveLength(7); expect(second.data.some(p => first.data.some(old => old.id === p.id))).toBe(false);
    expect(second.data.some(p => p.id === inserted.id)).toBe(false);
    const oldest = await service.getFeed({ categoryId, sortOrder: 'asc', limit: 2 }); expect(oldest.data[0].id).toBe(oldId);
    for (const params of [{ categoryId: categoryId + 1 }, { sortOrder: 'asc' as const }, { limit: 8 }, { search: 'changed' }])
      await expect(service.getFeed({ ...query, ...params, cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
    await db.post.update({ where: { id: second.data[0].id }, data: { status: 'REJECTED' } });
    const hidden = await service.getFeed({ ...query, cursor: first.nextCursor }); expect(hidden.data.some(p => p.id === second.data[0].id)).toBe(false);
    expect(first.data.every(p => !('content' in p) && p.summary.length <= 240)).toBe(true);
  });
  test('tags aggregate only public counts; options seek names without exposing pending tags/associations', async () => {
    const tags = await service.getTags(); expect(tags.length).toBeLessThanOrEqual(30);
    const all = await service.getTags(100), ranked = all.find(t => t.id === tagIds[0]); expect(ranked.count).toBe(4);
    expect(all.some(t => t.id === tagIds[35])).toBe(false); expect(all.every(t => !('posts' in t))).toBe(true);
    let cursor: string | null = null; const found: number[] = [];
    do {
      const page = await service.getTagOptions({ q: prefix, limit: 10, ...(cursor ? { cursor } : {}) });
      found.push(...page.data.map(t => t.id)); expect(page.data.every(t => !('count' in t) && !('posts' in t))).toBe(true); cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(tagIds.slice(0, 35)); expect(new Set(found).size).toBe(35);
    expect((await service.getTagOptions({ q: "%' OR 1=1 --" })).data).toEqual([]);
  });
  test('view receipt miss remains concurrent-safe; hits use no transaction and hidden posts fail closed', async () => {
    const id = publicIds[10], counted = await Promise.all(Array.from({ length: 6 }, () => service.recordView(id, owner)));
    expect(counted.filter(r => r.counted)).toHaveLength(1);
    const spy = jest.spyOn(db, '$transaction');
    try {
      expect((await service.recordView(id, owner)).counted).toBe(false); expect(spy).not.toHaveBeenCalled();
      await db.post.update({ where: { id }, data: { status: 'REJECTED' } });
      await expect(service.recordView(id, owner)).rejects.toMatchObject({ status: 404 }); expect(spy).not.toHaveBeenCalled();
      await db.post.update({ where: { id }, data: { status: 'APPROVED' } });
    } finally { spy.mockRestore(); }
    await db.postViewReceipt.updateMany({ where: { postId: id }, data: { viewedAt: new Date(Date.now() - 31 * 60000) } });
    const repeated = await Promise.all(Array.from({ length: 4 }, () => service.recordView(id, owner)));
    expect(repeated.filter(r => r.counted)).toHaveLength(1);
  });
  test('cleanup removes only a bounded expired receipt batch, retaining recent receipts and all post content', async () => {
    const id = publicIds[11], old = new Date('2000-01-01T00:00:00Z'), cleanupAt = new Date('2000-01-04T00:00:00Z'), before = await db.post.count({ where: { categoryId } });
    await db.postViewReceipt.createMany({ data: Array.from({ length: 510 }, (_, n) => ({ postId: id, viewerHash: String(n).padStart(64, '0'), viewedAt: old })) });
    await db.postViewReceipt.create({ data: { postId: id, viewerHash: 'f'.repeat(64), viewedAt: new Date() } });
    const cleanup = new ForumReceiptCleanupService(db);
    expect(await cleanup.cleanupExpired(cleanupAt)).toBe(500);
    expect(await db.postViewReceipt.count({ where: { postId: id } })).toBe(11);
    expect(await cleanup.cleanupExpired(cleanupAt)).toBe(10);
    expect(await db.postViewReceipt.count({ where: { postId: id } })).toBe(1); expect(await db.post.count({ where: { categoryId } })).toBe(before);
    cleanup.onModuleDestroy();
  });
  test('web and Agent share snapshot metrics after new interactions while status is still rechecked', async () => {
    const p = await db.post.create({ data: { title: 'snapshot metrics', content: 'fixture only', categoryId, userId: owner, status: 'APPROVED', likeCount: 5 } });
    const web = await service.getFeed({ sort: 'hot', hotPeriod: 'today', categoryId, limit: 2 });
    expect(web.snapshot.mode).toBe('shared_top_200'); expect(web.data[0].id).toBe(p.id); expect(web.data[0].viewCount).toBe(0);
    await service.recordView(p.id, owner);
    await db.post.update({ where: { id: p.id }, data: { likeCount: 7 } });
    const replay = await service.getFeed({ sort: 'hot', hotPeriod: 'today', categoryId, limit: 2, cursor: web.pageCursor });
    const agent = await new ForumDiscoveryService(db, snapshots).hot({ hours: 24, categoryId, limit: 2 }, { userId: owner });
    expect(replay.snapshot.id).toBe(web.snapshot.id); expect(agent.snapshot.id).toBe(web.snapshot.id);
    expect(replay.data[0]).toMatchObject({ viewCount: 0, likeCount: 5 }); expect(agent.posts[0]).toMatchObject({ viewCount: 0, likeCount: 5 });
    expect(replay.metricsAsOf).toBe(agent.asOf);
    await db.post.update({ where: { id: p.id }, data: { status: 'REJECTED' } });
    expect((await service.getFeed({ sort: 'hot', hotPeriod: 'today', categoryId, limit: 2, cursor: web.pageCursor })).data).toEqual([]);
    expect((await new ForumDiscoveryService(db, snapshots).hot({ hours: 24, categoryId, limit: 2 }, { userId: owner })).posts).toEqual([]);
  });
  test('actual HTTP validates new routes/limits/cursors and preserves legacy array/optional-count shape', async () => {
    const feed = await (await call(`feed?categoryId=${categoryId}&limit=3`)).json();
    expect(feed.data.data).toHaveLength(3); expect(feed.data.total).toBeNull(); expect(feed.data.pageCursor).toBeTruthy();
    expect((await call('feed?sort=likes')).status).toBe(400); expect((await call('feed?cursor=tampered')).status).toBe(400);
    expect((await call('tags?limit=101')).status).toBe(400); expect((await call('tag-options?limit=31')).status).toBe(400);
    expect(Array.isArray((await (await call('tags')).json()).data)).toBe(true);
    const options = await (await call(`tag-options?q=${prefix}&limit=3`)).json(); expect(options.data.data).toHaveLength(3); expect(options.data.nextCursor).toBeTruthy();
    const likes = await (await call(`posts?categoryId=${categoryId}&sort=likes&includeTotal=false`)).json();
    expect(likes.data.total).toBeNull(); expect(likes.data.totalPages).toBeNull();
    const filteredHot = await (await call(`feed?categoryId=${categoryId}&sort=hot&hotPeriod=all&search=synthetic`)).json();
    expect(filteredHot.data.snapshot.paging).toBe('first_page_only'); expect(filteredHot.data.nextCursor).toBeNull();
  });
  test('EXPLAIN ANALYZE reports actual deep OFFSET vs indexed seek rows on 10,000 synthetic posts', async () => {
    const [anchor] = await db.$queryRaw<Array<{ id: number; createdAt: Date }>>(Prisma.sql`SELECT p.id,p.createdAt FROM posts p
      WHERE p.status='APPROVED' AND p.categoryId=${categoryId} ORDER BY p.createdAt DESC,p.id DESC LIMIT 1 OFFSET 8999`);
    const offset = await db.$queryRaw<Array<{ EXPLAIN: string }>>(Prisma.sql`EXPLAIN ANALYZE SELECT p.id FROM posts p
      WHERE p.status='APPROVED' AND p.categoryId=${categoryId} ORDER BY p.createdAt DESC,p.id DESC LIMIT 20 OFFSET 9000`);
    const seek = await db.$queryRaw<Array<{ EXPLAIN: string }>>(Prisma.sql`EXPLAIN ANALYZE SELECT p.id FROM posts p
      WHERE p.status='APPROVED' AND p.categoryId=${categoryId} AND (p.createdAt<${anchor.createdAt} OR (p.createdAt=${anchor.createdAt} AND p.id<${anchor.id}))
      ORDER BY p.createdAt DESC,p.id DESC LIMIT 20`);
    const global = await db.$queryRaw<Array<{ EXPLAIN: string }>>`EXPLAIN ANALYZE SELECT p.id FROM posts p
      WHERE p.status='APPROVED' ORDER BY p.createdAt DESC,p.id DESC LIMIT 20`;
    const offsetPlan = String(Object.values(offset[0])[0]), seekPlan = String(Object.values(seek[0])[0]), globalPlan = String(Object.values(global[0])[0]);
    expect(offsetPlan).toContain('actual time='); expect(seekPlan).toContain('actual time=');
    expect(seekPlan).toContain('posts_status_categoryId_createdAt_id_idx'); expect(globalPlan).toContain('posts_status_createdAt_id_idx');
    console.info('SYNTHETIC_FORUM_PLAN offset9000\n' + offsetPlan + '\nseekSameAnchor\n' + seekPlan + '\nglobalLatest\n' + globalPlan);
  }, 30000);
});

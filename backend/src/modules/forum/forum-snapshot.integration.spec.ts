import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { ForumSnapshotService } from './forum-snapshot.service';
import { ForumDiscoveryService } from './forum-discovery.service';
import { ForumHotWorkerService } from './forum-hot-worker.service';

const suite = process.env.RUN_FORUM_DISCOVERY_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated SQL/Redis shared hot snapshots', () => {
  let db: PrismaService, redis: RedisService, service: ForumSnapshotService, worker: ForumHotWorkerService, owner: number, categoryId: number;
  const cacheKeys = new Set<string>();
  const priorFlag = process.env.FORUM_HOT_PRECOMPUTE_ENABLED;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test'
      || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386'
      || process.env.REDIS_PASSWORD) throw Error('Refusing non-fixture SQL/Redis');
    db = new PrismaService(); await db.$connect(); redis = new RedisService(); redis.onModuleInit();
    process.env.FORUM_HOT_PRECOMPUTE_ENABLED = 'true';
    await redis.getClient().ping(); worker = new ForumHotWorkerService(db, redis); service = new ForumSnapshotService(db, redis, worker);
    const name = 'snapshot_fixture_' + randomUUID();
    owner = (await db.user.create({ data: { username: name, email: name + '@example.test', password: 'disabled-fixture' } })).id;
    categoryId = (await db.category.create({ data: { name: name } })).id;
  });
  afterAll(async () => {
    if (redis) {
      if (categoryId) {
        const hash = worker.scopeKey({ hours: 168, categoryId, rankingBasis: 'published' });
        for (const key of await redis.getClient().keys('forum:hot:v2:{' + hash + '}:*')) cacheKeys.add(key);
      }
      for (const key of cacheKeys) await redis.del(key);
      await redis.getClient().quit();
    }
    if (db) {
      if (categoryId) await db.forumReadModelState.deleteMany({ where: { key: 'hot:v2:' + worker.scopeKey({ hours: 168, categoryId, rankingBasis: 'published' }) } });
      if (categoryId) await db.category.delete({ where: { id: categoryId } });
      if (owner) await db.user.delete({ where: { id: owner } });
      await db.$disconnect();
    }
    if (priorFlag === undefined) delete process.env.FORUM_HOT_PRECOMPUTE_ENABLED; else process.env.FORUM_HOT_PRECOMPUTE_ENABLED = priorFlag;
  });

  test('true full-set SQL ranking, cross-instance generation, bounded coverage and live moderation checks', async () => {
    await db.post.createMany({ data: Array.from({ length: 210 }, (_, i) => ({ categoryId, userId: owner,
      title: '虚构候选' + i, content: '仅用于隔离测试，不是真实论坛内容。', status: 'APPROVED' as const,
      createdAt: new Date(Date.now() - 3600000), likeCount: i })) });
    const winner = await db.post.create({ data: { categoryId, userId: owner, title: '排在任意候选池之外的榜首',
      content: '仅虚构集成测试。', status: 'APPROVED', createdAt: new Date(Date.now() - 3600000), likeCount: 100000 } });
    await db.post.create({ data: { categoryId, userId: owner, title: '不得泄露的下架帖', content: '虚构。',
      status: 'REJECTED', likeCount: 999999, createdAt: new Date(Date.now() - 3600000) } });
    await worker.publishScope({ hours: 168, categoryId, rankingBasis: 'published' });
    const filters = { hours: 168, categoryId }, first = await service.hot(filters, { limit: 20 });
    expect(first.rows[0].id).toBe(winner.id); expect(first.snapshot.rankedCount).toBe(200);
    expect(first.snapshot.hasMoreBeyondCoverage).toBe(true);
    const other = new ForumSnapshotService(db, redis);
    const resumed = await other.hot(filters, { limit: 20, snapshotId: first.snapshot.id });
    expect(resumed.snapshot.id).toBe(first.snapshot.id); expect(resumed.asOf).toEqual(first.asOf);
    await db.post.update({ where: { id: winner.id }, data: { status: 'REJECTED' } });
    const withdrawn = await other.hot(filters, { limit: 20, snapshotId: first.snapshot.id });
    expect(withdrawn.rows.some(row => row.id === winner.id)).toBe(false); expect(withdrawn.snapshot.removedCount).toBe(1);
    const page2 = await other.hot(filters, { limit: 20, offset: 20, snapshotId: first.snapshot.id });
    expect(page2.rows.map(row => row.id).some(id => first.rows.some(row => row.id === id))).toBe(false);
    const last = await other.hot(filters, { limit: 50, offset: 150, snapshotId: first.snapshot.id });
    expect(last.hasMore).toBe(false); expect(last.snapshot.hasMoreBeyondCoverage).toBe(true);
    expect(last).not.toHaveProperty('total');
  });

  test('Agent shares the public snapshot but not checkpoints; category edits cannot escape current filtering', async () => {
    const first = await service.hot({ hours: 168, categoryId }, { limit: 2 });
    const discovery = new ForumDiscoveryService(db, new ForumSnapshotService(db, redis));
    const result = await discovery.hot({ hours: 168, categoryId, limit: 2 }, { userId: owner });
    expect(result.asOf).toBe(first.asOf.toISOString()); expect(result.snapshot.id).toBe(first.snapshot.id);
    expect(result.posts.map(post => post.id)).toEqual(first.rows.map(post => post.id));
    expect(result.comparison.status).toBe('unavailable');
    const moved = first.rows[0].id, otherCategory = await db.category.create({ data: { name: 'snapshot_moved_' + randomUUID() } });
    try {
      await db.post.update({ where: { id: moved }, data: { categoryId: otherCategory.id } });
      const checked = await service.hot({ hours: 168, categoryId }, { limit: 2, snapshotId: first.snapshot.id });
      expect(checked.rows.some(row => row.id === moved)).toBe(false);
    } finally {
      await db.post.update({ where: { id: moved }, data: { categoryId } });
      await db.category.delete({ where: { id: otherCategory.id } });
    }
  });
});

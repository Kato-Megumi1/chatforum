import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { ForumViewAggregationService } from './forum-view-aggregation.service';
import { ForumInteractionProjectionService } from './forum-interaction-projection.service';
import { ForumHotWorkerService } from './forum-hot-worker.service';
import { ForumSnapshotService } from './forum-snapshot.service';

const suite = process.env.RUN_FORUM_INCREMENTAL_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated Redis view batches, hourly net deltas and precomputed heat', () => {
  let db: PrismaService, client: Redis, events: ForumEventsService, aggregation: ForumViewAggregationService, hot: ForumHotWorkerService;
  let owner: number, categoryId: number;
  const postIds: number[] = [], stateKeys: string[] = [], scopes: any[] = [];
  const oldViewFlag = process.env.FORUM_VIEW_AGGREGATION_ENABLED, oldHotFlag = process.env.FORUM_HOT_PRECOMPUTE_ENABLED;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test'
      || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '36386' || process.env.REDIS_PASSWORD) throw Error('Refusing non-fixture SQL/Redis');
    process.env.FORUM_VIEW_AGGREGATION_ENABLED = 'true'; process.env.FORUM_HOT_PRECOMPUTE_ENABLED = 'true';
    db = new PrismaService(); await db.$connect();
    // Dedicated fixture Redis logical DB: never shares a production namespace.
    client = new Redis({ host: '127.0.0.1', port: 36386, db: 13, enableOfflineQueue: false, retryStrategy: () => null });
    await new Promise<void>((resolve, reject) => { client.once('ready', resolve); client.once('error', reject); });
    const redis = { getClient: () => client, get: (key: string) => client.get(key) };
    events = new ForumEventsService(db); aggregation = new ForumViewAggregationService(db, redis as any, events); hot = new ForumHotWorkerService(db, redis as any);
    const suffix = randomUUID(); owner = (await db.user.create({ data: { username: 'incremental_' + suffix, email: suffix + '@example.test', password: 'disabled-fixture' } })).id;
    categoryId = (await db.category.create({ data: { name: 'incremental_' + suffix } })).id;
    const projection = new ForumInteractionProjectionService();
    events.register('forum-projections-v1', (event, context) => context.transaction(tx => projection.projectInTransaction(tx, event)));
  });
  afterAll(async () => {
    events?.onModuleDestroy();
    if (db) {
      await db.forumInteractionBucket.deleteMany({ where: { postId: { in: postIds } } });
      await db.forumViewBatch.deleteMany({ where: { postId: { in: postIds } } });
      await db.forumEvent.deleteMany({ where: { postId: { in: postIds } } });
      await db.forumReadModelState.deleteMany({ where: { key: { in: stateKeys } } });
      if (owner) await db.user.delete({ where: { id: owner } }); if (categoryId) await db.category.delete({ where: { id: categoryId } }); await db.$disconnect();
    }
    if (client) {
      const keys = [...await client.keys('forum:views:v1:*')];
      for (const scope of scopes) keys.push(...await client.keys('forum:hot:v2:{' + hot.scopeKey(scope) + '}:*'));
      if (keys.length) await client.del(...new Set(keys)); await client.quit();
    }
    if (oldViewFlag === undefined) delete process.env.FORUM_VIEW_AGGREGATION_ENABLED; else process.env.FORUM_VIEW_AGGREGATION_ENABLED = oldViewFlag;
    if (oldHotFlag === undefined) delete process.env.FORUM_HOT_PRECOMPUTE_ENABLED; else process.env.FORUM_HOT_PRECOMPUTE_ENABLED = oldHotFlag;
  });
  const createPost = async (data: any = {}) => { const post = await db.post.create({ data: { userId: owner, categoryId, title: '虚构增量测试', content: '只用于隔离测试。', status: 'APPROVED', ...data } }); postIds.push(post.id); return post; };
  const scope = (rankingBasis: 'published' | 'interaction') => { const value = { hours: 24 as const, categoryId, rankingBasis }; scopes.push(value); stateKeys.push('hot:v2:' + hot.scopeKey(value)); return value; };
  // Deliver only this test's event: does not globally claim/ACK another fixture's work.
  const deliverOwn = async (event: any) => {
    const token = randomUUID(); await db.forumEventDelivery.update({ where: { eventId_consumer: { eventId: event.id, consumer: 'forum-projections-v1' } },
      data: { state: 'PROCESSING', leaseToken: token, leaseUntil: new Date(Date.now() + 60000), attempts: { increment: 1 } } });
    await (events as any).deliver({ event, consumer: 'forum-projections-v1', token, attempts: 1 });
  };
  test('parallel viewers dedupe, crash after DB commit/reclaim cannot increment or append twice', async () => {
    const post = await createPost(), results = await Promise.all(Array.from({ length: 16 }, () => aggregation.record(post.id, 'signed-fixture-viewer')));
    expect(results.filter(result => result.counted)).toHaveLength(1); expect((await db.post.findUnique({ where: { id: post.id } })).viewCount).toBe(0);
    const ack = jest.spyOn(client, 'xack').mockRejectedValueOnce(Error('simulated crash before Redis ACK'));
    await aggregation.flushOnce(); ack.mockRestore();
    expect((await db.post.findUnique({ where: { id: post.id } })).viewCount).toBe(1);
    expect(await db.forumViewBatch.count({ where: { postId: post.id } })).toBe(1);
    const stream = `forum:views:v1:{${post.id % 32}}:batches`, pending = await client.xpending(stream, 'forum-view-db-v1', '-', '+', 100) as any[];
    expect(pending).toHaveLength(1); await client.call('XCLAIM', stream, 'forum-view-db-v1', 'crashed-worker', 0, pending[0][0], 'IDLE', 61000);
    await aggregation.flushOnce(); expect((await db.post.findUnique({ where: { id: post.id } })).viewCount).toBe(1);
    expect(await db.forumEvent.count({ where: { postId: post.id, kind: 'VIEW_AGGREGATED' } })).toBe(1);
    expect(await client.xlen(stream)).toBe(0);
    const event = await db.forumEvent.findFirst({ where: { postId: post.id, kind: 'VIEW_AGGREGATED' } }); await deliverOwn(event);
    const bucket = await db.forumInteractionBucket.findFirst({ where: { postId: post.id } }); expect(bucket.viewDelta).toBe(1n);
    const completed = await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: 'forum-projections-v1' } } }); expect(completed.state).toBe('COMPLETED');
    // Stale delivery lease cannot apply the same delta after its DB ACK.
    await (events as any).deliver({ event, consumer: 'forum-projections-v1', token: randomUUID(), attempts: 1 });
    expect((await db.forumInteractionBucket.findFirst({ where: { postId: post.id } })).viewDelta).toBe(1n);
  });
  test('durable signed like/comment deltas and their ACK commit atomically', async () => {
    const post = await createPost();
    for (const delta of [{ likes: 1, comments: 1 }, { likes: -1, comments: -1 }]) {
      const event = await db.$transaction(tx => events.append(tx, { kind: 'INTERACTION_CHANGED', postId: post.id, postRevision: post.revision, payload: { delta } })); await deliverOwn(event);
    }
    const bucket = await db.forumInteractionBucket.findFirst({ where: { postId: post.id } }); expect(bucket).toMatchObject({ likeDelta: 0, commentDelta: 0, viewDelta: 0n });
  });
  test('both bases publish separately, old posts revive only via real recent interaction and decay/expire naturally', async () => {
    const old = await createPost({ createdAt: new Date(Date.now() - 30 * 86400000), likeCount: 1000000 });
    const recent = await createPost({ createdAt: new Date(Date.now() - 3600000), likeCount: 2 });
    const hour = new Date(Math.floor(Date.now() / 3600000) * 3600000);
    await db.forumInteractionBucket.create({ data: { postId: old.id, hour, viewDelta: 10, likeDelta: 10 } });
    const interaction = scope('interaction'), published = scope('published'); await hot.publishScope(interaction); await hot.publishScope(published);
    const snapshot = new ForumSnapshotService(db, undefined, hot), revived = await snapshot.hot(interaction, { limit: 20 });
    expect(revived.rows.map(row => row.id)).toContain(old.id); expect(revived.rows.find(row => row.id === old.id)).toMatchObject({ windowLikes: 10, likeCount: 1000000 });
    expect((await snapshot.hot(published, { limit: 20 })).rows.map(row => row.id)).not.toContain(old.id);
    expect((await snapshot.hot(published, { limit: 20 })).rows.map(row => row.id)).toContain(recent.id);
    const now = new Date(), rankedNow = await (hot as any).rank(interaction, now), rankedLater = await (hot as any).rank(interaction, new Date(now.getTime() + 3600000));
    expect(Number(rankedLater.find(row => row.id === old.id).score)).toBeLessThan(Number(rankedNow.find(row => row.id === old.id).score));
    expect(await (hot as any).rank(interaction, new Date(now.getTime() + 8 * 86400000))).toEqual([]);
    await db.post.update({ where: { id: old.id }, data: { status: 'REJECTED' } });
    const hidden = await snapshot.hot(interaction, { limit: 20, snapshotId: revived.snapshot.id }); expect(hidden.rows.map(row => row.id)).not.toContain(old.id); expect(hidden.snapshot.removedCount).toBe(1);
  });
});

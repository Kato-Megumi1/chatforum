import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumService } from './forum.service';

const suite = process.env.RUN_FORUM_INCREMENTAL_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated durable forum writes and subscription fan-out', () => {
  let db: PrismaService, events: ForumEventsService, subscriptions: ForumSubscriptionsService, forum: ForumService;
  let owner: number, watcher: number, other: number, third: number, categoryId: number;
  const userIds: number[] = [], postIds: number[] = [], suffix = randomUUID();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture database');
    db = new PrismaService(); await db.$connect(); events = new ForumEventsService(db);
    subscriptions = new ForumSubscriptionsService(db, events); subscriptions.onModuleInit(); forum = new ForumService(db, undefined, events);
    categoryId = (await db.category.create({ data: { name: 'watch_fixture_' + suffix } })).id;
    for (let i = 0; i < 4; i++) userIds.push((await db.user.create({ data: { username: 'watch_' + suffix + '_' + i, email: suffix + '_' + i + '@example.test', password: 'disabled-fixture' } })).id);
    [owner, watcher, other, third] = userIds;
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (db) { await db.forumSubscription.deleteMany({ where: { userId: { in: userIds } } }); await db.user.updateMany({ where: { id: { in: userIds } }, data: { status: 'ACTIVE' } }); }
  });
  afterAll(async () => {
    events?.onModuleDestroy();
    if (db) {
      await db.forumEvent.deleteMany({ where: { postId: { in: postIds } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      if (categoryId) await db.category.delete({ where: { id: categoryId } }); await db.$disconnect();
    }
  });
  const post = async (title = '虚构订阅帖子') => { const row = await db.post.create({ data: { userId: owner, categoryId, title, content: '只有虚构内容。', status: 'APPROVED' } }); postIds.push(row.id); return row; };
  const append = async (row: any, kind = 'POST_PUBLISHED', data: any = {}) => db.$transaction(tx => events.append(tx, { kind, postId: row.id, postRevision: row.revision,
    actorId: owner, payload: { categoryId, ...data.payload }, occurredAt: data.occurredAt || new Date(), eventKey: data.eventKey }));
  const drain = async () => {
    // Only forum-subscriptions-v1 is registered; coordinated with the search test owner.
    for (let i = 0; i < 20; i++) {
      await events.runBatch(50);
      const pending = await db.forumEventDelivery.findMany({ where: { consumer: 'forum-subscriptions-v1', event: { postId: { in: postIds } }, state: { not: 'COMPLETED' } }, select: { state: true, errorCode: true } });
      if (!pending.length) return;
      if (pending.some(item => item.errorCode)) throw Error('Fixture subscription delivery failed: ' + JSON.stringify(pending));
    }
    throw Error('Fixture subscription continuation did not drain');
  };

  test('source create/update/delete/like/unlike/comment and outbox roll back together', async () => {
    const title = 'atomic_' + suffix;
    const rejectAppend = () => jest.spyOn(events, 'append').mockRejectedValueOnce(Error('synthetic outbox failure'));
    const points = (await db.user.findUnique({ where: { id: owner } })).points;
    rejectAppend(); await expect(forum.createPost(owner, { title, content: '虚构正文', categoryId })).rejects.toThrow('synthetic outbox failure'); jest.restoreAllMocks();
    expect(await db.post.count({ where: { userId: owner, title } })).toBe(0); expect((await db.user.findUnique({ where: { id: owner } })).points).toBe(points);
    const row = await forum.createPost(owner, { title, content: '虚构正文', categoryId }); postIds.push(row.id);
    expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'POST_PUBLISHED' } })).toBe(1);
    rejectAppend(); await expect(forum.updatePost(row.id, owner, { title: '不应保存', expectedRevision: 1 })).rejects.toThrow(); jest.restoreAllMocks();
    expect((await db.post.findUnique({ where: { id: row.id } })).revision).toBe(1);
    await forum.updatePost(row.id, owner, { title: '原子更新', expectedRevision: 1 }); expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'POST_UPDATED' } })).toBe(1);
    rejectAppend(); await expect(forum.likePost(row.id, watcher)).rejects.toThrow(); jest.restoreAllMocks();
    expect(await db.like.count({ where: { postId: row.id } })).toBe(0); expect((await db.post.findUnique({ where: { id: row.id } })).likeCount).toBe(0);
    await forum.likePost(row.id, watcher); await forum.likePost(row.id, watcher); expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'POST_LIKED' } })).toBe(1);
    rejectAppend(); await expect(forum.unlikePost(row.id, watcher)).rejects.toThrow(); jest.restoreAllMocks(); expect(await db.like.count({ where: { postId: row.id } })).toBe(1);
    await forum.unlikePost(row.id, watcher); await forum.unlikePost(row.id, watcher); expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'POST_UNLIKED' } })).toBe(1);
    rejectAppend(); await expect(forum.createComment(row.id, watcher, { content: '不应保存的评论' })).rejects.toThrow(); jest.restoreAllMocks();
    expect(await db.comment.count({ where: { postId: row.id } })).toBe(0); expect((await db.post.findUnique({ where: { id: row.id } })).commentCount).toBe(0);
    const comment = await forum.createComment(row.id, watcher, { content: '合成评论' }); expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'COMMENT_CREATED' } })).toBe(1);
    rejectAppend(); await expect(forum.deleteComment(comment.id, watcher)).rejects.toThrow(); jest.restoreAllMocks(); expect((await db.comment.findUnique({ where: { id: comment.id } })).status).toBe('ACTIVE');
    await forum.deleteComment(comment.id, watcher); expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'COMMENT_DELETED' } })).toBe(1);
    expect((await db.post.findUnique({ where: { id: row.id } })).commentCount).toBe(0);
    rejectAppend(); await expect(forum.deletePost(row.id, owner)).rejects.toThrow(); jest.restoreAllMocks(); expect(await db.post.findUnique({ where: { id: row.id } })).not.toBeNull();
    await forum.deletePost(row.id, owner); expect(await db.post.findUnique({ where: { id: row.id } })).toBeNull(); expect(await db.forumEvent.count({ where: { postId: row.id, kind: 'POST_DELETED' } })).toBe(1);
  }, 30000);

  test('CRUD rechecks ACTIVE and ownership; another user cannot modify or remove a watch', async () => {
    const created = await subscriptions.create(watcher, { kind: 'NEW_POSTS', categoryId, cooldownSeconds: 60 });
    expect((await subscriptions.list(watcher)).map(item => item.id)).toContain(created.id); expect(await subscriptions.list(other)).toEqual([]);
    await expect(subscriptions.setEnabled(other, created.id, false)).rejects.toMatchObject({ status: 404 });
    await subscriptions.remove(other, created.id); expect(await db.forumSubscription.findUnique({ where: { id: created.id } })).not.toBeNull();
    await db.user.update({ where: { id: watcher }, data: { status: 'BANNED' } });
    for (const operation of [() => subscriptions.list(watcher), () => subscriptions.create(watcher, { kind: 'NEW_POSTS' }),
      () => subscriptions.setEnabled(watcher, created.id, false), () => subscriptions.remove(watcher, created.id)]) await expect(operation()).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: watcher }, data: { status: 'ACTIVE' } }); await subscriptions.remove(watcher, created.id); expect(await subscriptions.list(watcher)).toEqual([]);
  });

  test('re-enabling skips events from the disabled period, not replaying an old backlog', async () => {
    const row = await post(), watch = await subscriptions.create(watcher, { kind: 'NEW_POSTS', categoryId, cooldownSeconds: 60 });
    await db.forumSubscription.update({ where: { id: watch.id }, data: { startedAt: new Date(Date.now() - 10000) } });
    await subscriptions.setEnabled(watcher, watch.id, false); await append(row, 'POST_PUBLISHED', { occurredAt: new Date(Date.now() - 1000) });
    await subscriptions.setEnabled(watcher, watch.id, true); await drain(); expect(await db.forumSubscriptionDelivery.count({ where: { subscriptionId: watch.id } })).toBe(0);
    await append(row, 'POST_PUBLISHED', { occurredAt: new Date(Date.now() + 1000) }); await drain(); expect(await db.forumSubscriptionDelivery.count({ where: { subscriptionId: watch.id } })).toBe(1);
  });

  test('cooldown merges distinct updates; repeated event does not duplicate; hidden targets have no post id', async () => {
    const first = await post(), second = await post(), watch = await subscriptions.create(watcher, { kind: 'NEW_POSTS', categoryId, cooldownSeconds: 3600 });
    const at = new Date((Math.floor(Date.now() / 3600000) + 1) * 3600000 + 10000), key = randomUUID();
    await append(first, 'POST_PUBLISHED', { occurredAt: at, eventKey: key }); await append(second, 'POST_PUBLISHED', { occurredAt: new Date(at.getTime() + 1000) }); await drain();
    const deliveries = await db.forumSubscriptionDelivery.findMany({ where: { subscriptionId: watch.id } }); expect(deliveries).toHaveLength(1); expect(deliveries[0].count).toBe(2);
    await append(first, 'POST_PUBLISHED', { occurredAt: at, eventKey: key }); await drain(); expect((await db.forumSubscriptionDelivery.findUnique({ where: { id: deliveries[0].id } })).count).toBe(2);
    expect(await db.notification.count({ where: { id: deliveries[0].notificationId, userId: watcher } })).toBe(1);
    expect((await subscriptions.notificationTargets(other, [deliveries[0].notificationId])).size).toBe(0);
    await db.post.updateMany({ where: { id: { in: [first.id, second.id] } }, data: { status: 'REJECTED' } });
    expect((await subscriptions.notificationTargets(watcher, [deliveries[0].notificationId])).get(deliveries[0].notificationId)).toBeUndefined();
  });

  test('201+ indexed candidates continue past a full page of keyword false positives', async () => {
    const row = await post('题词 最终命中'), audience = [watcher, other, third], since = new Date(Date.now() - 10000);
    const candidates = Array.from({ length: 201 }, (_, i) => {
      const query = i === 200 ? '题词 最终命中' : '题词 不匹配' + i;
      const filtersJson = { kind: 'NEW_POSTS', categoryId, postId: null, query, hours: null, rankingBasis: null };
      return { userId: audience[i % audience.length], kind: 'NEW_POSTS', categoryId, anchorKey: '题词', startedAt: since, cooldownSeconds: 3600,
        filtersJson, filterKey: createHash('sha256').update(JSON.stringify(filtersJson)).digest('hex') };
    });
    await db.forumSubscription.createMany({ data: candidates }); await append(row); await drain();
    const continuations = await db.forumEvent.findMany({ where: { postId: row.id, kind: 'SUBSCRIPTION_SCAN' } }); expect(continuations).toHaveLength(1);
    const target = await db.forumSubscription.findFirst({ where: { userId: candidates[200].userId, filterKey: candidates[200].filterKey } });
    expect(await db.forumSubscriptionDelivery.count({ where: { subscriptionId: target.id } })).toBe(1);
    expect(await db.forumSubscriptionDelivery.count({ where: { subscription: { userId: { in: audience } } } })).toBe(1);
    expect(await db.forumEventDelivery.count({ where: { eventId: continuations[0].id, consumer: 'forum-subscriptions-v1', state: 'COMPLETED' } })).toBe(1);
  }, 30000);
  test('hot tracking matches its explicit ranking basis/window instead of treating cumulative heat as interaction', async () => {
    const row = await post(), watch = await subscriptions.create(watcher, { kind: 'HOT_RISE', categoryId, hours: 24, rankingBasis: 'interaction', cooldownSeconds: 3600 });
    const payload = { categoryId, hours: 24, rank: 1, previousRank: 10, score: 4, delta: { views: 0, likes: 0, comments: 0 } };
    await append(row, 'HOT_RANK_CHANGED', { occurredAt: new Date(Date.now() + 1000), payload: { ...payload, rankingBasis: 'published' } }); await drain();
    expect(await db.forumSubscriptionDelivery.count({ where: { subscriptionId: watch.id } })).toBe(0);
    await append(row, 'HOT_RANK_CHANGED', { occurredAt: new Date(Date.now() + 2000), payload: { ...payload, rankingBasis: 'interaction' } }); await drain();
    expect(await db.forumSubscriptionDelivery.count({ where: { subscriptionId: watch.id } })).toBe(1);
  });
});

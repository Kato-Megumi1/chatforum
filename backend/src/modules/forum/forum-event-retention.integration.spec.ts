import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { FORUM_EVENT_CONSUMERS } from './forum-events.service';
import { ForumEventRetentionService } from './forum-event-retention.service';

const suite = process.env.RUN_FORUM_INCREMENTAL_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated conservative event retention', () => {
  let db: PrismaService, retention: ForumEventRetentionService, owner: number, categoryId: number, postId: number, notificationId: number;
  let controlExisted = false;
  const batchId = randomUUID(), buildKey = 'forum-search:build:' + randomUUID(), prior = process.env.FORUM_EVENT_RETENTION_ENABLED;
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture database');
    process.env.FORUM_EVENT_RETENTION_ENABLED = 'true'; db = new PrismaService(); await db.$connect(); retention = new ForumEventRetentionService(db);
    controlExisted = !!await db.forumReadModelState.findUnique({ where: { key: 'forum-search:control:v1' } });
    const suffix = randomUUID(); owner = (await db.user.create({ data: { username: 'retention_' + suffix, email: suffix + '@example.test', password: 'disabled-fixture' } })).id;
    categoryId = (await db.category.create({ data: { name: 'retention_' + suffix } })).id;
    postId = (await db.post.create({ data: { userId: owner, categoryId, title: '合成保留策略验收', content: '这不是旧业务数据。', status: 'APPROVED' } })).id;
    notificationId = (await db.notification.create({ data: { userId: owner, type: 'SYSTEM', title: '合成通知', content: '必须保留', relatedId: postId } })).id;
    await db.forumViewBatch.create({ data: { id: batchId, payloadHash: '0'.repeat(64), postId, count: 1, bucketStart: new Date() } });
  });
  afterEach(async () => { if (db) { await db.forumReadModelState.deleteMany({ where: { key: buildKey } }); await db.forumEvent.deleteMany({ where: { postId } }); } });
  afterAll(async () => {
    if (db) {
      await db.forumViewBatch.deleteMany({ where: { id: batchId } });
      if (!controlExisted) { const control = await db.forumReadModelState.findUnique({ where: { key: 'forum-search:control:v1' } }); if (control && !Object.keys(control.payloadJson || {}).length) await db.forumReadModelState.delete({ where: { key: control.key } }); }
      if (owner) await db.user.delete({ where: { id: owner } }); if (categoryId) await db.category.delete({ where: { id: categoryId } }); await db.$disconnect();
    }
    if (prior === undefined) delete process.env.FORUM_EVENT_RETENTION_ENABLED; else process.env.FORUM_EVENT_RETENTION_ENABLED = prior;
  });
  const create = async (ageDays: number, states = ['COMPLETED', 'COMPLETED', 'COMPLETED'], extraPending = false) => {
    const at = new Date(Date.now() - ageDays * 86400000), event = await db.forumEvent.create({ data: { eventKey: randomUUID(), kind: 'RETENTION_FIXTURE', postId, postRevision: 1, payloadJson: {}, occurredAt: at, createdAt: at } });
    await db.forumEventDelivery.createMany({ data: states.map((state, i) => ({ eventId: event.id, consumer: FORUM_EVENT_CONSUMERS[i], state })) });
    if (extraPending) await db.forumEventDelivery.create({ data: { eventId: event.id, consumer: 'extra-fixture', state: 'PENDING' } }); return event;
  };
  test('only old fully-acknowledged events/deliveries are deleted; sources, notifications and receipts remain', async () => {
    const eligible = await create(15), pending = await create(15, ['PENDING', 'COMPLETED', 'COMPLETED']), dead = await create(15, ['COMPLETED', 'DEAD', 'COMPLETED']);
    const recent = await create(1), missing = await create(15, ['COMPLETED', 'COMPLETED']), extra = await create(15, undefined, true);
    expect(await retention.cleanupOnce()).toEqual({ deleted: 1, status: 'cleaned' });
    expect(await db.forumEvent.findUnique({ where: { id: eligible.id } })).toBeNull(); expect(await db.forumEventDelivery.count({ where: { eventId: eligible.id } })).toBe(0);
    for (const event of [pending, dead, recent, missing, extra]) expect(await db.forumEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
    expect(await db.post.findUnique({ where: { id: postId } })).not.toBeNull(); expect(await db.notification.findUnique({ where: { id: notificationId } })).not.toBeNull(); expect(await db.forumViewBatch.findUnique({ where: { id: batchId } })).not.toBeNull();
  });
  test('BUILDING, READY and PUBLISHING all pause cleanup even when eligible events exist', async () => {
    const event = await create(15);
    for (const status of ['BUILDING', 'READY', 'PUBLISHING']) {
      await db.forumReadModelState.upsert({ where: { key: buildKey }, create: { key: buildKey, status, payloadJson: { status } }, update: { status, payloadJson: { status } } });
      expect(await retention.cleanupOnce()).toEqual({ deleted: 0, status: 'build_paused' }); expect(await db.forumEvent.findUnique({ where: { id: event.id } })).not.toBeNull();
    }
  });
  test('501 eligible events require two bounded cleanup transactions, never an unbounded delete', async () => {
    const at = new Date(Date.now() - 15 * 86400000);
    await db.forumEvent.createMany({ data: Array.from({ length: 501 }, () => ({ eventKey: randomUUID(), kind: 'RETENTION_FIXTURE', postId, postRevision: 1, payloadJson: {}, occurredAt: at, createdAt: at })) });
    const events = await db.forumEvent.findMany({ where: { postId }, select: { id: true } });
    await db.forumEventDelivery.createMany({ data: events.flatMap(event => FORUM_EVENT_CONSUMERS.map(consumer => ({ eventId: event.id, consumer, state: 'COMPLETED' }))) });
    expect(await retention.cleanupOnce()).toEqual({ deleted: 500, status: 'cleaned' }); expect(await db.forumEvent.count({ where: { postId } })).toBe(1);
    expect(await retention.cleanupOnce()).toEqual({ deleted: 1, status: 'cleaned' });
  }, 30000);
});

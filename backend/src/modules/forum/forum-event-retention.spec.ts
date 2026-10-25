import { ForumEventRetentionService } from './forum-event-retention.service';
import { FORUM_EVENT_CONSUMERS } from './forum-events.service';

describe('bounded conservative outbox retention', () => {
  const before = process.env.FORUM_EVENT_RETENTION_ENABLED;
  beforeEach(() => { process.env.FORUM_EVENT_RETENTION_ENABLED = 'true'; });
  afterAll(() => { if (before === undefined) delete process.env.FORUM_EVENT_RETENTION_ENABLED; else process.env.FORUM_EVENT_RETENTION_ENABLED = before; });
  function fixture(building = false) {
    const tx = { forumReadModelState: { upsert: jest.fn(), findFirst: jest.fn().mockResolvedValue(building ? { key: 'candidate' } : null) },
      $queryRaw: jest.fn(), forumEvent: { findMany: jest.fn().mockResolvedValue([{ id: 1n }]), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    return { tx, service: new ForumEventRetentionService({ $transaction: (work: any) => work(tx) } as any) };
  }
  test('disabled flag does not touch the database', async () => { process.env.FORUM_EVENT_RETENTION_ENABLED = 'false'; const f = fixture(); expect(await f.service.cleanupOnce()).toMatchObject({ status: 'disabled' }); expect(f.tx.forumReadModelState.upsert).not.toHaveBeenCalled(); });
  test('BUILDING/READY/PUBLISHING pauses cleanup under the same search-control lock', async () => { const f = fixture(true); expect(await f.service.cleanupOnce()).toMatchObject({ status: 'build_paused', deleted: 0 }); expect(f.tx.$queryRaw.mock.calls[0][0].sql).toContain('FOR UPDATE'); expect(f.tx.forumEvent.findMany).not.toHaveBeenCalled(); });
  test('createdAt-index order/take500 and all completed consumers are rechecked before exact-id delete', async () => {
    const f = fixture(), now = new Date('2026-10-14T12:00:00Z'); expect(await f.service.cleanupOnce(now)).toEqual({ deleted: 1, status: 'cleaned' });
    const query = f.tx.forumEvent.findMany.mock.calls[0][0]; expect(query).toMatchObject({ take: 500, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    expect(query.where.createdAt.lt).toEqual(new Date('2026-09-30T12:00:00Z')); expect(query.where.deliveries.every.state).toBe('COMPLETED');
    expect(query.where.AND.map(item => item.deliveries.some.consumer)).toEqual(FORUM_EVENT_CONSUMERS);
    expect(f.tx.forumEvent.deleteMany.mock.calls[0][0].where).toMatchObject({ id: { in: [1n] }, AND: query.where.AND, deliveries: query.where.deliveries });
  });
});

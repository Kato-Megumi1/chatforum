import { ForumViewAggregationService, FORUM_VIEW_RECORD_LUA, FORUM_VIEW_ROTATE_LUA } from './forum-view-aggregation.service';
import { ForumInteractionProjectionService } from './forum-interaction-projection.service';

describe('view intake and hourly projections', () => {
  const before = process.env.FORUM_VIEW_AGGREGATION_ENABLED;
  beforeEach(() => { process.env.FORUM_VIEW_AGGREGATION_ENABLED = 'true'; });
  afterAll(() => { if (before === undefined) delete process.env.FORUM_VIEW_AGGREGATION_ENABLED; else process.env.FORUM_VIEW_AGGREGATION_ENABLED = before; });
  test('intake queues through one Redis Lua call, never touches posts or SQL', async () => {
    const db = { $transaction: jest.fn(), post: { update: jest.fn() } }, client = { status: 'ready', eval: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0) };
    const service = new ForumViewAggregationService(db as any, { getClient: () => client } as any, {} as any);
    expect(await service.record(4, 'signed-viewer')).toMatchObject({ counted: true, status: 'queued', persistence: 'redis_pending' });
    expect(await service.record(4, 'signed-viewer')).toMatchObject({ counted: false, status: 'duplicate' });
    expect(client.eval.mock.calls[0][0]).toBe(FORUM_VIEW_RECORD_LUA); expect(client.eval.mock.calls[0][1]).toBe(3);
    expect(db.$transaction).not.toHaveBeenCalled(); expect(db.post.update).not.toHaveBeenCalled();
    expect(FORUM_VIEW_ROTATE_LUA.indexOf("'XADD'")).toBeLessThan(FORUM_VIEW_ROTATE_LUA.indexOf("'HDEL'")); expect(FORUM_VIEW_ROTATE_LUA).not.toMatch(/XTRIM/);
  });
  test('disabled and Redis failure do not become SQL fallback or a blocking retry loop', async () => {
    const db = { $transaction: jest.fn() }, client = { status: 'ready', eval: jest.fn().mockRejectedValue(Error('private redis password')) };
    const service = new ForumViewAggregationService(db as any, { getClient: () => client } as any, {} as any);
    expect(await service.record(1, 'viewer')).toMatchObject({ status: 'unavailable' });
    expect(await service.record(1, 'viewer')).toMatchObject({ status: 'unavailable' }); expect(client.eval).toHaveBeenCalledTimes(1);
    process.env.FORUM_VIEW_AGGREGATION_ENABLED = 'false'; expect(await service.record(1, 'viewer')).toMatchObject({ status: 'disabled' }); expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('positive and negative interactions remain event-hour deltas, not cumulative fake backfill', async () => {
    const tx = { forumInteractionBucket: { upsert: jest.fn() } }, service = new ForumInteractionProjectionService();
    await service.projectInTransaction(tx as any, { id: 1n, postId: 3, occurredAt: new Date('2026-10-14T11:37:00Z'), payloadJson: { delta: { likes: -1, comments: 2 } } });
    expect(tx.forumInteractionBucket.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { postId: 3, hour: new Date('2026-10-14T11:00:00Z'), viewDelta: 0n, likeDelta: -1, commentDelta: 2 } }));
    await service.projectInTransaction(tx as any, { id: 2n, postId: 3, occurredAt: new Date(), payloadJson: { hour: '2026-10-13T02:00:00Z', delta: { views: 4 } } });
    expect(tx.forumInteractionBucket.upsert.mock.calls[1][0].create).toMatchObject({ hour: new Date('2026-10-13T02:00:00Z'), viewDelta: 4n });
    await expect(service.projectInTransaction(tx as any, { id: 3n, postId: 3, occurredAt: new Date(), payloadJson: { delta: { views: -1 } } })).rejects.toThrow('INVALID_INTERACTION_DELTA');
  });
  test('a timed-out Redis command has bounded intake latency and never falls back to SQL', async () => {
    jest.useFakeTimers();
    try {
      const db = { $transaction: jest.fn() }, client = { status: 'ready', eval: jest.fn(() => new Promise(() => undefined)) };
      const service = new ForumViewAggregationService(db as any, { getClient: () => client } as any, {} as any);
      const pending = service.record(1, 'viewer'); await jest.advanceTimersByTimeAsync(101);
      expect(await pending).toMatchObject({ status: 'unavailable', persistence: 'none' }); expect(db.$transaction).not.toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
});

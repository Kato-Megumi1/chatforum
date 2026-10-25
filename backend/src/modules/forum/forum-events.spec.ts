import { randomUUID } from 'crypto';
import { ForumEventsService, FORUM_EVENT_CONSUMERS } from './forum-events.service';
import { ForumEventsWorker } from './forum-events.worker';

describe('forum outbox boundaries', () => {
  test('default worker is disabled and does not perform a startup scan', async () => {
    const before = process.env.FORUM_EVENTS_WORKER_ENABLED; delete process.env.FORUM_EVENTS_WORKER_ENABLED;
    const events = { runBatch: jest.fn(), stop: jest.fn() }, worker = new ForumEventsWorker(events as any);
    try { worker.onApplicationBootstrap(); expect(events.runBatch).not.toHaveBeenCalled(); await worker.onModuleDestroy(); expect(events.stop).toHaveBeenCalled(); }
    finally { if (before !== undefined) process.env.FORUM_EVENTS_WORKER_ENABLED = before; }
  });
  test('consumer names are bounded and duplicate registration cannot silently replace a handler', () => {
    const events = new ForumEventsService({} as any), handler = async () => undefined;
    expect(() => events.register('invalid consumer', handler)).toThrow('INVALID_FORUM_CONSUMER');
    const unregister = events.register('fixture-consumer', handler);
    expect(() => events.register('fixture-consumer', handler)).toThrow('DUPLICATE_FORUM_CONSUMER');
    unregister(); expect(() => events.register('fixture-consumer', handler)).not.toThrow();
  });
  test('append uses its supplied transaction and persists fanout even when no consumer is registered', async () => {
    const eventKey = randomUUID(), now = new Date(), event = { id: 1n, eventKey, kind: 'POST_CREATED', postId: 3, postRevision: 1,
      actorId: null, payloadJson: { status: 'APPROVED' }, occurredAt: now, createdAt: now };
    const tx = { forumEvent: { upsert: jest.fn().mockResolvedValue(event) }, forumEventDelivery: { createMany: jest.fn() } };
    const events = new ForumEventsService({} as any);
    expect(await events.append(tx as any, { eventKey, kind: event.kind, postId: 3, postRevision: 1, payload: event.payloadJson })).toEqual(event);
    expect(tx.forumEventDelivery.createMany).toHaveBeenCalledWith({ data: FORUM_EVENT_CONSUMERS.map(consumer => ({ eventId: 1n, consumer })), skipDuplicates: true });
  });
  test('keys, event identity, finite batches and bounded payloads are checked before writes', async () => {
    const events = new ForumEventsService({} as any), tx = { forumEvent: { upsert: jest.fn() } };
    for (const input of [{ kind: 'bad kind', postId: 1, postRevision: 1 }, { kind: 'POST_CREATED', postId: -1, postRevision: 1 },
      { kind: 'POST_CREATED', postId: 1, postRevision: 1, eventKey: 'not-a-uuid' },
      { kind: 'POST_CREATED', postId: 1, postRevision: 1, payload: { large: 'x'.repeat(40000) } }]) {
      await expect(events.append(tx as any, input)).rejects.toThrow();
    }
    expect(tx.forumEvent.upsert).not.toHaveBeenCalled(); await expect(events.runBatch(51)).rejects.toThrow('INVALID_FORUM_EVENT_BATCH');
  });
});

import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumConsumerError, ForumEventsService, FORUM_EVENT_CONSUMERS } from './forum-events.service';

const suite = process.env.RUN_FORUM_EVENTS_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated durable forum outbox', () => {
  let db: PrismaService;
  const eventKeys: string[] = [], stateKeys: string[] = [], services: ForumEventsService[] = [];
  const eventInput = (overrides: any = {}) => {
    const eventKey = randomUUID(); eventKeys.push(eventKey);
    return { eventKey, kind: 'POST_CREATED', postId: 1000000000, postRevision: 1, payload: { status: 'APPROVED' }, ...overrides };
  };
  const service = () => { const events = new ForumEventsService(db); services.push(events); return events; };
  const consumer = () => 'fixture-' + randomUUID();
  const stateKey = () => { const key = 'fixture:' + randomUUID(); stateKeys.push(key); return key; };
  const makeDue = (eventId: bigint, name: string) => db.forumEventDelivery.update({ where: { eventId_consumer: { eventId, consumer: name } }, data: { availableAt: new Date(0) } });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture forum DB');
    db = new PrismaService(); await db.$connect();
  });
  afterAll(async () => {
    for (const events of services) events.stop();
    if (db) {
      await db.forumEvent.deleteMany({ where: { eventKey: { in: eventKeys } } });
      await db.forumReadModelState.deleteMany({ where: { key: { in: stateKeys } } }); await db.$disconnect();
    }
  });

  test('business rollback removes event and fanout; committed append is idempotent and conflict checked', async () => {
    const events = service(), rollback = eventInput();
    await expect(db.$transaction(async tx => { await events.append(tx, rollback); throw Error('fixture rollback'); })).rejects.toThrow('fixture rollback');
    expect(await db.forumEvent.findUnique({ where: { eventKey: rollback.eventKey } })).toBeNull();
    const input = eventInput(), first = await db.$transaction(tx => events.append(tx, input));
    const again = await db.$transaction(tx => events.append(tx, input)); expect(again.id).toBe(first.id);
    const deliveries = await db.forumEventDelivery.findMany({ where: { eventId: first.id } });
    expect(deliveries.map(row => row.consumer).sort()).toEqual([...FORUM_EVENT_CONSUMERS].sort());
    expect(deliveries.every(row => row.state === 'PENDING')).toBe(true);
    await expect(db.$transaction(tx => events.append(tx, { ...input, postRevision: 2 }))).rejects.toThrow('FORUM_EVENT_KEY_CONFLICT');
    // Unregistered built-ins remain pending, including disabled search.
    expect(await events.runBatch()).toBe(0);
  });

  test('DB projection and ack roll back together, then retry exactly once in the successful transaction', async () => {
    const events = service(), name = consumer(), key = stateKey(); let fail = true;
    events.register(name, async (_event, ctx) => ctx.transaction(async tx => {
      await tx.forumReadModelState.create({ data: { key, payloadJson: { applied: 1 } } });
      if (fail) throw Error('secret raw driver error must not be persisted');
    }));
    const event = await db.$transaction(tx => events.append(tx, eventInput()));
    expect(await events.runBatch(1)).toBe(1);
    expect(await db.forumReadModelState.findUnique({ where: { key } })).toBeNull();
    expect(await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: name } } })).toMatchObject({ state: 'PENDING', attempts: 1, errorCode: 'CONSUMER_FAILED' });
    fail = false; await makeDue(event.id, name); await events.runBatch(1); await events.runBatch(1);
    expect(await db.forumReadModelState.count({ where: { key } })).toBe(1);
    expect(await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: name } } })).toMatchObject({ state: 'COMPLETED', attempts: 2, leaseToken: null });
  });

  test('an older uncommitted id is consumed after later committed work, without a MAX(id) watermark hole', async () => {
    const events = service(), name = consumer(), seen: bigint[] = [];
    events.register(name, async event => { seen.push(event.id); });
    let inserted: () => void, release: () => void, earlierId: bigint;
    const ready = new Promise<void>(resolve => { inserted = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const held = db.$transaction(async tx => { const event = await events.append(tx, eventInput()); earlierId = event.id; inserted(); await gate; }, { timeout: 15000 });
    await ready;
    try {
      const later = await db.$transaction(tx => events.append(tx, eventInput()));
      expect(later.id > earlierId).toBe(true); expect(await events.runBatch(1)).toBe(1); expect(seen).toEqual([later.id]);
    } finally { release(); await held; }
    expect(await events.runBatch(1)).toBe(1); expect(seen).toContain(earlierId); expect(seen).toHaveLength(2);
  });

  test('expired lease is reclaimed and the stale token cannot commit projection effects', async () => {
    const stale = service(), current = service(), name = consumer(), key = stateKey();
    const project = async (_event: any, ctx: any) => ctx.transaction(async (tx: any) => tx.forumReadModelState.create({ data: { key, payloadJson: { once: true } } }));
    stale.register(name, project); current.register(name, project);
    const event = await db.$transaction(tx => stale.append(tx, eventInput())), claim = await (stale as any).claimNext();
    expect(claim.event.id).toBe(event.id);
    await db.forumEventDelivery.update({ where: { eventId_consumer: { eventId: event.id, consumer: name } }, data: { leaseUntil: new Date(0) } });
    expect(await current.runBatch(1)).toBe(1); await (stale as any).deliver(claim);
    expect(await db.forumReadModelState.count({ where: { key } })).toBe(1);
    expect(await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: name } } })).toMatchObject({ state: 'COMPLETED', attempts: 2 });
  });

  test('SKIP LOCKED does not block another worker on an already-locked eligible row', async () => {
    const events = service(), name = consumer(), seen: bigint[] = [];
    events.register(name, async event => { seen.push(event.id); });
    const first = await db.$transaction(tx => events.append(tx, eventInput())), second = await db.$transaction(tx => events.append(tx, eventInput()));
    let locked: () => void, release: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const hold = db.$transaction(async tx => { await tx.$queryRaw`SELECT eventId FROM forum_event_deliveries WHERE eventId=${first.id} AND consumer=${name} FOR UPDATE`; locked(); await gate; }, { timeout: 15000 });
    await ready;
    try { expect(await events.runBatch(1)).toBe(1); expect(seen).toEqual([second.id]); }
    finally { release(); await hold; }
    await events.runBatch(1); expect(seen).toEqual([second.id, first.id]);
  });

  test('permanent failure is DEAD, diagnostics are redacted, and an explicit retry retains the event', async () => {
    const events = service(), name = consumer();
    events.register(name, async () => { throw new ForumConsumerError('FIXTURE_PERMANENT', true); });
    const event = await db.$transaction(tx => events.append(tx, eventInput())); await events.runBatch(1);
    expect(await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: name } } })).toMatchObject({ state: 'DEAD', errorCode: 'FIXTURE_PERMANENT' });
    const diagnostics = await events.diagnostics();
    expect(diagnostics.commitCursor).toBe('per_delivery_not_max_event_id'); expect(JSON.stringify(diagnostics)).not.toContain('payloadJson');
    expect(await events.retryDead(name)).toBe(1);
    expect(await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: name } } })).toMatchObject({ state: 'PENDING', attempts: 0, errorCode: null });
  });

  test('repeated worker crashes exhaust leases into DEAD without losing the event', async () => {
    const events = service(), name = consumer(); events.register(name, async () => undefined);
    const event = await db.$transaction(tx => events.append(tx, eventInput()));
    await db.forumEventDelivery.update({ where: { eventId_consumer: { eventId: event.id, consumer: name } }, data: { attempts: 100, state: 'PROCESSING', leaseUntil: new Date(0), leaseToken: randomUUID() } });
    await events.runBatch(1);
    expect(await db.forumEventDelivery.findUnique({ where: { eventId_consumer: { eventId: event.id, consumer: name } } })).toMatchObject({ state: 'DEAD', errorCode: 'LEASE_RETRY_EXHAUSTED' });
    expect(await db.forumEvent.count({ where: { id: event.id } })).toBe(1);
  });
});

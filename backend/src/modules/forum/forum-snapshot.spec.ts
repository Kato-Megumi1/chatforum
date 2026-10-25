import { ForumSnapshotService } from './forum-snapshot.service';
import { ForumHotWorkerService, FORUM_HOT_PUBLISH_LUA } from './forum-hot-worker.service';

function fixture(count = 4) {
  const ranked = Array.from({ length: count }, (_, i) => ({ id: count - i, createdAt: new Date(Date.now() - 3600000),
    viewCount: 100 + i, likeCount: i + 2, commentCount: i, score: count - i, windowViews: 1, windowLikes: 2, windowComments: -1 }));
  const visible = new Set(ranked.map(row => row.id)), store = new Map<string, string>(), states = new Map<string, any>();
  let lost = false;
  const client = { status: 'ready', set: jest.fn(async (key: string, value: string) => { if (store.has(key)) return null; store.set(key, value); return 'OK'; }),
    eval: jest.fn(async (script: string, _keys: number, ...args: any[]) => {
      if (script === FORUM_HOT_PUBLISH_LUA) { if (lost || store.get(args[0]) !== args[3]) return 0; store.set(args[1], args[4]); store.set(args[2], args[4]); return 1; }
      if (script.includes('DEL')) { if (store.get(args[0]) === args[1]) return Number(store.delete(args[0])); return 0; }
      return 1;
    }) };
  const redis = { get: jest.fn(async (key: string) => store.get(key) || null), getClient: () => client };
  const db: any = { $executeRaw: jest.fn(async () => 1), category: { findMany: jest.fn(async () => []) },
    forumReadModelState: { update: jest.fn(async ({ where, data }) => { states.set(where.key, data.payloadJson); return data; }) },
    $queryRaw: jest.fn(async (query: any) => query.sql.includes('FOR UPDATE') ? [{ payloadJson: states.get(query.values[0]) }]
      : query.sql.includes(' AS score') ? ranked : ranked.filter(row => visible.has(row.id)).map(({ id }) => ({ id }))) };
  db.$transaction = jest.fn(async work => { const previous = new Map(states); try { return await work(db); } catch (error) { states.clear(); previous.forEach((v, k) => states.set(k, v)); throw error; } });
  const worker = new ForumHotWorkerService(db, redis as any), service = new ForumSnapshotService(db, redis as any, worker);
  return { ranked, visible, store, states, client, redis, db, worker, service, loseLease: () => { lost = true; }, scope: { hours: 168 as const, categoryId: 1, rankingBasis: 'published' as const } };
}

describe('background-published hot snapshots', () => {
  const before = process.env.FORUM_HOT_PRECOMPUTE_ENABLED;
  beforeEach(() => { process.env.FORUM_HOT_PRECOMPUTE_ENABLED = 'true'; });
  afterAll(() => { if (before === undefined) delete process.env.FORUM_HOT_PRECOMPUTE_ENABLED; else process.env.FORUM_HOT_PRECOMPUTE_ENABLED = before; });
  test('HTTP cold misses and unsupported scopes never scan/rank or build', async () => {
    const f = fixture();
    expect((await f.service.hot(f.scope, { limit: 20 })).snapshot.status).toBe('not_ready');
    expect((await f.service.hot({ ...f.scope, hours: undefined }, { limit: 20 })).snapshot.status).toBe('unsupported_scope');
    expect((await f.service.hot({ ...f.scope, sortOrder: 'asc' }, { limit: 20 })).rows).toEqual([]);
    expect(f.db.$queryRaw).not.toHaveBeenCalled(); expect(f.client.set).not.toHaveBeenCalled();
  });
  test('only worker ranks the full matching set, published data excludes content and is Top200 bounded', async () => {
    const f = fixture(201); await f.worker.publishScope(f.scope);
    const rank = f.db.$queryRaw.mock.calls.find(([query]) => query.sql.includes(' AS score'))[0];
    expect(rank.sql.indexOf('ORDER BY')).toBeLessThan(rank.sql.indexOf('LIMIT')); expect(rank.values).toContain(201);
    const result = await f.service.hot(f.scope, { limit: 20 });
    expect(result.snapshot).toMatchObject({ mode: 'shared_top_200', source: 'background_precomputed', status: 'ready', rankedCount: 200, hasMoreBeyondCoverage: true, rankingBasis: 'published' });
    expect(result.rows).toHaveLength(20); expect(JSON.stringify([...f.store.values()])).not.toMatch(/username|content|conversation/);
    expect(f.db.$queryRaw.mock.calls.filter(([query]) => query.sql.includes(' AS score'))).toHaveLength(1);
  });
  test('refresh preserves pinned previous generations, withdrawals leave rank holes', async () => {
    const f = fixture(201); await f.worker.publishScope(f.scope); const first = await f.service.hot(f.scope, { limit: 50 });
    await f.worker.publishScope(f.scope); const current = await f.service.hot(f.scope, { limit: 50 }); expect(current.snapshot.id).not.toBe(first.snapshot.id);
    f.visible.delete(201); const pinned = await f.service.hot(f.scope, { limit: 50, snapshotId: first.snapshot.id });
    expect(pinned.snapshot.id).toBe(first.snapshot.id); expect(pinned.rows).toHaveLength(49); expect(pinned.snapshot.removedCount).toBe(1);
    const second = await f.service.hot(f.scope, { offset: 50, limit: 50, snapshotId: first.snapshot.id }); expect(second.rows[0].id).toBe(151);
    await expect(f.service.hot({ ...f.scope, hours: 24 }, { limit: 2, snapshotId: first.snapshot.id })).rejects.toThrow('FORUM_SNAPSHOT_EXPIRED');
  });
  test('distributed lease has one builder and a lost lease cannot publish', async () => {
    const f = fixture(), other = new ForumHotWorkerService(f.db, f.redis as any);
    const built = await Promise.all([f.worker.publishScope(f.scope), other.publishScope(f.scope)]); expect(built.filter(Boolean)).toHaveLength(1);
    const lost = fixture(); lost.loseLease(); expect(await lost.worker.publishScope(lost.scope)).toBe(false);
    expect([...lost.store.keys()].some(key => key.endsWith(':current'))).toBe(false);
  });
  test('both bases have separate keys and interaction filters do not reject revived old posts by publication date', async () => {
    const f = fixture(); await f.worker.publishScope(f.scope); await f.worker.publishScope({ ...f.scope, rankingBasis: 'interaction' });
    const result = await f.service.hot({ ...f.scope, rankingBasis: 'interaction' }, { limit: 2 });
    expect(result.snapshot).toMatchObject({ rankingBasis: 'interaction', windowCountsBasis: 'signed_net_deltas_since_activation', bucketGranularity: 'hour_including_current_partial_hour' });
    const check = f.db.$queryRaw.mock.calls.at(-1)[0]; expect(check.sql).not.toContain('p.createdAt>=');
    expect(result.rows[0]).toMatchObject({ windowViews: 1, windowLikes: 2, windowComments: -1, viewCount: 100 });
    const rank = f.db.$queryRaw.mock.calls.find(([query]) => query.sql.includes('windowViews'))[0]; expect(rank.sql).toContain('TIMESTAMPDIFF'); expect(rank.sql).toContain('HAVING score>0');
    expect(f.worker.scopeKey(f.scope)).not.toBe(f.worker.scopeKey({ ...f.scope, rankingBasis: 'interaction' }));
  });
  test('complex filters only filter bounded published candidates, never a live full-set query', async () => {
    const f = fixture(); await f.worker.publishScope(f.scope); f.visible.delete(4);
    const result = await f.service.hot({ ...f.scope, query: '眼镜', tagId: 8 }, { limit: 2 });
    expect(result.snapshot).toMatchObject({ paging: 'first_page_only', coverageLimited: true, coverage: 'filtered_top_200_candidates' });
    const check = f.db.$queryRaw.mock.calls.at(-1)[0]; expect(check.sql).toContain('p.id IN'); expect(check.sql).toContain('post_tags');
    expect(check.sql).not.toContain('ORDER BY'); await expect(f.service.hot({ ...f.scope, tagId: 8 }, { offset: 2, limit: 2 })).rejects.toThrow('FORUM_SNAPSHOT_EXPIRED');
  });
  test('Redis outage serves last observed generation without SQL cold rebuild; stale is explicit', async () => {
    const f = fixture(); await f.worker.publishScope(f.scope); f.redis.get.mockRejectedValue(Error('private-driver-error'));
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 181000);
    try { const result = await f.service.hot(f.scope, { limit: 2 }); expect(result.snapshot).toMatchObject({ status: 'stale', cacheBackend: 'process_fallback' }); expect(JSON.stringify(result)).not.toContain('private-driver'); }
    finally { clock.mockRestore(); }
    expect(f.db.$queryRaw.mock.calls.filter(([query]) => query.sql.includes(' AS score'))).toHaveLength(1);
  });
  test('Redis-publication/DB crash recovers hook once in the DB snapshot transaction', async () => {
    const f = fixture(), committed: string[] = []; let fail = true;
    f.worker.setPublishedHook(async (_tx, snapshot) => { if (fail) { fail = false; throw Error('simulated DB failure'); } committed.push(snapshot.id); });
    await expect(f.worker.publishScope(f.scope)).rejects.toThrow('simulated DB failure');
    const first = await f.worker.read(f.scope); expect(f.states.size).toBe(0);
    await f.worker.publishScope(f.scope); expect(committed.filter(id => id === first.value.id)).toHaveLength(1);
    expect(f.states.size).toBe(1);
  });
});

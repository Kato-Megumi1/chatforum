import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForumService } from './forum.service';
import { FeedQueryDto, PostQueryDto, TagOptionsQueryDto, TagsQueryDto } from './forum.dto';
import { LatestFeedCursor, readWebCursor, signWebCursor, webFilterKey } from './forum-feed.policy';
import { ForumReceiptCleanupService } from './forum-receipt-cleanup.service';

describe('bounded forum web read models', () => {
  const secret = 'forum-scale-fixture-only-secret-32-bytes', oldSecret = process.env.JWT_ACCESS_SECRET;
  beforeAll(() => { process.env.JWT_ACCESS_SECRET = secret; });
  afterAll(() => { if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret; });
  test('query contracts bound tags/feed and parse explicit total booleans', async () => {
    expect(new TagsQueryDto().limit).toBe(30); expect(new FeedQueryDto().includeTotal).toBe(false);
    expect(plainToInstance(PostQueryDto, { includeTotal: 'false' }).includeTotal).toBe(false);
    for (const [dto, input] of [[TagsQueryDto, { limit: 101 }], [TagOptionsQueryDto, { limit: 31 }],
      [FeedQueryDto, { sort: 'likes' }], [FeedQueryDto, { includeTotal: 'nope' }]] as const)
      expect((await validate(plainToInstance(dto as any, input))).length).toBeGreaterThan(0);
  });
  test('signed seek cursors bind endpoint, filters/order/limit and insertion bounds', () => {
    const filter = webFilterKey(['category', 1, 'desc', 20]);
    const value: LatestFeedCursor = { v: 1, kind: 'latest', filter, asOf: new Date().toISOString(), maxId: 20, at: null, id: null };
    const cursor = signWebCursor(value, secret);
    expect(readWebCursor(cursor, filter, 'latest', secret)).toEqual(value);
    expect(() => readWebCursor(cursor.slice(0, -3) + 'xxx', filter, 'latest', secret)).toThrow();
    expect(() => readWebCursor(cursor, webFilterKey(['category', 2, 'desc', 20]), 'latest', secret)).toThrow();
    expect(() => readWebCursor(cursor, filter, 'tags', secret)).toThrow();
    expect(() => readWebCursor(signWebCursor({ ...value, at: new Date().toISOString(), id: 21 }, secret), filter, 'latest', secret)).toThrow();
  });
  test('latest seek defaults to no COUNT/OFFSET and can replay first page without a new max-id query', async () => {
    const at = new Date(Date.now() - 1000), row = (id: number) => ({ id, createdAt: at, revision: 1, excerpt: 'summary' });
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([{ maxId: 10 }]).mockResolvedValueOnce([row(10), row(9), row(8)]),
      post: { findMany: jest.fn().mockResolvedValue([10, 9, 8].map(id => ({ id, revision: 1, contentFormat: 'plain', status: 'APPROVED' }))) } };
    const service = new ForumService(db as any), first = await service.getFeed({ limit: 2 });
    expect(first.data.map(p => p.id)).toEqual([10, 9]); expect(first.hasMore).toBe(true); expect(first.total).toBeNull();
    const sql = db.$queryRaw.mock.calls.map(args => args[0].sql).join(' ');
    expect(sql).not.toContain('COUNT('); expect(sql).not.toContain('OFFSET'); expect(sql).toContain('LIMIT ?');
    db.$queryRaw.mockResolvedValueOnce([row(10), row(9), row(8)]);
    const replay = await service.getFeed({ limit: 2, cursor: first.pageCursor }); expect(replay.data.map(p => p.id)).toEqual([10, 9]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
    db.$queryRaw.mockResolvedValueOnce([row(8)]);
    const second = await service.getFeed({ limit: 2, cursor: first.nextCursor, includeTotal: true });
    expect(second.data.map(p => p.id)).toEqual([8]); expect(second.total).toBeNull(); expect(second.hasMore).toBe(false);
    expect(db.$queryRaw.mock.calls[3][0].sql).toContain('p.createdAt<?');
  });
  test('optional counts run only on first feed request, and legacy likes can explicitly skip counting', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([{ maxId: 7 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ total: 0n }]) };
    const service = new ForumService(db as any), feed = await service.getFeed({ includeTotal: true });
    expect(feed.total).toBe(0); expect(feed.totalBasis).toBe('first_page_exact_at_query');
    expect(db.$queryRaw.mock.calls.filter(args => (args[0].sql || args[0].join('?')).includes('COUNT('))).toHaveLength(1);
    db.$queryRaw.mockClear().mockResolvedValue([]);
    const old = await service.getPosts({ sort: 'likes', page: 2, includeTotal: false });
    expect(old.total).toBeNull(); expect(old.totalPages).toBeNull(); expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  });
  test('tag rankings aggregate APPROVED rows in SQL before bounded LIMIT and share a short single-flight cache', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValue([{ id: 3, name: 'public', count: 10n }]), tag: { findMany: jest.fn() } };
    const service = new ForumService(db as any), results = await Promise.all([service.getTags(), service.getTags()]);
    expect(results[0]).toEqual([{ id: 3, name: 'public', count: 10, _count: { posts: 10 } }]);
    expect(db.$queryRaw).toHaveBeenCalledTimes(1); expect(db.tag.findMany).not.toHaveBeenCalled();
    const query = db.$queryRaw.mock.calls[0][0]; expect(query.sql).toContain("p.status='APPROVED'");
    expect(query.sql).toContain('GROUP BY t.id,t.name ORDER BY count DESC,t.id ASC LIMIT 100');
    await service.getTags(1); await service.getTags(100); expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    await expect(service.getTags(101)).rejects.toMatchObject({ status: 400 });
  });
  test('public categories share one short observed-count cache without changing the array protocol', async () => {
    const db = { category: { findMany: jest.fn().mockResolvedValue([{ id: 1, name: 'public', _count: { posts: 2 } }]) } };
    const service = new ForumService(db as any), [first, parallel] = await Promise.all([service.getCategories(), service.getCategories()]);
    expect(Array.isArray(first)).toBe(true); expect(first[0]).toMatchObject({ id: 1, _count: { posts: 2 }, countObservedAt: expect.any(String) });
    expect(parallel).toEqual(first); expect(await service.getCategories()).toEqual(first); expect(db.category.findMany).toHaveBeenCalledTimes(1);
    expect(db.category.findMany.mock.calls[0][0].include._count.select.posts.where).toEqual({ status: 'APPROVED' });
  });
  test('tag options use literal name parameters and a filter-bound name/id seek rather than offset', async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([{ id: 1, name: '%_a', count: 2n }, { id: 2, name: '%_b', count: 1n }]) };
    const service = new ForumService(db as any), first = await service.getTagOptions({ q: '%_', limit: 1 });
    expect(first.data).toEqual([{ id: 1, name: '%_a' }]); expect(first.hasMore).toBe(true);
    expect(db.$queryRaw.mock.calls[0][0].values).toContain('%_'); expect(db.$queryRaw.mock.calls[0][0].sql).not.toContain('%_');
    db.$queryRaw.mockResolvedValueOnce([{ id: 2, name: '%_b', count: 1n }]);
    expect((await service.getTagOptions({ q: '%_', limit: 1, cursor: first.nextCursor })).data[0].id).toBe(2);
    expect(db.$queryRaw.mock.calls[1][0].sql).toContain('t.name>?');
    await expect(service.getTagOptions({ q: 'other', limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
  });
  test('recent view receipts recheck public state but bypass transaction/row locks', async () => {
    const db = { post: { findFirst: jest.fn().mockResolvedValue({ id: 7, viewCount: 9 }) },
      postViewReceipt: { findUnique: jest.fn().mockResolvedValue({ viewedAt: new Date() }) }, $transaction: jest.fn() };
    const service = new ForumService(db as any), result = await service.recordView(7);
    expect(result).toMatchObject({ counted: false, viewCount: 9 }); expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.post.findFirst).toHaveBeenCalledWith({ where: { id: 7, status: 'APPROVED' }, select: { id: true, viewCount: true } });
    db.post.findFirst.mockResolvedValue(null);
    await expect(service.recordView(7, undefined, result.viewerToken)).rejects.toMatchObject({ status: 404 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('receipt cleanup is deferred, indexed/batched, single-flight and confined to the derived table', async () => {
    jest.useFakeTimers();
    let finish: (value: number) => void;
    const db = { $executeRaw: jest.fn(() => new Promise<number>(resolve => { finish = resolve; })) };
    const cleanup = new ForumReceiptCleanupService(db as any);
    try {
      cleanup.onApplicationBootstrap(); expect(db.$executeRaw).not.toHaveBeenCalled();
      const pending = cleanup.cleanupExpired(new Date('2026-10-14T12:00:00Z'));
      expect(await cleanup.cleanupExpired()).toBe(0); expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      const query = db.$executeRaw.mock.calls[0] as any;
      expect(query[0].join('?')).toBe('DELETE FROM post_view_receipts WHERE viewedAt<? ORDER BY viewedAt ASC LIMIT 500');
      expect(query[1]).toEqual(new Date('2026-10-12T12:00:00Z')); finish(500); expect(await pending).toBe(500);
    } finally { cleanup.onModuleDestroy(); jest.useRealTimers(); }
    expect(await cleanup.cleanupExpired()).toBe(0);
  });
});

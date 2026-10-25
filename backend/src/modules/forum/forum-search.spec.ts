import { ForumSearchAdapter, ForumSearchDocument, ForumSearchError } from './forum-search.adapter';
import { ForumSearchService } from './forum-search.service';
import { ForumSearchIndexService } from './forum-search-index.service';
import { ForumSearchConsumer } from './forum-search-consumer.service';

const document: ForumSearchDocument = { postId: 7, revision: 2, status: 'APPROVED', title: '中文测试', content: '虚构检索正文',
  categoryId: 1, userId: 1, tagIds: [2], createdAt: '2026-01-01T00:00:00.000Z' };
describe('forum search: REST, PIT boundaries and durable explicit publication (no network)', () => {
  const previous = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of ['FORUM_SEARCH_URL', 'FORUM_SEARCH_ENABLED', 'FORUM_SEARCH_ALIAS', 'FORUM_SEARCH_USERNAME', 'FORUM_SEARCH_PASSWORD', 'JWT_ACCESS_SECRET']) previous.set(key, process.env[key]);
    process.env.FORUM_SEARCH_URL = 'http://127.0.0.1:39200'; process.env.FORUM_SEARCH_ENABLED = 'true';
    process.env.FORUM_SEARCH_ALIAS = 'chatforum-forum-test-read'; delete process.env.FORUM_SEARCH_USERNAME; delete process.env.FORUM_SEARCH_PASSWORD;
    process.env.JWT_ACCESS_SECRET = 'fixture-search-secret-at-least-32-characters';
  });
  afterEach(() => { jest.restoreAllMocks(); for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value; previous.clear(); });
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  test('index uses built-in CJK unigrams+bigrams and BM25 without requiring a plugin or public endpoint', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({ acknowledged: true }));
    await new ForumSearchAdapter().createIndex('chatforum-forum-test-v1');
    const [url, options] = fetch.mock.calls[0], body = JSON.parse(options.body as string);
    expect(url).toBe('http://127.0.0.1:39200/chatforum-forum-test-v1');
    expect(body.settings.analysis.filter.forum_cjk_bigrams).toEqual({ type: 'cjk_bigram', output_unigrams: true });
    expect(body.settings.similarity.forum_bm25.type).toBe('BM25'); expect(body.mappings.dynamic).toBe('strict');
    expect(options.redirect).toBe('error');
    process.env.FORUM_SEARCH_URL = 'https://user:secret@example.com'; expect(() => new ForumSearchAdapter()).toThrow('FORUM_SEARCH_UNAVAILABLE');
  });
  test('bulk uses strict external versioning, treats duplicate/older versions as idempotent and never deletes tombstones', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({ errors: true, items: [{ index: { status: 409, error: { type: 'version_conflict_engine_exception' } } }] }));
    await new ForumSearchAdapter().bulk('chatforum-forum-test-v1', [{ ...document, status: 'DELETED', title: '', content: '' }]);
    const lines = String(fetch.mock.calls[0][1].body).trim().split('\n').map(line => JSON.parse(line));
    expect(lines[0]).toEqual({ index: { _index: 'chatforum-forum-test-v1', _id: '7', version: 2, version_type: 'external' } });
    expect(lines[1]).toMatchObject({ status: 'DELETED', title: '', content: '' });
    fetch.mockResolvedValue(response({ errors: true, items: [{ index: { status: 500 } }] }));
    await expect(new ForumSearchAdapter().bulk('chatforum-forum-test-v1', [document])).rejects.toThrow('FORUM_SEARCH_UNAVAILABLE');
  });
  test('REST search keeps user text as match data, source limited, original time bounds and search_after bound to PIT', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({ hits: { hits: [] } }));
    await new ForumSearchAdapter().search('fixture-pit', { query: '中文 OR <script>', categoryId: 1, tagId: 2, userId: 3,
      since: '2020-01-01T00:00:00.000Z', until: '2026-01-01T00:00:00.000Z' }, '2026-02-01T00:00:00.000Z', 20, [2, 1, 7], false);
    const body = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(body.pit.id).toBe('fixture-pit'); expect(body.search_after).toEqual([2, 1, 7]); expect(body.track_total_hits).toBe(false);
    expect(body._source).toEqual(['postId', 'revision']); expect(body.query.bool.must[0].multi_match.query).toBe('中文 OR <script>');
    expect(body.query.bool.filter).toContainEqual({ range: { createdAt: { gte: '2020-01-01T00:00:00.000Z', lte: '2026-01-01T00:00:00.000Z' } } });
    expect(body.highlight.pre_tags).toEqual(['']); expect(body).not.toHaveProperty('from');
  });
  test('failed/partial search never looks like zero matching documents and provider response text is not leaked', async () => {
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(response({ error: 'private-cluster-detail' }, 500));
    await expect(new ForumSearchAdapter().search('pit', { query: '中文' }, new Date().toISOString(), 2)).rejects.toMatchObject({ code: 'FORUM_SEARCH_UNAVAILABLE' });
    fetch.mockResolvedValue(response({ timed_out: true, hits: { hits: [] } }));
    await expect(new ForumSearchAdapter().search('pit', { query: '中文' }, new Date().toISOString(), 2)).rejects.toThrow('FORUM_SEARCH_UNAVAILABLE');
    fetch.mockResolvedValue(response({ error: 'private-pit-detail' }, 404));
    await expect(new ForumSearchAdapter().search('pit', { query: '中文' }, new Date().toISOString(), 2)).rejects.toMatchObject({ code: 'FORUM_SEARCH_EXPIRED', status: 409 });
  });
  function searchFixture() {
    const adapter = { configured: () => true, createPit: jest.fn(async () => 'fixture-pit'), closePit: jest.fn(async () => undefined), search: jest.fn(async (..._args: any[]) => ({
      hits: { total: { value: 3, relation: 'eq' }, hits: [7, 8, 9].map(id => ({ _id: String(id), _source: { postId: id, revision: 2, content: 'must-not-be-returned' },
        _score: 1, sort: [1, 100, id], highlight: { content: ['<b>虚构</b>片段'] } })) },
    })) };
    const indices = { activeIndex: jest.fn(async () => ({ indexName: 'chatforum-forum-test-v1', buildId: 'fixture-build' })), markDegraded: jest.fn(async () => undefined) };
    return { adapter, indices, service: new ForumSearchService(adapter as any, indices as any) };
  }
  test('PIT cursors bind scope/query/category/time/order/limit, first page replay and total count without returning full text', async () => {
    const { adapter, service } = searchFixture(), first = await service.search({ query: '中文', limit: 2, scopeKey: 'user:1:conversation:2' });
    expect(first.candidates).toHaveLength(2); expect(first.hasMore).toBe(true); expect(first.total.basis).toBe('index_pit_not_live_acl');
    expect(JSON.stringify(first)).not.toContain('must-not-be-returned'); expect(first.candidates[0].snippet).toBe('虚构 片段');
    for (const change of [{ scopeKey: 'user:2:conversation:2' }, { query: 'different' }, { categoryId: 3 }, { since: new Date('2020-01-01') }, { limit: 3 }, { sort: 'createdAt' as const }])
      await expect(service.search({ query: '中文', limit: 2, scopeKey: 'user:1:conversation:2', ...change, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'FORUM_SEARCH_INVALID_CURSOR' });
    await service.search({ query: '中文', limit: 2, scopeKey: 'user:1:conversation:2', cursor: first.pageCursor });
    expect(adapter.createPit).toHaveBeenCalledTimes(1); expect(adapter.search.mock.calls[1][4]).toBeUndefined(); expect(adapter.search.mock.calls[1][5]).toBe(false);
    await service.search({ query: '中文', limit: 2, scopeKey: 'user:1:conversation:2', cursor: first.nextCursor });
    expect(adapter.search.mock.calls[2][4]).toEqual([1, 100, 8]);
  });
  test('disabled search does not execute an old PIT and missing active index never creates a replacement automatically', async () => {
    const { adapter, indices, service } = searchFixture();
    process.env.FORUM_SEARCH_ENABLED = 'false'; await expect(service.search({ query: '中文' })).rejects.toThrow('FORUM_SEARCH_NOT_READY');
    expect(adapter.createPit).not.toHaveBeenCalled(); process.env.FORUM_SEARCH_ENABLED = 'true';
    indices.activeIndex.mockRejectedValue(new ForumSearchError('FORUM_SEARCH_NOT_READY'));
    await expect(service.search({ query: '中文' })).rejects.toThrow('FORUM_SEARCH_NOT_READY'); expect(adapter.createPit).not.toHaveBeenCalled();
  });
  test('relative hours derive the same since from the original PIT across later request clocks', async () => {
    const { adapter, service } = searchFixture(), first = await service.search({ query: '中文', hours: 24, limit: 2 });
    const later = Date.now() + 10000; jest.spyOn(Date, 'now').mockReturnValue(later);
    await service.search({ query: '中文', hours: 24, limit: 2, cursor: first.nextCursor });
    expect(adapter.search.mock.calls[0][1].since).toBe(new Date(Date.parse(first.asOf) - 24 * 3600000).toISOString());
    expect(adapter.search.mock.calls[1][1].since).toBe(adapter.search.mock.calls[0][1].since);
    await expect(service.search({ query: '中文', hours: 24, since: new Date('2020-01-01') })).rejects.toThrow('FORUM_SEARCH_INVALID_CURSOR');
  });
  test('consumer-disabled deliveries remain unregistered; remote failure cannot acknowledge the event', async () => {
    const events = { register: jest.fn() }, adapter = { configured: () => true }, indices = { syncEvent: jest.fn() };
    process.env.FORUM_SEARCH_ENABLED = 'false'; new ForumSearchConsumer(events as any, adapter as any, indices as any).onModuleInit(); expect(events.register).not.toHaveBeenCalled();
    process.env.FORUM_SEARCH_ENABLED = 'true'; new ForumSearchConsumer(events as any, adapter as any, indices as any).onModuleInit();
    const handler = events.register.mock.calls[0][1], context = { transaction: jest.fn(async fn => fn({})) };
    indices.syncEvent.mockRejectedValue(new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'));
    await expect(handler({ postId: 7 }, context)).rejects.toThrow(); expect(context.transaction).not.toHaveBeenCalled();
    indices.syncEvent.mockResolvedValue(undefined); await handler({ postId: 7 }, context); expect(context.transaction).toHaveBeenCalledTimes(1);
  });
  function buildFixture() {
    const values = new Map<string, any>(), clone = (value: any) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    const post = { id: 7, revision: 2, status: 'APPROVED', title: 'fixture', content: 'fixture body', categoryId: 1, userId: 1, tags: [], createdAt: new Date('2020-01-01') };
    const db: any = { forumReadModelState: {
      findUnique: jest.fn(async ({ where }) => clone(values.get(where.key))),
      upsert: jest.fn(async ({ where, create, update }) => { const value = values.has(where.key) ? { ...values.get(where.key), ...clone(update) } : clone(create); values.set(where.key, value); return value; }),
      update: jest.fn(async ({ where, data }) => { const value = { ...values.get(where.key), ...clone(data) }; values.set(where.key, value); return value; }),
    }, post: { aggregate: jest.fn(async () => ({ _max: { id: 7 } })), findUnique: jest.fn(async () => post),
      findMany: jest.fn(async ({ where }) => where.id.gt < 7 ? [post] : []) },
      forumEvent: { aggregate: jest.fn(async () => ({ _max: { id: 0n } })), findMany: jest.fn(async () => []) },
      forumEventDelivery: { count: jest.fn(async () => 0) }, $queryRaw: jest.fn(async () => []) };
    db.$transaction = jest.fn(async fn => fn(db));
    const adapter = { configured: () => true, createIndex: jest.fn(async () => ({})), bulk: jest.fn(async (..._args: any[]) => undefined), refresh: jest.fn(async () => undefined),
      documents: jest.fn(async () => [{ postId: 7, revision: 2, status: 'APPROVED' }]), count: jest.fn(async () => 1), switchAlias: jest.fn(async () => undefined),
      createPit: jest.fn(async () => 'validation-pit'), closePit: jest.fn(async () => undefined), inspectPage: jest.fn(async () => ({ docs: [], after: null })) };
    return { db, values, post, adapter, service: new ForumSearchIndexService(db, adapter as any) };
  }
  test('staging is validated before READY; publishing requires confirmation and never automatically deletes old indices', async () => {
    const { service, adapter, values } = buildFixture(), build = await service.startBuild({ confirmation: 'BUILD_FORUM_SEARCH' });
    expect(build.status).toBe('BUILDING'); expect((await service.status()).activeIndex).toBeNull();
    const raw = values.get('forum-search:build:' + build.id); raw.payloadJson.lease = { token: 'private-lease-capability', until: Date.now() + 60000 };
    raw.payloadJson.publicationToken = 'private-publication-capability';
    expect(JSON.stringify(await service.status())).not.toContain('private-lease-capability'); expect(JSON.stringify(await service.status())).not.toContain('private-publication-capability');
    delete raw.payloadJson.lease; delete raw.payloadJson.publicationToken;
    await expect(service.validateBuild(build.id)).rejects.toThrow('FORUM_SEARCH_CONFLICT');
    await service.runBuildBatch(build.id); expect((await service.validateBuild(build.id)).status).toBe('READY');
    expect(adapter.switchAlias).not.toHaveBeenCalled();
    await expect(service.publish(build.id, { confirmation: 'wrong' })).rejects.toThrow('FORUM_SEARCH_CONFLICT');
    expect((await service.publish(build.id, { confirmation: build.id })).status).toBe('ACTIVE');
    expect((await service.status()).activeIndex).toBe(build.indexName); expect(adapter.switchAlias).toHaveBeenCalledWith(build.indexName);
  });
  test('alias failure leaves the old SQL publication pointer and persists degraded state', async () => {
    const { service, adapter, values } = buildFixture(); values.set('forum-search:control:v1', { payloadJson: { activeIndex: 'chatforum-forum-old' } });
    const build = await service.startBuild({ confirmation: 'BUILD_FORUM_SEARCH' }); await service.runBuildBatch(build.id); await service.validateBuild(build.id);
    adapter.switchAlias.mockRejectedValue(new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'));
    await expect(service.publish(build.id, { confirmation: build.id })).rejects.toThrow('FORUM_SEARCH_UNAVAILABLE');
    expect((await service.status()).activeIndex).toBe('chatforum-forum-old'); expect((await service.status()).degraded).toBe('FORUM_SEARCH_UNAVAILABLE');
  });
  test('sync re-reads SQL, delayed events cannot overwrite a restored revision, and absent posts become permanent tombstones', async () => {
    const { db, post, service, adapter, values } = buildFixture(); values.set('forum-search:control:v1', { payloadJson: { activeIndex: 'chatforum-forum-old' } });
    post.revision = 5;
    await service.syncEvent({ id: 1n, postId: 7, postRevision: 3, kind: 'POST_DELETED', payloadJson: { content: 'untrusted' } } as any);
    expect(adapter.bulk.mock.calls[0][1][0]).toMatchObject({ revision: 5, status: 'APPROVED', content: 'fixture body' });
    db.post.findUnique.mockResolvedValue(null); await service.syncEvent({ id: 2n, postId: 7, postRevision: 6, kind: 'POST_DELETED' });
    expect(adapter.bulk.mock.calls[1][1][0]).toMatchObject({ revision: 6, status: 'DELETED', title: '', content: '' });
  });
  test('all five authoritative post lifecycle kinds sync, while subscription/hot/view/like/comment events do not', async () => {
    const { service, adapter, values } = buildFixture(); values.set('forum-search:control:v1', { payloadJson: { activeIndex: 'chatforum-forum-old' } });
    for (const kind of ['POST_PUBLISHED', 'POST_UPDATED', 'POST_HIDDEN', 'POST_DELETED', 'POST_APPROVED'])
      await service.syncEvent({ id: 1n, postId: 7, postRevision: 2, kind });
    expect(adapter.bulk).toHaveBeenCalledTimes(5);
    for (const kind of ['SUBSCRIPTION_SCAN', 'HOT_RANK_CHANGED', 'VIEW', 'LIKE', 'COMMENT'])
      await service.syncEvent({ id: 1n, postId: 7, postRevision: 2, kind });
    expect(adapter.bulk).toHaveBeenCalledTimes(5);
  });
});

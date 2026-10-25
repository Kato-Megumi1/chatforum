import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { ForumSearchAdapter } from './forum-search.adapter';
import { ForumSearchIndexService, SearchBuild } from './forum-search-index.service';
import { ForumSearchService } from './forum-search.service';
import { ForumSearchConsumer } from './forum-search-consumer.service';

const suite = process.env.RUN_FORUM_SEARCH_INTEGRATION === '1' ? describe : describe.skip;
suite('real isolated OpenSearch 3.9: CJK BM25, PIT, outbox and explicit publication', () => {
  let db: PrismaService, adapter: ForumSearchAdapter, indices: ForumSearchIndexService, search: ForumSearchService, events: ForumEventsService;
  let owner: number, categoryId: number, firstBuild: SearchBuild, controlOwned = false;
  const prefix = 'os_' + randomUUID().slice(0, 10), ownedBuilds: SearchBuild[] = [], postIds: number[] = [], previous = new Map<string, string | undefined>();
  const endpoint = 'http://127.0.0.1:39201'; // Dedicated fixture, never production's loopback endpoint.
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' || process.env.FORUM_SEARCH_URL !== endpoint)
      throw Error('Refusing non-isolated DB or OpenSearch');
    for (const key of ['FORUM_SEARCH_ENABLED', 'FORUM_SEARCH_ALIAS', 'FORUM_SEARCH_USERNAME', 'FORUM_SEARCH_PASSWORD', 'JWT_ACCESS_SECRET']) previous.set(key, process.env[key]);
    process.env.FORUM_SEARCH_ENABLED = 'true'; process.env.FORUM_SEARCH_ALIAS = 'chatforum-forum-' + prefix.replace('_', '-');
    delete process.env.FORUM_SEARCH_USERNAME; delete process.env.FORUM_SEARCH_PASSWORD; process.env.JWT_ACCESS_SECRET = 'forum-search-fixture-secret-at-least-32';
    const info = await (await fetch(endpoint)).json(); if (info.version?.number !== '3.9.0' || info.version?.distribution !== 'opensearch') throw Error('Unexpected search fixture version');
    db = new PrismaService(); await db.$connect();
    if (await db.forumReadModelState.findUnique({ where: { key: 'forum-search:control:v1' } })) throw Error('Search control belongs to another fixture');
    controlOwned = true;
    owner = (await db.user.create({ data: { username: prefix, email: prefix + '@example.test', password: 'disabled-fixture' } })).id;
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    for (let i = 0; i < 8; i++) postIds.push((await db.post.create({ data: { title: '中文校园讨论' + i, content: '学习交流与校园生活，虚构检索正文。',
      contentFormat: 'plain', userId: owner, categoryId, status: i === 7 ? 'PENDING' : 'APPROVED', createdAt: new Date(Date.now() - (8 - i) * 3600000) } })).id);
    adapter = new ForumSearchAdapter(); indices = new ForumSearchIndexService(db, adapter); search = new ForumSearchService(adapter, indices);
    events = new ForumEventsService(db); new ForumSearchConsumer(events, adapter, indices).onModuleInit();
  }, 30000);
  afterAll(async () => {
    if (indices) indices.onModuleDestroy(); if (events) await events.onModuleDestroy();
    // Only exact newly-created index names on the fixed isolated endpoint may be removed.
    for (const build of ownedBuilds) if (/^chatforum-forum-v-\d+-[a-f0-9]{8}$/.test(build.indexName)) await fetch(endpoint + '/' + build.indexName, { method: 'DELETE' });
    if (db) {
      if (controlOwned) await db.forumReadModelState.deleteMany({ where: { key: { in: ['forum-search:control:v1', ...ownedBuilds.map(build => 'forum-search:build:' + build.id)] } } });
      if (postIds.length) await db.forumEvent.deleteMany({ where: { postId: { in: postIds } } });
      if (categoryId) await db.category.delete({ where: { id: categoryId } }); if (owner) await db.user.delete({ where: { id: owner } }); await db.$disconnect();
    }
    for (const [key, value] of previous) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }, 30000);
  async function newBuild() { const build = await indices.startBuild({ confirmation: 'BUILD_FORUM_SEARCH' }); ownedBuilds.push(build); return build; }
  async function scan(build: SearchBuild) { let current = build; for (let n = 0; !current.scanDone && n < 100; n++) current = await indices.runBuildBatch(build.id, 50);
    if (!current.scanDone) throw Error('Fixture backfill did not finish'); return current; }
  async function drain() { for (let i = 0; i < 20 && await db.forumEventDelivery.count({ where: { consumer: 'forum-search-v1', state: { not: 'COMPLETED' } } }); i++) await events.runBatch(50); }
  async function change(id: number, status: 'APPROVED' | 'REJECTED') {
    const event = await db.$transaction(async tx => { const row = await tx.post.update({ where: { id }, data: { status, revision: { increment: 1 } } });
      return events.append(tx, { kind: status === 'APPROVED' ? 'POST_APPROVED' : 'POST_HIDDEN', postId: id, postRevision: row.revision, actorId: owner, payload: { status: 'untrusted-payload-status', content: 'untrusted' } }); });
    await drain(); return event;
  }
  test('new index backfills in bounded batches, validates READY and never becomes searchable without explicit publish', async () => {
    await expect(search.search({ query: '校园', categoryId })).rejects.toThrow('FORUM_SEARCH_NOT_READY');
    firstBuild = await newBuild(); expect((await indices.status()).activeIndex).toBeNull();
    await scan(firstBuild); await drain(); expect((await indices.validateBuild(firstBuild.id)).status).toBe('READY');
    await expect(search.search({ query: '校园', categoryId })).rejects.toThrow('FORUM_SEARCH_NOT_READY');
    await expect(indices.publish(firstBuild.id, { confirmation: 'wrong' })).rejects.toThrow('FORUM_SEARCH_CONFLICT');
    expect((await indices.publish(firstBuild.id, { confirmation: firstBuild.id })).status).toBe('ACTIVE');
    const found = await search.search({ query: '校园', categoryId, limit: 2 });
    expect(found.candidates).toHaveLength(2); expect(found.total.value).toBe(7); expect(found.total.relation).toBe('eq');
    expect(found.candidates.every(p => p.revision === 1 && p.snippet.length <= 240 && !('content' in p))).toBe(true);
  }, 30000);
  test('PIT pagination freezes ordering and totals; SQL revision/visibility recheck still excludes withdrawn evidence', async () => {
    const args = { query: '校园', categoryId, sort: 'createdAt' as const, sortOrder: 'asc' as const, limit: 2, scopeKey: 'fixture-user:' + owner };
    const first = await search.search(args); expect(first.candidates.map(p => p.id)).toEqual(postIds.slice(0, 2));
    const hidden = postIds[2]; await change(hidden, 'REJECTED'); await adapter.refresh(firstBuild.indexName);
    const second = await search.search({ ...args, cursor: first.nextCursor });
    expect(second.asOf).toBe(first.asOf); expect(second.total.value).toBe(7); expect(second.candidates[0].id).toBe(hidden);
    const valid = await db.post.findMany({ where: { OR: second.candidates.map(p => ({ id: p.id, revision: p.revision, status: 'APPROVED' })) } });
    expect(valid.some(p => p.id === hidden)).toBe(false);
    for (const changed of [{ query: '别的' }, { categoryId: categoryId + 1 }, { scopeKey: 'other-user' }, { limit: 3 }])
      await expect(search.search({ ...args, ...changed, cursor: first.nextCursor })).rejects.toThrow('FORUM_SEARCH_INVALID_CURSOR');
    expect((await search.search({ ...args, cursor: first.pageCursor })).candidates.map(p => p.id)).toEqual(first.candidates.map(p => p.id));
  }, 30000);
  test('relative hours are anchored to the original PIT asOf, not a later request clock', async () => {
    const args = { query: '校园', categoryId, hours: 24, limit: 2 }, first = await search.search(args);
    expect((await search.search({ ...args, cursor: first.nextCursor })).asOf).toBe(first.asOf);
    await expect(search.search({ ...args, hours: 48, cursor: first.nextCursor })).rejects.toThrow('FORUM_SEARCH_INVALID_CURSOR');
    await expect(search.search({ ...args, since: new Date('2020-01-01') })).rejects.toThrow('FORUM_SEARCH_INVALID_CURSOR');
  });
  test('authoritative POST_PUBLISHED delivers a newly committed SQL post without trusting its event payload', async () => {
    const published = await db.$transaction(async tx => {
      const post = await tx.post.create({ data: { title: '新发布校园帖子', content: '校园交流新内容', contentFormat: 'plain', userId: owner, categoryId, status: 'APPROVED' } });
      await events.append(tx, { kind: 'POST_PUBLISHED', postId: post.id, postRevision: post.revision, actorId: owner, payload: { title: 'ignored event title' } }); return post;
    });
    postIds.push(published.id); await drain(); await adapter.refresh(firstBuild.indexName);
    const found = await search.search({ query: '新发布', categoryId }); expect(found.candidates.map(post => post.id)).toContain(published.id);
    expect((await adapter.documents(firstBuild.indexName, [published.id]))[0]).toMatchObject({ revision: 1, status: 'APPROVED' });
  });
  test('permanent tombstones and strict external versions block delayed old public writes; explicit restore uses SQL current version', async () => {
    const id = postIds[3], before = await db.post.findUniqueOrThrow({ where: { id } });
    await change(id, 'REJECTED');
    await adapter.bulk(firstBuild.indexName, [{ postId: id, revision: before.revision, status: 'APPROVED', title: 'old', content: 'old', categoryId, userId: owner, tagIds: [], createdAt: before.createdAt.toISOString() }]);
    expect((await adapter.documents(firstBuild.indexName, [id]))[0]).toMatchObject({ status: 'REJECTED', revision: 2 });
    await change(id, 'APPROVED'); expect((await adapter.documents(firstBuild.indexName, [id]))[0]).toMatchObject({ status: 'APPROVED', revision: 3 });
    await db.$transaction(async tx => { await tx.post.delete({ where: { id } }); await events.append(tx, { kind: 'POST_DELETED', postId: id, postRevision: 4, actorId: owner }); });
    await drain(); await indices.syncEvent({ id: 1n, kind: 'POST_UPDATED', postId: id, postRevision: 1 });
    expect((await adapter.documents(firstBuild.indexName, [id]))[0]).toMatchObject({ status: 'DELETED', revision: 4 });
  }, 30000);
  test('expired PIT is a retryable explicit expiry, not an empty search or an implicit SQL substitute', async () => {
    const first = await search.search({ query: '校园', categoryId, limit: 1 }), cursor = JSON.parse(Buffer.from(first.nextCursor.split('.')[0], 'base64url').toString());
    await adapter.closePit(cursor.pit);
    await expect(search.search({ query: '校园', categoryId, limit: 1, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'FORUM_SEARCH_EXPIRED', status: 409 });
  });
  test('late commit of a lower outbox id cannot be skipped by a larger observed id; old index survives replacement', async () => {
    let release!: () => void, ready!: (id: bigint) => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), reserved = new Promise<bigint>(resolve => { ready = resolve; });
    const slow = db.$transaction(async tx => {
      const p = await tx.post.update({ where: { id: postIds[4] }, data: { status: 'REJECTED', revision: { increment: 1 } } });
      const event = await events.append(tx, { kind: 'POST_HIDDEN', postId: p.id, postRevision: p.revision, actorId: owner }); ready(event.id); await gate;
    }, { timeout: 30000 });
    let second: SearchBuild;
    try {
      const lowId = await reserved;
      const high = await db.$transaction(tx => events.append(tx, { kind: 'POST_UPDATED', postId: postIds[5], postRevision: 1, actorId: owner }));
      expect(high.id > lowId).toBe(true);
      second = await newBuild(); expect(BigInt(second.startEventId) > lowId).toBe(true); await scan(second);
    } finally { release(); await slow; }
    await expect(indices.validateBuild(second.id)).rejects.toThrow('FORUM_SEARCH_CONFLICT');
    await indices.runBuildBatch(second.id); await drain(); await adapter.refresh(second.indexName);
    expect((await adapter.documents(second.indexName, [postIds[4]]))[0].status).toBe('REJECTED');
    expect((await indices.validateBuild(second.id)).status).toBe('READY'); await indices.publish(second.id, { confirmation: second.id });
    expect((await indices.status()).activeIndex).toBe(second.indexName); expect((await fetch(endpoint + '/' + firstBuild.indexName, { method: 'HEAD' })).status).toBe(200);
    const alias = await adapter.aliasIndices(); expect(alias).toEqual([second.indexName]);
  }, 45000);
});

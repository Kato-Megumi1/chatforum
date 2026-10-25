import { ForumService } from './forum.service';
import { ForumDiscoveryService } from './forum-discovery.service';
import { ForumSearchError } from './forum-search.adapter';
import { PrismaService } from '../../common/prisma.service';
import { randomUUID } from 'crypto';

const observed = new Date('2026-10-14T01:00:00.000Z');
const result = (ids = [1, 2]) => ({ candidates: ids.map(id => ({ id, revision: 2, snippet: 'bounded fixture excerpt', score: 1 })),
  hasMore: true, nextCursor: 'pit-next', pageCursor: 'pit-first', asOf: observed.toISOString(),
  total: { value: 10, relation: 'eq', observedAt: observed.toISOString(), basis: 'index_pit_not_live_acl' },
  engine: 'opensearch', indexVersion: 'fixture-version', degraded: false });
const row = (id: number, revision = 2) => ({ id, revision, title: 'fixture', excerpt: 'fixture excerpt', snippet: 'fixture snippet',
  createdAt: new Date(observed.getTime() - 3600000), viewCount: 0, likeCount: 0, commentCount: 0,
  categoryId: 3, category: 'fixture category', userId: 7, author: 'fixture author', status: 'APPROVED', contentFormat: 'plain' });
function sqlText(value: any) { return value.sql || value.join('?'); }
function fixture() {
  const checkpoints = new Map<string, any>();
  const db: any = { user: { findFirst: jest.fn(async () => ({ id: 7, role: 'USER' })) },
    category: { findFirst: jest.fn(async () => ({ id: 3 })) },
    post: { findMany: jest.fn(async ({ where }) => [row(1), row(2)].filter(p => where.id.in.includes(p.id))) },
    postTag: { findMany: jest.fn(async () => []) },
    forumQueryCheckpoint: { findUnique: jest.fn(async ({ where }) => checkpoints.get(where.conversationId_filterKey.filterKey) || null),
      findMany: jest.fn(async () => []), deleteMany: jest.fn(),
      upsert: jest.fn(async ({ where, create, update }) => { const key = where.conversationId_filterKey.filterKey;
        const value = checkpoints.has(key) ? { ...checkpoints.get(key), ...update } : create; checkpoints.set(key, value); return value; }) },
    $queryRaw: jest.fn(async (query: any) => {
      const sql = sqlText(query);
      if (sql.includes('FROM conversations')) return [{ id: 11 }];
      if (sql.includes('MAX(id)')) return [{ maxId: 3 }];
      return [row(1), row(2)];
    }) };
  db.$transaction = jest.fn(async fn => fn(db));
  const engine = { search: jest.fn(async (..._args: any[]) => result()) };
  return { db, engine, checkpoints, web: new ForumService(db, undefined, undefined, engine as any),
    agent: new ForumDiscoveryService(db, undefined, engine as any) };
}

describe('forum indexed-search caller contracts (mock read models, no external calls)', () => {
  const previous = process.env.JWT_ACCESS_SECRET;
  beforeAll(() => { process.env.JWT_ACCESS_SECRET = 'forum-contract-fixture-secret-at-least-32'; });
  afterAll(() => { if (previous === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = previous; });
  test('web SQL delivery rechecks every filter and asOf without intersecting a second lexical search; stale revisions are dropped', async () => {
    const { web, db, engine } = fixture(); db.$queryRaw.mockResolvedValue([row(1), row(2, 3)]);
    const found: any = await web.getFeed({ search: '语义查询', categoryId: 3, userId: 7, tagId: 9, limit: 2 });
    expect(found.data.map(p => p.id)).toEqual([1]); expect(found.hasMore).toBe(true); expect(found.nextCursor).toBe('pit-next');
    expect(found.totalScope).toBe('index_pit_not_live_acl'); expect(found.totalObservedAt).toBe(observed.toISOString());
    const query = db.$queryRaw.mock.calls[0][0], sql = sqlText(query);
    for (const fragment of ["p.status='APPROVED'", 'p.categoryId=', 'p.userId=', 'pt.tagId=', 'p.createdAt<=']) expect(sql).toContain(fragment);
    expect(query.values).toEqual(expect.arrayContaining([3, 7, 9, observed])); expect(sql).not.toContain('MATCH('); expect(sql).not.toContain('LOCATE(');
    expect(engine.search.mock.calls[0][0]).toMatchObject({ categoryId: 3, userId: 7, tagId: 9, scopeKey: 'public-web' });
    expect(found.data[0]).not.toHaveProperty('content');
  });
  test('web first-page search failure explicitly degrades to SQL; its next cursor remains on SQL after recovery', async () => {
    const { web, db, engine } = fixture(); engine.search.mockRejectedValue(new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'));
    db.$queryRaw.mockImplementation(async (query: any) => sqlText(query).includes('MAX(id)') ? [{ maxId: 3 }] : [row(1), row(2), row(3)]);
    const first = await web.getFeed({ search: '校园', limit: 2 });
    expect(first.engine).toBe('mysql'); expect(first.degraded).toBe(true); expect(first.nextCursor.startsWith('sql:')).toBe(true);
    engine.search.mockResolvedValue(result()); await web.getFeed({ search: '校园', limit: 2, cursor: first.nextCursor });
    expect(engine.search).toHaveBeenCalledTimes(1);
    await expect(web.getFeed({ search: 'changed', limit: 2, cursor: first.nextCursor })).rejects.toMatchObject({ status: 400 });
  });
  test.each(['FORUM_SEARCH_EXPIRED', 'FORUM_SEARCH_UNAVAILABLE'])('web existing PIT %s never silently substitutes SQL', async code => {
    const { web, db, engine } = fixture(); engine.search.mockRejectedValue(new Error(code));
    await expect(web.getFeed({ search: '校园', cursor: 'existing-pit' })).rejects.toMatchObject({ status: 409 });
    expect(db.$queryRaw).not.toHaveBeenCalled(); expect(db.post.findMany).not.toHaveBeenCalled();
  });
  test('Agent keeps server scope/hours and SQL category/time/status/revision checks, including delivery-time account revocation', async () => {
    const { agent, db, engine } = fixture(); db.$queryRaw.mockImplementation(async query => sqlText(query).includes('FROM conversations') ? [{ id: 11 }] : [row(1), row(2, 3)]);
    const found = await agent.list({ query: '校园', categoryId: 3, hours: 24, limit: 2 }, { userId: 7, conversationId: 11 }, true);
    expect(found.posts.map(p => p.id)).toEqual([1]); expect(found.nextCursor).toBe('os:pit-next'); expect(found.hasMore).toBe(true);
    expect(engine.search.mock.calls[0][0]).toMatchObject({ scopeKey: '7:11', hours: 24, limit: 2 });
    const lookup = db.$queryRaw.mock.calls.map(args => args[0]).find(query => sqlText(query).includes('FROM posts p'));
    expect(sqlText(lookup)).toContain("p.status='APPROVED'"); expect(sqlText(lookup)).toContain('p.categoryId='); expect(sqlText(lookup)).toContain('p.createdAt>=');
    expect(lookup.values).toContainEqual(new Date(observed.getTime() - 24 * 3600000)); expect(lookup.values).toContainEqual(observed);
    expect(sqlText(lookup)).not.toContain('MATCH(');
    db.user.findFirst.mockResolvedValueOnce({ id: 7 }).mockResolvedValueOnce(null);
    await expect(agent.list({ query: '校园', categoryId: 3, hours: 24, limit: 2 }, { userId: 7 }, true)).rejects.toThrow('FORUM_ACCESS_DENIED');
  });
  test('Agent cursor=next restores the original PIT page size instead of the schema default', async () => {
    const { agent, engine } = fixture(), scope = { userId: 7, conversationId: 11 };
    await agent.list({ query: '校园', categoryId: 3, limit: 7 }, scope, true);
    const next = await agent.list({ query: '校园', categoryId: 3, cursor: 'next' }, scope, true);
    expect(engine.search.mock.calls[1][0]).toMatchObject({ cursor: 'pit-next', limit: 7 }); expect(next.requestedLimit).toBe(7);
  });
  test('Agent SQL fallback stays on SQL for next even when OpenSearch recovers; OS expiry never creates a SQL page', async () => {
    const { agent, db, engine } = fixture(), scope = { userId: 7, conversationId: 11 };
    engine.search.mockRejectedValue(new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'));
    db.$queryRaw.mockImplementation(async query => sqlText(query).includes('FROM conversations') ? [{ id: 11 }]
      : sqlText(query).includes('MAX(id)') ? [{ maxId: 3 }] : [row(1), row(2), row(3)]);
    const first = await agent.list({ query: '校园', categoryId: 3, limit: 2 }, scope, true);
    expect(first.engine).toBe('mysql'); expect(first.degraded).toBe(true); expect(first.nextCursor.startsWith('sql:')).toBe(true);
    engine.search.mockResolvedValue(result());
    const next = await agent.list({ query: '校园', categoryId: 3, cursor: 'next' }, scope, true);
    expect(next.requestedLimit).toBe(2);
    expect(engine.search).toHaveBeenCalledTimes(1);
    db.$queryRaw.mockClear(); engine.search.mockRejectedValue(new ForumSearchError('FORUM_SEARCH_EXPIRED', 409));
    await expect(agent.list({ query: '校园', categoryId: 3, limit: 2, cursor: 'os:expired-pit' }, { userId: 7 }, true)).rejects.toThrow('INVALID_CURSOR');
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

const suite = process.env.RUN_FORUM_DISCOVERY_INTEGRATION === '1' ? describe : describe.skip;
suite('indexed caller SQL revalidation: isolated DB with synthetic candidates, no search cluster', () => {
  let db: PrismaService, owner: number, other: number, categoryId: number, secondCategory: number, tagId: number, ids: number[];
  const oldSecret = process.env.JWT_ACCESS_SECRET, prefix = 'search_contract_' + randomUUID().slice(0, 8);
  const at = new Date();
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture DB');
    process.env.JWT_ACCESS_SECRET = 'forum-contract-isolated-secret-at-least-32'; db = new PrismaService(); await db.$connect();
    owner = (await db.user.create({ data: { username: prefix, email: prefix + '@example.test', password: 'disabled-fixture' } })).id;
    other = (await db.user.create({ data: { username: prefix + '_other', email: prefix + '_other@example.test', password: 'disabled-fixture' } })).id;
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    secondCategory = (await db.category.create({ data: { name: prefix + '_other' } })).id;
    tagId = (await db.tag.create({ data: { name: prefix } })).id; ids = [];
    const variations = [{}, { categoryId: secondCategory }, { userId: other }, { skipTag: true }, { createdAt: new Date(at.getTime() + 86400000) },
      { revision: 3 }, { status: 'REJECTED' }, { createdAt: new Date(at.getTime() - 72 * 3600000) }];
    for (const change of variations) {
      const { skipTag, ...data } = change as any;
      const post = await db.post.create({ data: { title: 'synthetic caller fixture', content: 'plain fixture content', contentFormat: 'plain',
        categoryId, userId: owner, status: 'APPROVED', revision: 2, createdAt: new Date(at.getTime() - 3600000), ...data } });
      ids.push(post.id); if (!skipTag) await db.postTag.create({ data: { postId: post.id, tagId } });
    }
  });
  afterAll(async () => {
    if (db) { await db.category.deleteMany({ where: { id: { in: [categoryId, secondCategory].filter(Boolean) } } });
      if (tagId) await db.tag.delete({ where: { id: tagId } }); await db.user.deleteMany({ where: { id: { in: [owner, other].filter(Boolean) } } }); await db.$disconnect(); }
    if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret;
  });
  const engine = () => ({ search: jest.fn(async () => ({ ...result(ids), asOf: at.toISOString(), total: { value: ids.length, relation: 'eq', observedAt: at.toISOString(), basis: 'index_pit_not_live_acl' } })) });
  test('web rejects mismatched category, author, tag, future timestamp, withdrawn status and stale revision in real SQL', async () => {
    const web = new ForumService(db, undefined, undefined, engine() as any);
    const found: any = await web.getFeed({ search: 'semantic query', categoryId, userId: owner, tagId, limit: 10 });
    expect(found.data.map(p => p.id)).toEqual([ids[0], ids[7]]); expect(found.total).toBe(8); expect(found.removedCount).toBe(6);
    expect(found.data.every(p => !('content' in p))).toBe(true);
  });
  test('Agent applies original 24-hour range/category and current status/revision, but all-history stays unbounded', async () => {
    const agent = new ForumDiscoveryService(db, undefined, engine() as any);
    const bounded = await agent.list({ query: 'semantic', categoryId, hours: 24, limit: 10 }, { userId: owner }, true);
    expect(bounded.posts.map(p => p.id)).toEqual([ids[0], ids[2], ids[3]]); expect(bounded.removedCount).toBe(5);
    const all = await agent.list({ query: 'semantic', categoryId, timeRange: 'all', limit: 10 }, { userId: owner }, true);
    expect(all.posts.map(p => p.id)).toContain(ids[7]); expect(all.hours).toBeNull();
  });
});

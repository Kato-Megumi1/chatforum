const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const mod = { exports: {} };
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../src/utils/forum-feed-cache.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', compiled)(mod, mod.exports);
const { ForumFeedCache, FORUM_FEED_CACHE_TTL: ttl, FORUM_FEED_CACHE_MAX_PAGES: max } = mod.exports;
const first = { userId: 1, epoch: 3 }, second = { userId: 2, epoch: 4 };
const query = { categoryId: '', tagId: '', search: '', sortBy: 'createdAt', hotBasis: 'interaction',
  hotPeriod: 'week', pageSize: 20, page: 1, cursor: 'signed-first' };
const value = { data: { data: [{ id: 1, user: { id: 3, isFollowing: false }, isFavorited: false }],
  pageCursor: 'signed-first', nextCursor: 'signed-second', hasMore: true }, likesTotal: null };
function fixture() {
  let now = 10_000;
  const cache = new ForumFeedCache(() => now);
  return { cache, revision: () => cache.revision(first), advance: amount => { now += amount; } };
}

test('TTL is measured from the network response, never extended by returning to a page', () => {
  const f = fixture(); assert(f.cache.write(first, query, value, f.revision()));
  f.advance(ttl - 1); assert(f.cache.read(first, query));
  f.advance(1); assert.equal(f.cache.read(first, query), null);
  assert(f.cache.write(first, query, value, f.revision()));
  f.advance(-1); assert.equal(f.cache.read(first, query), null, 'A backwards wall clock must not preserve a cache indefinitely');
});

test('cached responses and returned objects cannot share mutable favourite/follow state', () => {
  const f = fixture(), response = structuredClone(value);
  assert(f.cache.write(first, query, response, f.revision()));
  response.data.data[0].isFavorited = true;
  const shown = f.cache.read(first, query).value;
  assert.equal(shown.data.data[0].isFavorited, false);
  shown.data.data[0].user.isFollowing = true;
  assert.equal(f.cache.read(first, query).value.data.data[0].user.isFollowing, false);
});

test('all server page/filter/sort inputs separate cache entries, including exact signed cursor', () => {
  const f = fixture(); f.cache.write(first, query, value, f.revision());
  const variations = { categoryId: '2', tagId: '7', search: '海棠', sortBy: 'popular', hotBasis: 'published',
    hotPeriod: 'today', pageSize: 50, page: 2, cursor: 'different-signed-page' };
  for (const [key, changed] of Object.entries(variations)) {
    assert.equal(f.cache.read(first, { ...query, [key]: changed }), null, key + ' is part of the page identity');
  }
  assert.equal(f.cache.read(first, { ...query, cursor: '' }), null, 'An unsigned first-page query must not accidentally reuse a different snapshot');
  assert.equal(f.cache.read(first, query).value.data.pageCursor, 'signed-first');
});

test('switching accounts drops old pages and old responses cannot switch the cache back', () => {
  const f = fixture(), oldRevision = f.revision();
  f.cache.write(first, query, value, oldRevision);
  assert.equal(f.cache.read(second, query), null);
  const secondRevision = f.cache.revision(second);
  assert.equal(f.cache.write(first, query, value, oldRevision), false);
  assert.equal(f.cache.revision(second), secondRevision, 'A late old-account response must not invalidate B');
  assert.equal(f.cache.read(second, query), null);
  assert.equal(f.cache.read(first, query), null, 'Switching back does not revive old pages');
});

test('same account with a new login epoch cannot reuse a previous login page', () => {
  const f = fixture(), oldRevision = f.revision();
  f.cache.write(first, query, value, oldRevision);
  const relogin = { ...first, epoch: first.epoch + 1 };
  assert.equal(f.cache.read(relogin, query), null);
  assert.equal(f.cache.write(first, query, value, oldRevision), false);
});

test('successful mutations and permission/snapshot failures invalidate already in-flight reads', () => {
  const f = fixture(), networkStartedAtRevision = f.revision();
  f.cache.write(first, query, value, networkStartedAtRevision);
  f.cache.invalidate();
  assert.equal(f.cache.read(first, query), null);
  assert.equal(f.cache.write(first, query, value, networkStartedAtRevision), false,
    'A GET started before a confirmed write must not repopulate old favourite/follow state');
  assert(f.cache.write(first, query, value, f.revision()), 'A new explicit read may populate again');
});

test('LRU retention is bounded and a recently revisited signed page stays available', () => {
  const f = fixture();
  for (let page = 1; page <= max; page++) f.cache.write(first, { ...query, page }, value, f.revision());
  assert(f.cache.read(first, query));
  f.cache.write(first, { ...query, page: max + 1 }, value, f.revision());
  assert(f.cache.read(first, query));
  assert.equal(f.cache.read(first, { ...query, page: 2 }), null);
  assert(f.cache.read(first, { ...query, page: max + 1 }));
});

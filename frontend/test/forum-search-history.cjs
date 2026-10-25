const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const mod = { exports: {} };
const code = ts.transpileModule(readFileSync(join(__dirname, '../src/utils/forum-search-history.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', code)(mod, mod.exports);
const { forumSearchHistoryKey, submittedForumQuery, readForumSearchHistory: read, rememberForumSearch: remember,
  removeForumSearch: remove, clearForumSearchHistory: clear, FORUM_SEARCH_HISTORY_MAX_AGE: maxAge } = mod.exports;
const now = Date.UTC(2026, 9, 15);
function fixture() {
  const entries = new Map(), calls = [];
  return { entries, calls, storage: {
    getItem(key) { calls.push(['get', key]); return entries.get(key) || null; },
    setItem(key, value) { calls.push(['set', key]); entries.set(key, value); },
    removeItem(key) { calls.push(['remove', key]); entries.delete(key); },
  } };
}

test('bounded submitted search history is trimmed, de-duplicated and recent-first', () => {
  const f = fixture();
  for (let index = 0; index < 12; index++) assert(remember(1, '词条' + index, f.storage, now + index));
  assert.equal(read(1, f.storage, now + 20).length, 10);
  assert.deepEqual(read(1, f.storage, now + 20).map(entry => entry.query), Array.from({ length: 10 }, (_, index) => '词条' + (11 - index)));
  remember(1, ' 词条5 ', f.storage, now + 30);
  const recent = read(1, f.storage, now + 31);
  assert.equal(recent[0].query, '词条5'); assert.equal(recent.length, 10);
  assert.equal(recent.filter(entry => entry.query === '词条5').length, 1);
});

test('search history is isolated by current account and disabled for guests', () => {
  const f = fixture(); remember(1, 'A 的搜索', f.storage, now);
  assert.deepEqual(read(2, f.storage, now), []); remember(2, 'B 的搜索', f.storage, now);
  assert.equal(read(1, f.storage, now)[0].query, 'A 的搜索'); assert.equal(read(2, f.storage, now)[0].query, 'B 的搜索');
  f.calls.length = 0;
  for (const id of [undefined, 0, -1, NaN, Infinity, 1.5]) {
    assert.equal(forumSearchHistoryKey(id), null); assert.deepEqual(read(id, f.storage, now), []);
    assert.equal(remember(id, '不应保存', f.storage, now), false); assert.equal(clear(id, f.storage), false);
  }
  assert.deepEqual(f.calls, []);
});

test('deleting one query or clearing affects only this account key, never other site data', () => {
  const f = fixture(); f.entries.set('unrelated-site-setting', 'keep');
  remember(1, '一', f.storage, now); remember(1, '二', f.storage, now + 1); remember(2, '别的账号', f.storage, now);
  assert(remove(1, '一', f.storage, now + 2)); assert.deepEqual(read(1, f.storage, now + 2).map(entry => entry.query), ['二']);
  assert(clear(1, f.storage)); assert.deepEqual(read(1, f.storage, now + 2), []);
  assert.equal(read(2, f.storage, now + 2)[0].query, '别的账号'); assert.equal(f.entries.get('unrelated-site-setting'), 'keep');
});

test('expired entries and far-future timestamps do not return as search history', () => {
  const f = fixture(), key = forumSearchHistoryKey(1);
  f.entries.set(key, JSON.stringify({ version: 1, accountId: 1, entries: [
    { query: '过期', submittedAt: now - maxAge }, { query: '未来错误时间', submittedAt: now + 300001 },
    { query: '有效', submittedAt: now - 1000 },
  ] }));
  assert.deepEqual(read(1, f.storage, now).map(entry => entry.query), ['有效']);
});

test('malformed, oversized, wrong-version and wrong-account storage is ignored', () => {
  const f = fixture(), key = forumSearchHistoryKey(1), entry = { query: '测试', submittedAt: now };
  for (const value of ['bad JSON', '[]', 'null', 'x'.repeat(16001),
    JSON.stringify({ version: 2, accountId: 1, entries: [entry] }),
    JSON.stringify({ version: 1, accountId: 2, entries: [entry] }),
    JSON.stringify({ version: 1, accountId: 1, entries: Array(11).fill(entry) })]) {
    f.entries.set(key, value); assert.deepEqual(read(1, f.storage, now), []);
  }
});

test('storage failures never throw and a failed deletion does not report success', () => {
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('full'); }, removeItem() { throw new Error('blocked'); } };
  assert.deepEqual(read(1, unavailable, now), []); assert.equal(remember(1, '提交仍可搜索', unavailable, now), false);
  assert.equal(remove(1, '旧词条', unavailable, now), false); assert.equal(clear(1, unavailable), false);
});

test('only valid submitted text is recorded, not empty/control/oversized values', () => {
  const f = fixture();
  for (const query of ['', '   ', null, {}, 'a'.repeat(201), '隐藏\u0000内容', '第一行\n第二行']) {
    assert.equal(submittedForumQuery(query), ''); assert.equal(remember(1, query, f.storage, now), false);
  }
  assert.deepEqual(f.calls, []); assert.equal(submittedForumQuery(' 中文  搜索 '), '中文  搜索');
});

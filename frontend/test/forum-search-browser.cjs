// Explicit local browser test. History and every account/forum API use synthetic fixtures.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs'), { join } = require('node:path');
const base = process.env.FORUM_SEARCH_TEST_BASE || 'http://127.0.0.1:4188/';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local fixture pages only');
const output = join(__dirname, '../../.local/forum-search'); mkdirSync(output, { recursive: true });
const viewer = { id: 99081, username: 'Synthetic viewer', email: 'fixture@example.test', role: 'USER' };
const key = id => 'chatforum-forum-search-history-v1:' + id;
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    page.setDefaultTimeout(12000);
    const errors = [], queries = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ viewer, firstKey, secondKey }) => {
      localStorage.setItem('chatforum-user', JSON.stringify({ user: viewer, token: 'synthetic', refreshToken: '' }));
      const saved = (id, queries) => JSON.stringify({ version: 1, accountId: id, entries: queries.map((query, index) => ({ query, submittedAt: Date.now() - index * 1000 })) });
      localStorage.setItem(firstKey, saved(99081, ['A 最近搜索', 'A 旧搜索']));
      localStorage.setItem(secondKey, saved(99083, ['B 私有搜索']));
      localStorage.setItem('unrelated-site-setting', 'keep');
    }, { viewer, firstKey: key(viewer.id), secondKey: key(99083) });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      let data = [];
      if (path === '/api/forum/feed') {
        const query = Object.fromEntries(url.searchParams); queries.push(query);
        data = { data: [{ id: 1, title: 'Synthetic forum search result', summary: 'Synthetic summary',
          user: { id: 99082, username: 'Synthetic author', isFollowing: false }, category: { name: '校园生活' },
          isFavorited: false, viewCount: 3, commentCount: 1, likeCount: 0, createdAt: '2026-10-15T01:00:00Z' }],
          pageCursor: query.cursor || 'fixture-start', hasMore: query.cursor !== 'fixture-next', nextCursor: query.cursor === 'fixture-next' ? null : 'fixture-next' };
      }
      if (path === '/api/forum/categories') data = [{ id: 1, name: '校园生活', _count: { posts: 1 } }];
      if (path.includes('unread')) data = { unreadCount: 0, requests: 0 };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
    });
    const stored = id => page.evaluate(key => JSON.parse(localStorage.getItem(key) || 'null'), key(id));
    const searched = term => page.waitForFunction(term => new URLSearchParams(location.search).get('q') === term, term);
    const switchAccount = id => page.evaluate(({ id, viewer }) => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('user');
      if (id) { store.setUser({ ...viewer, id, username: 'Synthetic account ' + id }); store.setToken('synthetic-' + id, ''); }
      else store.clearAuth();
    }, { id, viewer });
    await page.goto(base + 'forum'); await page.locator('article.post-card').first().waitFor();
    const search = page.getByRole('textbox', { name: '搜索帖子', exact: true });
    const firstTop = (await page.locator('article.post-card').first().boundingBox()).y;
    assert.equal(await page.getByRole('region', { name: '搜索历史' }).count(), 0, 'History must not occupy the first screen before focus');
    await search.focus();
    const history = page.getByRole('region', { name: '搜索历史' }); await history.waitFor();
    assert.equal((await page.locator('article.post-card').first().boundingBox()).y, firstTop, 'Focused history overlays instead of pushing the feed');
    assert.equal(await page.getByRole('button', { name: 'B 私有搜索', exact: true }).count(), 0);
    const beforeTyping = await stored(viewer.id), initialCalls = queries.length;
    await search.fill('尚未提交的输入');
    assert.deepEqual(await stored(viewer.id), beforeTyping); assert.equal(queries.length, initialCalls, 'Typing must not search or save history');
    await search.evaluate(input => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    await page.waitForTimeout(50); assert.equal(queries.length, initialCalls, 'IME commit is not an explicit submission');
    await search.press('Escape'); await history.waitFor({ state: 'hidden' });
    await search.press('ArrowDown'); await history.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent.trim()), 'A 最近搜索');
    await page.keyboard.press('Enter'); await searched('A 最近搜索');
    assert.equal(queries.at(-1).search, 'A 最近搜索'); assert.equal(queries.at(-1).cursor, undefined);
    assert.equal((await stored(viewer.id)).entries[0].query, 'A 最近搜索');
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await page.waitForFunction(() => location.search.includes('cursor=fixture-next'));
    await search.fill(' 新提交搜索 '); await search.press('Enter'); await searched('新提交搜索');
    assert.equal(queries.at(-1).cursor, undefined, 'A new submission must use normal applyFilters to clear the signed cursor');
    assert.equal((await stored(viewer.id)).entries[0].query, '新提交搜索');
    await search.click(); await history.waitFor();
    await history.getByRole('button', { name: 'A 旧搜索', exact: true }).click(); await searched('A 旧搜索');
    assert.equal((await stored(viewer.id)).entries[0].query, 'A 旧搜索');
    await search.click(); await history.waitFor();
    const beforeRemoval = queries.length;
    const removeButton = history.getByRole('button', { name: '删除搜索记录：A 最近搜索', exact: true });
    await removeButton.focus(); await removeButton.press('Enter');
    assert.equal((await stored(viewer.id)).entries.some(entry => entry.query === 'A 最近搜索'), false);
    assert.equal(queries.length, beforeRemoval, 'Deleting a term must not submit a search');
    assert(await page.evaluate(() => document.activeElement?.classList.contains('history-query')), 'Keyboard deletion restores focus to a remaining history item');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `history-${width}.png`), fullPage: true });
    await page.locator('.page-label').click(); await history.waitFor({ state: 'hidden' });
    await search.click(); await history.waitFor();
    await history.getByRole('button', { name: '清空', exact: true }).click();
    await history.waitFor({ state: 'hidden' }); assert.equal(await stored(viewer.id), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('unrelated-site-setting')), 'keep');
    assert.equal((await stored(99083)).entries[0].query, 'B 私有搜索');
    assert.equal(queries.length, beforeRemoval, 'Clearing history must not change the active query');

    await search.fill('A 再次提交'); await search.press('Enter'); await searched('A 再次提交');
    await search.click(); await page.locator('.forum-search-input .el-input__clear').click();
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('q'));
    assert.equal((await stored(viewer.id)).entries[0].query, 'A 再次提交', 'Clearing the input does not delete submitted history');
    await search.fill('A 再次提交'); await search.press('Enter'); await searched('A 再次提交');
    await search.click(); await history.waitFor(); await switchAccount(99083);
    await history.waitFor({ state: 'hidden' }); await search.click(); await history.waitFor();
    assert.equal(await history.getByRole('button', { name: 'A 再次提交', exact: true }).count(), 0);
    await history.getByRole('button', { name: 'B 私有搜索', exact: true }).click(); await searched('B 私有搜索');
    await switchAccount(null); await search.click();
    assert.equal(await history.count(), 0, 'Guests must not see a previous account history');
    await search.fill('访客提交'); await search.press('Enter'); await searched('访客提交');
    assert.equal(await stored(0), null);
    await page.evaluate(key => localStorage.setItem(key, '{malformed fixture'), key(viewer.id));
    await switchAccount(viewer.id); await search.click();
    assert.equal(await history.count(), 0, 'Malformed saved history is ignored');
    await search.fill('畸形存储后的有效搜索'); await search.press('Enter'); await searched('畸形存储后的有效搜索');
    assert.equal((await stored(viewer.id)).entries[0].query, '畸形存储后的有效搜索');
    assert.deepEqual(errors, []); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log(`PASS ${width}px: focus-only history, explicit submit/IME, keyboard/touch selection, signed cursor reset, delete/clear, account/guest isolation, malformed storage`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

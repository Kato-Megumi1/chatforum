// Local synthetic fixtures only: no accounts, live forum writes or model calls.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = process.env.FORUM_LOADING_TEST_BASE || 'http://127.0.0.1:4188/';
const origin = new URL(base).origin;
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = join(__dirname, '../../.local/forum-loading');
mkdirSync(output, { recursive: true });
const user = { id: 99101, username: 'Synthetic viewer', email: 'fixture@example.test', role: 'USER' };
const author = { id: 99102, username: 'Synthetic author', avatar: '', isFollowing: false };
const date = '2026-10-15T01:00:00Z';
const post = (id, title = '虚构的校园讨论 ' + id) => ({ id, title, summary: '测试摘要，不含任何真实内容。', content: '测试正文。', contentFormat: 'PLAIN',
  user: author, category: { id: 1, name: '校园生活' }, tags: [], isFavorited: false, isLiked: false, commentCount: 0, viewCount: 1, likeCount: 0, createdAt: date });
const feed = (title) => ({ data: Array.from({ length: 12 }, (_, index) => post(index + 1, title ? title + ' ' + index : undefined)),
  hasMore: true, nextCursor: 'synthetic-next', pageCursor: 'synthetic-first', asOf: date });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    page.setDefaultTimeout(12000);
    const errors = [], feedCalls = [], badges = { notifications: 0, direct: 0 };
    let nextResponse = null;
    const queue = handler => { const started = deferred(); nextResponse = { handler, started }; return started.promise; };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic', refreshToken: '' })), user);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      const ok = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) }).catch(() => {});
      if (path === '/api/forum/notifications/unread-count') { badges.notifications++; return ok({ unreadCount: 2 }); }
      if (path === '/api/direct-messages/unread-count') { badges.direct++; return ok({ inbox: 1, requests: 0, total: 1 }); }
      if (path === '/api/forum/categories') return ok([{ id: 1, name: '校园生活' }]);
      if (path === '/api/forum/tags') return ok([]);
      if (path === '/api/forum/feed') {
        feedCalls.push(Object.fromEntries(url.searchParams));
        const queued = nextResponse; nextResponse = null;
        if (queued) { queued.started.resolve(); return queued.handler(route, ok); }
        return ok(feed());
      }
      if (/\/forum\/posts\/\d+\/comments$/.test(path)) return ok({ data: [], total: 0 });
      if (/\/forum\/posts\/\d+\/view$/.test(path)) return ok({ viewCount: 2 });
      if (/\/forum\/posts\/\d+$/.test(path)) return ok(post(Number(path.split('/').at(-1))));
      return ok([]);
    });

    const first = deferred(); queue(async (_route, ok) => { await first.promise; return ok(feed()); });
    await page.goto(base + 'forum');
    await page.locator('.feed-skeleton').waitFor();
    assert.equal(await page.locator('article.post-card').count(), 0);
    assert.equal(await page.locator('.post-skeleton').count(), 4);
    await page.screenshot({ path: join(output, `skeleton-${width}.png`), fullPage: true });
    first.resolve(); await page.locator('article.post-card').first().waitFor();
    await page.waitForTimeout(150);
    assert.deepEqual(badges, { notifications: 1, direct: 1 }, 'initial layout+route events share badge reads');

    await page.locator('.forum-container').evaluate(el => { el.scrollTop = 400; });
    const beforeScroll = await page.locator('.forum-container').evaluate(el => el.scrollTop);
    await page.locator('article.post-card').nth(3).locator('.post-content-link').click();
    await page.locator('.post-page').waitFor();
    const back = deferred(); const backStarted = queue(async (_route, ok) => { await back.promise; return ok(feed('已核对的新列表')); });
    await page.goBack(); await backStarted;
    await page.locator('article.post-card').first().waitFor();
    assert(await page.locator('.feed-loading-status').isVisible(), 'cached feed is displayed while refresh is pending');
    assert.equal(await page.locator('.feed-skeleton').count(), 0);
    assert((await page.locator('article.post-card').first().innerText()).includes('虚构的校园讨论'));
    const cachedScroll = await page.locator('.forum-container').evaluate(el => el.scrollTop);
    assert(Math.abs(cachedScroll - beforeScroll) < 5, `cached scroll restored: ${beforeScroll} / ${cachedScroll}`);
    back.resolve(); await page.getByRole('heading', { name: '已核对的新列表 0', exact: true }).waitFor();
    const freshScroll = await page.locator('.forum-container').evaluate(el => el.scrollTop);
    assert(Math.abs(freshScroll - beforeScroll) < 5, `background refresh scroll: expected ${beforeScroll}, got ${freshScroll}`);
    assert.deepEqual(badges, { notifications: 1, direct: 1 }, 'quick detail return reuses badge success TTL');

    await page.locator('article.post-card').nth(3).locator('.post-content-link').click(); await page.locator('.post-page').waitFor();
    queue(route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic network failure' }) }));
    await page.goBack(); await page.getByText('更新失败，当前显示上次列表', { exact: true }).waitFor();
    assert.equal(await page.locator('article.post-card').count(), 12);
    assert.equal(await page.locator('.el-message--error').count(), 0, 'inline failure needs no duplicate toast');
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByText('更新失败，当前显示上次列表', { exact: true }).waitFor({ state: 'hidden' });

    // Slow read: retain no fake loading promise forever; explicit retry replaces its generation.
    const slow = deferred(); const slowStarted = queue(async (_route, ok) => { await slow.promise; return ok(feed('不应覆盖的旧响应')); });
    await page.locator('.search-input input').fill('慢请求');
    await page.locator('.search-input input').press('Enter'); await slowStarted;
    await page.locator('.feed-skeleton').waitFor();
    await page.getByText('网络响应较慢，可以继续等待或重试。', { exact: true }).waitFor();
    await page.locator('.search-input input').fill('尚未提交的搜索');
    queue((_route, ok) => ok(feed('重试成功')));
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByRole('heading', { name: '重试成功 0', exact: true }).waitFor();
    assert.equal(feedCalls.at(-1).search, '慢请求', 'retry keeps the committed query, not the unsubmitted draft');
    slow.resolve(); await page.waitForTimeout(150);
    assert.equal(await page.getByRole('heading', { name: '不应覆盖的旧响应 0', exact: true }).count(), 0);
    assert.equal(await page.locator('.el-message--error').count(), 0, 'aborted old read stays silent');
    for (const status of [403, 409]) {
      await page.locator('.forum-container').evaluate(el => { el.scrollTop = 0; });
      await page.locator('article.post-card').first().locator('.post-content-link').click(); await page.locator('.post-page').waitFor();
      const denied = deferred(); const deniedStarted = queue(async route => {
        await denied.promise;
        return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic stale permission or cursor' }) });
      });
      await page.goBack(); await deniedStarted;
      await page.locator('article.post-card').first().waitFor();
      denied.resolve();
      await page.locator('article.post-card').first().waitFor({ state: 'hidden' });
      if (status === 409) {
        await page.getByText('列表已过期，请刷新。', { exact: true }).waitFor();
        await page.getByRole('button', { name: '刷新首屏', exact: true }).click();
      } else {
        await page.getByText('暂时没能加载帖子，请重试', { exact: true }).waitFor();
        await page.getByRole('button', { name: '重新加载', exact: true }).click();
      }
      await page.locator('article.post-card').first().waitFor();
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `recovered-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: skeleton, cached return/scroll, background failure/retry, 6s slow hint, committed query, cancelled stale response, 403/409 invalidation and coalesced badges (${feedCalls.length} feed reads)`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

// Explicit synthetic browser acceptance: run against a local Vite server, never production APIs.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs'), { join } = require('node:path');
const base = process.env.COMMUNITY_TEST_BASE || 'http://127.0.0.1:4188/';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'This fixture requires a local test page');
const viewer = { id: 99081, username: 'Synthetic viewer', email: 'fixture@example.test', role: 'USER', points: 0, level: 1, bio: 'Synthetic profile' };
const output = join(__dirname, '../../.local/community-ui'); mkdirSync(output, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    const errors = [], peopleRequests = [], notificationQueries = [];
    let notificationFailure = true, favoritesFailure = true, lastRead = false, nextPeopleFailure = true;
    let holdNextLike = false, releaseLike, likeStarted = () => {};
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-token', refreshToken: '' })), viewer);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      const ok = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      const fail = () => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Synthetic temporary failure' }) });
      if (path === '/api/forum/notifications/unread-count') return ok({ unreadCount: lastRead ? 20 : 21 });
      if (path === '/api/forum/subscriptions') return ok([]);
      if (path === '/api/forum/notifications/21/read') { lastRead = true; return ok({}); }
      if (path === '/api/forum/notifications') {
        const query = Object.fromEntries(url.searchParams); notificationQueries.push(query);
        if (notificationFailure) return fail();
        const type = query.type || '';
        if (type) {
          const offset = { COMMENT: 100, LIKE: 200, FOLLOW: 300, SYSTEM: 400 }[type];
          assert(offset, 'Only supported server notification types are sent');
          const pageNumber = Number(query.page || 1), count = pageNumber === 3 ? 1 : 20;
          const data = { data: Array.from({ length: count }, (_, index) => ({
            id: offset + (pageNumber - 1) * 20 + index + 1, title: type + ' Synthetic notification ' + (offset + (pageNumber - 1) * 20 + index + 1),
            content: 'Synthetic classified message', type, createdAt: '2026-10-15T01:00:00Z', isRead: true, url: null,
          })), total: 41, unreadCount: lastRead ? 20 : 21 };
          if (type === 'LIKE' && holdNextLike) {
            holdNextLike = false;
            await new Promise(resolve => { releaseLike = resolve; likeStarted(); });
            // An older filter response must not replace either the current list or global badge.
            data.unreadCount = 777;
          }
          return ok(data);
        }
        const secondPage = url.searchParams.get('page') === '2';
        const ids = secondPage && !lastRead ? [21] : Array.from({ length: 20 }, (_, index) => index + 1);
        return ok({ data: ids.map(id => ({ id, title: 'Synthetic notification ' + id, content: 'Synthetic notification content ' + 'A'.repeat(120), createdAt: '2026-10-15T01:00:00Z', isRead: false, url: '/forum/post/' + id })), total: lastRead ? 20 : 21, unreadCount: lastRead ? 20 : 21 });
      }
      if (path === '/api/forum/me/favorites') {
        if (favoritesFailure) return fail();
        return ok({ data: [{ id: 55, title: 'Synthetic favorite', summary: 'Synthetic summary', createdAt: '2026-10-15T01:00:00Z', commentCount: 0 }], total: 1 });
      }
      if (path === '/api/users/99082') return ok({ ...viewer, id: 99082, username: 'Synthetic author', _count: { posts: 0, followers: 2, following: 0 } });
      if (path === '/api/users/99082/followers') {
        const cursor = url.searchParams.get('cursor'); peopleRequests.push(cursor);
        if (cursor && nextPeopleFailure) { nextPeopleFailure = false; return fail(); }
        return ok({ data: [{ id: cursor ? 99084 : 99083, username: cursor ? 'Synthetic second person' : 'Synthetic first person', bio: 'B'.repeat(120), isFollowing: false }], hasMore: !cursor, nextCursor: cursor ? null : 40 });
      }
      if (path === '/api/forum/posts') return ok({ data: [], total: 0 });
      if (path.includes('/unread-count')) return ok({ unreadCount: 0 });
      if (path === '/api/users/profile') return ok(viewer);
      return ok([]);
    });

    await page.goto(base + 'notifications');
    assert.equal(await page.locator('.subscription-card .heading p, .subscription-note').count(), 0, 'No redundant background-processing tutorial');
    await page.getByText('暂时没能加载消息通知，请重试', { exact: true }).waitFor();
    assert.equal(await page.getByText('暂时没有新消息', { exact: true }).count(), 0);
    await page.screenshot({ path: join(output, `notifications-error-${width}.png`), fullPage: true });
    notificationFailure = false; await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByText('Synthetic notification 1', { exact: true }).waitFor();
    await page.locator('.el-radio-button').filter({ hasText: /^未读$/ }).click();
    await page.locator('.el-pagination .btn-next').click();
    const last = page.locator('.notification-item').filter({ hasText: 'Synthetic notification 21' });
    await last.waitFor(); await last.getByRole('button', { name: '标记已读', exact: true }).click();
    await page.getByText('Synthetic notification 1', { exact: true }).waitFor();
    assert.equal(await page.getByText('Synthetic notification 21', { exact: true }).count(), 0);
    assert.equal(await page.locator('.el-pagination').count(), 0);

    // Classification is a server filter, while the heading badge remains the global unread count.
    await page.locator('.el-radio-button').filter({ hasText: /^全部$/ }).click();
    const types = page.getByRole('navigation', { name: '消息分类' });
    await types.getByRole('button', { name: '评论与回复', exact: true }).click();
    await page.getByText('COMMENT Synthetic notification 101', { exact: true }).waitFor();
    assert.equal(notificationQueries.at(-1).type, 'COMMENT'); assert.equal(notificationQueries.at(-1).page, '1');
    assert.equal(notificationQueries.at(-1).unreadOnly, 'false');
    await page.locator('.el-pagination .btn-next').click();
    await page.getByText('COMMENT Synthetic notification 121', { exact: true }).waitFor();
    assert.equal(notificationQueries.at(-1).page, '2');
    await types.getByRole('button', { name: '新增关注', exact: true }).click();
    await page.getByText('FOLLOW Synthetic notification 301', { exact: true }).waitFor();
    assert.equal(notificationQueries.at(-1).type, 'FOLLOW'); assert.equal(notificationQueries.at(-1).page, '1');
    await page.getByText('20 条未读', { exact: true }).waitFor();

    const started = new Promise(resolve => { likeStarted = resolve; });
    const lateResponse = page.waitForResponse(response => {
      const url = new URL(response.url()); return url.pathname === '/api/forum/notifications' && url.searchParams.get('type') === 'LIKE';
    });
    holdNextLike = true;
    await types.getByRole('button', { name: '收到的赞', exact: true }).click(); await started;
    await types.getByRole('button', { name: '系统与追踪', exact: true }).click();
    await page.getByText('SYSTEM Synthetic notification 401', { exact: true }).waitFor();
    assert.equal(notificationQueries.at(-1).type, 'SYSTEM'); assert.equal(notificationQueries.at(-1).page, '1');
    releaseLike(); await lateResponse; await page.waitForTimeout(100);
    assert.equal(await page.getByText('LIKE Synthetic notification 201', { exact: true }).count(), 0);
    assert.equal(await types.getByRole('button', { name: '系统与追踪', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByText('20 条未读', { exact: true }).waitFor();
    assert.equal(await page.locator('.notification-list').getAttribute('aria-busy'), 'false');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Notification type filters must not overflow the viewport');
    await page.screenshot({ path: join(output, `notification-types-${width}.png`), fullPage: true });
    await types.getByRole('button', { name: '全部消息', exact: true }).click();
    await page.getByText('Synthetic notification 1', { exact: true }).waitFor();
    assert.equal(notificationQueries.at(-1).type, undefined); assert.equal(notificationQueries.at(-1).page, '1');
    assert(['COMMENT', 'LIKE', 'FOLLOW', 'SYSTEM'].every(type => notificationQueries.some(query => query.type === type)));

    await page.goto(base + 'user/profile?activity=favorites');
    await page.getByText('暂时没能加载社区内容，请重试', { exact: true }).waitFor();
    favoritesFailure = false; await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.getByText('Synthetic favorite', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '我的收藏', exact: true }).count(), 1);

    await page.goto(base + 'user/99082?people=followers');
    await page.getByText('Synthetic first person', { exact: true }).waitFor();
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await page.getByRole('button', { name: '重试加载更多', exact: true }).waitFor();
    await page.getByRole('button', { name: '重试加载更多', exact: true }).click();
    await page.getByText('Synthetic second person', { exact: true }).waitFor();
    assert.equal(await page.getByText('Synthetic first person', { exact: true }).count(), 1);
    assert.deepEqual(peopleRequests, [null, '40', '40']);
    await page.screenshot({ path: join(output, `people-retry-${width}.png`), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal viewport overflow');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: notification types are server filters, page reset + stale-response isolation + global badge; original retry/unread-last-page/people-seek cases preserved; no page errors/overflow`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

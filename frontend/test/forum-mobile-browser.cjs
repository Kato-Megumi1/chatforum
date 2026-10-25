// Run explicitly against local Vite. All forum/account APIs are synthetic and intercepted.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs'), { join } = require('node:path');
const base = process.env.FORUM_MOBILE_TEST_BASE || 'http://127.0.0.1:4188/';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local fixture pages only');
const output = join(__dirname, '../../.local/forum-mobile'); mkdirSync(output, { recursive: true });
const user = { id: 99081, username: 'Synthetic viewer', email: 'fixture@example.test', role: 'USER' };
const date = '2026-10-15T01:00:00Z';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [320, 390, 1440]) {
    const mobile = width <= 900, page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(12000);
    const errors = [], queries = []; let status = 'ready', degraded = false, failLoad = false;
    const post = id => ({ id, title: '校园活动与学习交流：这是验收用的虚构帖子', summary: '虚构帖子摘要，检验手机内容层级与可读性。',
      user: { id: 99082, username: 'Synthetic long author name', avatar: '', isFollowing: false }, category: { id: 1, name: '校园生活' },
      isFavorited: false, commentCount: 12, viewCount: 130, likeCount: 7, createdAt: date });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic', refreshToken: '' })), user);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      const ok = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      if (path === '/api/forum/categories') return ok([{ id: 1, name: '校园生活', _count: { posts: 1 } }, { id: 2, name: '学习交流', _count: { posts: 1 } }]);
      if (path === '/api/forum/tags') return ok([{ id: 4, name: '校园活动' }, { id: 5, name: '学习资料' }]);
      if (path === '/api/forum/subscriptions') return ok({ enabled: true });
      if (path === '/api/forum/feed' || path === '/api/forum/posts') {
        const query = Object.fromEntries(url.searchParams); queries.push(query);
        if (failLoad) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic retryable failure' }) });
        const hot = query.sort === 'hot';
        return ok({ data: hot && status === 'not_ready' ? [] : [post(query.cursor === 'fixture-next' ? 2 : 1)],
          total: 1, hasMore: query.cursor !== 'fixture-next', nextCursor: query.cursor === 'fixture-next' ? null : 'fixture-next',
          pageCursor: query.cursor || 'fixture-first', asOf: date, degraded,
          ...(hot ? { snapshot: { status, asOf: date, ...(query.hotBasis !== 'published' ? { windowCountsBasis: 'signed_net_deltas_since_activation' } : {}) } } : {}) });
      }
      if (path.includes('unread')) return ok({ unreadCount: 0, requests: 0 });
      return ok([]);
    });
    const goto = async path => { await page.goto(base + path); await page.locator('.forum-content').waitFor(); };
    const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No viewport overflow');
    await goto('forum'); await page.locator('article.post-card').first().waitFor();
    const latestTop = (await page.locator('article.post-card').first().boundingBox()).y;
    if (mobile) assert(latestTop < 280, `Latest first post is too low: ${latestTop}px`);
    assert.equal(await page.locator('a a, a button').count(), 0, 'Post controls must not be nested links/buttons');
    await noOverflow();
    await page.screenshot({ path: join(output, `latest-${width}.png`), fullPage: true });

    await goto('forum?sort=popular&period=week'); await page.locator('article.post-card').first().waitFor();
    const hotTop = (await page.locator('article.post-card').first().boundingBox()).y;
    if (mobile) {
      assert(hotTop < 300, `Hot first post is too low: ${hotTop}px`);
      assert.equal(await page.locator('.forum-hero').isVisible(), false);
      assert.equal(await page.locator('.forum-sidebar').isVisible(), false);
      await page.getByRole('button', { name: /^筛选/ }).click();
      const drawer = page.getByRole('dialog', { name: '筛选与追踪' }); await drawer.waitFor();
      await drawer.getByRole('combobox', { name: '筛选分类' }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('option', { name: '校园生活', exact: true }).click();
      await page.waitForFunction(() => location.search.includes('category=1'));
      await drawer.getByRole('combobox', { name: '筛选标签' }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('option', { name: '校园活动', exact: true }).click();
      await page.waitForFunction(() => location.search.includes('tag=4'));
      assert.equal(await drawer.getByRole('button', { name: '追踪热榜变化', exact: true }).isDisabled(), true, 'Unsupported tag scope cannot create a watch');
      await drawer.getByRole('combobox', { name: '筛选热榜口径' }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('option', { name: '发布衰减', exact: true }).click();
      await drawer.getByRole('combobox', { name: '筛选热榜范围' }).focus(); await page.keyboard.press('Enter');
      await page.getByRole('option', { name: '24 小时发布', exact: true }).click();
      await page.waitForFunction(() => location.search.includes('period=today') && location.search.includes('hotBasis=published'));
      await page.waitForTimeout(100);
      assert(queries.some(query => query.categoryId === '1' && query.tagId === '4' && query.hotPeriod === 'today' && query.hotBasis === 'published' && !query.cursor));
      await page.screenshot({ path: join(output, `filters-${width}.png`), fullPage: true });
      await drawer.getByRole('button', { name: '查看帖子', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.waitForFunction(() => location.search.includes('cursor=fixture-next'));
      await page.locator('article.post-card').first().waitFor();
      await page.getByRole('button', { name: /^筛选/ }).click(); await drawer.waitFor();
      await drawer.getByRole('button', { name: '清除筛选', exact: true }).click();
      await page.waitForFunction(() => !location.search.includes('category=') && !location.search.includes('tag=') && !location.search.includes('cursor='));
      await drawer.getByRole('button', { name: '查看帖子', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
    } else {
      assert.equal(await page.locator('.forum-hero').isVisible(), true);
      assert.equal(await page.locator('.forum-sidebar').isVisible(), true);
      assert.equal(await page.locator('.content-toolbar > .hot-period').count(), 2);
      assert.equal(await page.locator('.mobile-filter-button').isVisible(), false);
      assert.equal(await page.locator('.desktop-feed-detail.feed-tracking').isVisible(), true);
    }
    await goto('forum?sort=popular&period=week'); await page.locator('article.post-card').first().waitFor();
    await page.screenshot({ path: join(output, `hot-${width}.png`), fullPage: true }); await noOverflow();
    status = 'stale'; await goto('forum?sort=popular&period=week');
    await page.getByText('热榜更新延迟，暂显示上次结果。', { exact: true }).waitFor();
    status = 'not_ready'; await goto('forum?sort=popular&period=week');
    await page.getByText('热榜尚未就绪，请稍后刷新。', { exact: true }).waitFor();
    assert.equal(await page.getByText('暂无帖子', { exact: true }).count(), 0);
    degraded = true; status = 'ready'; await goto('forum?q=校园');
    await page.getByText('全文搜索暂不可用，已切换关键词匹配。', { exact: true }).waitFor();
    failLoad = true; await goto('forum');
    await page.getByText('暂时没能加载帖子，请重试', { exact: true }).waitFor();
    failLoad = false; await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.locator('article.post-card').first().waitFor(); await noOverflow();
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: latest y=${Math.round(latestTop)}, hot y=${Math.round(hotTop)}; filters/cursor and status errors checked; desktop preserved`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

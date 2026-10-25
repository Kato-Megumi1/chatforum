// All APIs are intercepted. No real users, email, forum data, model calls or production writes.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.FORUM_PIPELINE_TEST_BASE || 'http://127.0.0.1:4186/';
const origin = new URL(base).origin;
const user = { id: 99155, username: '追踪验收成员', email: 'watch@example.test', role: 'USER', level: 1, points: 0 };
const categories = [{ id: 1, name: '校园生活', _count: { posts: 120 } }, { id: 2, name: '图书交流', _count: { posts: 80 } }];
const response = data => ({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
const post = id => ({ id, title: '隔离验收帖子 ' + id, userId: user.id, user, categoryId: 2, category: categories[1],
  summary: '虚构摘要，仅验证界面。', content: '虚构正文，不读取真实论坛。', contentFormat: 'plain', revision: 1,
  tags: [], createdAt: '2026-10-14T02:00:00Z', viewCount: 12, likeCount: 3, commentCount: 0 });
const idle = page => page.waitForFunction(() => !document.querySelector('.post-list > .el-loading-mask'));
async function go(page, path) {
  if (page.url() === 'about:blank') return page.goto(base + path.replace(/^\//, ''));
  await page.evaluate(path => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path), path);
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 900, hasTouch: width < 900 });
      page.setDefaultTimeout(15000);
      const errors = [], writes = [], feeds = [], watches = new Map([[user.id, []], [99156, [{ id: 900, kind: 'NEW_POSTS', enabled: true,
        filtersJson: { query: '另账号专属关键词', categoryId: null }, cooldownSeconds: 3600 }]]]);
      let account = user.id, nextId = 1, hotStatus = 'ready', delayPostWatch = false, slowSubscriptions = false, subReads = 0, failPatch = false;
      const longCursor = 'pit.' + 'p'.repeat(9000) + '.fixture';
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-watch-token', refreshToken: '' })), user);
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method(), owner = account;
        if (p.startsWith('/api/')) {
          if (method === 'OPTIONS') return route.fulfill({ status: 204 });
          let data = [];
          if (method !== 'GET') writes.push({ p, method, owner, body: req.postData() ? req.postDataJSON() : null });
          if (p === '/api/forum/categories') data = categories;
          if (p === '/api/forum/tags') data = [{ id: 3, name: '虚构标签' }];
          if (p === '/api/forum/notifications/unread-count') data = { unreadCount: 0 };
          if (p === '/api/forum/notifications') data = { data: [], total: 0, unreadCount: 0 };
          if (p === '/api/forum/feed') {
            const q = Object.fromEntries(url.searchParams); feeds.push(q);
            const hot = q.sort === 'hot', blocked = hot && ['not_ready', 'disabled', 'unsupported_scope'].includes(hotStatus);
            if (hot) assert.equal(q.hotBasis, 'interaction', 'new hot navigation explicitly selects interaction basis');
            data = { data: blocked ? [] : [post(q.cursor ? 12 : 11)], hasMore: !q.cursor && !hot,
              nextCursor: !q.cursor && !hot ? longCursor + '-2' : null, pageCursor: hot ? 'hot-fixture' : q.cursor || longCursor,
              asOf: '2026-10-14T02:30:00Z', engine: q.search ? 'mysql' : undefined, degraded: !!q.search,
              degradationReason: q.search ? 'search_unavailable_sql_fallback' : undefined,
              snapshot: hot ? { status: hotStatus, asOf: '2026-10-14T02:30:00Z', coverageLimited: true, coverageLimit: 200,
                paging: 'snapshot', windowCountsBasis: 'signed_net_deltas_since_activation' } : null };
          }
          if (/^\/api\/forum\/posts\/\d+$/.test(p)) data = post(Number(p.split('/').at(-1)));
          if (/^\/api\/forum\/posts\/\d+\/comments$/.test(p)) data = { data: [], total: 0, activeCount: 0, page: 1 };
          if (/^\/api\/forum\/posts\/\d+\/view$/.test(p)) data = { counted: false, viewCount: 12 };
          if (p === '/api/forum/subscriptions' && method === 'GET') {
            subReads++; data = structuredClone(watches.get(owner) || []);
            if (slowSubscriptions && owner === user.id) await new Promise(resolve => setTimeout(resolve, 650));
          }
          if (p === '/api/forum/subscriptions' && method === 'POST') {
            const input = req.postDataJSON();
            assert(!('userId' in input), 'server session owns the watch');
            data = { id: nextId++, kind: input.kind, enabled: true, cooldownSeconds: input.cooldownSeconds,
              filtersJson: { categoryId: null, query: null, postId: null, hours: null, rankingBasis: null, ...input } };
            watches.get(owner).push(data);
            if (delayPostWatch && input.postId === 12) await new Promise(resolve => setTimeout(resolve, 650));
          }
          if (/^\/api\/forum\/subscriptions\/\d+$/.test(p)) {
            const id = Number(p.split('/').at(-1)), item = watches.get(owner).find(value => value.id === id);
            assert(item, 'fixture mutation remains owner-scoped');
            if (method === 'PATCH') {
              if (failPatch) { failPatch = false; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: '权限已变化' }) }); }
              assert.deepEqual(Object.keys(req.postDataJSON()), ['enabled']); item.enabled = req.postDataJSON().enabled;
            } else if (method === 'DELETE') watches.set(owner, watches.get(owner).filter(value => value.id !== id));
            data = { ok: true };
          }
          return route.fulfill(response(data));
        }
        if (url.origin === origin && method === 'GET') return route.continue();
        return route.abort();
      });
      await go(page, '/forum?category=2&q=图书馆'); await idle(page);
      await page.getByText('搜索服务暂不可用，当前使用数据库关键词查询，匹配方式可能与全文搜索不同。', { exact: true }).waitFor();
      await page.getByRole('button', { name: '追踪新帖', exact: true }).click(); await page.getByRole('button', { name: '已开启追踪', exact: true }).waitFor();
      assert(writes.some(write => write.body?.kind === 'NEW_POSTS' && write.body.categoryId === 2 && write.body.query === '图书馆'));
      await page.getByRole('button', { name: '下一页', exact: true }).click(); await idle(page);
      assert(feeds.at(-1).cursor.length > 8192, 'large signed PIT tokens are not truncated');
      await go(page, '/forum?sort=popular&period=week'); await idle(page);
      assert.equal(feeds.at(-1).hotBasis, 'interaction');
      await page.getByText(/按窗口内已记录的互动净变化排名/).waitFor();
      await page.getByRole('button', { name: '追踪热榜变化', exact: true }).click(); await page.getByRole('button', { name: '已开启追踪', exact: true }).waitFor();
      assert(writes.some(write => write.body?.kind === 'HOT_RISE' && write.body.hours === 168 && write.body.rankingBasis === 'interaction'));
      for (const [status, text] of [['not_ready', '互动热榜正在构建'], ['disabled', '当前热榜未启用'], ['unsupported_scope', '当前热榜暂不支持此筛选范围'], ['stale', '榜单更新延迟']]) {
        hotStatus = status; await page.getByRole('button', { name: '刷新热榜', exact: true }).click(); await idle(page);
        await page.getByText(new RegExp(text)).waitFor();
        assert.equal(await page.getByText('暂无帖子', { exact: true }).count(), 0, 'read-model failure is not an empty forum');
      }
      hotStatus = 'ready'; await page.getByRole('button', { name: '刷新热榜', exact: true }).click(); await idle(page);
      await page.screenshot({ path: '.local/forum-pipeline-hot-' + width + '.png' });
      await go(page, '/forum?tag=3'); await idle(page); assert(await page.getByRole('button', { name: '追踪新帖', exact: true }).isDisabled());
      await page.getByText('标签筛选暂不支持追踪，可改用分类或关键词。', { exact: true }).waitFor();
      delayPostWatch = true; await go(page, '/forum/post/12'); await page.getByRole('heading', { name: '隔离验收帖子 12', exact: true }).waitFor();
      await page.getByRole('button', { name: '关注更新', exact: true }).click(); await go(page, '/forum/post/13');
      await page.getByRole('heading', { name: '隔离验收帖子 13', exact: true }).waitFor(); await page.waitForTimeout(750);
      assert.equal(await page.getByRole('button', { name: '已关注更新', exact: true }).count(), 0, 'old-thread follow completion cannot alter the new thread');
      await page.getByRole('button', { name: '关注更新', exact: true }).click(); await page.getByRole('button', { name: '已关注更新', exact: true }).waitFor();
      await go(page, '/notifications'); await page.getByRole('heading', { name: '持续追踪', exact: true }).waitFor();
      const trackedPost = page.locator('.subscription-item').filter({ hasText: '帖子 #13' }); await trackedPost.waitFor();
      await trackedPost.getByRole('button', { name: '暂停', exact: true }).click(); await trackedPost.getByText('已暂停', { exact: true }).waitFor();
      failPatch = true; await trackedPost.getByRole('button', { name: '开启', exact: true }).click(); await page.getByText('权限已变化', { exact: true }).waitFor();
      assert.equal(await trackedPost.getByText('已暂停', { exact: true }).count(), 1, 'failed PATCH never claims that a watch was enabled');
      await trackedPost.getByRole('button', { name: '删除追踪', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click(); await trackedPost.waitFor({ state: 'detached' });
      slowSubscriptions = true; const before = subReads; await page.getByRole('button', { name: '刷新追踪', exact: true }).click();
      while (subReads === before) await page.waitForTimeout(20);
      account = 99156;
      await page.evaluate(user => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('user').setUser({ ...user, id: 99156, username: '另一个隔离成员' }), user);
      await page.getByText('全站 · 关键词：另账号专属关键词', { exact: true }).waitFor(); await page.waitForTimeout(750);
      assert.equal(await page.locator('.subscription-item').count(), 1, 'old-account list completion cannot replace the new account');
      assert.equal(await page.getByText('分类 #2 · 关键词：图书馆', { exact: true }).count(), 0);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: '.local/forum-pipeline-watches-' + width + '.png' });
      assert.deepEqual(errors, []); assert(writes.every(write => write.p.startsWith('/api/forum/')));
      console.log('PASS ' + width + 'px: explicit interaction basis/read-model states/search degradation, 9k PIT, owner-scoped tracking CRUD, failed PATCH, stale thread/account isolation; synthetic APIs only');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

// Synthetic APIs only: no real accounts, post bodies, credentials, or model calls.
const { chromium } = require('playwright'), assert = require('node:assert/strict');
const base = process.env.FORUM_TEST_BASE || 'http://127.0.0.1:4178/';
const hash = process.env.FORUM_TEST_HASH === '1', origin = new URL(base).origin;
const dest = path => base + (hash ? '#' : '') + path.replace(/^\//, '');
const user = { id: 99112, username: '游标验收成员', email: 'seek@example.test', role: 'USER', level: 1, points: 0 };
const categories = [{ id: 1, name: '校园生活', _count: { posts: 150000 } }, { id: 2, name: '学习交流', _count: { posts: 120000 } }];
const headers = { 'Access-Control-Allow-Origin': '*' };
const response = data => ({ contentType: 'application/json', headers, body: JSON.stringify({ success: true, data }) });
function makePost(id) { return { id, user, userId: user.id, title: '游标验收帖子 ' + id, summary: '虚构摘要，不使用实际用户数据。'.repeat(4), content: '虚构正文，仅用于编辑回归。', contentFormat: 'plain', revision: 3,
  categoryId: 1, category: categories[0], tags: [{ tag: { id: 900, name: '旧帖冷门标签' } }], createdAt: '2026-10-14T01:00:00Z', viewCount: 2, commentCount: 0, likeCount: 0 }; }
const waitIdle = page => page.waitForFunction(() => document.querySelectorAll('.post-list > .el-loading-mask').length === 0);
async function navigate(page, path, leaveDraft = false) {
  if (!hash || page.url() === 'about:blank') return page.goto(dest(path));
  const navigation = page.evaluate(path => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path).then(() => true), path).then(() => null, error => error);
  if (leaveDraft) await page.getByRole('dialog').filter({ hasText: '离开编辑页面？' }).getByRole('button', { name: '离开', exact: true }).click();
  const error = await navigation; if (error) throw error;
  if (leaveDraft) await page.waitForFunction(() => [...document.querySelectorAll('.el-message-box')].every(element => element.getClientRects().length === 0));
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
      page.setDefaultTimeout(12000);
      const errors = [], queries = [], tagQueries = [], writes = [];
      let expireHot = false, delayCatalogs = false, withdrawHotFirst = false, insertedPost = false, hotVersion = 1;
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-seek-token', refreshToken: '' })), user);
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
        if (p.startsWith('/api/')) {
          if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
          if (method !== 'GET') writes.push({ p, method, body: req.postDataJSON() });
          let data = [];
          if (p === '/api/forum/categories') { if (delayCatalogs) await new Promise(resolve => setTimeout(resolve, 650)); data = categories; }
          if (p === '/api/forum/tags') data = [{ id: 1, name: '热门标签' }];
          if (p === '/api/forum/feed') {
            const q = Object.fromEntries(url.searchParams); queries.push({ p, ...q });
            assert(!('page' in q), 'seek requests never pass OFFSET page numbers'); assert(!('includeTotal' in q), 'feed does not repeatedly COUNT');
            if (q.categoryId === '1') await new Promise(resolve => setTimeout(resolve, 450));
            const hot = q.sort === 'hot', live = hot && (q.search || q.tagId || q.hotPeriod === 'all');
            if (hot && q.cursor && expireHot) return route.fulfill({ status: 409, ...response(null), body: JSON.stringify({ message: '热榜快照已失效，请刷新首屏' }) });
            const cursor = q.cursor || (hot ? 'hot-v' + hotVersion + '-0' : insertedPost ? 'latest-new-0' : 'latest-0'), index = Number(cursor.split('-').at(-1)) || 0;
            const limit = Number(q.limit || 20), start = index * limit + 1;
            data = { data: hot && withdrawHotFirst && !index ? [] : Array.from({ length: limit }, (_, i) => ({ ...makePost(start + i), title: (q.categoryId === '1' ? '旧分类' : q.categoryId === '2' ? '新分类' : '游标验收帖子') + ' ' + (start + i) })),
              hasMore: !live && index < 2, nextCursor: !live && index < 2 ? cursor.replace(/\d+$/, String(index + 1)) : null,
              pageCursor: live ? null : cursor, limit, sort: q.sort, asOf: '2026-10-14T03:04:05Z', total: null,
              snapshot: hot ? { updatedAt: '2026-10-14T03:04:05Z', paging: live ? 'first_page_only' : 'cursor', coverage: 'top_200' } : null };
            if (!hot && insertedPost && cursor.startsWith('latest-new-')) data.data[0] = { ...makePost(100001), title: '刚发布的虚构新帖' };
          }
          if (p === '/api/forum/posts') {
            const q = Object.fromEntries(url.searchParams); queries.push({ p, ...q }); assert(Number(q.page || 1) <= 100, 'likes must not issue deep OFFSET queries');
            data = { data: Array.from({ length: Number(q.limit || 20) }, (_, i) => makePost(i + 1)), total: q.includeTotal === 'true' ? 100000 : null };
          }
          if (/^\/api\/forum\/posts\/\d+$/.test(p)) data = makePost(Number(p.split('/').at(-1)));
          if (/^\/api\/forum\/posts\/\d+\/view$/.test(p)) data = { counted: false, viewCount: 2, viewerToken: 'synthetic-viewer' };
          if (/^\/api\/forum\/posts\/\d+\/comments$/.test(p)) data = { data: [], total: 0, activeCount: 0, page: 1 };
          if (p === '/api/forum/tag-options') {
            const q = Object.fromEntries(url.searchParams); tagQueries.push(q);
            if (delayCatalogs) await new Promise(resolve => setTimeout(resolve, 650));
            if (q.q === '慢查询') await new Promise(resolve => setTimeout(resolve, 600));
            data = { data: q.q ? [{ id: q.q === '慢查询' ? 50 : 51, name: q.q === '慢查询' ? '旧慢查询标签' : '远程冷门标签' }]
              : q.cursor ? [{ id: 32, name: '翻页冷门标签' }] : Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: '常用标签' + (i + 1) })),
              hasMore: !q.q && !q.cursor, nextCursor: !q.q && !q.cursor ? 'tags-page-2' : null, limit: 30 };
          }
          if (p === '/api/forum/notifications/unread-count') data = { count: 0 };
          return route.fulfill(response(data));
        }
        // Only public same-origin static GETs can reach the network. All API writes above are fixtures.
        if (url.origin === origin && method === 'GET') return route.continue();
        return route.abort();
      });
      try {
      await navigate(page, '/forum?page=501'); await page.getByText('旧页码链接没有可恢复的游标，已返回首屏。', { exact: true }).waitFor(); await waitIdle(page);
      assert.equal(await page.locator('.page-label').innerText(), '第 1 页');
      await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.getByText('第 2 页', { exact: true }).waitFor(); await waitIdle(page);
      assert.equal(await page.locator('.post-title').first().innerText(), '游标验收帖子 21');
      await page.locator('.forum-container').evaluate(el => el.scrollTop = 750); await page.waitForTimeout(80);
      await page.locator('.post-card').nth(7).click(); await page.locator('.discussion').waitFor();
      const saved = await page.evaluate(id => JSON.parse(sessionStorage.getItem('chatforum-forum-navigation-v1:' + id)), user.id);
      assert(saved.feed.cursors['1'] && saved.feed.cursors['2']); assert(!JSON.stringify(saved).includes('虚构摘要'));
      await page.locator('.el-page-header__left').click(); await page.locator('.post-card').nth(7).waitFor(); await waitIdle(page);
      await page.waitForFunction(scroll => Math.abs(document.querySelector('.forum-container').scrollTop - scroll) < 4, saved.scroll);
      assert.equal(queries.filter(q => q.p.endsWith('/feed')).at(-1).cursor, 'latest-1');
      await page.getByRole('button', { name: '上一页', exact: true }).click(); await waitIdle(page); assert.equal(await page.locator('.post-title').first().innerText(), '游标验收帖子 1');
      insertedPost = true; await page.reload(); await waitIdle(page); assert.equal(await page.locator('.post-title').first().innerText(), '游标验收帖子 1', 'reload deliberately replays the saved insertion bound');
      await page.getByRole('button', { name: '刷新帖子', exact: true }).click(); await waitIdle(page); await page.getByText('刚发布的虚构新帖', { exact: true }).waitFor(); assert(!queries.at(-1).cursor, 'explicit refresh clears the old time/id bound'); insertedPost = false;
      await page.getByPlaceholder('搜索帖子标题或内容...').fill('中文搜索'); await page.getByPlaceholder('搜索帖子标题或内容...').press('Enter'); await waitIdle(page);
      assert.equal(queries.at(-1).search, '中文搜索'); assert(!queries.at(-1).cursor); assert.equal(await page.locator('.page-label').innerText(), '第 1 页');
      await page.locator('.category-item').filter({ hasText: '校园生活' }).click(); await page.locator('.category-item').filter({ hasText: '学习交流' }).click();
      await page.locator('.post-title').first().filter({ hasText: '新分类' }).waitFor(); await page.waitForTimeout(500); assert.equal(await page.locator('.post-title').first().innerText(), '新分类 1');
      await navigate(page, '/forum?sort=popular&period=week'); await waitIdle(page); await page.getByText(/更新于 10-14/).waitFor();
      await page.getByText('热榜为前 200 条排序快照，并非全站完整结果。', { exact: true }).waitFor();
      withdrawHotFirst = true; await page.getByRole('button', { name: '刷新热榜', exact: true }).click(); await waitIdle(page);
      await page.getByText('本页帖子已不可访问，可继续查看下一页', { exact: true }).waitFor(); assert(await page.getByRole('button', { name: '下一页', exact: true }).isEnabled());
      await page.getByRole('button', { name: '下一页', exact: true }).click(); await waitIdle(page); assert.equal(await page.locator('.post-title').first().innerText(), '游标验收帖子 21');
      withdrawHotFirst = false; await page.getByRole('button', { name: '刷新热榜', exact: true }).click(); await waitIdle(page);
      expireHot = true; const beforeExpiry = queries.length; await page.getByRole('button', { name: '下一页', exact: true }).click();
      await page.getByText('这份列表快照已失效，请刷新首屏查看最新结果。', { exact: true }).waitFor(); await page.waitForTimeout(100);
      assert.equal(queries.length, beforeExpiry + 1, 'expiry never silently fetches a new ranking');
      expireHot = false; hotVersion++; await page.getByRole('button', { name: '刷新首屏', exact: true }).click(); await waitIdle(page); assert(!queries.at(-1).cursor);
      await navigate(page, '/forum?sort=popular&period=all&q=筛选'); await waitIdle(page);
      await page.getByText('当前热门筛选仅显示首屏；请收紧筛选或切换“最新”继续浏览。', { exact: true }).waitFor(); assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
      await navigate(page, '/forum?sort=likes&page=1000'); await page.getByText('旧链接超过点赞排序的 100 页范围，已返回首屏。', { exact: true }).waitFor(); await waitIdle(page);
      await page.getByRole('button', { name: '下一页', exact: true }).click(); await waitIdle(page);
      const likes = queries.filter(q => q.p.endsWith('/posts')); assert.equal(likes.at(-2).includeTotal, 'true'); assert.equal(likes.at(-1).includeTotal, 'false');
      await page.getByRole('button', { name: '刷新排序', exact: true }).click(); await waitIdle(page); assert.equal(queries.at(-1).includeTotal, 'true', 'explicit likes refresh recounts instead of retaining an old total'); assert.equal(queries.at(-1).page, '1');
      await navigate(page, '/forum?sort=likes&page=100'); await waitIdle(page); assert(await page.getByRole('button', { name: '下一页', exact: true }).isDisabled());
      await navigate(page, '/forum/create'); await page.getByPlaceholder('请输入帖子标题').waitFor();
      const tagSelect = page.locator('.post-form .el-select').nth(1); await tagSelect.click(); await page.getByRole('button', { name: '加载更多标签', exact: true }).click(); await page.getByRole('option', { name: '翻页冷门标签', exact: true }).click();
      await tagSelect.locator('input').fill('慢查询'); await page.waitForTimeout(350); await tagSelect.locator('input').fill('冷门');
      await page.getByRole('option', { name: '远程冷门标签', exact: true }).click(); await page.waitForTimeout(650);
      assert.equal(await page.getByRole('option', { name: '旧慢查询标签', exact: true }).count(), 0, 'stale remote tag response is discarded');
      assert(tagQueries.some(q => q.cursor === 'tags-page-2')); assert(tagQueries.some(q => q.q === '冷门'));
      await page.keyboard.press('Escape'); await page.getByPlaceholder('请输入帖子标题').fill('延迟目录草稿'); await page.getByRole('textbox', { name: '帖子内容' }).fill('草稿正文和标签不应被异步初始化覆盖。');
      await page.getByText(/草稿已保存/).waitFor(); delayCatalogs = true; await page.reload(); await page.getByText('已恢复上次草稿', { exact: true }).waitFor(); await page.waitForTimeout(1000);
      assert.equal(await page.getByPlaceholder('请输入帖子标题').inputValue(), '延迟目录草稿'); assert.equal(await page.getByRole('textbox', { name: '帖子内容' }).inputValue(), '草稿正文和标签不应被异步初始化覆盖。');
      assert.equal(await page.locator('.draft-state').innerText(), '已恢复上次草稿', 'delayed catalog initialization is not a user edit');
      assert(await tagSelect.innerText().then(text => text.includes('翻页冷门标签') && text.includes('远程冷门标签')));
      await navigate(page, '/forum/post/55/edit', true);
      await page.getByRole('heading', { name: '编辑帖子', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.post-form input')?.value === '游标验收帖子 55');
      const retainedCreateDraft = await page.evaluate(() => JSON.parse(localStorage.getItem('chatforum-post-draft-v1:99112:new') || 'null'));
      assert.equal(retainedCreateDraft.postId, '', 'leaving create must not bind its stored draft to the target post');
      assert.deepEqual(retainedCreateDraft.tags, ['翻页冷门标签', '远程冷门标签']);
      assert((await tagSelect.innerText()).includes('旧帖冷门标签'));
      await page.getByRole('button', { name: '预览', exact: true }).click(); assert.equal(await page.locator('.plain-preview').innerText(), '虚构正文，仅用于编辑回归。');
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      await page.getByRole('textbox', { name: '帖子内容' }).fill('编辑页保留原帖关联的虚构草稿。'); await page.getByText(/草稿已保存/).waitFor();
      await navigate(page, '/forum/create', true); await page.getByRole('heading', { name: '发布帖子', exact: true }).waitFor(); await page.getByText('已恢复上次草稿', { exact: true }).waitFor();
      assert.equal(await page.getByPlaceholder('请输入帖子标题').inputValue(), '延迟目录草稿'); assert.equal(await page.getByRole('textbox', { name: '帖子内容' }).inputValue(), '草稿正文和标签不应被异步初始化覆盖。');
      assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('chatforum-post-draft-v1:99112:55')).postId), '55', 'edit draft keeps its original post through unmount');
      await navigate(page, '/forum/post/55/edit', true); await page.getByText('已恢复上次草稿', { exact: true }).waitFor();
      assert.equal(await page.getByRole('textbox', { name: '帖子内容' }).inputValue(), '编辑页保留原帖关联的虚构草稿。');
      await navigate(page, '/forum', true); await waitIdle(page); await page.locator('.category-item').nth(2).waitFor(); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.getByRole('button', { name: '下一页', exact: true }).click(); await page.getByText('第 2 页', { exact: true }).waitFor(); await waitIdle(page);
      await page.evaluate(user => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('user').setUser({ ...user, id: 99113, username: '另一个虚构成员' }), user);
      await page.getByText('第 1 页', { exact: true }).waitFor(); await waitIdle(page); assert(!queries.at(-1).cursor, 'account switch drops previous cursor and page');
      const otherSaved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('chatforum-forum-navigation-v1:99113')));
      assert.equal(otherSaved.userId, 99113); assert(!otherSaved.feed.cursors['2'], 'the second account never inherits cursor backstack');
      await page.locator('.forum-container').evaluate(el => el.scrollTop = 0); await page.addStyleTag({ content: '*{transition:none!important;animation:none!important}' }); await page.screenshot({ path: '.local/forum-scale-' + width + '.png' });
      await page.getByRole('button', { name: '下一页', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: '.local/forum-scale-paging-' + width + '.png' });
      assert.deepEqual(errors, []); assert(writes.every(write => write.p.startsWith('/api/forum/')), 'every simulated write stays inside the intercepted forum fixture');
      assert(!writes.some(write => write.p.startsWith('/api/chat')), 'no model API was invoked');
      console.log('PASS ' + width + 'px: seek/search/filter race/account-scoped snapshot scroll, explicit hot expiry/coverage, shallow likes/count, remote tag pagination/race, delayed draft/old tags, synthetic APIs only');
      } catch (error) {
        console.error('SYNTHETIC_DIAGNOSTIC ' + JSON.stringify(await page.evaluate(() => ({ url: location.href,
          label: document.querySelector('.draft-state')?.textContent,
          title: document.querySelector('.post-form input')?.value,
          tagText: document.querySelectorAll('.post-form .el-select')[1]?.textContent,
          selectedTags: [...document.querySelectorAll('.post-form .el-select')][1]?.querySelectorAll('.el-tag').length,
          draft: JSON.parse(localStorage.getItem('chatforum-post-draft-v1:99112:new') || 'null'),
          loadingMasks: document.querySelectorAll('.el-loading-mask').length,
        }))));
        console.error('SYNTHETIC_TAG_QUERIES ' + JSON.stringify(tagQueries));
        console.error('SYNTHETIC_PAGE_ERRORS ' + JSON.stringify(errors));
        console.error('SYNTHETIC_ROUTER ' + JSON.stringify(await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.currentRoute.value.fullPath)));
        await page.screenshot({ path: '.local/forum-scale-failure-' + width + '.png' });
        throw error;
      }
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

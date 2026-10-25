// Synthetic API only: never uses real accounts, conversations, posts or direct messages.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.FORUM_TEST_BASE || 'http://127.0.0.1:4184/';
const hash = process.env.FORUM_TEST_HASH === '1';
const origin = new URL(base).origin;
const viewer = { id: 99081, username: '社交验收账号', email: 'social@example.test', role: 'USER', level: 1, points: 0 };
const author = { id: 99082, username: '社区作者', bio: '虚构的社区个人简介', level: 2, points: 50 };
const date = '2026-10-15T01:00:00Z';
const dest = path => base + (hash ? '#' : '') + path.replace(/^\//, '');
const ok = data => ({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
async function navigate(page, path) {
  if (page.url() === 'about:blank' || !hash) return page.goto(dest(path));
  await page.evaluate(path => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(path), path);
}
(async () => {
  fs.mkdirSync('.local', { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
      page.setDefaultTimeout(12000);
      const errors = [], writes = [], peopleQueries = [], dialogs = [];
      let following = false, saved = false, rejectFollow = false;
      const post = id => ({ id, title: '社交体验测试帖子 ' + id, summary: '一篇只用于界面验收的虚构帖子。', content: '普通文本内容。', contentFormat: 'plain', user: { ...author, isFollowing: following }, category: { id: 1, name: '校园生活' }, tags: [], isFavorited: id === 1 && saved, isLiked: false, commentCount: 0, viewCount: 5, likeCount: 1, createdAt: date, revision: 1 });
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
      await page.addInitScript(viewer => localStorage.setItem('chatforum-user', JSON.stringify({ user: viewer, token: 'synthetic-social-token', refreshToken: '' })), viewer);
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
        if (path.startsWith('/api/')) {
          if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
          if (method !== 'GET') writes.push({ path, method });
          let data = [];
          if (path === '/api/forum/feed') data = { data: [post(1), post(2)], hasMore: false, pageCursor: 'synthetic-start', asOf: date };
          if (path === '/api/forum/categories') data = [{ id: 1, name: '校园生活', _count: { posts: 2 } }];
          if (path === '/api/forum/posts') data = { data: [post(1)], total: 1 };
          if (/^\/api\/forum\/posts\/\d+$/.test(path)) data = post(Number(path.split('/').at(-1)));
          if (/\/posts\/\d+\/comments$/.test(path)) data = { data: [], total: 0, activeCount: 0 };
          if (/\/posts\/\d+\/view$/.test(path)) data = { counted: false, viewCount: 5 };
          if (/\/posts\/\d+\/favorite$/.test(path)) { await new Promise(resolve => setTimeout(resolve, 180)); saved = method === 'POST'; data = { isFavorited: saved }; }
          if (/\/users\/\d+\/follow$/.test(path)) {
            await new Promise(resolve => setTimeout(resolve, 180));
            if (rejectFollow) { rejectFollow = false; return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: '虚构的账号不可用错误' }) }); }
            following = method === 'POST'; data = { isFollowing: following, followers: following ? 8 : 7 };
          }
          if (/^\/api\/users\/\d+$/.test(path)) data = { ...author, isFollowing: following, _count: { posts: 1, followers: following ? 8 : 7, following: 3 } };
          if (/\/users\/\d+\/(followers|following)$/.test(path)) {
            peopleQueries.push(Object.fromEntries(url.searchParams));
            data = { data: [{ id: url.searchParams.has('cursor') ? 99084 : 99083, username: url.searchParams.has('cursor') ? '第二页社区成员' : '第一位社区成员', bio: '公开简介', isFollowing: false }], hasMore: !url.searchParams.has('cursor'), nextCursor: url.searchParams.has('cursor') ? null : 42 };
          }
          if (path === '/api/forum/me/favorites') data = { data: [post(1)], total: 1 };
          if (path === '/api/forum/me/posts' || path === '/api/forum/me/following') data = { data: [], total: 0 };
          if (/unread(?:-count)?$/.test(path)) data = { unreadCount: 0, requests: 0 };
          if (path === '/api/messages/conversations' || path === '/api/messages/threads') data = { data: [], hasMore: false };
          return route.fulfill({ ...ok(data), headers: { 'Access-Control-Allow-Origin': '*' } });
        }
        if (url.origin === origin && method === 'GET') return route.continue();
        return route.abort();
      });
      try {
        await navigate(page, '/forum');
        await page.locator('article.post-card').first().waitFor();
        assert.equal(await page.locator('a a, a button').count(), 0, 'No nested author/favorite controls inside post anchors');
        const follow = page.getByRole('button', { name: '关注 社区作者', exact: true }).first();
        await follow.click();
        await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).first().waitFor();
        assert.equal(await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).count(), 2, 'Same author state synchronizes across cards');
        const followedAuthors = page.getByRole('button', { name: '取消关注 社区作者', exact: true });
        assert.deepEqual((await followedAuthors.allTextContents()).map(text => text.trim()), ['已关注', '已关注'], 'Follow status has no cancellation hint');
        assert.equal(await followedAuthors.first().getAttribute('aria-pressed'), 'true');
        let followWrites = writes.filter(write => write.path.endsWith('/follow')).length;
        await followedAuthors.first().click();
        await page.getByRole('button', { name: '关注 社区作者', exact: true }).first().waitFor();
        assert.equal(writes.filter(write => write.path.endsWith('/follow')).length, followWrites + 1, 'One click directly unfollows once');
        assert.equal(writes.at(-1).method, 'DELETE');
        assert.equal(await page.getByRole('dialog').count(), 0, 'Unfollowing needs no confirmation dialog');
        await page.getByRole('button', { name: '关注 社区作者', exact: true }).first().click();
        await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).first().waitFor();
        await page.getByRole('button', { name: '收藏：社交体验测试帖子 1', exact: true }).click();
        await page.getByRole('button', { name: '取消收藏：社交体验测试帖子 1', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '收藏：社交体验测试帖子 2', exact: true }).count(), 1);
        assert.match(page.url(), /forum(?:$|[?#])/, 'Bookmark must not navigate into the post');
        await page.locator('article.post-card').first().getByRole('link', { name: '查看 社区作者 的主页' }).click();
        await page.getByRole('heading', { name: '社区作者', exact: true }).waitFor();
        await page.getByRole('button', { name: /粉丝/ }).click();
        await page.getByText('第一位社区成员', { exact: true }).waitFor();
        await page.getByRole('button', { name: '加载更多', exact: true }).click();
        await page.getByText('第二页社区成员', { exact: true }).waitFor();
        assert.ok(peopleQueries.some(query => query.cursor === '42'));
        await page.getByRole('button', { name: '关注 第一位社区成员', exact: true }).click();
        const personFollow = page.getByRole('button', { name: '取消关注 第一位社区成员', exact: true });
        await personFollow.waitFor();
        assert.equal((await personFollow.textContent()).trim(), '已关注', 'People lists use the same concise status');
        await personFollow.click();
        await page.getByRole('button', { name: '关注 第一位社区成员', exact: true }).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0, 'People list unfollow is immediate');
        rejectFollow = true;
        await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).click();
        await page.getByText('虚构的账号不可用错误', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).count(), 1, 'Failure leaves confirmed state intact');
        assert.equal((await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).textContent()).trim(), '已关注');
        await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).click();
        await page.getByRole('button', { name: '关注 社区作者', exact: true }).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0, 'Profile unfollow is immediate');
        await page.getByRole('button', { name: '关注 社区作者', exact: true }).click();
        await page.getByRole('button', { name: '取消关注 社区作者', exact: true }).waitFor();
        await page.getByRole('button', { name: '私信', exact: true }).click();
        await page.waitForURL(/messages\?user=99082/);
        await navigate(page, '/user/profile?activity=favorites');
        await page.locator('.forum-activity').getByRole('link', { name: /社交体验测试帖子 1/ }).waitFor();
        assert.equal(await page.locator('.social-shortcuts').count(), 0, 'No duplicate shortcut row');
        const navigation = page.locator('.activity-navigation');
        assert.equal(await navigation.getByRole('tab').count(), 4, 'One community navigation group');
        assert.equal(await navigation.getByRole('tab', { name: '我的收藏', exact: true }).count(), 1);
        assert.equal(await navigation.getByRole('link', { name: '私信', exact: true }).count(), 1);
        await page.screenshot({ path: '.local/forum-social-profile-' + width + '.png', fullPage: true });
        await navigate(page, '/forum/post/1');
        const detailFollow = page.getByRole('button', { name: '取消关注 社区作者', exact: true });
        await detailFollow.waitFor();
        assert.equal((await detailFollow.textContent()).trim(), '已关注');
        await detailFollow.click();
        await page.getByRole('button', { name: '关注 社区作者', exact: true }).waitFor();
        assert.equal(await page.getByRole('dialog').count(), 0, 'Post detail unfollow is immediate');
        const detailActions = page.locator('.post-actions');
        await detailActions.getByRole('button', { name: '已收藏 · 取消', exact: true }).click();
        await detailActions.getByRole('button', { name: '收藏帖子', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '追踪帖子更新', exact: true }).count(), 1, 'Author follow and tracking stay distinct');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
        assert.equal(overflow, false, 'No horizontal overflow');
        assert.deepEqual(dialogs, [], 'No native follow confirmation');
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ width, result: 'passed', checks: ['author_links', 'follow_truth_and_error', 'direct_unfollow', 'follow_status_labels', 'same_author_sync', 'private_bookmarks', 'social_seek', 'single_profile_navigation', 'message_entry', 'mobile_layout'], writes: writes.length }));
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

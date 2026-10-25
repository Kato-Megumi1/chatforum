// Synthetic fixtures only. Every API response/write is intercepted; no real
// users, discussions, model calls or email delivery are involved.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.POST_TEST_BASE || 'http://127.0.0.1:4184/';
const origin = new URL(base).origin;
const hash = process.env.POST_TEST_HASH === '1';
const viewer = { id: 99171, username: '虚构验收用户', email: 'post-qa@example.test', role: 'USER', level: 1, points: 0 };
const author = { id: 99172, username: '虚构校园作者', isFollowing: false };
const date = '2026-10-15T01:00:00Z';
const text = '普通文本 <b>保持原样</b>\n下一行也保留。';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync('.local', { recursive: true });
  try {
    for (const width of [320, 390, 1440]) {
      const mobile = width <= 900;
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile });
      const errors = [], writes = [], commentQueries = [];
      let rejectComment = true, rejectRead = false, nextId = 1000, saved = false, activeCount = 9;
      const post = { id: 1, title: '校园生活与学习交流：长文阅读和评论验收',
        summary: '纯粹虚构的界面测试内容。', content: '这是用于手机长文阅读验收的虚构内容。\n'.repeat(120),
        contentFormat: 'plain', category: { id: 1, name: '校园生活' }, user: author, tags: [],
        viewCount: 20, likeCount: 3, commentCount: 9, createdAt: date, isFavorited: saved, isLiked: false };
      const comment = id => ({ id, user: author, content: '仅用于验收的虚构评论 ' + id,
        createdAt: date, status: 'ACTIVE', replyCount: 0, replies: [], isLiked: false, likeCount: 0, canDelete: false });
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-post-token', refreshToken: '' })), viewer);
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (path.startsWith('/api/')) {
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
          let data = [];
          const body = request.method() === 'POST' ? request.postDataJSON() : undefined;
          if (!['GET', 'OPTIONS'].includes(request.method())) writes.push({ path, method: request.method(), body });
          if (path === '/api/forum/posts/1') data = { ...post, isFavorited: saved };
          if (path === '/api/forum/posts/2') data = { ...post, id: 2, contentFormat: 'markdown',
            content: '长中文段落'.repeat(80) + '\n\n```text\n' + 'long-unbroken-code_'.repeat(150) + '\n```' };
          if (/^\/api\/forum\/posts\/[12]\/comments$/.test(path)) {
            if (request.method() === 'GET') {
              if (rejectRead) { rejectRead = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '虚构评论读取失败' }) }); }
              const params = Object.fromEntries(url.searchParams); commentQueries.push(params);
              const onlyAuthor = params.onlyAuthor === 'true';
              if (onlyAuthor && params.commentId === '2') return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: '该评论不在当前作者筛选范围内' }) });
              const replies = Array.from({ length: 4 }, (_, i) => ({ ...comment(201 + i), content: '楼主在其他楼层里的回复 ' + (i + 1), parentId: 2 }));
              const second = { ...comment(2), user: { id: 99173, username: '虚构其他用户' }, content: onlyAuthor ? '该楼层用于展示作者回复' : '其他人的根评论',
                contextOnly: onlyAuthor, replyCount: onlyAuthor ? 4 : 7, replies: replies.slice(0, 3) };
              data = { data: params.parentId ? replies : [comment(1), second], total: params.parentId ? 4 : 2,
                activeCount: onlyAuthor ? 5 : activeCount, totalActiveCount: activeCount, onlyAuthor, ...(params.commentId ? { focusId: Number(params.commentId) } : {}) };
            }
            else {
              if (!body.parentId && rejectComment) { rejectComment = false; return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '虚构的暂时发送失败' }) }); }
              data = { ...comment(++nextId), user: viewer, content: body.content, parentId: body.parentId || null }; activeCount++;
            }
          }
          if (/^\/api\/forum\/posts\/[12]\/view$/.test(path)) data = { counted: false, viewCount: 20 };
          if (path === '/api/forum/posts/1/favorite') { saved = request.method() === 'POST'; data = { isFavorited: saved }; }
          if (/unread(?:-count)?$/.test(path)) data = { unreadCount: 0, requests: 0 };
          return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, data }) });
        }
        return url.origin === origin && request.method() === 'GET' ? route.continue() : route.abort();
      });
      try {
        await page.goto(base + (hash ? '#' : '') + 'forum/post/1');
        await page.locator('#comment-1').waitFor();
        const typography = () => page.evaluate(() => ({
          body: getComputedStyle(document.querySelector('.post-content')).fontSize,
          comment: getComputedStyle(document.querySelector('.comment-text')).fontSize,
          reply: getComputedStyle(document.querySelector('.reply .comment-text')).fontSize,
          navigation: getComputedStyle(document.querySelector('.logo-text')).fontSize,
          title: getComputedStyle(document.querySelector('h1')).fontSize,
        }));
        const standard = await typography();
        assert.deepEqual([standard.body, standard.comment, standard.reply], ['15px', '14px', '14px']);
        const chooseFont = async label => {
          await page.getByRole('button', { name: '阅读设置', exact: true }).click();
          await page.getByRole('button', { name: label, exact: true }).click();
          const bounds = await page.locator('.reading-settings-panel').boundingBox();
          assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'reading popover fits the viewport');
          await page.getByRole('button', { name: '阅读设置', exact: true }).click();
        };
        await chooseFont('大字');
        assert.deepEqual(await typography(), { ...standard, body: '17px', comment: '16px', reply: '16px' });
        await chooseFont('更大');
        assert.deepEqual(await typography(), { ...standard, body: '19px', comment: '18px', reply: '18px' });
        await page.reload(); await page.locator('#comment-1').waitFor();
        assert.equal((await typography()).body, '19px', 'same-account preference survives reload');
        const switchUser = user => page.evaluate(user => {
          document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('user').setUser(user);
        }, user);
        await switchUser({ ...viewer, id: 99174, username: '虚构另一账号' });
        await page.waitForFunction(() => document.querySelector('.post-page')?.dataset.readingFont === 'standard');
        await page.locator('#comment-1').waitFor();
        assert.equal((await typography()).body, '15px', 'a different account starts with its own preference');
        await chooseFont('大字');
        await switchUser(viewer);
        await page.waitForFunction(() => document.querySelector('.post-page')?.dataset.readingFont === 'larger');
        await page.locator('#comment-1').waitFor();
        assert.equal((await typography()).body, '19px', 'switching back restores the first account only');
        await page.goto(base + (hash ? '#' : '') + 'forum/post/2');
        await page.locator('.legacy-content pre').waitFor();
        assert.equal(await page.locator('.legacy-content code').evaluate(el => getComputedStyle(el).fontSize), '19px');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'large Chinese/code content must not overflow the document');
        assert(await page.locator('.post-wrapper').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        assert(await page.locator('.legacy-content pre').evaluate(el => el.scrollWidth > el.clientWidth), 'long code scrolls inside its block');
        await page.goto(base + (hash ? '#' : '') + 'forum/post/1'); await page.locator('#comment-1').waitFor();
        await chooseFont('恢复标准');
        assert.deepEqual(await typography(), standard);
        await page.reload(); await page.locator('#comment-1').waitFor();
        assert.deepEqual(await typography(), standard, 'reset remains standard after reload');
        await page.evaluate(() => {
          window.__readingSetItem = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            if (key.startsWith('chatforum-reading-font-v1:')) throw Error('Synthetic storage quota failure');
            return window.__readingSetItem.call(this, key, value);
          };
        });
        await page.getByRole('button', { name: '阅读设置', exact: true }).click();
        await page.getByRole('button', { name: '大字', exact: true }).click();
        await page.getByText('本次已生效；浏览器暂未能保存设置', { exact: true }).waitFor();
        assert.equal((await typography()).body, '17px', 'storage failure does not break current-page scaling');
        await page.evaluate(() => { Storage.prototype.setItem = window.__readingSetItem; delete window.__readingSetItem; });
        await page.getByRole('button', { name: '恢复标准', exact: true }).click();
        await page.getByRole('button', { name: '阅读设置', exact: true }).click();
        assert.deepEqual(await typography(), standard);
        const editor = page.getByRole('textbox', { name: '评论内容', exact: true });
        if (mobile) {
          const dock = page.getByRole('group', { name: '帖子快捷操作', exact: true });
          await dock.waitFor();
          assert.equal(await editor.isVisible(), false, 'mobile comment editor starts compact');
          const dockBox = await dock.boundingBox(), navBox = await page.locator('.mobile-tabbar').boundingBox();
          assert(dockBox.y + dockBox.height <= navBox.y + 1, 'post dock must sit above, not overlap, main navigation');
          assert(dockBox.y >= 0 && dockBox.x >= 0 && dockBox.x + dockBox.width <= width + 1);
          assert(await page.locator('.post-wrapper').evaluate(el => el.scrollHeight > el.clientHeight * 2), 'fixture is a genuinely long post');
          await dock.getByRole('button', { name: '查看 9 条评论' }).click();
          await page.waitForFunction(() => document.activeElement?.id === 'post-discussion-1');
          await page.waitForFunction(() => { const heading = document.querySelector('#post-discussion-1').getBoundingClientRect(), dock = document.querySelector('.mobile-post-dock').getBoundingClientRect(); return heading.top >= 58 && heading.bottom < dock.top; });
          await dock.getByRole('button', { name: /写评论/ }).click();
          await editor.fill(text);
          await page.getByRole('button', { name: '收起编辑器', exact: true }).click();
          assert.equal(await editor.isVisible(), false);
          await dock.getByRole('button', { name: /继续编辑评论/ }).click();
          assert.equal(await editor.inputValue(), text, 'collapse/reopen preserves the unsent draft');
          await page.setViewportSize({ width, height: 480 });
          await dock.getByRole('button', { name: /继续编辑评论/ }).click();
          await page.waitForFunction(() => { const dock = document.querySelector('.mobile-post-dock').getBoundingClientRect(), nav = document.querySelector('.mobile-tabbar').getBoundingClientRect(); return dock.bottom <= nav.top + 1 && nav.bottom <= innerHeight + 1; });
          await page.setViewportSize({ width, height: 844 });
        } else {
          assert.equal(await page.locator('.mobile-post-dock').isVisible(), false, 'desktop has no additional dock');
          assert.equal(await editor.isVisible(), true, 'desktop keeps the original full editor');
          assert.equal(await page.locator('.mobile-compose-trigger').isVisible(), false);
          await editor.fill(text);
        }
        const publish = page.getByRole('button', { name: '发表评论', exact: true });
        await publish.click();
        await page.getByText('虚构的暂时发送失败', { exact: true }).first().waitFor();
        assert.equal(await editor.inputValue(), text, 'failed submission keeps the draft');
        assert.equal(await editor.isVisible(), true, 'failed submission keeps the editor expanded');
        await publish.click();
        await page.locator('#comment-1001 .comment-text').waitFor();
        assert.equal(await page.locator('#comment-1001 .comment-text').textContent(), text);
        assert.equal(await page.locator('#comment-1001 b').count(), 0, 'new forum comments remain ordinary text, not HTML/Markdown');
        assert.equal(writes.filter(write => write.path.endsWith('/comments') && !write.body?.parentId).length, 2);
        assert.deepEqual(writes.filter(write => write.path.endsWith('/comments') && !write.body?.parentId).map(write => write.body), [{ content: text }, { content: text }]);
        if (mobile) assert.equal(await editor.isVisible(), false, 'successful mobile publication returns to compact reading');
        const replyButton = page.locator('#comment-1 .comment-actions').getByRole('button', { name: '回复', exact: true });
        await replyButton.click();
        const reply = page.getByRole('textbox', { name: '回复内容', exact: true });
        await reply.fill('未发送的回复草稿');
        await page.locator('#reply-editor-1').getByRole('button', { name: '取消', exact: true }).click();
        await replyButton.click();
        assert.equal(await reply.inputValue(), '未发送的回复草稿');
        await reply.fill(text);
        await page.getByRole('button', { name: '发送回复', exact: true }).click();
        await page.locator('#comment-1002 .comment-text').waitFor();
        assert.equal(await page.locator('#comment-1002 .comment-text').textContent(), text);
        assert.equal(await page.locator('#comment-1002 b').count(), 0);
        assert.deepEqual(writes.find(write => write.body?.parentId === 1).body, { content: text, parentId: 1 });
        await replyButton.click();
        assert.equal(await reply.inputValue(), '', 'a successfully sent reply never resurrects an older collapsed draft');
        await page.locator('#reply-editor-1').getByRole('button', { name: '取消', exact: true }).click();
        if (mobile) {
          const sizes = await page.locator('.comment-actions .el-button').evaluateAll(els => els.map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height })));
          assert(sizes.every(box => box.width >= 44 && box.height >= 44), 'comment touch targets must be at least 44px');
          await page.locator('.mobile-post-dock').getByRole('button', { name: '收藏帖子', exact: true }).click();
          await page.locator('.mobile-post-dock').getByRole('button', { name: '取消收藏帖子', exact: true }).waitFor();
        }
        // Element Plus exposes an accessible but visually-clipped native input;
        // users activate its visible switch wrapper, not that hidden input.
        const authorSwitch = page.locator('.discussion-controls .el-switch');
        rejectRead = true;
        await authorSwitch.click();
        await page.locator('.comments-error').waitFor();
        assert.equal(await page.locator('.comments > .el-empty').count(), 0, 'a failed read never masquerades as no comments');
        await page.getByRole('button', { name: '重试评论', exact: true }).click();
        await page.locator('.author-filter-hint').filter({ hasText: '5 条' }).waitFor();
        assert(commentQueries.some(query => query.onlyAuthor === 'true' && query.page === '1'));
        assert.equal(await page.locator('#comment-2 > .comment-body > .comment-text').count(), 0, 'context parent body is not displayed');
        assert.equal(await page.locator('#comment-2 > .comment-body > .comment-actions').count(), 0, 'context parent has no like/reply controls');
        assert.equal(await page.locator('#comment-2 .thread-context').textContent(), '该楼层用于展示楼主回复');
        assert.equal(await page.locator('.post-meta').getByText(/11 条评论/).count(), 1, 'author-only count never replaces overall discussion count');
        await page.locator('#comment-1 .comment-actions').getByRole('button', { name: '回复', exact: true }).click();
        await page.getByRole('textbox', { name: '回复内容', exact: true }).fill('非楼主在筛选状态中发表的回复');
        await page.getByRole('button', { name: '发送回复', exact: true }).click();
        await page.getByText('回复已发布，当前仅展示楼主发言', { exact: true }).waitFor();
        assert.equal(await page.getByText('非楼主在筛选状态中发表的回复', { exact: true }).count(), 0, 'new non-author replies do not leak into author-only scope');
        assert.equal(await page.locator('.author-filter-hint').textContent(), '只看楼主发言 · 5 条');
        assert.equal(await page.locator('.post-meta').getByText(/12 条评论/).count(), 1, 'hidden own reply still updates the global discussion count');
        await page.locator('#comment-2').getByRole('button', { name: '查看全部 4 条回复', exact: true }).click();
        await page.locator('#comment-204').waitFor();
        assert(commentQueries.some(query => query.parentId === '2' && query.onlyAuthor === 'true'));
        await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push({ path: '/forum/post/1', query: { comment: '2' } }));
        await page.getByText('这条评论不在“只看楼主”范围内或已不可访问，以下仅展示楼主发言。', { exact: true }).waitFor();
        assert(commentQueries.some(query => query.commentId === '2' && query.onlyAuthor === 'true'), 'notification focus retains the author filter');
        assert.equal(await page.locator('#comment-2 > .comment-body > .comment-text').count(), 0);
        await authorSwitch.click();
        await page.locator('#comment-2 > .comment-body > .comment-text').filter({ hasText: '其他人的根评论' }).waitFor();
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'document overflow');
        assert(await page.locator('.post-wrapper').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'post wrapper overflow');
        assert.deepEqual(errors, []);
        await page.waitForTimeout(3300); // Keep deliberately injected failure toasts out of layout screenshots.
        await page.screenshot({ path: `.local/post-mobile-ux-${width}.png` });
        console.log(`PASS ${width}px: reading font persistence/account/storage/overflow, long-post jump, drafts, plain-text replies, author filter/context/focus, touch targets, desktop preservation`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

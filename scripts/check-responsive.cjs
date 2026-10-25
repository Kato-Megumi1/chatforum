// Synthetic browser fixtures only: no real accounts, histories or model calls.
// Requires Playwright + Edge. Preview a Pages build on port 4173 first.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.RESPONSIVE_BASE || 'http://127.0.0.1:4173/chatforum-web/';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local synthetic fixtures only');
const routeUrl = route => base + (process.env.RESPONSIVE_HASH === '0' ? '' : '#/') + route;
const user = { id: 99001, username: '手机布局验收', email: 'fixture@example.test', role: 'USER', level: 1, points: 0,
  bio: '仅用于测试换行。' + 'long-unbroken-text'.repeat(8), _count: { posts: 1, followers: 0, following: 0 } };
const post = { id: 1, user, title: '手机与桌面排版测试：' + 'long-title'.repeat(12), content: '测试正文。'.repeat(20),
  tags: [{ tag: { id: 1, name: '测试讨论' } }], createdAt: '2026-09-13T00:00:00Z', viewCount: 1, commentCount: 2, likeCount: 0 };
const book = { id: 1, name: '测试小说库', permission: 'ADMIN', chatReady: true, activeIndexVersion: 1, visibility: 'PRIVATE',
  documents: [{ id: 1, fileName: '仅用于布局的文件名'.repeat(8) + '.epub', version: 1, isCurrent: true, status: 'COMPLETED', chunkCount: 10 }] };
async function within(page, selector, label) {
  // Element Plus drawers/dialogs enter with a transform; inspect their settled position.
  await page.waitForFunction(selector => {
    const els = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length);
    return els.length && els.every(el => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; });
  }, selector, { timeout: 4000 });
  const boxes = await page.locator(selector).evaluateAll(els => els.filter(el => el.getClientRects().length).map(el => {
    const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: innerWidth };
  }));
  assert(boxes.length, label + ' has no visible content');
  assert(boxes.every(b => b.left >= -1 && b.right <= b.width + 1), label + ' exceeds viewport: ' + JSON.stringify(boxes));
}
async function overflow(page, selector, label) {
  assert(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1), label + ' horizontal overflow');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), label + ' document overflow');
}
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const widths = process.env.RESPONSIVE_WIDTHS ? process.env.RESPONSIVE_WIDTHS.split(',').map(Number) : [320, 360, 390, 768, 1024, 1440];
    for (const width of widths) {
      const mobile = width <= 900;
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: mobile, hasTouch: mobile });
      const errors = [], writes = [];
      let syntheticSent = false;
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
      await page.route('**/api/**', async r => {
        const p = new URL(r.request().url()).pathname;
        if (!['GET', 'OPTIONS'].includes(r.request().method())) writes.push(p);
        if (p === '/api/chat/runs/layout-fixture/events') {
          const content = '已收到这条测试消息。';
          return r.fulfill({ contentType: 'text/event-stream', headers: { 'Access-Control-Allow-Origin': '*' }, body:
            'event: delta\ndata: ' + JSON.stringify({ text: content, offset: content.length }) + '\n\n' +
            'event: complete\ndata: ' + JSON.stringify({ status: 'COMPLETED', result: { content, ragMetadata: { state: 'general' } } }) + '\n\n' });
        }
        let data = [];
        if (p === '/api/chat/runs') { syntheticSent = true; data = { id: 'layout-fixture', status: 'RUNNING' }; }
        if (p === '/api/chat/config') data = { configured: true, defaultModelId: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', available: true }] };
        if (p === '/api/chat/conversations') data = [{ id: 1, title: '测试会话', userId: user.id,
          conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona', personaLabel: '加藤惠' }];
        if (p === '/api/chat/conversations/1/messages') data = [
          { id: 1, conversationId: 1, role: 'USER', content: '今天终于忙完了，想找你聊一会儿。' },
          { id: 2, conversationId: 1, role: 'ASSISTANT', content: '这是一条布局测试消息。\n\n长段落也应该有舒服的行距，不会把整个屏幕挤满。聊天记录、角色选项和原文依据，都可以在需要的时候打开。', ragMetadata: { state: 'roleplay' } },
        ];
        if (p === '/api/chat/conversations/1/messages' && syntheticSent) data.push(
          { id: 3, conversationId: 1, role: 'USER', content: '点击发送测试' },
          { id: 4, conversationId: 1, role: 'ASSISTANT', content: '已收到这条测试消息。', ragMetadata: { state: 'general' } },
        );
        if (p === '/api/forum/posts') data = { data: [post], total: 300 };
        if (p === '/api/forum/feed') data = { data: [post], hasMore: true, nextCursor: 'synthetic-next', pageCursor: 'synthetic-first' };
        if (p === '/api/forum/posts/1') data = post;
        if (p === '/api/forum/posts/1/comments') data = { data: [{ id: 1, user, createdAt: post.createdAt, content: '评论' + 'long-text'.repeat(20), replyCount: 21, replies: [], status: 'ACTIVE' }], total: 300, activeCount: 300 };
        if (/^\/api\/forum\/me\/(posts|replies|favorites|following)$/.test(p)) data = { data: [], total: 0, page: 1, limit: 10 };
        if (p === '/api/forum/categories') data = [{ id: 1, name: '日常交流', _count: { posts: 1 } }, { id: 2, name: '原作讨论' }];
        if (p === '/api/forum/tags') data = [{ id: 1, name: '讨论' }];
        if (p === '/api/forum/tag-options') data = { data: [{ id: 1, name: '讨论' }], hasMore: false, nextCursor: null };
        if (p === '/api/rag/knowledge-bases') data = [book];
        if (p === '/api/rag/knowledge-bases/1/indexes') data = [{ version: 1, status: 'ACTIVE', chunkCount: 10 }];
        if (p === '/api/users/99001') data = user;
        await r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, data }) });
      });
      for (const route of ['login', 'register']) {
        await page.goto(routeUrl(route)); await page.locator('.' + route + '-card').waitFor();
        await overflow(page, '.' + route + '-container', route);
        await within(page, '.' + route + '-card', route);
      }
      await page.addInitScript(({ user }) => {
        localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-layout-token', refreshToken: '' }));
        localStorage.setItem('chatforum-chat', JSON.stringify({ conversationSettings: {
          1: { selectedPersona: 'kato_megumi_persona', agentMode: 'agent', knowledgeBaseId: 1, customPersonaName: '', customPersonaPrompt: '' },
        } }));
      }, { user });
      await page.goto(routeUrl('chat'));
      await page.getByRole('heading', { name: '有什么我能帮你的吗？', exact: true }).waitFor();
      if (mobile) await page.locator('.mobile-conversations').click();
      await page.getByRole('tab', { name: '角色对话', exact: true }).click();
      await page.locator('.conversation-item').filter({ hasText: '测试会话' }).click();
      await page.reload(); await page.getByText('这是一条布局测试消息。').waitFor();
      await overflow(page, '.chat-layout', 'chat ' + width);
      await within(page, '.chat-toolbar, .chat-input-wrapper', 'chat controls');
      if (mobile) {
        await page.locator('.mobile-conversations').click();
        await page.locator('.conversation-item').filter({ hasText: '测试会话' }).click();
        await page.waitForFunction(() => document.querySelector('.chat-sidebar').getBoundingClientRect().right <= 0);
        await page.getByRole('button', { name: '对话选项', exact: true }).click();
        await within(page, '.chat-toolbar', 'mobile option sheet');
      }
      await page.locator('.toolbar-right button').click();
      await page.getByRole('dialog', { name: '模型设置' }).waitFor();
      await within(page, '.el-drawer', 'model settings');
      await page.getByRole('dialog', { name: '模型设置' }).getByRole('button', { name: /close|关闭/i }).click();
      await page.getByRole('dialog', { name: '模型设置' }).waitFor({ state: 'hidden' });
      if (mobile) await page.getByRole('button', { name: '收起对话选项' }).click();
      const input = page.locator('.chat-textarea textarea');
      await input.fill('换行测试'); await input.press('Shift+Enter');
      assert((await input.inputValue()).endsWith('\n'), 'Shift+Enter must not send');
      await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
      if (mobile) { await input.press('Enter'); assert((await input.inputValue()).endsWith('\n\n')); }
      await input.fill('');
      if (mobile) {
        await page.setViewportSize({ width, height: 480 });
        await input.focus();
        await page.waitForFunction(() => document.querySelector('.main-layout').getBoundingClientRect().height <= 481);
        const box = await page.locator('.btn-send').boundingBox();
        assert(box.y >= 0 && box.y + box.height <= 480, 'Send button hidden at keyboard height');
        assert.equal(await page.locator('.connection > .el-button:visible').count(), 0, 'Connection settings must not float over chat');
        await page.setViewportSize({ width, height: 844 });
      }
      await input.blur();
      await page.mouse.move(0, 0);
      await page.addStyleTag({ content: '* { transition: none !important; animation: none !important; caret-color: transparent !important; }' });
      if (process.env.RESPONSIVE_SCREENSHOTS && [390, 1440].includes(width)) await page.screenshot({ path: `.local/${process.env.RESPONSIVE_SCREENSHOT_PREFIX || 'final'}-chat-${width}.png` });
      if (!process.env.RESPONSIVE_OLD_DESKTOP) {
        await input.fill('点击发送测试');
        await page.getByRole('button', { name: '发送消息' }).click();
        try { await page.getByText('已收到这条测试消息。').waitFor({ timeout: 5000 }); }
        catch (e) {
          console.log(JSON.stringify({ writes, errors, alerts: await page.locator('.el-message__content').allTextContents(), input: await input.inputValue() }));
          await page.screenshot({ path: '.local/layout-send-failure.png' });
          throw e;
        }
      }
      for (const [route, selector] of [['forum', '.forum-container'], ['forum/create', '.create-post-container'], ['forum/post/1', '.post-page'],
        ['knowledge-bases', '.novel-page'], ['user/profile', '.profile-container'], ['user/99001', '.user-space-container']]) {
        await page.goto(routeUrl(route)); await page.locator(selector).waitFor();
        if (route === 'forum') { await page.locator('.post-card').waitFor(); await within(page, process.env.RESPONSIVE_OLD_DESKTOP ? '.pagination-wrapper .el-pagination' : '.seek-pagination', 'forum pagination'); }
        if (route === 'forum/post/1') {
          await page.locator('.comment').waitFor(); await page.getByRole('button', { name: '回复', exact: true }).click();
          await page.getByRole('textbox', { name: '回复内容' }).fill('测试草稿，不发送');
          await within(page, '.pagination', 'comment pagination');
        }
        if (route === 'knowledge-bases') {
          await page.locator('.book').waitFor(); await within(page, mobile ? '.mobile-document-list' : process.env.RESPONSIVE_OLD_DESKTOP ? '.el-table' : '.document-table', 'novel documents');
          await page.getByRole('button', { name: '创建小说库' }).click();
          await page.getByRole('dialog').waitFor(); await within(page, '.el-dialog', 'create novel dialog');
          await page.getByRole('dialog').getByRole('button', { name: /close|关闭/i }).click();
          await page.getByRole('dialog').waitFor({ state: 'hidden' });
        }
        if (route === 'user/99001') await page.locator('.user-space-main').waitFor();
        await overflow(page, selector, route + ' ' + width);
        if (process.env.RESPONSIVE_SCREENSHOTS && [390, 1440].includes(width) && ['forum', 'knowledge-bases'].includes(route)) await page.screenshot({ path: `.local/${process.env.RESPONSIVE_SCREENSHOT_PREFIX || 'final'}-${route}-${width}.png` });
      }
      assert.deepEqual(writes.filter(path => path !== '/api/forum/posts/1/view'), process.env.RESPONSIVE_OLD_DESKTOP ? [] : ['/api/chat/runs'], 'Only one synthetic send and the synthetic reading receipt are allowed; all API calls are intercepted');
      assert.deepEqual(errors, []);
      console.log('PASS ' + width + 'px: 9 pages, drawer/dialog, forum/comments, KB, IME/newlines, keyboard-height, no model calls');
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });

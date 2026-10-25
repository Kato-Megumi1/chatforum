// Synthetic, intercepted APIs only. No account login, real histories or provider calls.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.SPACES_BASE || 'http://127.0.0.1:4175/';
const origin = new URL(base).origin;
const user = { id: 99001, username: '界面验收', role: 'USER', email: 'fixture@example.test' };
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1440]) {
      const mobile = width < 900;
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
      const errors = [], writes = [], assets = [];
      const conversations = [
        { id: 1, title: '普通任务记录', conversationType: 'ASSISTANT', personaKey: 'assistant', personaLabel: 'AI 助手' },
        { id: 2, title: '角色聊天记录', conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona', personaLabel: '加藤惠' },
        { id: 3, title: '待分类旧记录', conversationType: 'LEGACY' },
        { id: 4, title: '自定义角色记录', conversationType: 'ROLEPLAY', personaKey: 'custom:fixture', personaLabel: '纸鸢',
          customPersonaPrompt: '你是纸鸢。这是一段虚构验收设定。' },
      ].map(c => ({ ...c, userId: user.id, sharedMemory: false, updatedAt: '2026-09-22T01:00:00Z' }));
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', req => { if (req.url().includes('auth-bg')) assets.push(req.url()); });
      await page.route('**/*', r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort());
      await page.route('**/api/**', async r => {
        const p = new URL(r.request().url()).pathname, method = r.request().method();
        let data = [];
        if (method !== 'GET') writes.push({ p, method, body: r.request().postDataJSON() });
        if (p === '/api/chat/config') data = { configured: true, defaultModelId: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', available: true }] };
        if (p === '/api/chat/conversations') data = conversations;
        if (p === '/api/chat/conversations' && method === 'POST') {
          const body = r.request().postDataJSON();
          data = { ...conversations[3], id: 5, title: '新角色记录', customPersonaPrompt: body.customPersonaPrompt };
          conversations.push(data);
        }
        const message = p.match(/^\/api\/chat\/conversations\/(\d+)\/messages$/);
        if (message) {
          const c = conversations.find(c => c.id === Number(message[1]));
          data = c.id === 5 ? [] : [{ id: c.id * 2, role: 'ASSISTANT', content: `${c.title}的虚构回复`, conversationId: c.id,
            ragMetadata: { state: 'general', personaKey: c.personaKey } }];
        }
        if (p === '/api/chat/conversations/2' && method === 'PUT') {
          Object.assign(conversations[1], r.request().postDataJSON()); data = conversations[1];
        }
        await r.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      });
      await page.goto(base + 'login');
      await page.locator('.login-card').waitFor();
      assert(assets.some(a => a.endsWith('/auth-bg-optimized.jpg')), 'Optimized auth background requested');
      assert(!assets.some(a => a.endsWith('/auth-bg.jpg')), 'Original 12 MB image must not load');
      await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic', refreshToken: '' })), user);
      await page.goto(base + 'chat');
      await page.getByText('普通任务记录的虚构回复', { exact: true }).waitFor();
      const openSidebar = async () => { if (mobile) await page.getByRole('button', { name: '对话列表', exact: true }).click(); };
      const selectSpace = async (name, title) => {
        await openSidebar();
        await page.getByRole('tab', { name, exact: true }).click();
        await page.locator('.conversation-item').filter({ hasText: title }).click();
        await page.getByText(title + '的虚构回复', { exact: true }).waitFor();
      };
      const screenshot = async label => {
        await page.addStyleTag({ content: '* { transition:none!important; animation:none!important; }' });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Horizontal overflow');
        const send = await page.locator('.btn-send').boundingBox();
        assert(send && send.x >= 0 && send.x + send.width <= width && send.y + send.height <= 900, 'Send button visible');
        await page.screenshot({ path: `.local/spaces-${label}-${width}.png` });
      };
      await screenshot('assistant');
      await selectSpace('角色对话', '角色聊天记录');
      assert.equal(await page.getByText('普通任务记录的虚构回复', { exact: true }).count(), 0);
      assert.equal(await page.locator('.conversation-item').filter({ hasText: '普通任务记录' }).count(), 0);
      await screenshot('roleplay');
      await openSidebar();
      await page.locator('.btn-settings').click();
      const drawer = page.getByRole('dialog', { name: '模型设置' });
      await drawer.waitFor();
      assert.equal(await drawer.getByRole('switch').getAttribute('aria-checked'), 'false');
      await drawer.locator('.el-switch').click();
      await page.waitForFunction(() => document.querySelector('.el-switch.is-checked'));
      await drawer.getByRole('button', { name: /close|关闭/i }).click();
      await drawer.waitFor({ state: 'hidden' });
      // Sidebar remains open after opening settings on mobile.
      if (mobile) await page.getByRole('button', { name: '关闭对话列表', exact: true }).click({ position: { x: width - 10, y: 100 } });
      await selectSpace('普通 AI', '普通任务记录');
      await openSidebar(); await page.locator('.btn-settings').click(); await drawer.waitFor();
      assert.equal(await drawer.getByRole('switch').getAttribute('aria-checked'), 'false', 'Sharing switch must not leak between modes');
      await drawer.getByRole('button', { name: /close|关闭/i }).click(); await drawer.waitFor({ state: 'hidden' });
      if (mobile) await page.getByRole('button', { name: '关闭对话列表', exact: true }).click({ position: { x: width - 10, y: 100 } });
      await selectSpace('角色对话', '自定义角色记录');
      await openSidebar();
      await page.locator('.btn-new-chat').click();
      await page.locator('.conversation-item.active').filter({ hasText: '新角色记录' }).waitFor({ state: 'attached' });
      assert.equal(writes.at(-1).body.customPersonaPrompt, conversations[3].customPersonaPrompt, 'Cloning custom role must preserve identity, not wrap prompt twice');
      await selectSpace('旧历史', '待分类旧记录');
      assert(await page.locator('.chat-textarea textarea').isDisabled(), 'Ambiguous histories remain readable, cannot mix identities');
      assert.deepEqual(writes, [{ p: '/api/chat/conversations/2', method: 'PUT', body: { sharedMemory: true } },
        { p: '/api/chat/conversations', method: 'POST', body: { conversationType: 'ROLEPLAY', persona: 'custom',
          personaLabel: '纸鸢', customPersonaPrompt: conversations[3].customPersonaPrompt } }]);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: AI/role/history separation, owner-scoped sharing UI, no overflow, optimized image, no real data/model calls`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

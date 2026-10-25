// All data and API calls are synthetic. Never dispatch model, login or email requests.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const base = process.env.KATO_DEFAULTS_TEST_BASE || 'http://127.0.0.1:5186/';
const hash = process.env.KATO_DEFAULTS_TEST_HASH === '1';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Serve a local development or built fixture page only');
const viewer = { id: 99151, username: 'Synthetic defaults viewer', email: 'defaults@example.test', role: 'USER' };
const preferredName = '路人女主 · 加藤惠的原作记忆';
const routeUrl = route => base.replace(/\/?$/, '/') + (hash ? '#/' : '') + route;
const initialConversations = () => [
  { id: 11001, userId: viewer.id, title: 'Synthetic ordinary conversation', conversationType: 'ASSISTANT', updatedAt: '2026-10-15T01:00:00Z' },
  { id: 11002, userId: viewer.id, title: 'Synthetic Kato conversation', conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona', personaLabel: '加藤惠', updatedAt: '2026-10-15T01:00:00Z' },
];

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [390, 1440]) {
    const mobile = width <= 900;
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
    page.setDefaultTimeout(10000);
    const calls = [], writes = [], errors = [], conversations = initialConversations();
    let nextId = 11003;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(viewer => {
      localStorage.setItem('chatforum-user', JSON.stringify({ user: viewer, token: 'synthetic-defaults-token', refreshToken: '' }));
    }, viewer);
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      // Every API is intercepted, including a production build's external API origin.
      if (!url.pathname.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
      const path = url.pathname, method = route.request().method(); calls.push({ path, method });
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'authorization,content-type' } });
      if (method !== 'GET') writes.push({ path, method, body: route.request().postDataJSON() });
      let data = [];
      if (path === '/api/chat/config') data = { configured: true, defaultModelId: 'qwen3.8-max', models: [{ id: 'qwen3.8-max', label: 'Qwen3.8-Max', available: true }] };
      if (path === '/api/chat/conversations') {
        if (method === 'POST') {
          const body = route.request().postDataJSON();
          data = { id: nextId++, userId: viewer.id, title: 'Synthetic new Kato', conversationType: body.conversationType, personaKey: body.persona, personaLabel: '加藤惠', updatedAt: '2026-10-15T01:00:00Z' };
          conversations.unshift(data);
        } else data = conversations;
      }
      if (/^\/api\/chat\/conversations\/\d+\/messages$/.test(path)) data = [];
      if (path === '/api/rag/knowledge-bases') data = [
        { id: 17, name: preferredName, chatReady: false, chatUnavailableReason: 'Synthetic unpublished library' },
        { id: 61, name: 'Synthetic unrelated library', chatReady: true },
        { id: 73, name: preferredName, chatReady: true, permission: 'READER', visibility: 'PRIVATE', activeIndexVersion: 8 },
      ];
      if (path.includes('unread')) data = { unreadCount: 0, requests: 0 };
      if (method !== 'GET' && !(path === '/api/chat/conversations' && method === 'POST')) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ success: false, message: 'Unexpected synthetic write' }), headers: { 'Access-Control-Allow-Origin': origin } });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }), headers: { 'Access-Control-Allow-Origin': origin } });
    });
    const state = id => page.evaluate(id => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
      return { currentId: store.currentConversation?.id, settings: JSON.parse(JSON.stringify(store.conversationSettings[id] || null)) };
    }, id);
    const waitSettings = async (id, mode, kb) => { try { await page.waitForFunction(({ id, mode, kb }) => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
      const settings = store?.conversationSettings[id];
      return store?.currentConversation?.id === id && settings?.agentMode === mode && settings?.knowledgeBaseId === kb && !settings?.katoDefaultKnowledgePending;
    }, { id, mode, kb }); } catch (error) { console.error(JSON.stringify({ expected: { id, mode, kb }, actual: await state(id), calls, errors })); throw error; } };
    const closeOptions = async () => {
      if (mobile && await page.getByRole('button', { name: '收起对话选项', exact: true }).isVisible()) await page.getByRole('button', { name: '收起对话选项', exact: true }).click();
    };
    const openSidebar = async () => {
      await closeOptions();
      if (mobile && !await page.locator('.chat-sidebar').evaluate(sidebar => sidebar.classList.contains('mobile-open'))) await page.getByRole('button', { name: '对话列表', exact: true }).click();
    };
    const select = async (space, title) => {
      await openSidebar(); await page.getByRole('tab', { name: space, exact: true }).click();
      await page.locator('.conversation-item').filter({ hasText: title }).click();
    };
    const openOptions = async () => { if (mobile) await page.getByRole('button', { name: '对话选项', exact: true }).click(); };

    await page.goto(routeUrl('chat'));
    await page.getByRole('heading', { name: '有什么我能帮你的吗？', exact: true }).waitFor();
    await waitSettings(11001, 'normal', 0);
    assert.equal((await state(11001)).currentId, 11001);
    assert.equal(await page.getByRole('button', { name: '知识库', exact: true }).count(), 0, 'Ordinary AI has no knowledge library button');
    assert.equal(calls.filter(call => call.path === '/api/rag/knowledge-bases').length, 0, 'Opening ordinary AI must not fetch novel libraries');

    await select('角色对话', 'Synthetic Kato conversation');
    await waitSettings(11002, 'agent', 73);
    assert.equal((await state(11002)).settings.knowledgeBaseId, 73, 'Default library ID comes from the server-readable ready list');
    await openOptions();
    assert(await page.getByRole('combobox', { name: '选择知识库', exact: true }).isVisible());
    await page.locator('.mode-toggle .el-radio-button').filter({ hasText: '普通' }).click();
    await page.locator('.kb-select .el-select').click();
    await page.getByRole('option', { name: '不使用知识库', exact: true }).click();
    await waitSettings(11002, 'normal', 0);
    const libraryCalls = calls.filter(call => call.path === '/api/rag/knowledge-bases').length;
    await select('普通 AI', 'Synthetic ordinary conversation'); await waitSettings(11001, 'normal', 0);
    assert.equal(await page.getByRole('button', { name: '知识库', exact: true }).count(), 0);
    assert.equal(calls.filter(call => call.path === '/api/rag/knowledge-bases').length, libraryCalls);
    await select('角色对话', 'Synthetic Kato conversation'); await waitSettings(11002, 'normal', 0);
    await page.reload(); await page.locator('.persona-bar').waitFor({ state: 'attached' }); await waitSettings(11002, 'normal', 0);

    await openSidebar(); await page.getByRole('button', { name: '新建角色对话', exact: true }).click();
    await waitSettings(11003, 'agent', 73);
    assert.equal(writes.length, 1, 'The only write is creating a synthetic roleplay conversation');
    assert.equal(writes[0].path, '/api/chat/conversations'); assert.equal(writes[0].method, 'POST');
    assert.equal(writes[0].body.conversationType, 'ROLEPLAY'); assert.equal(writes[0].body.persona, 'kato_megumi_persona');
    assert.equal(calls.some(call => call.path.startsWith('/api/auth/') || call.path.startsWith('/api/chat/runs')), false, 'No auth, model or mail request is dispatched');
    assert.deepEqual(errors, []); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log(`PASS ${width}px: ordinary AI no KB fetch/button, Kato defaults Agent + readable ready library ID 73, explicit choices survive switch/reload, new Kato defaults, synthetic create only`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

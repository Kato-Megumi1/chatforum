// Local synthetic APIs only. No real chats, model calls, file operations or deployments.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = process.env.GENERATION_PROCESS_TEST_BASE || 'http://127.0.0.1:4188/';
const origin = new URL(base).origin;
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = join(__dirname, '../../.local/generation-process'); mkdirSync(output, { recursive: true });
const user = { id: 99211, username: 'Synthetic viewer', email: 'fixture@example.test', role: 'USER' };
const conversations = [
  { id: 11001, title: 'Synthetic assistant', conversationType: 'ASSISTANT' },
  { id: 11002, title: 'Synthetic roleplay', conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona', personaLabel: '加藤惠' },
].map(row => ({ ...row, userId: user.id, updatedAt: '2026-10-19T02:00:00Z' }));
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const progress = (phase, elapsedMs, hadThinking = false) => ({ stage: phase === 'verifying' ? 'verifying' : phase === 'completed' ? 'completed' : 'generating', phase,
  elapsedMs, firstTokenMs: null, phaseElapsedMs: elapsedMs - 1000, queueMs: 200, modelCalls: phase === 'generating' ? 1 : 2,
  activeModelCalls: phase === 'completed' ? 0 : 1, stages: [],
  phases: [{ phase: 'queued', durationMs: 200, modelCalls: 0 }, { phase: 'context', durationMs: 800, modelCalls: 0 },
    ...(hadThinking && phase !== 'thinking' ? [{ phase: 'thinking', durationMs: 46000, modelCalls: 1 }] : []),
    { phase, durationMs: elapsedMs - 1000, modelCalls: phase === 'generating' ? 1 : 2 }],
  modelOutput: { thinkingChars: hadThinking ? 1234 : 0, textChars: hadThinking ? 0 : 32, toolChars: 0, lastDataElapsedMs: elapsedMs - 200 },
  reasoning_content: 'SECRET_INNER_REASONING', system: 'SECRET_SYSTEM_PROMPT' });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [390, 1440]) for (const kind of ['ASSISTANT', 'ROLEPLAY']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900, reducedMotion: 'reduce' });
    page.setDefaultTimeout(12000);
    const middle = gate(), finish = gate(), errors = [], writes = [];
    const cid = kind === 'ASSISTANT' ? 11001 : 11002;
    let reads = 0, completed = false;
    const content = '虚构的最终回答，只有核验后的正文。';
    const metadata = { state: kind === 'ASSISTANT' ? 'general' : 'roleplay', performance: progress('completed', 90200, kind === 'ASSISTANT'),
      responseOptions: { deepThinking: kind === 'ASSISTANT', webSearch: kind === 'ASSISTANT' }, webSearch: { enabled: true, sources: [
        {title:'虚构公开来源',url:'https://example.org/source',snippet:'只来自搜索摘要，不冒称已读取全文。',engine:'Bing',retrievedAt:'2026-10-19T01:00:00Z'},
        {title:'UNSAFE_SOURCE',url:'javascript:alert(1)',snippet:'must not render'},
      ] } };
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(user => {
      localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic', refreshToken: '' }));
      localStorage.setItem('chatforum-chat', JSON.stringify({ conversationSettings: {
        11001: { agentMode: 'agent', knowledgeBaseId: 0 },
        11002: { selectedPersona: 'kato_megumi_persona', agentMode: 'agent', knowledgeBaseId: 73, customPersonaName: '', customPersonaPrompt: '', deepThinking: true },
      } }));
    }, user);
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      if (path === '/api/chat/runs/synthetic-process/events') {
        const step = reads++;
        if (step === 1) await middle.promise;
        if (step >= 2) await finish.promise;
        if (step < 2) return route.fulfill({ contentType: 'text/event-stream', body: 'event: progress\ndata: ' + JSON.stringify(progress(step ? 'verifying' : kind === 'ASSISTANT' ? 'thinking' : 'generating', step ? 80000 : 47000, kind === 'ASSISTANT')) + '\n\n' });
        completed = true;
        return route.fulfill({ contentType: 'text/event-stream', body:
          'event: delta\ndata: ' + JSON.stringify({ text: content, offset: content.length }) + '\n\n' +
          'event: complete\ndata: ' + JSON.stringify({ status: 'COMPLETED', result: { content, ragMetadata: metadata } }) + '\n\n' });
      }
      const ok = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      if (path === '/api/chat/config') return ok({ configured: true, defaultModelId: 'qwen3.8-max', models: [{ id: 'qwen3.8-max', label: 'Qwen3.8-Max', available: true }] });
      if (path === '/api/chat/conversations' && method === 'GET') return ok(conversations);
      if (/\/chat\/conversations\/\d+\/messages$/.test(path)) return ok(completed ? [
        { id: 1, role: 'USER', content: '虚构请求', conversationId: cid },
        { id: 2, role: 'ASSISTANT', content, conversationId: cid, ragMetadata: metadata },
      ] : []);
      if (path === '/api/rag/knowledge-bases') return ok([{ id: 73, name: '路人女主 · 加藤惠的原作记忆', chatReady: true, permission: 'READ', activeIndexVersion: 1 }]);
      if (path === '/api/forum/notifications/unread-count') return ok({ unreadCount: 0 });
      if (path === '/api/direct-messages/unread-count') return ok({ inbox: 0, requests: 0, total: 0 });
      if (path === '/api/chat/runs' && method === 'POST') { writes.push(request.postDataJSON()); return ok({ id: 'synthetic-process', status: 'RUNNING' }); }
      return ok([]);
    });
    await page.goto(base + 'chat'); await page.locator('.chat-layout').waitFor();
    await page.waitForFunction(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
      return store?.currentConversation?.id === 11001 && !store.isLoadingConversation;
    });
    if (kind === 'ROLEPLAY') {
      if (width < 900) await page.getByRole('button', { name: '对话列表', exact: true }).click();
      await page.getByRole('tab', { name: '角色对话', exact: true }).click();
      await page.locator('.conversation-item').filter({ hasText: 'Synthetic roleplay' }).click();
    }
    await page.waitForFunction(id => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
      return store?.currentConversation?.id === id && !store.isLoadingConversation;
    }, cid);
    assert.equal(await page.getByRole('button', { name: '深度思考', exact: true }).count(), 0, 'No thinking pill remains in the composer');
    assert.equal(await page.getByRole('button', { name: '联网搜索', exact: true }).count(), 0, 'No search pill remains in the composer');
    const drawer = page.getByRole('dialog', { name: '模型设置', exact: true });
    const openSettings = async () => {
      if (width >= 900) await page.locator('.sidebar-footer .btn-settings').click();
      else if (kind === 'ASSISTANT') await page.locator('.mobile-conversation-title').click();
      else {
        if (!await page.getByRole('button', { name: '收起对话选项', exact: true }).isVisible()) await page.locator('.mobile-conversation-title').click();
        await page.locator('.chat-toolbar .toolbar-right .el-button').click();
      }
      await drawer.waitFor();
    };
    const closeSettings = async () => {
      await page.keyboard.press('Escape'); await drawer.waitFor({ state: 'hidden' });
      if (width < 900 && kind === 'ROLEPLAY' && await page.getByRole('button', { name: '收起对话选项', exact: true }).isVisible())
        await page.getByRole('button', { name: '收起对话选项', exact: true }).click();
    };
    await openSettings();
    const thinking = drawer.getByRole('switch', { name: '深度思考', exact: true }), web = drawer.getByRole('switch', { name: '联网搜索', exact: true });
    if (kind === 'ASSISTANT') {
      assert.equal(await thinking.getAttribute('aria-checked'), 'true');
      await thinking.locator('..').click(); assert.equal(await thinking.getAttribute('aria-checked'), 'false'); await thinking.locator('..').click();
    } else assert.equal(await thinking.count(), 0, 'Roleplay has no deep-thinking setting, including old cached true');
    if (kind === 'ASSISTANT') { assert.equal(await web.getAttribute('aria-checked'), 'false'); await web.locator('..').click(); assert.equal(await web.getAttribute('aria-checked'), 'true'); }
    else assert.equal(await web.count(), 0, 'Roleplay has no web-search setting');
    await closeSettings();
    await page.locator('.chat-textarea textarea').fill('虚构请求');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const details = page.locator('details.generation-process');
    await details.locator('.process-current').getByText(kind === 'ASSISTANT' ? '深度思考中' : '生成回答', { exact: true }).waitFor();
    await openSettings();
    if (kind === 'ASSISTANT') assert(await thinking.isDisabled());
    else assert.equal(await thinking.count(), 0);
    if (kind === 'ASSISTANT') assert(await web.isDisabled());
    await closeSettings();
    await details.locator('summary').focus(); await page.keyboard.press('Enter');
    await details.locator('.process-body').waitFor();
    assert.equal(await details.evaluate(el => el.open), true);
    assert.equal(await page.locator('.typing-indicator').count(), 1, 'One pending bubble, not duplicate process replies');
    assert.equal(await details.locator('.model-active,.process-metrics').count(), 0);
    assert.equal(await details.locator('.process-phases li').count() > 0, true);
    assert.equal(await details.locator('.process-summary').count() > 0, true);
    if (kind === 'ASSISTANT') assert((await details.innerText()).includes('1,234 字思考数据'));
    else assert(!(await details.innerText()).includes('深度'));
    assert(!(await page.locator('body').innerText()).includes('SECRET_'));
    await page.screenshot({ path: join(output, `initial-${kind.toLowerCase()}-${width}.png`), fullPage: true });
    middle.resolve();
    await details.locator('.process-current').getByText('核对依据', { exact: true }).waitFor();
    assert.equal(await details.evaluate(el => el.open), true, 'Progress updates preserve the expanded process');
    assert(!(await details.innerText()).includes('次调用'));
    assert.equal(await details.locator('.process-indicator').evaluate(el => getComputedStyle(el).animationName), 'none');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `pending-${kind.toLowerCase()}-${width}.png`), fullPage: true });
    finish.resolve(); await page.getByText(content, { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
      return !store.isStreaming && store.messages.some(message => message.id === 2);
    });
    if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
    await details.locator('.process-body').waitFor();
    assert.equal(await details.locator('.process-current').innerText(), kind === 'ASSISTANT' ? '深度思考完成' : '已完成');
    const elapsed = await details.locator('.process-elapsed').innerText();
    await page.waitForTimeout(350); assert.equal(await details.locator('.process-elapsed').innerText(), elapsed, 'Completed timers freeze');
    assert.equal(writes.length, 1, 'Reconnects cannot submit a second model task');
    assert.equal(writes[0].mode, 'agent'); assert.equal(!!writes[0].persona, kind === 'ROLEPLAY');
    assert.equal(writes[0].deepThinking, kind === 'ASSISTANT'); assert.equal(writes[0].webSearch, kind === 'ASSISTANT');
    assert(!writes[0].enabledSkills.includes('web_search'), 'Only the explicit server switch grants network permission');
    const sourceDetails = page.locator('.web-source-details');
    if (kind === 'ASSISTANT') {
    await sourceDetails.locator('summary').click();
    const source = sourceDetails.getByRole('link', {name: /虚构公开来源/}); await source.waitFor();
    assert.equal(await source.getAttribute('href'), 'https://example.org/source');
    assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
    } else assert.equal(await sourceDetails.count(), 0, 'Old roleplay web metadata cannot render network UI');
    assert(!(await page.locator('body').innerText()).includes('UNSAFE_SOURCE'));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `options-sources-${kind.toLowerCase()}-${width}.png`), fullPage: true });
    assert(!(await page.locator('body').innerText()).includes('SECRET_'));
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px ${kind}: expandable pending phases, live updates, private-text filtering, stable single bubble, reduced motion, frozen completion, one durable task`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

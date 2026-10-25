// Synthetic UI acceptance only: all APIs (including run/file writes) are intercepted.
// Never send real chats, attachments, model calls, login or mail requests.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = (process.env.CHAT_UX_TEST_BASE || 'http://127.0.0.1:4190/').replace(/\/?$/, '/');
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = join(__dirname, '../../.local/chat-ux-review'); mkdirSync(output, { recursive: true });
const testKinds = (process.env.CHAT_UX_TEST_KINDS || 'ASSISTANT,ROLEPLAY').split(',');
assert(testKinds.length && testKinds.every(kind => ['ASSISTANT', 'ROLEPLAY'].includes(kind)));
const testFocus = process.env.CHAT_UX_TEST_FOCUS || 'all';
assert(['all', 'parallel', 'typing', 'resume', 'recovery'].includes(testFocus));
const viewer = { id: 99231, username: '虚构体验测试', email: 'synthetic@example.test', role: 'USER' };
const conversations = [
  { id: 12001, title: '合成普通对话', conversationType: 'ASSISTANT' },
  { id: 12003, title: '合成并行对话', conversationType: 'ASSISTANT' },
  { id: 12002, title: '合成角色对话', conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona', personaLabel: '加藤惠' },
].map(row => ({ ...row, userId: viewer.id, updatedAt: '2026-10-19T01:00:00Z' }));
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
// Element Plus exposes a zero-size native switch input for AT/keyboard and a
// visible clickable parent track. Exercise that visible track, not force-click.
const toggleSwitch = locator => locator.locator('..').click();
const waitForPopoverPaint = page => page.waitForFunction(() => {
  const popover = document.querySelector('.answer-preferences-popover');
  return popover && getComputedStyle(popover).opacity === '1' &&
    popover.getAnimations().every(animation => animation.playState !== 'running');
});
const performance = phase => ({ stage: phase === 'completed' ? 'completed' : phase === 'verifying' ? 'verifying' : 'generating',
  phase, elapsedMs: 47000, phaseElapsedMs: 45000, firstTokenMs: null, queueMs: 200,
  modelCalls: 2, activeModelCalls: phase === 'completed' ? 0 : 1, stages: [], phases: [
    { phase: 'queued', durationMs: 200, modelCalls: 0 }, { phase: 'context', durationMs: 1800, modelCalls: 0 },
    { phase, durationMs: 45000, modelCalls: 2 },
  ], reasoning_content: 'PRIVATE_REASONING_MUST_NOT_APPEAR', prompt: 'PRIVATE_PROMPT_MUST_NOT_APPEAR' });

async function assertTypingGeometry(page) {
  const geometry = await page.locator('.typing-indicator').evaluate(indicator => {
    const bubble = indicator.closest('.thinking-bubble'), body = indicator.closest('.message-body');
    const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; };
    return { dots: [...indicator.children].map(box), holder: box(indicator), bubble: box(bubble), body: box(body),
      status: box(body.querySelector('.generation-status .process-indicator')),
      pseudoBefore: getComputedStyle(indicator, '::before').content, pseudoAfter: getComputedStyle(indicator, '::after').content };
  });
  assert.equal(geometry.dots.length, 3, 'Three real dots participate in layout');
  assert.equal(geometry.pseudoBefore, 'none'); assert.equal(geometry.pseudoAfter, 'none');
  assert(geometry.dots.every(dot => dot.width === 8 && dot.left >= geometry.body.left + 7 && dot.right <= geometry.bubble.right + 1), 'All dots stay inside the message content gutter');
  assert(Math.abs(geometry.dots[0].left - geometry.status.left) <= 1, 'The first waiting dot aligns with the status indicator');
  assert.equal(geometry.dots[1].left - geometry.dots[0].left, 16); assert.equal(geometry.dots[2].left - geometry.dots[1].left, 16);
}

async function fixture(browser, width, kind, libraryMode = 'ready') {
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width <= 900, hasTouch: width <= 900, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const state = { messages: [], files: [], writes: [], calls: [], errors: [], runs: [], recovery: [], nextOutcome: 'success', library: gate() };
  const cid = kind === 'ROLEPLAY' ? 12002 : 12001;
  page.on('pageerror', error => state.errors.push(error.message));
  await page.addInitScript(viewer => {
    localStorage.setItem('chatforum-user', JSON.stringify({ user: viewer, token: 'synthetic-ux-only', refreshToken: '' }));
    localStorage.setItem('chatforum-chat', JSON.stringify({ conversationSettings: {
      12001: { agentMode: 'normal', knowledgeBaseId: 0 },
      12002: { selectedPersona: 'kato_megumi_persona', agentMode: 'agent', knowledgeBaseId: 73, deepThinking: true, webSearch: true },
    } }));
  }, viewer);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    if (!path.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
    state.calls.push({ path, method });
    const headers = { 'Access-Control-Allow-Origin': origin };
    const json = (data, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify({ success: status < 400, data }) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    if (path === '/api/chat/config') return json({ configured: true, defaultModelId: 'qwen3.8-max', models: [{ id: 'qwen3.8-max', label: 'Qwen3.8-Max', available: true }] });
    if (path === '/api/chat/conversations') return json(conversations);
    if (path === '/api/chat/runs/recovery') return json(Number(url.searchParams.get('conversationId')) === cid ? state.recovery : []);
    if (/\/chat\/conversations\/\d+\/messages$/.test(path)) {
      const conversationId = Number(path.split('/')[4]);
      return json(state.messages.filter(message => message.conversationId === conversationId));
    }
    if (path === '/api/rag/knowledge-bases') {
      if (libraryMode === 'slow') await state.library.promise;
      return json([{ id: 73, name: '路人女主 · 加藤惠的原作记忆', permission: 'READER',
        chatReady: libraryMode !== 'unavailable', activeIndexVersion: 1,
        ...(libraryMode === 'unavailable' ? { chatUnavailableReason: '合成知识库尚未准备好，请稍后重试。' } : {}) }]);
    }
    if (path.includes('unread-count')) return json({ unreadCount: 0, inbox: 0, requests: 0, total: 0 });
    if (/^\/api\/coding\/\d+$/.test(path)) return json({ files: state.files, changes: [] });
    if (/^\/api\/coding\/\d+\/files$/.test(path) && method === 'POST') {
      const body = request.postDataJSON();
      state.files.push(...body.files.map((file, index) => ({ id: 700 + index, path: file.path, kind: 'text', revision: 1, bytes: Buffer.byteLength(file.content) })));
      return json({ files: state.files });
    }
    if (path === '/api/chat/runs' && method === 'POST') {
      const input = request.postDataJSON(), run = { id: 'synthetic-ux-' + (state.runs.length + 1), input,
        outcome: state.nextOutcome, failedGeneration: state.failedGeneration, status: 'RUNNING', reads: 0, finish: gate() };
      state.runs.push(run); state.writes.push(input); return json({ id: run.id, status: run.status });
    }
    const run = state.runs.find(item => path.startsWith('/api/chat/runs/' + item.id));
    if (run && method === 'DELETE') { run.status = 'CANCELLED'; run.finish.resolve(); return json({ id: run.id, status: run.status }); }
    if (run && path.endsWith('/events')) {
      const sse = body => route.fulfill({ contentType: 'text/event-stream', headers, body }).catch(() => undefined);
      const runKind = run.input.conversationId === 12002 ? 'ROLEPLAY' : 'ASSISTANT';
      if (!run.reads++) return sse('event: progress\ndata: ' + JSON.stringify(performance(runKind === 'ROLEPLAY' ? 'verifying' : 'generating')) + '\n\n');
      await run.finish.promise;
      if (run.status === 'CANCELLED') return sse('event: terminal\ndata: {"status":"CANCELLED"}\n\n');
      if (run.outcome === 'failure') {
        run.status = 'FAILED'; return sse('event: terminal\ndata: ' + JSON.stringify({ status: 'FAILED', error: '合成模型服务暂时不可用，请稍后重试。',
          result: { failure: { code: 'MODEL_REQUEST_TIMEOUT', message: '合成模型等待超时，请重新发送。' },
            ...(run.failedGeneration ? { ragMetadata: { generation: run.failedGeneration } } : {}) } }) + '\n\n');
      }
      run.status = 'COMPLETED';
      const searchEnabled = runKind === 'ASSISTANT' && run.input.webSearch === true;
      const content = runKind === 'ROLEPLAY' ? '嗯，那就随便聊聊吧。你今天有没有碰到什么有意思的事？'
        : searchEnabled ? '联网暂时不可用，本轮没有获取到新的公开资料。' : '这是一条合成回答。';
      const metadata = { state: runKind === 'ROLEPLAY' ? 'roleplay' : 'general', performance: performance('completed'),
        responseOptions: { deepThinking: runKind === 'ASSISTANT', webSearch: searchEnabled },
        ...(searchEnabled ? { webSearch: { enabled: true, sources: [], failure: 'SEARCH_UNAVAILABLE' } } : {}) };
      state.messages.push({ id: state.messages.length + 1, role: 'USER', conversationId: run.input.conversationId, content: run.input.question },
        { id: state.messages.length + 2, role: 'ASSISTANT', conversationId: run.input.conversationId, content, ragMetadata: metadata });
      return sse('event: delta\ndata: ' + JSON.stringify({ text: content, offset: content.length }) + '\n\nevent: complete\ndata: ' +
        JSON.stringify({ status: 'COMPLETED', result: { content, ragMetadata: metadata } }) + '\n\n');
    }
    if (run) return json({ id: run.id, status: run.status });
    if (method !== 'GET') throw Error('Unexpected synthetic write: ' + method + ' ' + path);
    return json([]);
  });
  await page.goto(base + 'chat'); await page.locator('.chat-layout').waitFor();
  const waitSelected = id => page.waitForFunction(id => {
    const store = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('chat');
    return store?.currentConversation?.id === id && !store.isLoadingConversation;
  }, id);
  await waitSelected(12001);
  if (kind === 'ROLEPLAY') {
    if (width <= 900) await page.getByRole('button', { name: '对话列表', exact: true }).click();
    await page.getByRole('tab', { name: '角色对话', exact: true }).click();
    await page.locator('.conversation-item').filter({ hasText: '合成角色对话' }).click();
    await waitSelected(12002);
  }
  const textbox = page.locator('.chat-textarea textarea');
  const busy = value => page.waitForFunction(value => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('chat')?.isStreaming === value, value);
  const capture = async name => {
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
    assert(!(await page.locator('body').innerText()).includes('PRIVATE_'), 'No raw reasoning/system text in UI');
    await page.waitForFunction(() => [...document.querySelectorAll('.chat-message')].every(message => message.getAnimations().every(animation => animation.playState !== 'running')));
    await page.screenshot({ path: join(output, `${name}-${kind.toLowerCase()}-${width}.png`), fullPage: true });
  };
  const openSettings = async () => {
    if (width > 900) await page.locator('.btn-settings').click();
    else if (kind === 'ASSISTANT') await page.getByRole('button', { name: '模型设置', exact: true }).filter({ visible: true }).first().click();
    else {
      await page.getByRole('button', { name: '对话选项', exact: true }).click();
      await page.locator('.chat-toolbar').getByRole('button', { name: '设置', exact: true }).click();
    }
    await page.locator('.settings-drawer').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const drawer = document.querySelector('.settings-drawer'); if (!drawer) return false;
      const box = drawer.getBoundingClientRect(); return box.left >= -1 && box.right <= innerWidth + 1;
    });
  };
  const closeSettings = async () => {
    await page.locator('.settings-drawer .el-drawer__close-btn').click();
    await page.locator('.settings-drawer').waitFor({ state: 'hidden' });
    const closeOptions = page.getByRole('button', { name: '收起对话选项', exact: true });
    if (await closeOptions.isVisible()) await closeOptions.click();
  };
  const selectByTitle = async (title, id) => {
    if (width <= 900) await page.getByRole('button', { name: '对话列表', exact: true }).click();
    await page.locator('.conversation-item').filter({ hasText: title }).click(); await waitSelected(id);
    if (width <= 900) await page.waitForFunction(() => document.querySelector('.chat-sidebar')?.getBoundingClientRect().right <= 0);
  };
  return { page, state, cid, textbox, busy, capture, openSettings, closeSettings, selectByTitle,
    close: async () => { state.library.resolve(); state.runs.forEach(run => run.finish.resolve()); await page.close(); } };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of testFocus === 'all' ? [320, 390, 1440] : []) for (const kind of testKinds) {
      const f = await fixture(browser, width, kind);
      try {
        const { page, state, textbox, busy, capture, openSettings, closeSettings } = f;
        assert.equal(await page.locator('.chat-input-area .response-options,.assistant-welcome .response-options').count(), 0, 'No thinking/search controls in either composer');
        await openSettings();
        assert.equal(await page.locator('.settings-drawer .model-help,.settings-drawer .response-setting-row p,.assistant-footnote').count(), 0, 'No fixed explanatory copy remains in settings or below the composer');
        const deep = page.getByRole('switch', { name: '深度思考', exact: true }), web = page.getByRole('switch', { name: '联网搜索', exact: true });
        if (kind === 'ASSISTANT') assert.equal(await deep.getAttribute('aria-checked'), 'true');
        else assert.equal(await deep.count(), 0, 'Roleplay has no deep-thinking toggle');
        if (kind === 'ASSISTANT') {
          assert.equal(await web.getAttribute('aria-checked'), 'false');
          assert(!state.calls.some(call => call.path === '/api/rag/knowledge-bases'));
          await toggleSwitch(web);
        } else assert.equal(await web.count(), 0, 'Roleplay has no web-search toggle, including stale saved true options');
        await capture('settings-drawer'); await closeSettings();
        const preferences = page.getByRole('button', { name: '回答设置', exact: true });
        if (kind === 'ASSISTANT') {
          assert.equal(await preferences.count(), 1);
          assert.equal(await preferences.locator('svg').count(), 1, 'Icon-only mobile preference trigger must render its icon');
          await preferences.focus(); await page.keyboard.press('Enter');
          const panel = page.getByRole('group', { name: '本次会话的回答设置', exact: true }); await panel.waitFor(); await waitForPopoverPaint(page);
          assert.equal(await panel.locator('.preferences-heading,.preference-row small').count(), 0, 'Popover keeps functional switches without repeated captions');
          assert.equal(await panel.getByRole('switch', { name: '联网搜索', exact: true }).getAttribute('aria-checked'), 'true', 'Popover and drawer share confirmed options');
          await toggleSwitch(panel.getByRole('switch', { name: '深度思考', exact: true }));
          assert.equal(await panel.getByRole('switch', { name: '深度思考', exact: true }).getAttribute('aria-checked'), 'false');
          await toggleSwitch(panel.getByRole('switch', { name: '深度思考', exact: true }));
          const popover = page.locator('.answer-preferences-popover');
          const bounds = await popover.boundingBox();
          assert(bounds && bounds.x >= -1 && bounds.x + bounds.width <= width + 1, 'Preference popover stays horizontally in viewport');
          await capture('answer-preferences-popover'); await preferences.click(); await panel.waitFor({ state: 'hidden' });
        } else assert.equal(await preferences.count(), 0, 'Roleplay never displays assistant deep-thinking popover');
        await textbox.fill(kind === 'ROLEPLAY' ? '惠，今天想聊点轻松的话题。' : '看看今天的校园公告吧。');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        const process = page.locator('details.generation-process').last();
        await process.locator('.process-elapsed').waitFor(); await process.locator('summary').click();
        await process.locator('.process-body').waitFor();
        assert.equal(await page.locator('.typing-indicator').count(), 1);
        await assertTypingGeometry(page);
        const stop = page.getByRole('button', { name: '停止生成', exact: true }), stopBox = await stop.boundingBox();
        assert(stopBox && stopBox.x >= 0 && stopBox.x + stopBox.width <= width + 1 && stopBox.y + stopBox.height <= 844, 'Stop stays inside viewport');
        await capture('expanded-pending');
        await openSettings();
        if (kind === 'ASSISTANT') { assert(await web.isDisabled()); assert(await deep.isDisabled()); }
        else { assert.equal(await deep.count(), 0); assert.equal(await web.count(), 0); }
        await closeSettings();
        state.runs.at(-1).finish.resolve(); await busy(false);
        if (kind === 'ASSISTANT') await page.getByText('联网搜索暂不可用', { exact: true }).waitFor();
        else {
          await page.getByText('嗯，那就随便聊聊吧。你今天有没有碰到什么有意思的事？', { exact: true }).waitFor();
          assert.equal(await page.getByText('联网搜索暂不可用', { exact: true }).count(), 0, 'Roleplay has no search failure state');
          assert(!state.messages.at(-1).ragMetadata.webSearch, 'Roleplay response metadata has no search status');
        }
        await openSettings();
        if (kind === 'ASSISTANT') { assert.equal(await web.isDisabled(), false); assert.equal(await deep.isDisabled(), false); }
        else assert.equal(await web.count(), 0);
        await closeSettings();
        assert.equal(state.writes[0].deepThinking, kind === 'ASSISTANT'); assert.equal(state.writes[0].webSearch, kind === 'ASSISTANT');
        assert.equal(state.writes[0].mode, kind === 'ASSISTANT' ? 'normal' : 'agent');
        assert(!state.writes[0].enabledSkills.includes('web_search'));
        assert.equal(state.writes[0].knowledgeBaseId || 0, kind === 'ROLEPLAY' ? 73 : 0);
        await capture(kind === 'ASSISTANT' ? 'search-unavailable' : 'roleplay-natural-dialogue');

        if (kind === 'ASSISTANT') {
          await page.locator('.assistant-composer input[type=file]').setInputFiles({ name: '合成附件.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic attachment only') });
          await page.getByRole('button', { name: '移除待发送附件 合成附件.txt', exact: true }).waitFor();
        }
        const failedQuestion = '这条合成消息失败后应该恢复到输入框。';
        state.nextOutcome = 'failure'; await textbox.fill(failedQuestion);
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        if (kind === 'ASSISTANT') assert.equal(await page.locator('.attachment-chip').count(), 0, 'Accepted files leave pending composer');
        state.runs.at(-1).finish.resolve(); await busy(false);
        await page.waitForFunction(text => document.querySelector('.chat-textarea textarea')?.value === text, failedQuestion);
        if (kind === 'ASSISTANT') await page.getByRole('button', { name: '移除待发送附件 合成附件.txt', exact: true }).waitFor();
        const failure = page.locator('.generation-failure'); await failure.waitFor();
        assert.equal(await failure.locator('strong').innerText(), '回答未生成');
        assert.equal(await failure.locator('p').innerText(), '合成模型等待超时，请重新发送。');
        assert.equal(await page.locator('.chat-message.user').last().locator('.message-text').innerText(), failedQuestion, 'Failed question remains in the conversation');
        assert.equal(state.writes.length, 2, 'A terminal failure never starts another model task automatically');
        const failureBounds = await failure.boundingBox();
        assert(failureBounds && failureBounds.x >= -1 && failureBounds.x + failureBounds.width <= width + 1, 'Failure card stays inside the viewport');
        assert.equal(await page.locator('.typing-indicator').count(), 0); await capture('failure-draft-restored');

        state.nextOutcome = 'success'; await failure.getByRole('button', { name: '重新发送', exact: true }).click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        await page.getByRole('button', { name: '停止生成', exact: true }).click(); await busy(false);
        await page.waitForFunction(text => document.querySelector('.chat-textarea textarea')?.value === text, failedQuestion);
        if (kind === 'ASSISTANT') await page.getByRole('button', { name: '移除待发送附件 合成附件.txt', exact: true }).waitFor();
        assert.equal(await page.locator('.generation-failure strong').innerText(), '已停止生成');
        assert.equal(state.writes.length, 3, 'Failure/cancel must not silently resubmit a paid task');
        assert.equal(await page.locator('.typing-indicator').count(), 0); await capture('cancel-draft-restored');
        if (width === 320 && kind === 'ASSISTANT') {
          await page.setViewportSize({ width, height: 480 }); await textbox.focus();
          const sendBounds = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
          assert(sendBounds && sendBounds.y + sendBounds.height <= 480, 'Composer send remains reachable with short keyboard viewport');
          await capture('keyboard-composer');
          await preferences.click(); await page.getByRole('group', { name: '本次会话的回答设置', exact: true }).waitFor(); await waitForPopoverPaint(page);
          const popover = await page.locator('.answer-preferences-popover').boundingBox();
          assert(popover && popover.x >= -1 && popover.x + popover.width <= width + 1 && popover.y >= -1 && popover.y + popover.height <= 481,
            'Preference popover fits the narrow keyboard viewport');
          await capture('keyboard-preferences-popover');
        }
        assert.deepEqual(state.errors, []);
        console.log(`PASS ${width}px ${kind}: real pending expansion, safe telemetry, normal/Agent flags, ${kind === 'ASSISTANT' ? 'search error' : 'natural synthetic dialogue without search controls/status'}, failure/cancel text + attachment recovery, no overflow`);
      } catch (error) {
        await f.capture('unexpected-failure');
        console.error('Synthetic UI errors:', f.state.errors);
        throw error;
      } finally { await f.close(); }
    }
    for (const width of ['all', 'parallel'].includes(testFocus) && testKinds.includes('ASSISTANT') ? [390, 1440] : []) {
      const f = await fixture(browser, width, 'ASSISTANT');
      try {
        const { page, state, textbox, busy, capture, selectByTitle } = f;
        await textbox.fill('第一个会话的问题'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        await selectByTitle('合成并行对话', 12003); await busy(false);
        await textbox.fill('第二个会话的问题'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        assert.deepEqual(state.writes.map(write => write.conversationId), [12001, 12003], 'Different conversations admit distinct tasks concurrently');
        assert(!state.calls.some(call => call.method === 'DELETE'), 'Switching conversations never cancels the background run');
        await selectByTitle('合成普通对话', 12001); await busy(true);
        assert.equal(await page.locator('.chat-message.user .message-text').last().innerText(), '第一个会话的问题');
        await selectByTitle('合成并行对话', 12003); await busy(true);
        assert.equal(await page.locator('.chat-message.user .message-text').last().innerText(), '第二个会话的问题');
        state.runs[0].finish.resolve();
        await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia._s.get('chat')?.isConversationStreaming(12001) === false);
        await busy(true);
        assert.equal(await page.locator('.chat-message.user .message-text').last().innerText(), '第二个会话的问题', 'Background completion preserves the selected conversation');
        assert.equal(await page.locator('.typing-indicator').count(), 1, 'B pending survives A completion');
        await capture('parallel-conversations-pending');
        await page.getByRole('button', { name: '停止生成', exact: true }).click(); await busy(false);
        assert.deepEqual(state.calls.filter(call => call.method === 'DELETE').map(call => call.path), ['/api/chat/runs/synthetic-ux-2'], 'Stop targets only the selected conversation');
        await selectByTitle('合成普通对话', 12001); await busy(false);
        await page.getByText('这是一条合成回答。', { exact: true }).waitFor();
        assert.equal(await page.locator('.generation-failure').count(), 0, 'Completed A cannot inherit B cancellation');
        assert.deepEqual(state.errors, []);
        console.log(`PASS ${width}px parallel ASSISTANT conversations: A/B admitted, pending isolated, background completion preserved B, stop targeted B only`);
      } finally { await f.close(); }
    }
    for (const width of testFocus === 'recovery' ? [390, 1440] : []) {
      const f = await fixture(browser, width, 'ASSISTANT');
      try {
        const { page, state, busy, capture, textbox } = f;
        const id = '10000000-0000-4000-8000-000000000001';
        const active = { id, input: { conversationId: f.cid, question: '真实服务器保存的合成原题' },
          status: 'RUNNING', reads: 0, finish: gate(), outcome: 'success' };
        state.runs.push(active); state.recovery = [{ id, status: 'RUNNING' }];
        await page.reload(); await busy(true);
        assert.equal(await page.locator('.chat-message.user').count(), 0, 'Refresh cannot invent a USER message or reveal the private request');
        assert.equal(await page.locator('.chat-message.assistant').count(), 1);
        await page.locator('.generation-status .process-indicator').waitFor();
        assert.equal(state.writes.length, 0, 'Re-subscribing never creates another paid task');
        await capture('refresh-running-task');
        state.recovery = []; active.finish.resolve(); await busy(false);
        await page.getByText('真实服务器保存的合成原题', { exact: true }).waitFor();
        assert.equal(await page.locator('.chat-message.user').count(), 1, 'Only successful real server history supplies the original turn');
        assert.equal(state.writes.length, 0);
        state.messages = [];
        const pointer = { draftId: id, revision: 3, hash: 'b'.repeat(64) };
        state.recovery = [{ id, status: 'FAILED', progress: { elapsedMs: 47000 }, result: {
          ragMetadata: { generation: { fileIncomplete: true, truncated: true, canContinue: true, resumeFile: pointer,
            privatePrefix: 'PRIVATE_SOURCE_MUST_NOT_APPEAR' } } } }];
        await page.reload(); const resume = page.getByRole('button', { name: '继续完成文件', exact: true }); await resume.waitFor();
        assert.equal(await page.locator('.chat-message.user').count(), 0);
        assert.equal(await textbox.inputValue(), '', 'Discovery cannot overwrite composer text');
        assert.equal(await page.getByRole('button', { name: '重新发送', exact: true }).count(), 0);
        assert.equal(await page.locator('.generation-failure .failure-heading strong').innerText(), '文件尚未完成');
        await capture('refresh-file-task'); await resume.click(); await busy(true);
        assert.equal(state.writes.length, 1); assert.deepEqual(state.writes[0].resumeFile, pointer);
        assert.equal(state.writes[0].question, '继续完成文件');
        state.recovery = []; state.runs.at(-1).finish.resolve(); await busy(false);
        assert.deepEqual(state.errors, []);
        console.log(`PASS ${width}px refreshed tasks: original run reattached without POST/USER fabrication; real completed history restores, failed private file resumes only on explicit click`);
      } finally { await f.close(); }
    }
    for (const width of testFocus === 'resume' ? [390, 1440] : []) {
      const f = await fixture(browser, width, 'ASSISTANT');
      try {
        const { page, state, textbox, busy, capture } = f;
        const pointer = { draftId: '39411c9b-62be-44da-b3bc-1eac374f3925', revision: 2, hash: 'a'.repeat(64) };
        const generation = { truncated: true, canContinue: true, fileIncomplete: true, fileFailureReason: 'OUTPUT_LIMIT', resumeFile: pointer };
        state.messages.push({ id: 101, role: 'USER', conversationId: f.cid, content: '合成页面需求' },
          { id: 102, role: 'ASSISTANT', conversationId: f.cid, content: '文件仍未完成。', ragMetadata: { generation } },
          { id: 103, role: 'USER', conversationId: f.cid, content: '后续对话' },
          { id: 104, role: 'ASSISTANT', conversationId: f.cid, content: '这是一条后续回答。' });
        const reload = () => page.evaluate(async () => {
          const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat');
          store.dismissFailedAttempt(store.currentConversation.id); await store.selectConversation(store.currentConversation);
        });
        await reload(); const resume = page.getByRole('button', { name: '继续完成文件', exact: true }); await resume.waitFor();
        assert.equal(await page.locator('.generation-status .process-current').first().innerText(), '文件未完成');
        assert.equal(await page.locator('.file-resume-unavailable').count(), 0); assert.equal(state.writes.length, 0);
        await capture('file-resume-available'); state.nextOutcome = 'failure'; await resume.click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        assert.deepEqual(state.writes[0].resumeFile, pointer); assert.equal(state.writes[0].question, '继续完成文件');
        assert.equal(await page.locator('.chat-message.user .message-text').last().innerText(), '继续完成文件');
        state.runs[0].finish.resolve(); await busy(false); assert.equal(state.writes.length, 1, 'Resume failure cannot submit another paid task automatically');
        assert.equal(await page.locator('.generation-failure .failure-heading strong').innerText(), '回答未生成');
        assert.equal(await page.locator('.generation-failure p').innerText(), '合成模型等待超时，请重新发送。');
        state.nextOutcome = 'success'; await page.locator('.generation-failure').getByRole('button', { name: '重新发送', exact: true }).click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        assert.deepEqual(state.writes[1].resumeFile, pointer, 'Explicit retry retains the exact source revision/hash');
        await page.getByRole('button', { name: '停止生成', exact: true }).click(); await busy(false); await textbox.fill('');
        state.messages.splice(2); delete generation.resumeFile; await reload();
        await page.getByRole('button', { name: '重新生成文件', exact: true }).waitFor();
        await page.getByText('此回答未保留草稿，无法接着完成。', { exact: true }).waitFor();
        assert.equal(await resume.count(), 0); await capture('file-resume-unavailable'); assert.deepEqual(state.errors, []);
        console.log(`PASS ${width}px file resume: older answer sends versioned pointer, visible action name, explicit retry preserves pointer, old no-draft response is clear`);
      } finally { await f.close(); }
    }
    for (const width of testFocus === 'resume' ? [390, 1440] : []) {
      const f = await fixture(browser, width, 'ASSISTANT');
      try {
        const { page, state, textbox, busy, capture } = f;
        const pointer = { draftId: '39411c9b-62be-44da-b3bc-1eac374f3925', revision: 3, hash: 'b'.repeat(64) };
        const originalQuestion = '这是合成文件需求，先生成文件再模拟服务中断。';
        state.failedGeneration = { truncated: true, canContinue: true, fileIncomplete: true,
          fileFailureReason: 'SERVICE_ERROR', resumeFile: pointer, privatePrefix: 'PRIVATE_FILE_SOURCE_MUST_NOT_APPEAR' };
        state.nextOutcome = 'failure'; await textbox.fill(originalQuestion);
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        assert(!state.writes[0].resumeFile, 'The original task is not already a resume request');
        state.runs[0].finish.resolve(); await busy(false);
        const failure = page.locator('.generation-failure'); await failure.waitFor();
        const resume = failure.getByRole('button', { name: '继续完成文件', exact: true }); await resume.waitFor();
        assert.equal(await failure.locator('.failure-heading strong').innerText(), '文件尚未完成');
        assert.equal(await failure.locator('p').innerText(), '文件草稿已保存，可以继续完成。');
        assert(!(await failure.innerText()).includes('请重新发送'), 'The recovery card cannot instruct restarting the original task');
        assert.equal(await failure.getByRole('button', { name: '重新发送', exact: true }).count(), 0,
          'A newly saved server draft takes priority over re-running the original task');
        assert.equal(await textbox.inputValue(), originalQuestion, 'The interrupted task still restores its original composer draft');
        assert.equal(state.writes.length, 1, 'Saving a recovery pointer never auto-submits another model request');
        await capture('service-failed-file-resume');
        await textbox.fill('这是用户刚写的新草稿。'); await resume.click();
        assert.equal(state.writes.length, 1, 'A resume click cannot discard a newer user draft');
        assert.equal(await textbox.inputValue(), '这是用户刚写的新草稿。');
        await textbox.fill(originalQuestion); state.nextOutcome = 'success'; state.failedGeneration = undefined;
        await resume.click(); await page.getByRole('button', { name: '停止生成', exact: true }).waitFor();
        assert.equal(state.writes.length, 2); assert.deepEqual(state.writes[1].resumeFile, pointer);
        assert.equal(state.writes[1].question, '继续完成文件');
        assert.equal(await page.locator('.chat-message.user .message-text').last().innerText(), '继续完成文件');
        state.runs[1].finish.resolve(); await busy(false);
        assert.equal(await failure.count(), 0); assert.deepEqual(state.errors, []);
        console.log(`PASS ${width}px service-failed file: safe server draft action, no automatic retry, new composer draft protected, explicit click sends new pointer only`);
      } finally { await f.close(); }
    }
    if (testFocus === 'resume') {
      const f = await fixture(browser, 390, 'ROLEPLAY');
      try {
        f.state.messages.push({ id: 201, role: 'ASSISTANT', conversationId: f.cid, content: '这是一条合成角色回复。',
          ragMetadata: { generation: { truncated: true, canContinue: true, fileIncomplete: true,
            resumeFile: { draftId: '39411c9b-62be-44da-b3bc-1eac374f3925', revision: 2, hash: 'a'.repeat(64) } } } });
        await f.page.evaluate(async () => { const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat'); await store.selectConversation(store.currentConversation); });
        assert.equal(await f.page.getByRole('button', { name: '继续完成文件', exact: true }).count(), 0);
        assert.equal(await f.page.getByRole('button', { name: '重新生成文件', exact: true }).count(), 0);
        assert.equal(await f.page.locator('.file-resume-unavailable').count(), 0); assert.equal(f.state.writes.length, 0);
        console.log('PASS 390px ROLEPLAY: stale file-resume metadata cannot expose file actions or no-draft explanations');
      } finally { await f.close(); }
    }
    for (const width of testFocus === 'typing' ? [390, 1440] : []) for (const kind of testKinds) {
      const f = await fixture(browser, width, kind);
      try {
        await f.textbox.fill(kind === 'ROLEPLAY' ? '惠，今天想聊点轻松的话题。' : '这是一条合成问题。');
        await f.page.getByRole('button', { name: '发送消息', exact: true }).click();
        await f.page.locator('.generation-status .process-elapsed').waitFor();
        await assertTypingGeometry(f.page); await f.capture('typing-aligned');
        await f.page.getByRole('button', { name: '停止生成', exact: true }).click(); await f.busy(false);
        assert.deepEqual(f.state.errors, []); console.log(`PASS ${width}px ${kind}: all three loading dots inside content, aligned with status, no pseudo-element overflow`);
      } finally { await f.close(); }
    }
    for (const libraryMode of testFocus === 'all' && testKinds.includes('ROLEPLAY') ? ['slow', 'unavailable'] : []) {
      const f = await fixture(browser, 390, 'ROLEPLAY', libraryMode);
      try {
        if (libraryMode === 'unavailable') {
          await f.page.getByRole('button', { name: '对话选项', exact: true }).click();
          await f.page.locator('.knowledge-notice').filter({ hasText: '合成知识库尚未准备好，请稍后重试。' }).waitFor();
          await f.capture('library-unavailable-options');
          await f.page.getByRole('button', { name: '收起对话选项', exact: true }).click();
        }
        await f.textbox.fill('想问问小说里的一件事。');
        await f.page.getByRole('button', { name: '发送消息', exact: true }).click();
        await f.page.waitForTimeout(150);
        if (libraryMode === 'unavailable') {
          assert.equal(f.state.writes.length, 0, 'Unavailable KB cannot silently run without it');
          assert.equal(await f.textbox.inputValue(), '想问问小说里的一件事。');
        } else assert(f.state.writes.every(write => write.knowledgeBaseId === 73), 'Known KB is never silently dropped while list reloads');
        await f.capture('library-' + libraryMode);
        assert.deepEqual(f.state.errors, []);
        console.log(`PASS 390px ROLEPLAY ${libraryMode} KB: ${libraryMode === 'unavailable' ? 'explicit blocked send, original draft retained, no model task' : 'known KB remains in any admitted task, no silent downgrade'}`);
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

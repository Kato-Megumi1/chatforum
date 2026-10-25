// Local synthetic acceptance only. Every API is intercepted; no accounts, models,
// real files or production review images are read or changed.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = (process.env.ARTIFACT_REVIEW_TEST_BASE || 'http://127.0.0.1:4190/').replace(/\/?$/, '/');
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname));
const output = join(__dirname, '../../.local/artifact-review'); mkdirSync(output, { recursive: true });
const viewer = { id: 99371, username: '虚构验收用户', email: 'synthetic-review@example.test', role: 'USER' };
const reviewId = '9f7d1076-ae39-4054-840b-7b50a93517a6', sourceHash = 'a'.repeat(64);
const views = [{ index: 0, width: 390, height: 844 }, { index: 1, width: 1280, height: 900 }];
const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(browser, width, mode = 'ok') {
  const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width <= 900, hasTouch: width <= 900, reducedMotion: 'reduce' });
  page.setDefaultTimeout(12000);
  const state = { mode, calls: [], errors: [], writes: [], popups: 0, reportGate: gate(), imageGate: gate() };
  page.on('pageerror', error => state.errors.push(error.message)); page.on('popup', () => { state.popups++; });
  const pngs = await page.evaluate(views => views.map(view => {
    const canvas = document.createElement('canvas'); canvas.width = view.width; canvas.height = view.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f0f5fc'; ctx.fillRect(0, 0, view.width, view.height);
    ctx.fillStyle = '#284e7a'; ctx.fillRect(0, 0, view.width, 64);
    ctx.fillStyle = 'white'; ctx.font = 'bold 22px sans-serif'; ctx.fillText('Synthetic QA page', 24, 42);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(24, 94, view.width - 48, 190);
    ctx.fillStyle = '#293e5a'; ctx.font = 'bold 23px sans-serif'; ctx.fillText(view.index ? 'Desktop preview' : 'Mobile preview', 40, 135);
    ctx.fillStyle = '#768ba7'; ctx.font = '15px sans-serif'; ctx.fillText('Fixture content only', 40, 170);
    ctx.fillStyle = '#e1ebf9'; ctx.fillRect(40, 195, Math.min(view.width - 80, 320), 55);
    ctx.fillStyle = '#d4e3f7'; ctx.fillRect(24, 310, view.width - 48, 130);
    ctx.fillStyle = '#aebfd5'; ctx.font = '14px sans-serif'; ctx.fillText('No user data / no model calls', 24, view.height - 28);
    return canvas.toDataURL('image/png').split(',')[1];
  }), views);
  const conversations = [{ id: 13001, userId: viewer.id, title: '合成页面验收', conversationType: 'ASSISTANT', updatedAt: '2026-10-19T01:00:00Z' },
    { id: 13002, userId: viewer.id, title: '虚构另一会话', conversationType: 'ASSISTANT', updatedAt: '2026-10-19T01:00:00Z' }];
  const artifacts = [{ changeId: 21, path: 'synthetic-demo.html', review: { status: 'passed', reviewId, sourceHash, issues: [] } },
    { changeId: 22, path: 'synthetic-note.txt' },
    { changeId: 23, path: 'unavailable-demo.html', review: { status: 'unavailable', issues: ['当前模型未完成视觉验收；没有自动替换模型。'] } }];
  await page.addInitScript(viewer => {
    localStorage.setItem('chatforum-user', JSON.stringify({ user: viewer, token: 'synthetic-review-token', refreshToken: '' }));
    window.__reviewBlobs = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = value => { const url = create(value); window.__reviewBlobs.created.push({ url, type: value.type }); return url; };
    URL.revokeObjectURL = url => { window.__reviewBlobs.revoked.push(url); revoke(url); };
  }, viewer);
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (!path.startsWith('/api/')) return url.origin === origin ? route.continue() : route.abort();
    state.calls.push(path);
    const headers = { 'Access-Control-Allow-Origin': origin };
    const json = (data, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify({ success: status < 400, data, ...(status >= 400 ? { message: 'Synthetic unavailable' } : {}) }) }).catch(() => undefined);
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS' } });
    if (request.method() !== 'GET') { state.writes.push(path); return json({}, 400); }
    if (path === '/api/chat/config') return json({ configured: true, defaultModelId: 'qwen3.8-max', models: [{ id: 'qwen3.8-max', label: 'Qwen3.8-Max', available: true }] });
    if (path === '/api/chat/conversations') return json(conversations);
    if (/\/chat\/conversations\/\d+\/messages$/.test(path)) return json(path.includes('/13001/') ? [
      { id: 1, role: 'USER', content: '请生成一个虚构演示页面。', conversationId: 13001 },
      { id: 2, role: 'ASSISTANT', content: '合成页面文件已准备好，可查看离线验收或直接下载。', conversationId: 13001,
        ragMetadata: { state: 'general', fileArtifacts: artifacts } },
    ] : []);
    if (path.includes('unread-count')) return json({ unreadCount: 0, inbox: 0, requests: 0, total: 0 });
    if (path === '/api/coding/13001') return json({ files: [], changes: [] });
    if (/\/coding\/13001\/changes\/\d+\/download$/.test(path)) return route.fulfill({
      headers: { ...headers, 'Content-Disposition': 'attachment; filename="synthetic-demo.html"' }, contentType: 'application/octet-stream', body: '<!doctype html><title>Synthetic downloaded data only</title>' });
    if (path === `/api/coding/13001/changes/21/review/${reviewId}`) {
      if (state.mode === 'held-report') await state.reportGate.promise;
      if (state.mode === 'report-failure') return json({}, 500);
      return json({ status: 'passed', reviewId, sourceHash, issues: [], views });
    }
    if (path.startsWith(`/api/coding/13001/changes/21/review/${reviewId}/images/`)) {
      const index = Number(path.split('/').pop());
      if (state.mode === 'held-images' || state.mode === 'partial-forbidden' && index === 1) await state.imageGate.promise;
      if (state.mode === 'partial-forbidden' && index === 1) return json({}, 403);
      return route.fulfill({ headers, contentType: 'image/png', body: Buffer.from(pngs[index], 'base64') }).catch(() => undefined);
    }
    return json([]);
  });
  await page.goto(base + 'chat');
  const card = page.locator('.artifact-card').filter({ hasText: 'synthetic-demo.html' }); await card.waitFor();
  const details = card.locator('details.artifact-review'), download = card.getByRole('button', { name: '下载修改版 synthetic-demo.html', exact: true });
  const assertNoOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const downloadFile = async () => {
    const saved = page.waitForEvent('download'); await download.click(); const item = await saved;
    assert.equal(item.suggestedFilename(), 'synthetic-demo.html'); await item.cancel().catch(() => undefined);
    await page.waitForFunction(() => !document.querySelector('.artifact-card .artifact-main>button')?.disabled);
  };
  const loadedImages = async () => page.waitForFunction(() => {
    const images = [...document.querySelectorAll('.artifact-card:first-child .review-images img')];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  const capture = async name => { await assertNoOverflow(); await page.screenshot({ path: join(output, `${name}-${width}.png`), fullPage: true }); };
  return { page, state, card, details, download, downloadFile, loadedImages, capture,
    close: async () => { state.reportGate.resolve(); state.imageGate.resolve(); await page.close(); } };
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [320, 390, 1440]) {
      const f = await fixture(browser, width, 'held-report');
      try {
        assert.equal(f.state.calls.filter(path => path.includes('/review/')).length, 0, 'Collapsed cards must not prefetch private reports/images');
        await f.downloadFile(); assert.equal(f.state.calls.filter(path => path.includes('/review/')).length, 0, 'Download does not require QA');
        await f.details.locator('summary').click(); await f.details.getByText('正在加载验收记录…', { exact: true }).waitFor();
        assert.equal(await f.download.isDisabled(), false, 'QA loading cannot disable the file download');
        await f.downloadFile();
        f.state.reportGate.resolve(); await f.loadedImages();
        const imageUrls = await f.card.locator('.review-images img').evaluateAll(images => images.map(image => image.src));
        assert(imageUrls.every(url => url.startsWith('blob:'))); assert.equal(imageUrls.length, 2);
        await f.card.getByText('手机 · 390 × 844', { exact: true }).waitFor(); await f.card.getByText('桌面 · 1280 × 900', { exact: true }).waitFor();
        assert.equal(await f.card.locator('.review-scope,.artifact-copy small').count(), 0, 'No repeated review disclaimer or fixed file caption');
        await f.card.locator('.artifact-main').scrollIntoViewIfNeeded(); await f.capture('expanded-primary');
        await f.card.locator('.review-images figure').last().scrollIntoViewIfNeeded(); await f.capture('expanded-desktop');
        const calls = f.state.calls.filter(path => path.includes('/review/')).length;
        await f.details.locator('summary').click(); await f.details.locator('summary').click();
        assert.equal(f.state.calls.filter(path => path.includes('/review/')).length, calls, 'Reopening a valid review does not refetch');
        const unavailable = f.page.locator('.artifact-card').filter({ hasText: 'unavailable-demo.html' });
        await unavailable.locator('summary').click(); await unavailable.getByText('当前模型未完成视觉验收；没有自动替换模型。', { exact: true }).waitFor();
        assert.equal((await unavailable.locator('summary').innerText()).replace(/\s/g, ''), '未完成视觉验收⌄');
        assert.equal(await unavailable.getByRole('button', { name: '下载修改版 unavailable-demo.html', exact: true }).isDisabled(), false);
        await f.capture('expanded');
        if (width <= 900) await f.page.getByRole('button', { name: '对话列表', exact: true }).click();
        await f.page.locator('.conversation-item').filter({ hasText: '虚构另一会话' }).click();
        await f.page.waitForFunction(urls => urls.every(url => window.__reviewBlobs.revoked.includes(url)), imageUrls);
        assert.equal(await f.page.locator('.review-images img').count(), 0);
        assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.writes, []); assert.equal(f.state.popups, 0);
        console.log(`PASS ${width}px: lazy authenticated PNGs, safe download, honest unavailable state, no overflow, conversation URL revocation`);
      } finally { await f.close(); }
    }
    {
      const f = await fixture(browser, 390, 'report-failure');
      try {
        await f.details.locator('summary').click(); await f.details.getByText('验收记录暂不可查看。', { exact: false }).waitFor();
        assert.equal(await f.download.isDisabled(), false); await f.downloadFile();
        f.state.mode = 'ok'; await f.details.getByRole('button', { name: '重试', exact: true }).click(); await f.loadedImages();
        await f.card.getByText('已做页面验收', { exact: false }).waitFor(); await f.capture('retry-recovered');
        assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.writes, []);
        console.log('PASS 390px: report failure is explicit and retryable; HTML download stays independent');
      } finally { await f.close(); }
    }
    {
      const f = await fixture(browser, 1440, 'partial-forbidden');
      try {
        await f.details.locator('summary').click();
        await f.page.waitForFunction(() => document.querySelector('.review-images img')?.naturalWidth > 0);
        const firstUrl = await f.card.locator('.review-images img').getAttribute('src');
        f.state.imageGate.resolve(); await f.details.getByText('验收记录暂不可查看。', { exact: false }).waitFor();
        assert.equal(await f.card.locator('.review-images img').count(), 0);
        assert(await f.page.evaluate(url => window.__reviewBlobs.revoked.includes(url), firstUrl));
        assert.equal(await f.download.isDisabled(), false); await f.capture('revoked');
        assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.writes, []);
        console.log('PASS 1440px: image 403 clears and revokes an already loaded PNG, without public fallback');
      } finally { await f.close(); }
    }
    {
      const f = await fixture(browser, 390, 'held-images');
      try {
        await f.details.locator('summary').click(); await f.page.waitForTimeout(100);
        for (let attempt = 0; attempt < 400 && f.state.calls.filter(path => path.includes('/images/')).length < 2; attempt++) await f.page.waitForTimeout(30);
        assert.equal(f.state.calls.filter(path => path.includes('/images/')).length, 2, 'Both synthetic image requests reached their gate');
        await f.page.evaluate(() => {
          const user = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('user');
          user.setUser({ id: 99372, username: '虚构新账号', email: 'other@example.test', role: 'USER' });
          user.setToken('synthetic-new-session', '');
        });
        f.state.imageGate.resolve(); await f.page.waitForTimeout(150);
        assert.equal(await f.page.locator('.review-images img').count(), 0);
        assert.equal(await f.page.evaluate(() => window.__reviewBlobs.created.filter(item => item.type === 'image/png').length), 0);
        assert.deepEqual(f.state.errors, []); assert.deepEqual(f.state.writes, []);
        console.log('PASS 390px: old-account late PNG responses cannot create or show object URLs');
      } finally { await f.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

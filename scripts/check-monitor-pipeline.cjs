// Synthetic local-only monitor regression. Every API request is intercepted;
// this script never reaches SMTP, models, databases, or a running admin server.
const { createServer } = require('node:http');
const { readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const files = { '/': 'index.html', '/monitor.js': 'monitor.js', '/monitor.css': 'monitor.css' };
const summary = {
  totals: { totalTokens: 130, inputTokens: 100, outputTokens: 30, embeddingTokens: 0, calls: 1, unreportedCalls: 0, partialRecords: 0, unpricedRecords: 1 },
  users: 2, banned: 0, logins: 1, tasks: [], failedLogins: 0,
  models: [], daily: [], backfill: 'complete', untrackedTasks: 0,
};
const actor = { id: 99187, username: '虚构管线管理员', email: 'pipeline@example.test', role: 'ADMIN' };
const buildId = 'fixture-build-20261014';
const consumer = 'forum-search-v1';

async function run() {
  const server = createServer((req, res) => {
    const name = files[req.url];
    if (!name) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(readFileSync(join(__dirname, '../backend/monitor-public', name)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    for (const width of [390, 1440]) {
      // The real server only returns /me to current ACTIVE ADMIN sessions.
      // Both denied and unauthenticated responses must leave admin navigation hidden.
      for (const status of [401, 403]) {
        const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
        const page = await context.newPage();
        const deniedRequests = [];
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === base && files[url.pathname]) return route.continue();
          deniedRequests.push(url.pathname);
          assert.equal(url.origin, base);
          assert.equal(url.pathname, '/ops-api/me');
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ message: '合成会话没有管理权限' }) });
        });
        await page.goto(base);
        await page.locator('#login').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.getElementById('workspace').hidden);
        assert.equal(await page.locator('[data-view="forum-pipeline"]').isVisible(), false);
        assert.deepEqual(deniedRequests, ['/ops-api/me']);
        await context.close();
      }

      const context = await browser.newContext({ viewport: { width, height: 950 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [], writes = [], dialogs = [];
      let acceptDialog = true, failValidation = true, failRetry = true;
      let candidate = null, activeIndex = 'forum-fixture-active';
      let dead = [{ eventId: '17', consumer, attempts: 12, errorCode: '<img src=x onerror="alert(1)">' }];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => {
        dialogs.push(dialog.message());
        assert.equal(dialog.type(), 'confirm');
        if (acceptDialog) await dialog.accept(); else await dialog.dismiss();
      });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === base && files[url.pathname]) return route.continue();
        try {
          assert.equal(url.origin, base, 'No non-fixture network requests are permitted');
          assert.equal(url.pathname.startsWith('/ops-api/'), true);
          const path = url.pathname.slice('/ops-api'.length), method = req.method();
          assert.equal(path.includes('smtp'), false, 'Pipeline tests must never call SMTP');
          let data, status = 200;
          if (method !== 'GET') {
            assert.equal(req.headers()['x-ops-csrf'], 'fixture-pipeline-csrf');
            writes.push({ path, method, body: req.postData() ? req.postDataJSON() : null });
          }
          if (path === '/me' && method === 'GET') data = { user: actor, csrf: 'fixture-pipeline-csrf' };
          else if (path === '/summary' && method === 'GET') data = summary;
          else if (path === '/forum-pipeline' && method === 'GET') data = {
            search: { configured: true, enabled: true, activeIndex, candidate },
            events: {
              workerEnabled: true,
              queues: [
                { consumer: 'forum-projections-v1', state: 'PENDING', count: 4, oldestAt: '2026-10-14T01:00:00Z', lagMs: 12000 },
                { consumer, state: 'DEAD', count: dead.length, oldestAt: '2026-10-14T01:00:00Z', lagMs: 8000 },
              ],
              dead,
            },
          };
          else if (path === '/forum-search/build' && method === 'POST') {
            assert.deepEqual(req.postDataJSON(), { confirmation: 'BUILD_FORUM_SEARCH' });
            candidate = { id: buildId, status: 'BUILDING', postCursor: 20, maxPostId: 30 };
            data = { id: buildId, status: 'BUILDING' };
          } else if (path === `/forum-search/${buildId}/validate` && method === 'POST') {
            assert.deepEqual(req.postDataJSON(), { confirmation: buildId });
            if (failValidation) { status = 409; data = { message: '合成复核尚未完成，禁止发布' }; }
            else { candidate.status = 'READY'; data = { id: buildId, status: 'READY' }; }
          } else if (path === `/forum-search/${buildId}/publish` && method === 'POST') {
            assert.deepEqual(req.postDataJSON(), { confirmation: buildId });
            assert.equal(candidate.status, 'READY');
            candidate.status = 'ACTIVE'; activeIndex = 'forum-fixture-new';
            data = { id: buildId, status: 'ACTIVE' };
          } else if (path === '/forum-pipeline/retry' && method === 'POST') {
            assert.deepEqual(req.postDataJSON(), { consumer, confirmation: consumer });
            if (failRetry) { status = 403; data = { message: '合成重试已被拒绝' }; }
            else { dead = []; data = { ok: true, updated: 1 }; }
          } else if (path === '/session' && method === 'DELETE') data = { ok: true };
          else throw Error(`Unexpected fixture API request: ${method} ${path}`);
          return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        } catch (error) {
          errors.push(error.message);
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: '合成测试请求不匹配' }) });
        }
      });

      await page.goto(base);
      await page.locator('#total-tokens').getByText('130', { exact: true }).waitFor();
      await page.locator('[data-view="forum-pipeline"]').click();
      await page.locator('#forum-pipeline-summary').getByText(/当前索引 forum-fixture-active/).waitFor();
      assert.match(await page.locator('#forum-pipeline-summary').innerText(), /队列：已启用/);
      assert.match(await page.locator('#forum-pipeline-queues').innerText(), /PENDING/);
      assert.match(await page.locator('#forum-pipeline-queues').innerText(), /12 秒/);
      assert.equal(await page.locator('#forum-pipeline-dead img').count(), 0);
      assert.match(await page.locator('#forum-pipeline-dead').innerText(), /<img src=x/);

      acceptDialog = false;
      await page.getByRole('button', { name: '构建新索引', exact: true }).click();
      assert.equal(writes.length, 0, 'Cancelling build must not write');
      acceptDialog = true;
      await page.getByRole('button', { name: '构建新索引', exact: true }).click();
      await page.locator('#forum-pipeline-summary').getByText(/BUILDING/).waitFor();
      assert.equal(await page.getByRole('button', { name: '发布 READY 索引', exact: true }).count(), 0);
      await page.evaluate(() => { document.getElementById('toast').hidden = true; });
      await page.getByRole('button', { name: '复核索引', exact: true }).click();
      await page.locator('#error').getByText('合成复核尚未完成，禁止发布', { exact: true }).waitFor();
      assert.equal(await page.locator('#toast').isVisible(), false, 'Rejected validation must not report success');
      assert.equal(await page.getByRole('button', { name: '发布 READY 索引', exact: true }).count(), 0);
      failValidation = false;
      await page.getByRole('button', { name: '复核索引', exact: true }).click();
      await page.locator('#forum-pipeline-summary').getByText(/READY/).waitFor();
      await page.getByRole('button', { name: '发布 READY 索引', exact: true }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Monitor page must not overflow horizontally');
      mkdirSync(join(__dirname, '../.local'), { recursive: true });
      await page.screenshot({ path: join(__dirname, `../.local/monitor-pipeline-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '发布 READY 索引', exact: true }).click();
      await page.locator('#forum-pipeline-summary').getByText(/当前索引 forum-fixture-new/).waitFor();

      const retryButton = page.getByRole('button', { name: '重试 ' + consumer, exact: true });
      const beforeCancel = writes.length;
      acceptDialog = false;
      await retryButton.click();
      assert.equal(writes.length, beforeCancel, 'Cancelling retry must not write');
      acceptDialog = true;
      await page.evaluate(() => { document.getElementById('toast').hidden = true; });
      await retryButton.click();
      await page.locator('#error').getByText('合成重试已被拒绝', { exact: true }).waitFor();
      assert.equal(await page.locator('#toast').isVisible(), false, 'Rejected retry must not report success');
      failRetry = false;
      await retryButton.click();
      await page.locator('#forum-pipeline-dead').getByText('所选范围内暂无记录', { exact: true }).waitFor();
      assert.equal(await retryButton.count(), 0);
      assert.equal(writes.length, 6);
      assert.deepEqual(writes.map(row => row.method), Array(6).fill('POST'));
      assert(dialogs.some(message => message.includes('BUILD_FORUM_SEARCH')));
      assert(dialogs.some(message => message.includes(buildId)));
      assert(dialogs.some(message => message.includes('最多 50 条')));
      assert.deepEqual(errors, []);
      await page.locator('#logout').click();
      await page.locator('#login').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-view="forum-pipeline"]').isVisible(), false);
      await context.close();
      console.log(`PASS ${width}px: denied admin navigation, pipeline status, confirmed build/validate/READY publish, bounded DEAD retry, CSRF, cancellation/errors and literal rendering (all APIs synthetic)`);
    }
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

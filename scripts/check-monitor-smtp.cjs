// Every request at the independent 8091 address is fulfilled here or aborted.
// Never contacts the running monitor, reads saved SMTP settings, or sends email.
const { readFileSync } = require('node:fs'), { join } = require('node:path');
const assert = require('node:assert/strict'), { chromium } = require('playwright');
const base = 'http://127.0.0.1:8091';
const files = { '/': 'index.html', '/monitor.js': 'monitor.js', '/monitor.css': 'monitor.css' };
const actor = { id: 99187, username: 'SMTP 合成验收管理员', email: 'admin@bootstrap.invalid', role: 'ADMIN' };
const recipient = 'synthetic.smtp.recipient@qq.com';
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 950 } });
      page.setDefaultTimeout(10000);
      const errors = [], calls = [], blocked = [];
      let saveFails = true, testMode = 'accepted';
      const settings = { locked: false, smtp: { enabled: false, host: '', port: 465, user: '', from: '', passwordConfigured: false }, models: { catalog: [], enabled: {} } };
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => { assert.match(dialog.message(), /刷新会丢弃尚未保存的配置/); await dialog.accept(); });
      await page.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
        assert.equal(url.origin, base, 'all fixture resources stay at the independent loopback entry');
        if (method === 'GET' && files[p]) {
          const name = files[p];
          return route.fulfill({ contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(join(__dirname, '../backend/monitor-public', name)) });
        }
        if (p.startsWith('/ops-api/')) {
          if (method !== 'GET') assert.equal(req.headers()['x-ops-csrf'], 'synthetic-smtp-csrf');
          calls.push({ p, method, body: method === 'GET' ? null : req.postDataJSON() });
          let data, status = 200, headers = {};
          if (p === '/ops-api/me') data = { user: actor, csrf: 'synthetic-smtp-csrf' };
          else if (p === '/ops-api/summary') data = { totals: { totalTokens: 0, calls: 0, unreportedCalls: 0, partialRecords: 0, unpricedRecords: 0 }, users: 1, banned: 0, logins: 0, tasks: [], failedLogins: 0, models: [], daily: [], backfill: 'complete', untrackedTasks: 0 };
          else if (p === '/ops-api/settings' && method === 'GET') data = settings;
          else if (p === '/ops-api/settings/smtp' && method === 'PUT') {
            const input = req.postDataJSON();
            assert.equal(input.password, 'synthetic-smtp-authorization');
            if (saveFails) { status = 503; data = { message: '合成配置保存失败，请稍后重试' }; }
            else { Object.assign(settings.smtp, input, { passwordConfigured: true }); delete settings.smtp.password; data = settings; }
          } else if (p === '/ops-api/settings/smtp/test' && method === 'POST') {
            assert.deepEqual(req.postDataJSON(), { to: recipient }, 'a single non-admin, non-sender mailbox is sent without config or content');
            await new Promise(resolve => setTimeout(resolve, 200));
            if (testMode === 'accepted') data = { ok: true };
            else if (testMode === 'false') data = { ok: false };
            else if (testMode === 'missing') data = {};
            else if (testMode === 'failed') { status = 503; data = { message: '合成 SMTP 连接失败，邮件服务器未接受请求' }; }
            else { status = 429; headers = { 'Retry-After': '41' }; data = { message: '发送测试邮件过于频繁，请在 41 秒后重试' }; }
          } else throw Error('Unexpected synthetic monitor API: ' + method + ' ' + p);
          return route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(data) });
        }
        blocked.push({ p, method }); return route.abort();
      });
      const tests = () => calls.filter(call => call.p.endsWith('/smtp/test'));
      const button = page.locator('#smtp-test-form button');
      await page.goto(base); await page.locator('#total-tokens').getByText('0', { exact: true }).waitFor();
      await page.locator('[data-view="mail"]').click(); await page.waitForFunction(() => !document.querySelector('#mail-view').hidden);
      assert.equal(await page.locator('#smtp-test-to').inputValue(), '', 'an unconfigured sender never falls back to the placeholder admin mailbox');
      assert(await button.isDisabled()); await page.locator('#smtp-test-status').getByText('请先保存并启用邮件配置。', { exact: true }).waitFor();
      await page.locator('#smtp-test-form').dispatchEvent('submit'); assert.equal(tests().length, 0, 'unconfigured programmatic submissions are blocked too');
      await page.locator('#smtp-host').fill('smtp.example.test'); await page.locator('#smtp-user').fill('sender@example.test'); await page.locator('#smtp-from').fill('sender@example.test');
      await page.locator('#smtp-enabled').check(); await page.locator('#smtp-password').fill('synthetic-smtp-authorization');
      assert(await button.isDisabled()); await page.locator('#smtp-test-status').getByText('请先保存邮件配置。', { exact: true }).waitFor();
      await page.locator('#smtp-form button').click(); await page.locator('#error').getByText('合成配置保存失败，请稍后重试', { exact: true }).waitFor(); assert(await button.isDisabled());
      saveFails = false; await page.locator('#smtp-form button').click(); await page.waitForFunction(() => !document.querySelector('#smtp-test-form button').disabled);
      assert.equal(await page.locator('#smtp-password').inputValue(), ''); assert.equal(await page.locator('#smtp-test-to').inputValue(), 'sender@example.test', 'saved sender wins over placeholder admin.email');
      assert.equal(await page.locator('#mail-view .setting-intro,#mail-view .notice').count(), 0);
      assert.equal(await page.locator('#smtp-test-status').innerText(), '');
      for (const invalid of ['not-an-email', 'first@example.test,second@example.test']) {
        await page.locator('#smtp-test-to').fill(invalid); assert.equal(await page.locator('#smtp-test-to').evaluate(input => input.checkValidity()), false);
        await button.click(); assert.equal(tests().length, 0, 'invalid or multiple recipients never trigger an API call');
      }
      await page.locator('#smtp-test-to').fill(recipient); await button.click(); await page.locator('#smtp-test-status').getByText('正在发送…', { exact: true }).waitFor(); assert(await button.isDisabled());
      await page.locator('#toast').getByText('测试邮件已提交邮件服务器，请检查收件箱及垃圾邮件', { exact: true }).waitFor();
      assert(!(await page.locator('#toast').innerText()).includes('已送达'));
      await page.screenshot({ path: join(__dirname, `../.local/monitor-smtp-${width}.png`), fullPage: true });
      for (const mode of ['false', 'missing', 'failed', 'throttled']) {
        testMode = mode; await button.click();
        const expected = mode === 'failed' ? '合成 SMTP 连接失败，邮件服务器未接受请求' : mode === 'throttled' ? '发送测试邮件过于频繁，请在 41 秒后重试' : '邮件服务器未确认接受测试邮件，请检查邮件配置后重试。';
        await page.locator('#error').getByText(expected, { exact: true }).waitFor(); assert(await page.locator('#toast').isHidden(), 'failed or ambiguous responses never show a success toast');
      }
      assert.equal(tests().length, 5); await page.waitForTimeout(150); assert.equal(tests().length, 5, 'throttling does not trigger an automatic retry');
      await page.locator('#smtp-from').fill('unsaved@example.test'); assert(await button.isDisabled()); await page.locator('#smtp-test-form').dispatchEvent('submit'); assert.equal(tests().length, 5);
      await page.locator('#refresh').click(); await page.waitForFunction(() => !document.querySelector('#smtp-test-form button').disabled); assert.equal(await page.locator('#smtp-from').inputValue(), 'sender@example.test');
      settings.locked = true; await page.locator('#refresh').click(); await page.locator('#smtp-test-status').getByText('邮件配置已锁定。', { exact: true }).waitFor();
      assert(await button.isDisabled()); await page.locator('#smtp-test-form').dispatchEvent('submit'); assert.equal(tests().length, 5);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
      assert(calls.every(call => call.p.startsWith('/ops-api/')), 'only synthetic local management APIs were handled');
      assert(!calls.some(call => call.p.includes('/chat') || call.p.includes('/model')), 'no model, chat or real email requests');
      assert(blocked.every(request => request.method === 'GET'), 'no write was sent or forwarded outside the synthetic API');
      console.log(`PASS ${width}px: 8091 fully intercepted SMTP UI, sender default/no placeholder fallback, unsaved/locked gating, single third-party recipient, explicit acceptance/failure/429, CSRF, no real network or mail`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

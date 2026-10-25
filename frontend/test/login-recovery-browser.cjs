// Focused browser fixture: all APIs, credentials and mail deliveries are synthetic.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = process.env.LOGIN_RECOVERY_TEST_BASE || 'http://127.0.0.1:5186/';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Local fixture pages only');
const screenshots = join(__dirname, '../../.local/login-recovery');
mkdirSync(screenshots, { recursive: true });

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [320, 390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    page.setDefaultTimeout(10000);
    let loginStatus = 401;
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (!url.pathname.startsWith('/api/')) return route.continue();
      const path = url.pathname, body = route.request().postDataJSON();
      if (route.request().method() !== 'GET') calls.push({ path, body });
      let status = 200, data = [], message = '';
      if (path === '/api/auth/login') {
        status = loginStatus;
        if (status === 200) data = { user: { id: 99091, username: 'Synthetic login', email: 'fixture@example.test', role: 'USER' }, accessToken: 'synthetic', refreshToken: '', expiresIn: 300 };
        else message = status === 401 ? 'Invalid credentials' : '服务暂不可用';
      }
      if (path === '/api/auth/password-recovery/code') data = { message: '测试验证码已受理', retryAfterSeconds: 60 };
      if (path === '/api/auth/password-recovery/reset') data = { message: '密码已重置，请使用新密码登录' };
      if (path === '/api/forum/feed') data = { data: [], hasMore: false, nextCursor: null };
      if (path.includes('unread')) data = { unreadCount: 0, requests: 0 };
      return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: status === 200, data, message }) });
    });
    const visit = async () => { await page.goto(base + 'login'); await page.locator('.login-card').waitFor(); };
    const login = () => page.getByRole('button', { name: '登录', exact: true });
    const recovery = () => page.getByRole('button', { name: '忘记密码？', exact: true });
    const email = () => page.locator('.login-card input').nth(0);
    const password = () => page.locator('.login-card input').nth(1);
    const fillLogin = async () => { await email().fill('fixture@example.test'); await password().fill('synthetic-password'); };

    await visit();
    assert.equal(await recovery().count(), 0, 'The initial login page must have no recovery block');
    await page.screenshot({ path: join(screenshots, `initial-${width}.png`), fullPage: true });
    await login().click(); await page.getByText('请输入邮箱', { exact: true }).last().waitFor();
    assert.equal(calls.length, 0); assert.equal(await recovery().count(), 0, 'Required-field errors are not password failures');
    await email().fill('invalid-mail'); await password().fill('synthetic-password');
    await login().click(); await page.getByText('请输入正确的邮箱格式', { exact: true }).waitFor();
    assert.equal(calls.length, 0); assert.equal(await recovery().count(), 0, 'Email format errors must not reveal recovery');

    await fillLogin(); await login().click(); await recovery().waitFor();
    assert.equal(calls.filter(call => call.path === '/api/auth/login').length, 1);
    const visual = await recovery().evaluate(button => {
      const style = getComputedStyle(button), box = button.getBoundingClientRect();
      return { text: button.textContent.trim(), color: style.color, background: style.backgroundColor, left: box.left, right: box.right, height: box.height };
    });
    assert.equal(visual.text, '忘记密码？'); assert.equal(visual.background, 'rgba(0, 0, 0, 0)');
    assert.notEqual(visual.color, visual.background); assert(visual.left >= 0 && visual.right <= width);
    if (width < 900) assert(visual.height >= 44, 'Mobile recovery link must remain touchable');
    await page.waitForFunction(() => document.querySelectorAll('.login-card .el-form-item__error').length === 0);
    await page.screenshot({ path: join(screenshots, `rejected-${width}.png`), fullPage: true });

    await recovery().click();
    const dialog = page.getByRole('dialog', { name: '找回密码' }); await dialog.waitFor();
    const fields = dialog.locator('input');
    assert.equal(await fields.nth(0).inputValue(), 'fixture@example.test', 'Recovery prefills the failed login email');
    await dialog.getByRole('button', { name: '获取验证码', exact: true }).click();
    await page.getByText('测试验证码已受理', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/code')).length, 1);
    assert.equal(calls.find(call => call.path.endsWith('/code')).body.email, 'fixture@example.test');
    assert(await dialog.getByRole('button', { name: /秒后重发/ }).isDisabled());
    await fields.nth(1).fill('12345'); await fields.nth(2).fill('synthetic-new-password'); await fields.nth(3).fill('different-password');
    await dialog.getByRole('button', { name: '重置密码', exact: true }).click();
    await page.getByText('请输入6位邮箱验证码', { exact: true }).waitFor();
    assert.equal(calls.filter(call => call.path.endsWith('/reset')).length, 0);
    await fields.nth(1).fill('123456'); await fields.nth(3).fill('synthetic-new-password');
    await dialog.getByRole('button', { name: '重置密码', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(calls.find(call => call.path.endsWith('/reset')).body, { email: 'fixture@example.test', code: '123456', newPassword: 'synthetic-new-password', confirmPassword: 'synthetic-new-password' });
    assert.equal(await password().inputValue(), ''); assert.equal(await recovery().count(), 0);
    assert.equal(calls.filter(call => call.path === '/api/auth/login').length, 1, 'Reset must not auto-login');

    await page.reload(); await page.locator('.login-card').waitFor(); loginStatus = 503;
    await fillLogin(); await login().click(); await page.getByText('服务暂不可用', { exact: true }).waitFor();
    assert.equal(await recovery().count(), 0, 'Service or network errors must not be represented as rejected credentials');
    loginStatus = 200; await login().click();
    await page.waitForURL(/\/forum(?:[?#]|$)/); assert.equal(await recovery().count(), 0);
    assert.deepEqual(errors, []); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    console.log(`PASS ${width}px: initially hidden, local validation and 503 hidden, 401 readable recovery link, email/code/reset flow, no auto-login, successful login`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

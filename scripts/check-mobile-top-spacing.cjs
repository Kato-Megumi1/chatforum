// Synthetic account and books only. Every API request is intercepted; no model,
// account, password, email or novel data is read from the running backend.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const base = process.env.MOBILE_SPACING_BASE || 'http://127.0.0.1:5186/';
const origin = new URL(base).origin;
const useHash = process.env.MOBILE_SPACING_HASH === '1';
const viewer = { id: 99281, username: 'Synthetic mobile viewer', email: 'mobile-spacing@example.test', role: 'USER' };
const target = route => base + (useHash ? '#' : '') + route;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  mkdirSync('.local/mobile-top-spacing', { recursive: true });
  try {
    for (const { width, height, insets } of [
      { width: 320, height: 844, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
      { width: 390, height: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 } },
      { width: 768, height: 1024, insets: { top: 47, bottom: 20, left: 0, right: 0 } },
      { width: 844, height: 390, insets: { top: 0, bottom: 21, left: 44, right: 44 } },
      { width: 1440, height: 900, insets: { top: 0, bottom: 0, left: 0, right: 0 } },
    ]) {
      const mobile = width <= 900;
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const errors = [], writes = [], reads = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-mobile-spacing', refreshToken: '' })), viewer);
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (path.startsWith('/api/')) {
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
          if (request.method() !== 'GET') writes.push(path); else reads.push(path);
          let data = [];
          if (path === '/api/chat/config') data = { configured: true, defaultModelId: 'qwen3.8-max', models: [{ id: 'qwen3.8-max', label: 'Qwen3.8-Max', available: true }] };
          if (path === '/api/rag/knowledge-bases') data = [{ id: 1, name: 'Synthetic book', permission: 'READ', chatReady: true, activeIndexVersion: 1, documents: [] }];
          if (path.includes('unread')) data = { unreadCount: 0, requests: 0 };
          return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, data }) });
        }
        return url.origin === origin && request.method() === 'GET' ? route.continue() : route.abort();
      });
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
      await page.goto(target('chat'));
      await page.locator('.welcome-copy h1').waitFor({ state: 'attached' });
      assert.equal(await page.locator('.assistant-composer').getByRole('button', { name: '知识库', exact: true }).count(), 0, 'Ordinary AI has no hidden or visible knowledge-base control');
      assert.equal(reads.filter(path => path === '/api/rag/knowledge-bases').length, 0, 'Ordinary AI does not fetch unused novel libraries');
      assert.equal(await page.locator('.assistant-suggestions button').count(), 2, 'Welcome actions stay compact');
      const layout = await page.locator('.main-layout').boundingBox();
      assert.equal(layout.y, 0, 'The app starts at the browser content edge');
      assert.equal(await page.locator('.main-layout').evaluate(el => getComputedStyle(el).paddingTop), '0px', 'Browser chrome must not be counted twice');
      const chatHeader = await page.locator(mobile ? '.mobile-chat-header' : '.header').boundingBox();
      assert.equal(chatHeader.y, 0, 'Visible chat header has no blank strip above it');
      if (mobile) {
        const tools = await page.locator('.composer-tools').boundingBox();
        assert(tools.height <= 48, 'Mobile composer tools must remain on one row');
        const main = await page.locator('.main-layout').evaluate(el => ({ left: getComputedStyle(el).paddingLeft, right: getComputedStyle(el).paddingRight }));
        assert.deepEqual(main, { left: `${insets.left}px`, right: `${insets.right}px` }, 'Landscape side protection remains');
        assert.equal(await page.locator('.mobile-tabbar').evaluate(el => parseFloat(getComputedStyle(el).paddingBottom)), 6 + insets.bottom, 'Home indicator protection remains');
        if (height > 500) {
          await page.setViewportSize({ width, height: 480 });
          const input = page.locator('.chat-textarea textarea');
          await input.fill('Synthetic draft, never sent');
          await input.focus();
          await page.waitForFunction(() => document.querySelector('.main-layout').getBoundingClientRect().height <= 481);
          const send = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
          assert(send.y >= 0 && send.y + send.height <= 481, `Keyboard-height viewport keeps send control visible: ${JSON.stringify({ width, send })}`);
          await input.blur();
          const blurredSend = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
          assert.equal(blurredSend.y, send.y, 'Changing focus must not move the send button');
          await input.fill('');
          await page.setViewportSize({ width, height });
          await page.waitForFunction(expected => document.querySelector('.main-layout').getBoundingClientRect().height >= expected - 1, height);
        }
      }
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.local/mobile-top-spacing/chat-${width}.png` });
      await page.goto(target('knowledge-bases'));
      await page.locator('.book').waitFor();
      const kbHeader = await page.locator('.header').boundingBox();
      assert.equal(kbHeader.y, 0, 'Novel library header has no extra system-inset strip');
      assert.equal(kbHeader.height, 60, 'Existing desktop and mobile header height is preserved');
      assert(await page.locator('.novel-page').evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Library fits available width');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No document horizontal overflow');
      if ([390, 1440].includes(width)) await page.screenshot({ path: `.local/mobile-top-spacing/library-${width}.png` });
      assert.deepEqual(writes, [], 'No backend writes or model calls');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}x${height}: top alignment, inset ${insets.top}, side/bottom protection, library, keyboard viewport`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

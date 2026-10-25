// Local synthetic UI only: no production accounts, authentication, models or mail.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = process.env.HEADER_USERNAME_TEST_BASE || 'http://127.0.0.1:5194/';
const hash = process.env.HEADER_USERNAME_TEST_HASH === '1';
const origin = new URL(base).origin;
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Only a local synthetic page may be tested');
const url = base.replace(/\/?$/, '/') + (hash ? '#/' : '') + 'forum';

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const output = join(__dirname, '../../.local/header-username-regression'); mkdirSync(output, { recursive: true });
  try {
    for (const width of [1024, 1440, 390]) {
      const mobile = width <= 900;
      const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: mobile, hasTouch: mobile });
      page.setDefaultTimeout(10000);
      const errors = [], writes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('chatforum-user', JSON.stringify({
        user: { id: 991777, username: 'Megumi', email: 'synthetic-header@example.test', role: 'USER', avatar: '' },
        token: 'synthetic-header-token', refreshToken: '',
      })));
      await page.route('**/*', async route => {
        const request = route.request(), target = new URL(request.url());
        if (!target.pathname.startsWith('/api/')) return target.origin === origin ? route.continue() : route.abort();
        if (request.method() !== 'GET' && request.method() !== 'OPTIONS') writes.push(target.pathname);
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
          'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'authorization,content-type',
          'Access-Control-Allow-Methods': 'GET,OPTIONS',
        } });
        let data = [];
        if (target.pathname === '/api/forum/feed') data = { data: [], hasMore: false, nextCursor: null };
        if (target.pathname.endsWith('/unread-count')) data = { unreadCount: 0, requests: 0 };
        return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': origin },
          body: JSON.stringify({ success: true, data }) });
      });
      await page.goto(url);
      const trigger = page.locator('.header .user-info'); await trigger.waitFor();
      if (!mobile) {
        for (const [font, zoom, username] of [
          ['"Segoe UI",sans-serif', 1, 'Megumi'],
          ['Arial,sans-serif', 1.25, 'Synthetic gjpqy'],
          ['Georgia,serif', 1.5, 'Synthetic Megumi gjpqy — 超长昵称与中文用户'],
        ]) {
          await page.evaluate(({ font, zoom, username }) => {
            const store = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('user');
            store.user.username = username;
            document.documentElement.style.zoom = zoom;
            document.querySelector('.username').style.fontFamily = font;
          }, { font, zoom, username });
          await page.waitForTimeout(30);
          const measure = await page.locator('.username').evaluate(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            const outer = element.getBoundingClientRect(), text = range.getBoundingClientRect(), style = getComputedStyle(element);
            return { box: outer.toJSON(), text: text.toJSON(), lineHeight: style.lineHeight, fontSize: style.fontSize,
              overflow: style.overflow, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
          });
          assert(measure.box.top <= measure.text.top + .6 && measure.box.bottom >= measure.text.bottom - .6,
            `${width}px ${font} zoom ${zoom}: username line box clips text ascenders/descenders: ${JSON.stringify(measure)}`);
          assert(parseFloat(measure.lineHeight) >= parseFloat(measure.fontSize) * 1.4, 'A dropdown line-height:1 must not shrink the name');
          assert.equal(await trigger.getAttribute('title'), username, 'Full long name remains available without removing ellipsis');
          assert.equal(await trigger.getAttribute('aria-label'), `账号菜单，${username}`);
          assert.equal(await trigger.evaluate(element => element.tagName), 'BUTTON', 'Account menu uses a native keyboard trigger');
          await trigger.focus(); await page.keyboard.press('Enter');
          await page.getByRole('menuitem', { name: '个人中心', exact: true }).waitFor();
          await page.keyboard.press('Escape');
          await page.screenshot({ path: join(output, `header-${width}-${zoom}.png`), fullPage: false });
        }
      } else {
        assert.equal(await page.locator('.username').isVisible(), false, 'Mobile retains the uncluttered avatar-only header');
        assert.equal(await trigger.getAttribute('aria-label'), '账号菜单，Megumi');
        await trigger.click(); await page.getByRole('menuitem', { name: '个人中心', exact: true }).waitFor();
      }
      assert.deepEqual(writes, []); assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: synthetic account name, descender room, keyboard menu and responsive header`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

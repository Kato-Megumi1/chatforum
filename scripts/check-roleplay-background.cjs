// Only intercepted APIs and fictional messages. Never reads real chat or calls a model.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const base = process.env.ROLEPLAY_TEST_BASE || 'http://127.0.0.1:4184/';
const hash = process.env.ROLEPLAY_TEST_HASH === '1';
const origin = new URL(base).origin;
const route = name => base.replace(/\/?$/, '/') + (hash ? '#/' : '') + name;
const user = { id: 99615, username: '背景布局验收', email: 'wallpaper@example.test', role: 'USER', level: 1, points: 0 };
const conversations = [
  { id: 101, conversationType: 'ASSISTANT', title: '普通 AI 布局测试' },
  { id: 102, conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona', personaLabel: '加藤惠', title: '角色布局测试' },
  { id: 103, conversationType: 'LEGACY', title: '旧历史布局测试' },
].map(c => ({ ...c, userId: user.id, updatedAt: '2026-10-15T02:00:00Z' }));
// Enough fictional turns to require scrolling at every target viewport.
const messages = conversationId => Array.from({ length: 14 }, (_, i) => [
  { id: i * 2 + 1, conversationId, role: 'USER', content: i === 13 ? '今天终于忙完了，想找你聊一会儿。' : `第 ${i + 1} 轮虚构消息：验证长对话滚动时背景仍然完整覆盖聊天范围。` },
  { id: i * 2 + 2, conversationId, role: 'ASSISTANT', content: '这是虚构的背景布局验收消息。\n\n聊天内容要清晰，背景只是安静地留在身后。原有角色、模式和知识库设置都应保持原位。', ragMetadata: { state: 'roleplay' } },
]).flat();
const sameBounds = (actual, expected, description) => {
  for (const edge of ['left', 'top', 'right', 'bottom']) assert(Math.abs(actual[edge] - expected[edge]) <= 1, `${description}: ${edge} (${actual[edge]} vs ${expected[edge]})`);
};

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const scenarios = [390, 900, 1024, 1440, 1920].map(width => ({ width, height: 900 }));
    scenarios.push({ width: 2100, height: 1138 }, { width: 2560, height: 1138 });
    for (const { width, height } of scenarios) {
      const mobile = width <= 900;
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const errors = [], writes = [], images = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', r => { if (r.url().includes('roleplay-megumi-background')) images.push(r.status()); });
      await page.route('**/*', async r => {
        const url = new URL(r.request().url());
        if (url.pathname.startsWith('/api/')) {
          if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
          if (r.request().method() !== 'GET') writes.push(url.pathname);
          let data = [];
          if (url.pathname === '/api/chat/config') data = { configured: true, defaultModelId: 'qwen3.8-max', models: [{ id: 'qwen3.8-max', label: 'Qwen3.8-Max', available: true }] };
          if (url.pathname === '/api/chat/conversations') data = conversations;
          const match = url.pathname.match(/^\/api\/chat\/conversations\/(\d+)\/messages$/);
          if (match) data = messages(+match[1]);
          return r.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true, data }) });
        }
        return url.origin === origin ? r.continue() : r.abort();
      });
      await page.addInitScript(({ user }) => {
        localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic-wallpaper-token', refreshToken: '' }));
        sessionStorage.setItem('chatforum-chat-navigation-v1', JSON.stringify({ userId: user.id, space: 'ROLEPLAY', conversationId: 102, scroll: {} }));
      }, { user });
      await page.goto(route('chat'));
      await page.locator('.persona-theme .message-text').first().waitFor();
      await page.waitForFunction(() => {
        const image = document.querySelector('.roleplay-wallpaper img');
        return image?.complete && image.naturalWidth > 0;
      });
      const wallpaper = await page.locator('.persona-theme').evaluate(el => {
        const style = getComputedStyle(el), surface = el.querySelector('.dialogue-surface');
        const layer = el.querySelector('.roleplay-wallpaper'), image = layer.querySelector('img');
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, left: r.left, top: r.top, right: r.right, width: r.width, height: r.height, bottom: r.bottom }; };
        return {
          image: style.backgroundImage, color: style.backgroundColor, isolation: style.isolation,
          zIndex: style.zIndex, attachment: style.backgroundAttachment,
          surfaceIsolation: getComputedStyle(surface).isolation,
          layerOpacity: +getComputedStyle(layer).opacity,
          layerEvents: getComputedStyle(layer).pointerEvents,
          layerPosition: getComputedStyle(layer).position,
          layerTransform: getComputedStyle(layer).transform,
          layerMaxHeight: getComputedStyle(layer).maxHeight,
          imageFit: getComputedStyle(image).objectFit,
          horizontalMask: getComputedStyle(layer).maskImage,
          verticalMask: getComputedStyle(image).maskImage,
          ariaHidden: layer.getAttribute('aria-hidden'), main: rect(el), surface: rect(surface),
          layer: rect(layer), art: rect(image), toolbar: rect(el.querySelector('.chat-toolbar')),
          column: rect(el.querySelector('.chat-content')), messages: rect(el.querySelector('.chat-messages')),
          composer: rect(el.querySelector('.chat-input-area')), input: rect(el.querySelector('.chat-input-wrapper')),
          composerBackground: getComputedStyle(el.querySelector('.chat-input-area')).backgroundColor,
          imageOrigin: new URL(image.currentSrc, location.href).origin,
          loaded: image.complete && image.naturalWidth > 0,
        };
      });
      assert.equal(wallpaper.image, 'none', 'one canvas must not combine image-width paint with a different side color');
      assert.equal(wallpaper.color, 'rgb(255, 248, 247)', 'both canvas sides share one unchanging base color');
      assert.equal(wallpaper.isolation, 'auto');
      assert.equal(wallpaper.zIndex, 'auto', 'background cannot create a stack trapping mobile options');
      assert(!wallpaper.attachment.includes('fixed'), 'mobile must not use fixed background attachment');
      assert.equal(wallpaper.surfaceIsolation, 'isolate', 'only the message/composer surface owns the decorative layer');
      assert.equal(wallpaper.layerEvents, 'none');
      assert.equal(wallpaper.layerPosition, 'absolute');
      assert.equal(wallpaper.layerTransform, 'none', 'background has no subject-offset transform');
      assert.equal(wallpaper.layerMaxHeight, 'none', 'background is not restricted to a floating poster height');
      assert.equal(wallpaper.imageFit, 'cover', 'original art covers the entire dialogue surface without stretching');
      assert.equal(wallpaper.ariaHidden, 'true');
      assert(wallpaper.layerOpacity >= .15 && wallpaper.layerOpacity <= .3, 'artwork must remain faint');
      assert(wallpaper.horizontalMask.includes('linear-gradient') && wallpaper.horizontalMask.includes('90deg'), 'horizontal edges are feathered');
      assert(wallpaper.verticalMask.includes('linear-gradient'), 'vertical edges are feathered');
      assert.equal(wallpaper.imageOrigin, origin, 'artwork remains the local bundled original');
      assert(wallpaper.loaded && images.every(status => status < 400), 'original bundled artwork loads (including browser cache)');
      sameBounds(wallpaper.layer, wallpaper.surface, 'wallpaper layer covers all four dialogue surface edges');
      sameBounds(wallpaper.art, wallpaper.surface, 'image DOM box covers all four dialogue surface edges');
      assert(Math.abs(wallpaper.surface.left - wallpaper.column.left) <= 1 && Math.abs(wallpaper.surface.right - wallpaper.column.right) <= 1, 'background aligns with the middle conversation column, not the whole page');
      if (!mobile) assert(Math.abs(wallpaper.surface.top - wallpaper.toolbar.bottom) <= 1, 'background starts immediately below the settings toolbar');
      assert.equal(wallpaper.composerBackground, 'rgba(0, 0, 0, 0)', 'composer surroundings reveal the same background');
      assert(Math.abs(wallpaper.composer.bottom - wallpaper.surface.bottom) <= 1, 'background includes the entire composer area');
      assert(wallpaper.input.top >= wallpaper.surface.top && wallpaper.input.bottom <= wallpaper.surface.bottom + 1, 'white input card sits inside the background range');
      assert(wallpaper.messages.bottom <= wallpaper.composer.top + 1, 'messages and composer remain separate non-overlapping layout regions');
      const scrollBounds = async scrollTop => page.locator('.chat-messages').evaluate((el, top) => {
        el.style.scrollBehavior = 'auto'; el.scrollTop = top;
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        const surface = el.closest('.dialogue-surface');
        return { scrollTop: el.scrollTop, maxScroll: el.scrollHeight - el.clientHeight, surface: rect(surface), layer: rect(surface.querySelector('.roleplay-wallpaper')), image: rect(surface.querySelector('.roleplay-wallpaper img')) };
      }, scrollTop);
      const topScroll = await scrollBounds(0);
      assert(topScroll.maxScroll > 100, 'fictional long conversation genuinely requires scrolling');
      const bottomScroll = await scrollBounds(1e7);
      assert(bottomScroll.scrollTop > topScroll.scrollTop + 100, 'conversation messages can scroll independently');
      sameBounds(bottomScroll.layer, topScroll.layer, 'scrolling messages never moves the wallpaper layer');
      sameBounds(bottomScroll.image, topScroll.image, 'scrolling messages never moves the image');
      sameBounds(bottomScroll.layer, bottomScroll.surface, 'background still covers the surface after scrolling');
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth + 1);
      assert(await page.locator('.chat-messages').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      await page.locator('.chat-textarea textarea').fill('未发送的布局草稿');
      const box = await page.getByRole('button', { name: '发送消息', exact: true }).boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= width && box.y + box.height <= height + 1, 'send button stays visible');
      assert(await page.getByRole('button', { name: '发送消息', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'wallpaper never intercepts clicks');
      await page.locator('.chat-textarea textarea').fill('');
      const checkKnowledgeDropdown = async () => {
        await page.locator('.kb-select .el-select').click();
        const option = page.getByRole('option', { name: '不使用知识库', exact: true });
        await option.waitFor();
        assert(await option.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'knowledge dropdown stays above decorative artwork');
        await option.click();
        await option.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => ![...document.querySelectorAll('.el-select__popper')].some(el => {
          const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && +style.opacity > 0;
        }));
      };
      if (mobile) {
        assert.equal(await page.locator('.persona-theme .assistant .message-bubble').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(255, 252, 252, 0.94)');
        await page.getByRole('button', { name: '对话选项', exact: true }).click();
        await checkKnowledgeDropdown();
        assert(await page.getByRole('button', { name: '收起对话选项', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'options close button stays above wallpaper and backdrop');
        await page.getByRole('button', { name: '收起对话选项', exact: true }).click();
        await page.locator('.chat-toolbar').waitFor({ state: 'hidden' });
        if (width === 390) {
          await page.setViewportSize({ width, height: 480 });
          await page.locator('.chat-textarea textarea').focus();
          await page.waitForFunction(() => document.querySelector('.btn-send').getBoundingClientRect().bottom <= 480);
          assert(await page.getByRole('button', { name: '发送消息', exact: true }).evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), 'send stays clickable at keyboard height');
          const keyboardBounds = await scrollBounds(1e7);
          sameBounds(keyboardBounds.layer, keyboardBounds.surface, 'keyboard-height wallpaper resizes to the entire surface');
          sameBounds(keyboardBounds.image, keyboardBounds.surface, 'keyboard-height image resizes with its surface');
          if (process.env.ROLEPLAY_SCREENSHOTS === '1') await page.screenshot({ path: path.join('.local', 'roleplay-region-390x480.png') });
          await page.setViewportSize({ width, height });
        }
      } else await checkKnowledgeDropdown();
      await page.locator('.chat-textarea textarea').blur();
      await page.mouse.move(0, 0);
      if (process.env.ROLEPLAY_SCREENSHOTS === '1') {
        await page.screenshot({ path: path.join('.local', `roleplay-region-${width}x${height}.png`) });
        // Temporary DOM outlines explain the requested extent; production CSS is untouched.
        await page.locator('.dialogue-surface').evaluate(el => {
          el.style.outline = '3px solid #d946a6'; el.style.outlineOffset = '-3px';
          const label = document.createElement('div');
          label.dataset.testBoundsLabel = 'true'; label.textContent = '背景范围：设置栏下方 → 消息区 + 输入框';
          Object.assign(label.style, { position: 'absolute', left: '7px', top: '7px', zIndex: '10', padding: '5px 8px', borderRadius: '5px', background: '#fff8fc', color: '#a21c70', fontSize: '12px', pointerEvents: 'none' });
          el.append(label);
        });
        await page.screenshot({ path: path.join('.local', `roleplay-region-${width}x${height}-bounds.png`) });
        await page.locator('.dialogue-surface').evaluate(el => { el.style.removeProperty('outline'); el.style.removeProperty('outline-offset'); el.querySelector('[data-test-bounds-label]')?.remove(); });
      }

      const choose = async name => {
        if (mobile) await page.getByRole('button', { name: '对话列表', exact: true }).click();
        await page.getByRole('tab', { name, exact: true }).click();
        if (mobile) await page.getByRole('button', { name: '关闭对话列表', exact: true }).click({ position: { x: width - 10, y: 120 } });
      };
      await choose('普通 AI');
      await page.locator('.assistant-main .message-text').first().waitFor();
      assert.equal(await page.locator('.assistant-main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(245, 247, 250)');
      assert.equal(await page.locator('.assistant-main').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
      assert.equal(await page.locator('.assistant-main').evaluate(el => getComputedStyle(el, '::before').backgroundImage), 'none');
      assert.equal(await page.locator('.assistant-main .assistant .message-bubble').first().evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
      assert.equal(await page.locator('.persona-theme').count(), 0);
      assert.equal(await page.locator('.roleplay-wallpaper').count(), 0, 'ordinary AI never receives a decorative roleplay layer');
      await choose('旧历史');
      await page.locator('.identity-notice').waitFor();
      assert.equal(await page.locator('.chat-main').evaluate(el => getComputedStyle(el).backgroundImage), 'none');
      assert.equal(await page.locator('.chat-main').evaluate(el => getComputedStyle(el, '::before').backgroundImage), 'none');
      assert.equal(await page.locator('.persona-theme').count(), 0);
      assert.equal(await page.locator('.roleplay-wallpaper').count(), 0, 'legacy chats never receive a decorative roleplay layer');
      assert.deepEqual(errors, []);
      assert.deepEqual(writes, [], 'layout test must never submit a model request or a mutation');
      console.log(`PASS ${width}x${height}: full dialogue column wallpaper including composer, stable scrolling, click-safe controls, ordinary AI/legacy unchanged`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });

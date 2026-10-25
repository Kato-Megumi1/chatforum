// Local synthetic fixtures only. No real users, novel text, index jobs or model calls.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');
const base = process.env.KNOWLEDGE_LIBRARY_TEST_BASE || 'http://127.0.0.1:4188/';
const origin = new URL(base).origin;
assert(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = join(__dirname, '../../.local/knowledge-library');
mkdirSync(output, { recursive: true });
const user = { id: 99201, username: 'Synthetic viewer', email: 'fixture@example.test', role: 'USER' };
const citation = { label: 1, chunkId: 73001, documentVersion: 1, chapter: '虚构测试章节', fileName: 'synthetic.txt' };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try { for (const width of [390, 1440]) for (const permission of ['READ', 'WRITE', 'ADMIN']) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 900, hasTouch: width < 900 });
    page.setDefaultTimeout(10000);
    const calls = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(user => localStorage.setItem('chatforum-user', JSON.stringify({ user, token: 'synthetic', refreshToken: '' })), user);
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
      if (url.origin !== origin) return route.abort();
      if (!path.startsWith('/api/')) return route.continue();
      calls.push({ path, method });
      const ok = data => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
      if (path.includes('/reviews')) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Retired UI must not request reviews' }) });
      if (path === '/api/rag/knowledge-bases' && method === 'GET') return ok([{ id: 73, name: '虚构小说库', permission, chatReady: true, visibility: 'PRIVATE', activeIndexVersion: 1,
        documents: [{ id: 74, fileName: 'synthetic.txt', version: 1, isCurrent: true, chunkCount: 1, status: 'COMPLETED' }] }]);
      if (path === '/api/rag/knowledge-bases/73/indexes' && method === 'GET') return ok([{ version: 1, status: 'ACTIVE', chunkCount: 1 }, { version: 2, status: 'READY', chunkCount: 1, metrics: { validated: true } }]);
      if (path === '/api/rag/knowledge-bases/73/search' && method === 'POST') return ok({ indexVersion: 1, passages: [{ content: '虚构检索预览内容。', citation }] });
      if (path === '/api/rag/knowledge-bases/73/graph' && method === 'GET') return ok({ indexVersion: 1, entities: [{ key: 'fixture', name: '虚构人物', mentions: 1 }],
        facts: [{ subject: '虚构人物', target: '测试场景', text: '测试图谱事实。', chapter: '虚构测试章节', citation }] });
      if (path === '/api/rag/knowledge-bases/73/citations/73001' && method === 'GET') return ok({ ...citation, indexVersion: 1, content: '虚构来源片段，仅用于界面测试。' });
      if (path === '/api/forum/notifications/unread-count') return ok({ unreadCount: 0 });
      if (path === '/api/direct-messages/unread-count') return ok({ inbox: 0, requests: 0, total: 0 });
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected synthetic API' }) });
    });
    await page.goto(base + 'knowledge-bases');
    await page.getByText('虚构小说库', { exact: true }).waitFor();
    await page.locator('.novel-page[aria-busy="true"]').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.heading > p, .heading > div > p').count(), 0, 'No permanent marketing subtitle');
    assert.equal(await page.getByText(/上传保存修订版后|内置实体别名词表|嵌入模型由服务端管理/).count(), 0);
    await page.getByText('线上索引 v1', { exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: '原文复核', exact: true }).count(), 0);
    for (const name of ['原文版本', '检索预览', '人物与场景图谱']) assert.equal(await page.getByRole('tab', { name, exact: true }).count(), 1);
    assert.equal(await page.getByRole('tab', { name: '索引发布', exact: true }).count(), Number(permission !== 'READ'));
    assert.equal(await page.getByRole('tab', { name: '访问权限', exact: true }).count(), Number(permission === 'ADMIN'));
    if (permission === 'ADMIN') {
      await page.getByRole('tab', { name: '访问权限', exact: true }).click();
      assert.equal(await page.getByRole('switch', { name: '知识库访问范围' }).isChecked(), false);
      await page.getByRole('tabpanel', { name: '访问权限', exact: true }).getByText('受限访问', { exact: true }).waitFor();
    }
    assert.equal(calls.some(call => call.path.endsWith('/indexes')), permission !== 'READ');
    await page.getByRole('tab', { name: '检索预览', exact: true }).click();
    await page.getByPlaceholder('输入人名、章节细节或对话场景').fill('虚构查询');
    await page.getByRole('button', { name: '检索', exact: true }).click();
    await page.getByText('虚构检索预览内容。', { exact: true }).waitFor();
    await page.getByRole('tab', { name: '人物与场景图谱', exact: true }).click();
    await page.getByRole('button', { name: '查看图谱', exact: true }).click();
    await page.getByRole('button', { name: /\[1\] 虚构测试章节/ }).click();
    const source = page.getByRole('dialog', { name: '原文依据', exact: true });
    await source.getByText('虚构来源片段，仅用于界面测试。', { exact: true }).waitFor();
    await source.getByRole('button', { name: /close|关闭/i }).click();
    await source.waitFor({ state: 'hidden' });
    if (permission !== 'READ') {
      await page.getByRole('tab', { name: '索引发布', exact: true }).click();
      await page.getByRole('button', { name: '构建新索引', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: '构建索引', exact: true });
      await confirm.waitFor();
      await confirm.getByRole('button', { name: '取消', exact: true }).click();
      await confirm.waitFor({ state: 'hidden' });
      assert.equal(calls.some(call => /reindex|activate$/.test(call.path)), false, 'Cancelling cannot create or publish an index');
    }
    await page.getByRole('button', { name: '创建小说库', exact: true }).click();
    const create = page.getByRole('dialog', { name: '创建角色小说库', exact: true });
    await create.waitFor();
    assert.equal(await create.getByRole('switch').isChecked(), false, 'New knowledge bases remain private by default');
    await create.getByText('仅自己和管理员', { exact: true }).waitFor();
    await create.getByRole('button', { name: /close|关闭/i }).click();
    await create.waitFor({ state: 'hidden' });
    assert.equal(calls.some(call => call.path.includes('/reviews')), false);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.getByRole('tab', { name: '原文版本', exact: true }).click();
    assert.equal(await page.getByRole('tab', { name: '原文版本', exact: true }).getAttribute('aria-selected'), 'true');
    await page.waitForTimeout(300); // Let the Element Plus active-bar transition settle for the screenshot.
    await page.screenshot({ path: join(output, `${permission.toLowerCase()}-${width}.png`), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px ${permission}: no review tab/requests, permission tabs retained, search/graph/source/create and cancelled index confirmation intact`);
    await page.close();
  } } finally { await browser.close(); }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });

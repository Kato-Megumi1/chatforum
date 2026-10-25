// Real DOM against shipped monitor assets; every URL is fulfilled locally in Playwright.
// No server, saved browser profile, account, DB, provider or SMTP connection is used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { readFileSync, mkdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const origin = process.env.MONITOR_REPORTS_FIXTURE_ORIGIN || 'http://127.0.0.1:5177';
assert.equal(new URL(origin).origin, origin);
assert(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname), 'Local synthetic origin only');
const root = join(__dirname, '..'), output = join(root, '.local/report-monitor-review');
mkdirSync(output, { recursive: true });
const assets = new Map([
  ['/__monitor_report_fixture__', ['text/html', readFileSync(join(root, 'backend/monitor-public/index.html'), 'utf8')]],
  ['/monitor.js', ['text/javascript', readFileSync(join(root, 'backend/monitor-public/monitor.js'), 'utf8')]],
  ['/monitor.css', ['text/css', readFileSync(join(root, 'backend/monitor-public/monitor.css'), 'utf8')]],
]);
const publicRoutes = [...readFileSync(join(root, 'frontend/src/router/index.ts'), 'utf8').matchAll(/\bpath:\s*['"]([^'"]*)['"]/g)].map(match => match[1]);
assert(!publicRoutes.some(path => /^\/?(?:admin|monitor|ops)(?:\/|$)/i.test(path)), 'Public frontend must not contain local administrator routes');

const actor = { id: 99671, username: '虚构验收管理员', email: 'fixture-admin@example.test', role: 'ADMIN' };
const now = '2026-10-25T01:00:00.000Z';
const csrf = 'synthetic-report-monitor-csrf';
const postTitle = '虚构帖子 · 一起维护友好讨论';
const contextBody = '这里只是隔离验收的虚构正文。\n<img src=x onerror="window.fixtureInjected=true">\n这段标签必须作为纯文本显示。';
const summary = { totals: { totalTokens: 0, inputTokens: 0, outputTokens: 0, embeddingTokens: 0, calls: 0,
  unreportedCalls: 0, partialRecords: 0, unpricedRecords: 0 }, users: 3, banned: 0, logins: 0,
  tasks: [], failedLogins: 0, models: [], daily: [], backfill: 'complete', untrackedTasks: 0 };

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 900, hasTouch: width < 900 });
      const page = await context.newPage(), errors = [], fixtureErrors = [], writes = [], successful = [];
      page.setDefaultTimeout(12000);
      page.on('pageerror', error => errors.push(error.message));
      const reports = [
        { id: 701, type: 'POST', targetId: 904, status: 'PENDING', revision: 1, reason: '人身攻击\n请核查这段虚构讨论的上下文。',
          createdAt: now, reporter: { id: 99672, username: '虚构举报人' }, post: { id: 904, title: postTitle, status: 'APPROVED', revision: 5 } },
        { id: 702, type: 'COMMENT', targetId: 905, commentId: 906, status: 'PENDING', revision: 1,
          reason: '<script>普通文本，不执行</script>', createdAt: now, post: { id: 905, title: '虚构评论 · 请文明交流', status: 'APPROVED', revision: 2 } },
      ];
      const appeals = [
        { id: 801, reportId: 701, status: 'PENDING', revision: 1, reason: '补充了讨论上下文，请重新核查。', createdAt: now,
          report: { id: 701, post: { id: 904, title: postTitle } } },
        { id: 802, reportId: 703, status: 'PENDING', revision: 1, reason: '虚构第二份申诉，用于驳回流程验收。', createdAt: now,
          report: { id: 703, post: { id: 907, title: '虚构评论 · 第二份申诉' } } },
      ];
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        try {
          assert.equal(url.origin, origin, 'No remote requests');
          const asset = assets.get(url.pathname);
          if (asset) return route.fulfill({ contentType: asset[0], body: asset[1] });
          assert(url.pathname.startsWith('/ops-api/'), 'Unexpected URL ' + url.pathname);
          const path = url.pathname.slice('/ops-api'.length), method = request.method();
          const respond = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
          if (method === 'GET') {
            if (path === '/me') return respond({ user: actor, csrf });
            if (path === '/summary') return respond(summary);
            if (path === '/reports') return respond({ page: 1, take: 25, total: reports.length, rows: reports });
            if (path === '/report-appeals') return respond({ page: 1, take: 25, total: appeals.length, rows: appeals });
            if (path === '/reports/701/context') return respond({ type: 'POST', targetId: 904, title: postTitle, content: contextBody,
              status: reports[0].status === 'PENDING' ? 'APPROVED' : 'REJECTED' });
          }
          assert.equal(method, 'POST'); assert.equal(request.headers()['x-ops-csrf'], csrf, 'Independent CSRF value must accompany every decision');
          const body = request.postDataJSON(); writes.push({ path, body });
          const match = path.match(/^\/(reports|report-appeals)\/(\d+)\/decision$/);
          assert(match, 'Only explicit report decisions are writable');
          const target = (match[1] === 'reports' ? reports : appeals).find(row => row.id === Number(match[2]));
          assert(target); assert.equal(body.expectedRevision, target.revision);
          if (body.confirmation !== String(target.id)) return respond({ message: '确认编号不正确，请重新输入' }, 400);
          if (typeof body.reason !== 'string' || !body.reason.trim()) return respond({ message: '请填写处理说明' }, 400);
          if (match[1] === 'reports') {
            assert.equal(body.action, 'HIDE'); target.status = 'RESOLVED'; target.decision = 'HIDE';
          } else {
            assert(['ACCEPT', 'REJECT'].includes(body.action)); target.status = body.action === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
          }
          target.decisionReason = body.reason; target.revision++; successful.push({ path, body });
          return respond({ ok: true });
        } catch (error) {
          fixtureErrors.push(error.message);
          return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'Synthetic fixture rejected unexpected request' }) });
        }
      });

      try {
        await page.goto(origin + '/__monitor_report_fixture__');
        await page.locator('#workspace').waitFor();
        assert.equal(await page.evaluate(() => localStorage.length), 0, 'Fresh context has no actual saved login');
        await page.locator('[data-view="reports"]').click();
        const reportRow = page.locator('#table tbody tr').filter({ hasText: '#701' });
        await reportRow.getByRole('button', { name: '隐藏内容', exact: true }).waitFor();
        const reportLayout = await page.locator('#table').evaluate(wrapper => ({
          reasonWidth: wrapper.querySelector('tbody td:nth-child(2) .comment-excerpt').getBoundingClientRect().width,
          tableWidth: wrapper.querySelector('table').getBoundingClientRect().width,
          wrapperWidth: wrapper.getBoundingClientRect().width, horizontalScroll: getComputedStyle(wrapper).overflowX,
          pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        }));
        assert(reportLayout.reasonWidth >= 64, 'Report reason must have room for several Chinese characters, not one character per line');
        assert(reportLayout.tableWidth >= 900, 'Only report tables retain a readable minimum width');
        assert(reportLayout.pageWidth <= reportLayout.viewport + 1, 'Report table must not overflow the document');
        if (width < 900) { assert(reportLayout.tableWidth > reportLayout.wrapperWidth); assert.equal(reportLayout.horizontalScroll, 'auto'); }
        assert.equal(await page.locator('#table script, #table img').count(), 0, 'Report reason must remain plain text');
        await page.screenshot({ path: join(output, `reports-${width}.png`), fullPage: true });
        await reportRow.getByRole('button', { name: '查看内容', exact: true }).click();
        await page.locator('#report-context-dialog[open]').waitFor();
        assert.equal(await page.locator('#report-context-text').textContent(), postTitle + '\n\n' + contextBody);
        assert.equal(await page.locator('#report-context-text img').count(), 0);
        assert.equal(await page.evaluate(() => window.fixtureInjected), undefined);
        await page.screenshot({ path: join(output, `context-${width}.png`), fullPage: true });
        await page.locator('#report-context-dialog').getByRole('button', { name: '关闭', exact: true }).click();

        await reportRow.getByRole('button', { name: '隐藏内容', exact: true }).click();
        await page.locator('#decision-reason').fill('已核对虚构上下文，先隐藏并保留作者申诉入口。');
        await page.locator('#confirmation').fill('incorrect-number'); await page.locator('#confirm-action').click();
        await page.locator('#confirm-error').getByText('确认编号不正确，请重新输入', { exact: true }).waitFor();
        assert.equal(successful.length, 0);
        await page.locator('#confirmation').fill('701');
        await page.screenshot({ path: join(output, `hide-confirmation-${width}.png`), fullPage: true });
        await page.locator('#confirm-action').click();
        await reportRow.getByText('已处理', { exact: false }).waitFor();
        assert.equal(await reportRow.getByRole('button', { name: '隐藏内容', exact: true }).count(), 0);

        await page.locator('[data-view="report-appeals"]').click();
        const firstAppeal = page.locator('#table tbody tr').filter({ hasText: '申诉 #801' });
        await firstAppeal.waitFor();
        assert(await firstAppeal.locator('td:nth-child(2) .comment-excerpt').evaluate(element => element.getBoundingClientRect().width >= 64),
          'Appeal reason must not become a one-character-wide column');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Appeal table must not overflow the document');
        await firstAppeal.getByRole('button', { name: '通过并恢复', exact: true }).click();
        await page.locator('#decision-reason').fill('补充上下文成立，恢复虚构内容。');
        await page.locator('#confirmation').fill('801'); await page.locator('#confirm-action').click();
        await firstAppeal.getByText('已通过', { exact: false }).waitFor();
        const secondAppeal = page.locator('#table tbody tr').filter({ hasText: '申诉 #802' });
        await secondAppeal.getByRole('button', { name: '驳回申诉', exact: true }).click();
        await page.locator('#decision-reason').fill('核查后仍不符合社区规则，保留本次处理。');
        await page.locator('#confirmation').fill('802'); await page.locator('#confirm-action').click();
        await secondAppeal.getByText('未通过', { exact: false }).waitFor();
        await page.locator('#table').evaluate(wrapper => { wrapper.scrollLeft = 0; });
        await page.screenshot({ path: join(output, `appeals-processed-${width}.png`), fullPage: true });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page must not overflow horizontally');
        assert.deepEqual(successful.map(item => item.body.action), ['HIDE', 'ACCEPT', 'REJECT']);
        assert.equal(writes.length, 4); assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []);
        assert(existsSync(join(output, `reports-${width}.png`)));
        console.log(`PASS ${width}px: real monitor DOM, escaped context, wrong/correct confirmation, CSRF/revision payload, hide + restore + reject, no real API or storage`);
      } finally { await context.close(); }
    }

    // An independent unprivileged session cannot render a management workspace.
    // Server authorization itself is covered by monitor-reports.spec.ts, not this mocked UI check.
    const denied = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const page = await denied.newPage();
      await page.route('**/*', async route => {
        const url = new URL(route.request().url()); assert.equal(url.origin, origin);
        const asset = assets.get(url.pathname);
        if (asset) return route.fulfill({ contentType: asset[0], body: asset[1] });
        assert.equal(url.pathname, '/ops-api/me');
        return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: '需要管理员权限' }) });
      });
      await page.goto(origin + '/__monitor_report_fixture__'); await page.locator('#login').waitFor();
      assert.equal(await page.locator('#workspace').isVisible(), false);
      assert.equal(await page.getByRole('button', { name: '隐藏内容', exact: true }).count(), 0);
      console.log('PASS public route inventory has no administrator route; denied independent session keeps management workspace hidden');
    } finally { await denied.close(); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });

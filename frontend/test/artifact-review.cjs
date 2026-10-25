const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const vue = require('vue');
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const helperModule = { exports: {} };
new Function('module', 'exports', compile(readFileSync(join(__dirname, '../src/utils/artifact-review.ts'), 'utf8')))(helperModule, helperModule.exports);
const helper = helperModule.exports;
const reviewId = '9f7d1076-ae39-4054-840b-7b50a93517a6', sourceHash = 'a'.repeat(64);
const summary = () => ({ status: 'passed', reviewId, sourceHash, issues: [] });
const report = (more = {}) => ({ ...summary(), views: [{ index: 0, width: 390, height: 844 }, { index: 1, width: 1280, height: 900 }], ...more });
const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: 'image/png' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('HTML-only status cannot manufacture a passed review from missing or malformed metadata', () => {
  assert(helper.isHtmlArtifact('demos/Example.HTML')); assert(helper.isHtmlArtifact('demo.htm'));
  for (const name of ['a.pdf', 'a.docx', 'a.png', 'a.html.txt', undefined]) assert.equal(helper.isHtmlArtifact(name), false);
  assert.equal(helper.artifactReviewSummary(summary()).status, 'passed');
  for (const value of [undefined, {}, { status: 'unknown' }, { status: 'passed' }, { status: 'passed', reviewId: '../private' }])
    assert.equal(helper.artifactReviewSummary(value).status, 'not_reviewed');
  assert.equal(helper.artifactReviewLabel('passed'), '已做页面验收');
  assert.equal(helper.artifactReviewLabel('issues'), '验收发现问题');
  assert.equal(helper.artifactReviewLabel('unavailable'), '未完成视觉验收');
  assert.equal(helper.artifactReviewLabel('not_reviewed'), '未完成视觉验收');
});

test('reports bind immutable review/hash and only the real fixed viewport images', () => {
  assert.equal(helper.artifactReviewReport(report(), reviewId, sourceHash).views.length, 2);
  for (const value of [report({ reviewId: '00000000-0000-0000-0000-000000000000' }), report({ sourceHash: 'b'.repeat(64) }),
    report({ sourceHash: '../private' }), report({ status: 'PASS_FAKE' }), report({ views: [] }),
    report({ views: [{ index: 4, width: 390, height: 844 }] }),
    report({ views: [{ index: 0, width: 390, height: 844 }, { index: 0, width: 390, height: 844 }] }),
    report({ views: [{ index: 1, width: 390, height: 844 }] })]) assert.throws(() => helper.artifactReviewReport(value, reviewId, sourceHash));
  const safe = helper.artifactReviewReport(report({ status: 'unavailable', views: [], issues: ['Only real issue', ...Array(20).fill('x'.repeat(1000))],
    html: 'PRIVATE_HTML', base64: 'PRIVATE_IMAGE', token: 'PRIVATE_TOKEN' }), reviewId, sourceHash);
  assert.equal(safe.issues.length, 8); assert.equal(safe.issues[1].length, 240);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE_/);
});

test('screenshots must be bounded PNG blobs with the PNG signature, never executable markup', async () => {
  assert(await helper.isReviewPng(png()));
  for (const value of [null, 'https://public.example/review.png', new Blob(['<svg onload=alert(1)>'], { type: 'image/svg+xml' }),
    new Blob(['<html>private</html>'], { type: 'image/png' }), new Blob([], { type: 'image/png' })]) assert.equal(await helper.isReviewPng(value), false);
});

function fixture(component = 'ArtifactReview') {
  const props = vue.reactive({ conversationId: 11, changeId: 21, path: 'demo.html', review: summary(),
    artifacts: [{ changeId: 21, path: 'demo.html', review: summary() }, { changeId: 22, path: 'note.pdf' }] });
  let epoch = 3, respond = call => Promise.resolve(call.path.endsWith('/images/0') || call.path.endsWith('/images/1') ? png() : report());
  const identity = vue.reactive({ user: { id: 7 }, token: 'synthetic' });
  const user = { get token() { return identity.token; }, getAuthSession: () => ({ userId: identity.user?.id ?? null, epoch }) };
  const calls = [], created = [], revoked = [], downloads = [], errors = [], unmounts = [], scope = vue.effectScope();
  const dependencies = {
    vue: { ...vue, onUnmounted: callback => unmounts.push(callback) },
    '@/utils/request': { default: { get(path, config) { const call = { path, config }; calls.push(call); return respond(call); } } },
    '@/stores/user': { useUserStore: () => user }, '@/utils/artifact-review': helper,
    '@/utils/chat-files': { downloadChatFile: (...args) => downloads.push(args) },
    'element-plus': { ElMessage: { error: value => errors.push(value) } },
  };
  const source = readFileSync(join(__dirname, '../src/components/' + component + '.vue'), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const names = component === 'ArtifactReview' ? 'load,report,images,loading,loadError,label,canView,visibleIssues,failImage' : 'download,downloading';
  const mod = { exports: {} };
  scope.run(() => new Function('module', 'exports', 'require', 'defineProps', 'URL', compile(script + '\nexport {' + names + '};'))(
    mod, mod.exports, name => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.endsWith('.vue')) return {};
      throw Error('Unexpected import ' + name);
    }, () => props, { createObjectURL(blob) { const value = 'blob:synthetic-' + (created.length + 1); created.push({ value, blob }); return value; },
      revokeObjectURL: value => revoked.push(value) }));
  return { ...mod.exports, props, calls, created, revoked, downloads, errors, source,
    respond: handler => { respond = handler; }, renewToken: () => { identity.token += '-renew'; },
    switchAccount: id => { epoch++; identity.user = id ? { id } : null; identity.token += '-login'; },
    unmount: () => { unmounts.forEach(callback => callback()); scope.stop(); },
  };
}

test('preview loads lazily over authenticated private endpoints, coalesces and revokes on unmount', async t => {
  const f = fixture(); t.after(f.unmount); assert.equal(f.calls.length, 0); assert.equal(f.label.value, '已做页面验收');
  await Promise.all([f.load(), f.load()]);
  assert.equal(f.calls.length, 3); assert.equal(f.created.length, 2); assert.equal(f.loading.value, false);
  assert.equal(f.calls[0].path, `/coding/11/changes/21/review/${reviewId}`);
  for (const call of f.calls.slice(1)) { assert.equal(call.config.responseType, 'blob'); assert(call.config.signal instanceof AbortSignal); }
  assert(f.images.value.every(image => image.url.startsWith('blob:synthetic-') && image.state === 'ready'));
  await f.load(); assert.equal(f.calls.length, 3, 'Disclosure does not repeat a successful request');
  f.renewToken(); assert.equal(f.revoked.length, 0, 'Ordinary token renewal does not invalidate a same-session preview');
  f.unmount(); assert.equal(f.revoked.length, 2); assert.equal(f.images.value.length, 0);
});

test('conversation changes discard late reports before any image request', async t => {
  const f = fixture(); t.after(f.unmount); const waiting = deferred(); f.respond(() => waiting.promise);
  const pending = f.load(); f.props.conversationId = 12;
  assert.equal(f.calls[0].config.signal.aborted, true); waiting.resolve(report()); await pending;
  assert.equal(f.report.value, undefined); assert.equal(f.images.value.length, 0); assert.equal(f.created.length, 0); assert.equal(f.calls.length, 1);
});

test('same-user relogin and account switches reject late PNGs and never rebind an old artifact', async t => {
  for (const id of [7, 8]) {
    const f = fixture(); t.after(f.unmount); const waiting = deferred();
    f.respond(call => call.path.includes('/images/') ? waiting.promise : Promise.resolve(report()));
    const pending = f.load(); await tick(); assert.equal(f.calls.length, 3);
    f.switchAccount(id); waiting.resolve(png()); await pending;
    assert.equal(f.created.length, 0); assert.equal(f.canView.value, false); assert.equal(f.images.value.length, 0);
    const calls = f.calls.length; await f.load(true); assert.equal(f.calls.length, calls);
  }
});

test('loaded images are revoked on hash changes and image errors are explicit, without public fallbacks', async t => {
  const f = fixture(); t.after(f.unmount); await f.load();
  f.failImage(0); assert.equal(f.images.value[0].state, 'error'); assert.equal(f.images.value[0].url, ''); assert.equal(f.revoked.length, 1);
  f.props.review = { ...summary(), sourceHash: 'b'.repeat(64) }; assert.equal(f.revoked.length, 2); assert.equal(f.report.value, undefined);
  await f.load(); assert.equal(f.loadError.value, true); assert.equal(f.label.value, '未完成视觉验收'); assert.equal(f.images.value.length, 0);
});

test('a screenshot permission or revision failure clears all already loaded previews', async t => {
  const f = fixture(); t.after(f.unmount); const second = deferred();
  f.respond(call => call.path.endsWith('/images/0') ? Promise.resolve(png()) : call.path.endsWith('/images/1') ? second.promise : Promise.resolve(report()));
  const pending = f.load(); await tick(); assert.equal(f.created.length, 1);
  second.reject({ response: { status: 403 } }); await pending;
  assert.equal(f.loadError.value, true); assert.equal(f.images.value.length, 0); assert.equal(f.report.value, undefined); assert.equal(f.revoked.length, 1);
});

test('unavailable/non-visual-model results never become passed and remain retryable without model substitution', async t => {
  const f = fixture(); t.after(f.unmount); f.respond(async () => { throw Error('Synthetic network failure'); });
  await f.load(); assert.equal(f.loadError.value, true); assert.equal(f.label.value, '未完成视觉验收');
  f.respond(async () => report({ status: 'unavailable', views: [], issues: ['当前模型未执行视觉验收'] }));
  await f.load(true); assert.equal(f.loadError.value, false); assert.equal(f.label.value, '未完成视觉验收');
  assert.deepEqual(f.visibleIssues.value, ['当前模型未执行视觉验收']); assert.equal(f.created.length, 0);
  assert(f.calls.every(call => call.path.startsWith('/coding/')));
});

test('downloads are independent per artifact, remain plain downloads, and discard stale-account responses', async t => {
  const f = fixture('FileArtifacts'); t.after(f.unmount); const a = deferred(), b = deferred();
  f.respond(call => call.path.includes('/21/') ? a.promise : b.promise);
  const first = f.download(f.props.artifacts[0]), second = f.download(f.props.artifacts[1]);
  assert.equal(f.downloading.value.size, 2); assert.equal(f.calls.length, 2); assert(f.calls.every(call => call.path.endsWith('/download')));
  a.resolve(new Blob(['<html>synthetic</html>'])); await first; assert.equal(f.downloads.length, 1); assert.equal(f.downloading.value.has(22), true);
  f.switchAccount(8); b.resolve(new Blob(['synthetic PDF'])); await second; assert.equal(f.downloads.length, 1);
  assert.equal(f.downloading.value.size, 0); assert.deepEqual(f.errors, []);
});

test('review UI never executes generated HTML or places private screenshots in public URLs', () => {
  const review = readFileSync(join(__dirname, '../src/components/ArtifactReview.vue'), 'utf8');
  const artifacts = readFileSync(join(__dirname, '../src/components/FileArtifacts.vue'), 'utf8');
  assert.match(review, /<details/); assert.match(review, /<summary/); assert.match(review, /:src="image\.url"/);
  assert.match(review, /此截图暂不可查看/); assert.doesNotMatch(review, /review-scope|页面验收不代表所有业务与交互测试均已通过/);
  assert.doesNotMatch(review + artifacts, /<iframe|srcdoc=|v-html|window\.open|target="_blank"|favicon/);
  assert.match(artifacts, /<ArtifactReview v-if="isHtmlArtifact\(file\.path\)"/);
  assert.match(artifacts, /:disabled="downloading\.has\(file\.changeId\)"/);
});

const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');

// Synthetic Vue refs and deferred HTTP only: no production accounts, browser sessions or APIs.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(file, names) {
  const calls = [], navigations = [], watchers = [], teardown = [];
  const route = { params: { id: '9' }, query: {}, fullPath: '/notifications' };
  const user = { user: { id: 1, username: 'Fixture' }, token: 'synthetic' };
  const badge = { unreadCount: 0, refreshCalls: 0, async refresh() { this.refreshCalls++; } };
  let respond = () => Promise.resolve({ data: [], total: 0, unreadCount: 0 });
  const request = Object.fromEntries(['get', 'put', 'patch', 'delete'].map(method => [method, (path, options) => {
    const call = { method, path, options }; calls.push(call); return respond(call);
  }]));
  const imports = {
    vue: { ref: value => ({ value }), reactive: value => value, computed: getter => ({ get value() { return getter(); } }),
      watch(getter, callback) { watchers.push({ getter, callback }); }, onUnmounted(callback) { teardown.push(callback); } },
    'vue-router': { useRoute: () => route, useRouter: () => ({
      push: async target => { navigations.push(target); }, replace: async target => { navigations.push(target); },
    }) },
    '@/utils/request': request, '@/stores/user': { useUserStore: () => user },
    '@/stores/notifications': { useNotificationStore: () => badge },
    '@/utils/forum-experience': { notificationTarget: () => null },
    '@element-plus/icons-vue': { ChatDotRound: {}, Collection: {}, Document: {}, User: {} },
    'element-plus': { ElMessageBox: { confirm: async () => undefined }, ElMessage: { info() {} } },
    dayjs: () => ({ format: () => 'fixture-date' }),
  };
  const source = readFileSync(join(__dirname, '../src/' + file), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const code = ts.transpileModule(script + '\nexport {' + names.join(',') + '};', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(imports, name)) return imports[name]; throw new Error('Unexpected import ' + name);
  }, mod, mod.exports);
  return { ...mod.exports, calls, navigations, watchers, teardown, route, user, badge, source,
    respond(handler) { respond = handler; } };
}
const notification = () => fixture('views/Notifications.vue', ['items', 'page', 'total', 'unreadOnly', 'notificationType', 'setType', 'loading', 'loadError', 'markingAll', 'busy', 'load', 'read', 'readAll', 'open']);
const activity = () => fixture('components/ForumActivity.vue', ['items', 'page', 'total', 'active', 'loading', 'loadError', 'load']);
const space = () => fixture('views/UserSpace.vue', ['posts', 'postsError', 'postsLoading', 'loadPosts', 'people', 'peopleLoading', 'peopleError', 'peopleRetryAppend', 'peopleCursor', 'loadPeople']);

test('notification failure is a retryable error, not a false empty inbox', async () => {
  const f = notification(); f.respond(async () => { throw new Error('offline'); });
  await assert.doesNotReject(f.load());
  assert.equal(f.loadError.value, true); assert.equal(f.loading.value, false);
  assert.match(f.source, /!items\.length && !loading && !loadError/);
  f.badge.unreadCount = 4; // The shared count store owns the badge, independently of a list snapshot.
  f.respond(async () => ({ data: [{ id: 11, title: 'Synthetic update' }], total: 1, unreadCount: 1 }));
  await f.load(); assert.equal(f.loadError.value, false); assert.equal(f.items.value[0].id, 11); assert.equal(f.badge.unreadCount, 4);
  assert.equal(f.badge.refreshCalls, 2);
});

test('notification categories filter on the server, reset pagination and ignore stale category responses', async () => {
  const f = notification(), old = deferred(); f.badge.unreadCount = 15;
  f.page.value = 4; f.items.value = [{ id: 9 }]; f.respond(() => old.promise);
  const pending = f.load();
  f.respond(async () => ({ data: [{ id: 21, type: 'LIKE' }], total: 1, unreadCount: 15 }));
  f.setType('LIKE');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.page.value, 1); assert.equal(f.calls.at(-1).options.params.type, 'LIKE');
  old.resolve({ data: [{ id: 2, type: 'COMMENT' }], total: 80, unreadCount: 16 }); await pending;
  assert.deepEqual(f.items.value, [{ id: 21, type: 'LIKE' }]);
  assert.equal(f.badge.unreadCount, 15); // Only the global count store can update this value.
  f.unreadOnly.value = true; await f.load();
  assert.deepEqual(f.calls.at(-1).options.params, { page: 1, limit: 20, unreadOnly: true, type: 'LIKE' });
  f.setType(''); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.at(-1).options.params.type, undefined);
});

test('an older list snapshot cannot undo the forced badge refresh after marking a notification read', async () => {
  const f = notification(), list = deferred(), item = { id: 31, isRead: false }, refreshOptions = [];
  f.badge.unreadCount = 7;
  f.badge.refresh = async options => {
    refreshOptions.push(options);
    if (options?.force) f.badge.unreadCount = 0;
  };
  f.respond(call => call.method === 'get' ? list.promise : Promise.resolve({}));
  const loading = f.load();
  await f.read(item); assert.equal(item.isRead, true); assert.equal(f.badge.unreadCount, 0);
  list.resolve({ data: [], total: 0, unreadCount: 7 }); await loading;
  assert.equal(f.badge.unreadCount, 0);
  assert.deepEqual(refreshOptions, [undefined, { force: true }]);
});

test('layout observes a same-account re-login epoch through token changes without clearing on token renewal', async t => {
  const vue = require('vue'), identity = vue.reactive({ user: { id: 1 }, token: 'synthetic-old-token' });
  let epoch = 1;
  const user = { get user() { return identity.user; }, get token() { return identity.token; },
    getAuthSession: () => ({ userId: identity.user?.id ?? null, epoch }) };
  const badge = () => ({ clears: 0, refreshes: 0, clear() { this.clears++; }, refresh() { this.refreshes++; } });
  const notifications = badge(), messages = badge();
  const imports = { '@/utils/api': { publicAsset: path => path },
    vue: { computed: vue.computed, watch: vue.watch, onMounted() {}, onUnmounted() {} },
    '@element-plus/icons-vue': {}, '@/stores/notifications': { useNotificationStore: () => notifications },
    '@/stores/direct-messages': { useDirectMessageStore: () => messages },
    'vue-router': { useRouter: () => ({}), useRoute: () => ({ path: '/forum' }) },
    'element-plus': {}, '@/stores/user': { useUserStore: () => user },
    '@/composables/useMobileViewport': { useMobileViewport: () => ({}) } };
  const source = readFileSync(join(__dirname, '../src/layouts/MainLayout.vue'), 'utf8').match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = vue.effectScope(); t.after(() => scope.stop());
  scope.run(() => new Function('require', 'exports', 'document', code)(name => imports[name], {}, { hidden: false }));
  assert.equal(notifications.clears, 1); assert.equal(messages.refreshes, 1);
  // Epoch is intentionally closure-only; replacing the token must still trigger the identity getter.
  epoch++; identity.token = 'synthetic-new-login'; await vue.nextTick();
  assert.equal(notifications.clears, 2); assert.equal(messages.refreshes, 2);
  identity.token = 'synthetic-normal-token-renewal'; await vue.nextTick();
  assert.equal(notifications.clears, 2); assert.equal(messages.refreshes, 2);
});

test('late failed notification load cannot replace a newer successful filter result', async () => {
  const f = notification(), old = deferred();
  f.respond(() => old.promise); const pending = f.load();
  f.unreadOnly.value = true;
  f.respond(async () => ({ data: [{ id: 22 }], total: 1, unreadCount: 1 })); await f.load();
  old.reject(new Error('old failure')); await pending;
  assert.equal(f.loadError.value, false); assert.equal(f.loading.value, false); assert.deepEqual(f.items.value, [{ id: 22 }]);
});

test('failed mark-read settles safely and does not prevent opening a valid notification destination', async () => {
  const f = notification(), item = { id: 12, isRead: false, url: '/forum/post/9' };
  f.respond(async () => { throw new Error('mark failed'); });
  await assert.doesNotReject(f.read(item)); assert.equal(item.isRead, false); assert.equal(f.busy.size, 0);
  await assert.doesNotReject(f.open(item)); assert.deepEqual(f.navigations, ['/forum/post/9']);
  assert.equal(item.isRead, false); assert.equal(f.badge.refreshCalls, 0);
});

test('failed mark-all does not claim success or leave either read action pending', async () => {
  const f = notification(), single = deferred(), item = { id: 13, isRead: false };
  f.respond(call => call.path.endsWith('/read-all') ? Promise.reject(new Error('mark-all failed')) : single.promise);
  const pending = f.read(item); await assert.doesNotReject(f.readAll());
  assert.equal(f.markingAll.value, false); assert.equal(f.badge.refreshCalls, 0);
  single.resolve({}); await pending;
  assert.equal(item.isRead, true); assert.equal(f.busy.size, 0);
});

test('reading the last unread item on a later page goes back to the remaining valid page', async () => {
  const f = notification(), item = { id: 21, isRead: false };
  f.page.value = 2; f.total.value = 21; f.unreadOnly.value = true; f.items.value = [item];
  f.respond(async call => call.method === 'put' ? {} : { data: [{ id: 1, isRead: false }], total: 20, unreadCount: 20 });
  await f.read(item);
  assert.equal(f.page.value, 1); assert.equal(f.total.value, 20); assert.deepEqual(f.items.value, [{ id: 1, isRead: false }]);
  assert.equal(f.calls.find(call => call.method === 'get').options.params.page, 1);
  assert.equal(f.busy.size, 0);
});

test('an auxiliary badge failure cannot strand the unread list on an empty later page', async () => {
  const f = notification(), item = { id: 21, isRead: false };
  f.page.value = 2; f.total.value = 21; f.unreadOnly.value = true; f.items.value = [item];
  f.badge.refresh = async () => { throw new Error('badge offline'); };
  f.respond(async call => call.method === 'put' ? {} : { data: [{ id: 1 }], total: 20, unreadCount: 20 });
  await f.read(item);
  assert.equal(f.page.value, 1); assert.deepEqual(f.items.value, [{ id: 1 }]); assert.equal(f.busy.size, 0);
});

test('mark-all in the unread filter resets pagination before refreshing', async () => {
  const f = notification(); f.page.value = 3; f.unreadOnly.value = true;
  f.respond(async call => call.method === 'put' ? {} : { data: [], total: 0, unreadCount: 0 });
  await f.readAll();
  assert.equal(f.page.value, 1); assert.equal(f.markingAll.value, false);
  assert.equal(f.calls.find(call => call.method === 'get').options.params.page, 1);
});

test('logout clears the notification page and ignores a previous account response', async () => {
  const f = notification(), old = deferred(); f.respond(() => old.promise);
  const pending = f.load(); f.total.value = 80; f.user.user = null; f.watchers[0].callback();
  assert.equal(f.total.value, 0); assert.equal(f.loading.value, false);
  old.resolve({ data: [{ id: 1, content: 'old private synthetic notification' }], total: 1, unreadCount: 1 }); await pending;
  assert.deepEqual(f.items.value, []); assert.equal(f.total.value, 0); assert.equal(f.loadError.value, false);
});

test('personal activity has separate retryable error and empty states', async () => {
  const f = activity(); f.respond(async () => { throw new Error('offline'); });
  await assert.doesNotReject(f.load()); assert.equal(f.loadError.value, true); assert.equal(f.loading.value, false);
  assert.match(f.source, /!items\.length && !loading && !loadError/);
  f.respond(async () => ({ data: [{ id: 32 }], total: 1 })); await f.load();
  assert.equal(f.loadError.value, false); assert.deepEqual(f.items.value, [{ id: 32 }]);
});

test('activity logout clears stale pagination and prevents private results from returning', async () => {
  const f = activity(), old = deferred(); f.respond(() => old.promise);
  const pending = f.load(); f.total.value = 100; f.user.user = null; f.watchers[0].callback();
  old.resolve({ data: [{ id: 77 }], total: 100 }); await pending;
  assert.deepEqual(f.items.value, []); assert.equal(f.total.value, 0); assert.equal(f.loading.value, false);
});

test('public user posts expose failed requests as retryable errors rather than no posts', async () => {
  const f = space(); f.respond(async () => { throw new Error('offline'); });
  await assert.doesNotReject(f.loadPosts()); assert.equal(f.postsError.value, true); assert.equal(f.postsLoading.value, false);
  f.respond(async () => ({ data: [{ id: 7 }], total: 1 })); await f.loadPosts();
  assert.equal(f.postsError.value, false); assert.deepEqual(f.posts.value, [{ id: 7 }]);
});

test('failed next-page people request retries its cursor and preserves already loaded people', async () => {
  const f = space(); f.route.query.people = 'followers';
  f.respond(async () => ({ data: [{ id: 1, username: 'Synthetic A' }], hasMore: true, nextCursor: 40 }));
  await f.loadPeople(false);
  f.respond(async () => { throw new Error('next page offline'); }); await f.loadPeople(true);
  assert.equal(f.peopleError.value, true); assert.equal(f.peopleRetryAppend.value, true);
  assert.equal(f.peopleCursor.value, 40); assert.deepEqual(f.people.value.map(person => person.id), [1]);
  f.respond(async () => ({ data: [{ id: 1 }, { id: 2, username: 'Synthetic B' }], hasMore: false, nextCursor: null }));
  await f.loadPeople(f.peopleRetryAppend.value);
  assert.equal(f.peopleError.value, false); assert.deepEqual(f.people.value.map(person => person.id), [1, 2]);
  assert.equal(f.calls[1].options.params.cursor, 40); assert.equal(f.calls[2].options.params.cursor, 40);
});

test('late user-post response cannot update a page after the viewer account changed', async () => {
  const f = space(), old = deferred(); f.respond(() => old.promise);
  const pending = f.loadPosts(); f.user.user = { id: 2, username: 'Other synthetic account' };
  old.resolve({ data: [{ id: 91 }], total: 1 }); await pending;
  assert.deepEqual(f.posts.value, []);
});

test('leaving a loading people tab clears its spinner and invalidates the late people response', async () => {
  const f = space(), old = deferred(); f.route.query.people = 'followers'; f.respond(() => old.promise);
  const pending = f.loadPeople(false); assert.equal(f.peopleLoading.value, true);
  f.route.query.people = undefined; f.watchers[1].callback();
  assert.equal(f.peopleLoading.value, false);
  old.resolve({ data: [{ id: 99 }], hasMore: false, nextCursor: null }); await pending;
  assert.deepEqual(f.people.value, []); assert.equal(f.peopleLoading.value, false);
});

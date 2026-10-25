const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const vue = require('vue'), pinia = require('pinia');

function load(relativePath, imports = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(readFileSync(join(__dirname, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (Object.hasOwn(imports, name)) return imports[name];
    throw Error('Unexpected import: ' + name);
  }, mod, mod.exports);
  return mod.exports;
}
const { createReadRefreshCache } = load('../src/utils/read-refresh-cache.ts');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('concurrent route/focus reads share one promise and only successful reads start the short TTL', async () => {
  let time = 1000, value = 0;
  const loads = [];
  const cache = createReadRefreshCache({ scope: () => '1:2', now: () => time,
    load() { const d = deferred(); loads.push(d); return d.promise; }, apply(result) { value = result; } });
  const first = cache.refresh();
  assert.equal(cache.refresh(), first);
  assert.equal(cache.refresh(), first);
  await tick(); assert.equal(loads.length, 1);
  loads[0].resolve(7); await first; assert.equal(value, 7);
  time += 11999; await cache.refresh(); assert.equal(loads.length, 1);
  time++; const next = cache.refresh(); await tick(); assert.equal(loads.length, 2);
  loads[1].resolve(8); await next; assert.equal(value, 8);
});

test('a confirmed mutation forces a new read and invalidates a pre-mutation response', async () => {
  const loads = [], values = [];
  const cache = createReadRefreshCache({ scope: () => '1:2',
    load() { const d = deferred(); loads.push(d); return d.promise; }, apply(result) { values.push(result); } });
  const old = cache.refresh(); await tick();
  const fresh = cache.refresh({ force: true }); assert.notEqual(fresh, old);
  assert.equal(cache.refresh(), fresh); await tick(); assert.equal(loads.length, 2);
  loads[1].resolve(0); await fresh;
  loads[0].resolve(12); await old;
  assert.deepEqual(values, [0]);
  await cache.refresh(); assert.equal(loads.length, 2);
});

test('a failed read is not cached and all callers can retry after the shared rejection', async () => {
  let attempts = 0;
  const cache = createReadRefreshCache({ scope: () => '1:2',
    load: async () => { if (++attempts === 1) throw Error('offline'); return 3; }, apply() {} });
  const first = cache.refresh(), second = cache.refresh();
  assert.equal(first, second);
  await assert.rejects(first, /offline/);
  await cache.refresh(); assert.equal(attempts, 2);
});

test('clear invalidates queued dispatches, pending responses and same-account cached success', async () => {
  const loads = [], values = [];
  const cache = createReadRefreshCache({ scope: () => '1:2',
    load() { const d = deferred(); loads.push(d); return d.promise; }, apply(result) { values.push(result); } });
  const queued = cache.refresh(); cache.clear(); await queued; assert.equal(loads.length, 0);
  const old = cache.refresh(); await tick(); cache.clear();
  const fresh = cache.refresh(); await tick();
  loads[0].resolve(9); await old; assert.deepEqual(values, []);
  loads[1].resolve(1); await fresh; assert.deepEqual(values, [1]);
  cache.clear(); const again = cache.refresh(); await tick(); assert.equal(loads.length, 3);
  loads[2].resolve(2); await again;
});

function fixture(kind) {
  let epoch = 0, clock = 1000;
  const identity = vue.reactive({ user: { id: 1 }, token: 'fixture-token-1' });
  const user = { get user() { return identity.user; }, get token() { return identity.token; },
    getAuthSession: () => ({ userId: identity.user?.id ?? null, epoch }) };
  const calls = [];
  const request = { get(path) { const d = deferred(); calls.push({ path, ...d }); return d.promise; } };
  const imports = { vue, pinia, '@/utils/request': request,
    '@/utils/read-refresh-cache': { createReadRefreshCache: options => createReadRefreshCache({ ...options, now: () => clock }) },
    './user': { useUserStore: () => user } };
  const mod = load(`../src/stores/${kind}.ts`, imports);
  pinia.setActivePinia(pinia.createPinia());
  const store = kind === 'notifications' ? mod.useNotificationStore() : mod.useDirectMessageStore();
  const payload = value => kind === 'notifications' ? { unreadCount: value } : { inbox: value, requests: value + 1, total: value + value + 1 };
  const count = () => kind === 'notifications' ? store.unreadCount : store.total;
  const expected = value => kind === 'notifications' ? value : value + value + 1;
  function switchTo(id) {
    epoch++;
    identity.user = id ? { id } : null;
    identity.token = id ? `fixture-token-${id}-${epoch}` : '';
  }
  return { store, calls, payload, count, expected, switchTo, identity, advance: ms => { clock += ms; } };
}

for (const kind of ['notifications', 'direct-messages']) {
  test(`${kind}: actual store coalesces badge requests, then force refreshes after a write`, async t => {
    const f = fixture(kind); t.after(() => f.store.$dispose());
    // Pinia decorates action promises; the underlying refresh still performs one HTTP read.
    const first = f.store.refresh(), duplicate = f.store.refresh();
    await tick(); assert.equal(f.calls.length, 1);
    f.calls[0].resolve(f.payload(4)); await Promise.all([first, duplicate]);
    assert.equal(f.count(), f.expected(4));
    await f.store.refresh(); assert.equal(f.calls.length, 1);
    const forced = f.store.refresh({ force: true }); await tick(); assert.equal(f.calls.length, 2);
    f.calls[1].resolve(f.payload(0)); await forced;
    assert.equal(f.count(), f.expected(0));
  });

  test(`${kind}: changing account, logout and same-account re-login immediately clear badges and reject late writes`, async t => {
    const f = fixture(kind); t.after(() => f.store.$dispose());
    const first = f.store.refresh(); await tick(); f.calls[0].resolve(f.payload(3)); await first;
    const old = f.store.refresh({ force: true }); await tick();
    f.switchTo(2); assert.equal(f.count(), 0);
    const next = f.store.refresh(); await tick();
    f.calls[1].resolve(f.payload(99)); await old; assert.equal(f.count(), 0);
    f.calls[2].resolve(f.payload(1)); await next; assert.equal(f.count(), f.expected(1));
    f.switchTo(2); assert.equal(f.count(), 0);
    const relogin = f.store.refresh(); await tick(); assert.equal(f.calls.length, 4);
    f.calls[3].resolve(f.payload(2)); await relogin;
    f.switchTo(null); assert.equal(f.count(), 0);
    await f.store.refresh(); assert.equal(f.calls.length, 4);
  });

  test(`${kind}: normal token renewal keeps successful TTL, while network failure allows immediate retry`, async t => {
    const f = fixture(kind); t.after(() => f.store.$dispose());
    const first = f.store.refresh(); await tick(); f.calls[0].resolve(f.payload(2)); await first;
    f.identity.token = 'rotated-same-session'; await f.store.refresh();
    assert.equal(f.count(), f.expected(2)); assert.equal(f.calls.length, 1);
    f.advance(12000); const failed = f.store.refresh(); await tick();
    f.calls[1].reject(Error('temporary network failure')); await failed;
    assert.equal(f.count(), f.expected(2));
    const retry = f.store.refresh(); await tick(); assert.equal(f.calls.length, 3);
    f.calls[2].resolve(f.payload(3)); await retry;
    assert.equal(f.count(), f.expected(3));
  });

  test(`${kind}: denied account responses clear badges without blocking navigation or caching the failure`, async t => {
    const f = fixture(kind); t.after(() => f.store.$dispose());
    const first = f.store.refresh(); await tick(); f.calls[0].resolve(f.payload(3)); await first;
    const denied = f.store.refresh({ force: true }); await tick();
    f.calls[1].reject({ response: { status: 403 } }); await denied;
    assert.equal(f.count(), 0);
    const retry = f.store.refresh(); await tick(); assert.equal(f.calls.length, 3);
    f.calls[2].resolve(f.payload(1)); await retry;
  });
}

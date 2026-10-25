const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

function load(env, storage) {
  const mod = { exports: {} };
  const source = readFileSync(join(__dirname, '../src/utils/api.ts'), 'utf8').replaceAll('import.meta.env', 'env');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('module', 'exports', 'env', 'localStorage', code)(mod, mod.exports, env, storage);
  return mod.exports;
}
test('Pages production never reads stored overrides; API, SSE and uploads use deployment backend', () => {
  let reads = 0;
  const api = load({ DEV: false, VITE_API_BASE_URL: 'https://deployment.example/api/', BASE_URL: '/chatforum-web/' },
    { getItem() { reads++; return 'https://untrusted.example/api'; } });
  assert.equal(reads, 0); assert.equal(api.CONNECTION_SETTINGS_ENABLED, false);
  assert.equal(api.API_BASE, 'https://deployment.example/api');
  assert.equal(api.apiUrl('/auth/login'), 'https://deployment.example/api/auth/login');
  assert.equal(api.apiUrl('/chat/runs/fixture/events'), 'https://deployment.example/api/chat/runs/fixture/events');
  assert.equal(api.mediaUrl('/uploads/avatar.png'), 'https://deployment.example/uploads/avatar.png');
});
test('Docker production uses same-origin /api without consulting browser storage', () => {
  const api = load({ DEV: false, BASE_URL: '/' }, { getItem() { throw Error('Must not access storage'); } });
  assert.equal(api.apiUrl('/auth/register'), '/api/auth/register');
  assert.equal(api.CONNECTION_SETTINGS_ENABLED, false);
});
test('development retains its local override and debug flag', () => {
  const api = load({ DEV: true, VITE_API_BASE_URL: 'https://deployment.example/api' }, { getItem(key) {
    assert.equal(key, 'chatforum-api-base'); return 'http://127.0.0.1:3000/api/';
  } });
  assert.equal(api.API_BASE, 'http://127.0.0.1:3000/api'); assert.equal(api.CONNECTION_SETTINGS_ENABLED, true);
});
test('development with unavailable/empty browser storage keeps its configured default', () => {
  for (const storage of [{ getItem() { throw Error('Storage disabled'); } }, { getItem() { return null; } }]) {
    assert.equal(load({ DEV: true, VITE_API_BASE_URL: 'https://dev.example/api' }, storage).API_BASE, 'https://dev.example/api');
    assert.equal(load({ DEV: true }, storage).API_BASE, '/api');
  }
});

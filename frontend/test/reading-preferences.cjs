const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(readFileSync(join(__dirname, '../src/utils/reading-preferences.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(mod, mod.exports);
const { READING_FONT_OPTIONS, readReadingFont, saveReadingFont, readingFontStyle } = mod.exports;
function storage() {
  const values = new Map(), calls = [];
  return { values, calls, getItem(key) { calls.push(['read', key]); return values.get(key) ?? null; },
    setItem(key, value) { calls.push(['write', key, value]); values.set(key, value); },
    removeItem(key) { calls.push(['remove', key]); values.delete(key); } };
}

test('standard typography has no overrides; only three whitelisted scales exist', () => {
  assert.deepEqual(READING_FONT_OPTIONS.map(option => option.value), ['standard', 'large', 'larger']);
  assert.deepEqual(readingFontStyle('standard'), {});
  assert.deepEqual(readingFontStyle('large'), { '--reading-body-size': '17px', '--reading-comment-size': '16px' });
  assert.deepEqual(readingFontStyle('larger'), { '--reading-body-size': '19px', '--reading-comment-size': '18px' });
});

test('preferences survive reload-style reads and are isolated by numeric account ID', () => {
  const s = storage();
  assert.equal(readReadingFont(7, s), 'standard');
  assert.equal(saveReadingFont(7, 'larger', s), true);
  assert.equal(readReadingFont(7, s), 'larger');
  assert.equal(readReadingFont(8, s), 'standard');
  saveReadingFont(8, 'large', s); saveReadingFont(7, 'standard', s);
  assert.equal(readReadingFont(7, s), 'standard'); assert.equal(readReadingFont(8, s), 'large');
  assert.deepEqual([...s.values.entries()], [['chatforum-reading-font-v1:8', 'large']]);
});

test('invalid IDs and arbitrary persisted content cannot inject font CSS or access other storage', () => {
  const s = storage();
  for (const id of [undefined, null, 0, -1, NaN, Infinity, 1.5, '7', {}, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(readReadingFont(id, s), 'standard'); assert.equal(saveReadingFont(id, 'large', s), false);
  }
  assert.deepEqual(s.calls, []);
  for (const value of ['large; color:red', '19px', '{"font":"large"}', '<script>', '', null, {}, 'LARGE']) {
    s.values.set('chatforum-reading-font-v1:7', value);
    assert.equal(readReadingFont(7, s), 'standard');
    assert.equal(saveReadingFont(7, value, s), false);
  }
});

test('disabled/quota-limited storage fails closed without breaking current-page rendering', () => {
  const blocked = { getItem() { throw Error('Blocked'); }, setItem() { throw Error('Quota'); }, removeItem() { throw Error('Blocked'); } };
  assert.equal(readReadingFont(7, blocked), 'standard');
  assert.equal(saveReadingFont(7, 'large', blocked), false);
  assert.equal(saveReadingFont(7, 'standard', blocked), false);
  assert.deepEqual(readingFontStyle('large'), { '--reading-body-size': '17px', '--reading-comment-size': '16px' });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  try {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw Error('Privacy mode'); } });
    assert.equal(readReadingFont(7), 'standard'); assert.equal(saveReadingFont(7, 'large'), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete globalThis.localStorage;
  }
});

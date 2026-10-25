const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const moduleResult = { exports: {} };
const compiled = ts.transpileModule(readFileSync(require('node:path').join(__dirname, '../src/utils/chat-model-selection.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
new Function('module', 'exports', compiled)(moduleResult, moduleResult.exports);
const { selectedChatModel } = moduleResult.exports;
test('disabled cached DeepSeek selections use the same Qwen ID for display and sending', () => {
  const models = [{ id: 'deepseek-v4-pro', available: false }, { id: 'qwen3.8-max', available: true }];
  assert.equal(selectedChatModel(models, 'qwen3.8-max', 'deepseek-v4-pro', 'deepseek-v4-pro'), 'qwen3.8-max');
  assert.equal(selectedChatModel(models, 'qwen3.8-max'), 'qwen3.8-max');
  assert.equal(selectedChatModel(models, 'qwen3.8-max', 'client-unknown'), 'qwen3.8-max');
});
test('an explicitly enabled model choice remains supported, and an unavailable default is not silently substituted', () => {
  const models = [{ id: 'deepseek-v4-pro', available: true }, { id: 'qwen3.8-max', available: false }];
  assert.equal(selectedChatModel(models, 'qwen3.8-max', 'deepseek-v4-pro'), 'deepseek-v4-pro');
  assert.equal(selectedChatModel(models, 'qwen3.8-max'), 'qwen3.8-max');
});

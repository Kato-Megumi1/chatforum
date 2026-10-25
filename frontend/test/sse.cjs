const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const mod = { exports: {} };
const source = ts.transpileModule(readFileSync(join(__dirname, '../src/utils/sse.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', source)(mod, mod.exports);
const { readSse } = mod.exports;

test('SSE preserves Chinese/emoji split across every byte, CRLF, IDs and multiple data lines', async () => {
  const bytes = new TextEncoder().encode(': keepalive\r\nevent: delta\r\nid: 4\r\ndata: 你好🌸\r\ndata: 第二行\r\n\r\nevent: complete\ndata: {}\n\n');
  const stream = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const frames = []; for await (const frame of readSse(stream)) frames.push(frame);
  assert.deepEqual(frames, [{ event: 'delta', id: '4', data: '你好🌸\n第二行' }, { event: 'complete', id: undefined, data: '{}' }]);
});
test('truncated frame is not committed, allowing reconnect from the last delivered offset', async () => {
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"未完成')); c.close(); } });
  const frames = []; for await (const frame of readSse(stream)) frames.push(frame);
  assert.deepEqual(frames, []);
});
test('leaving the iterator cancels its underlying network reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: delta\ndata: {}\n\n')); }, cancel() { cancelled = true; } });
  for await (const frame of readSse(stream)) { assert.equal(frame.event, 'delta'); break; }
  assert.equal(cancelled, true);
});

// Run from backend's working directory, preferably inside the release Docker image:
// node /tmp/check-runtime-security.cjs
// Uses only synthetic files. Never reads application configuration or connects to a DB/model.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { join } = require('node:path');
const runtimeRequire = createRequire(join(process.cwd(), 'package.json'));
let phase = 'dependency-versions';

async function main() {
  const sharp = runtimeRequire('sharp'), proxyAddr = runtimeRequire('proxy-addr');
  let handlebars;
  try { handlebars = runtimeRequire('handlebars'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  assert.equal(sharp.versions.sharp, '0.35.5');
  assert.equal(runtimeRequire('proxy-addr/package.json').version, '2.0.8');
  if (handlebars) assert.equal(handlebars.VERSION, '4.7.10');
  assert.equal(proxyAddr.compile('::ffff:10.0.0.0/8')('203.0.113.10', 0), false);
  assert.equal(proxyAddr.compile('loopback')('127.0.0.1', 0), true);
  if (handlebars) assert.equal(handlebars.compile('Hello {{name}}')({ name: '<script>' }), 'Hello &lt;script&gt;');

  const { parseAttachment } = runtimeRequire(join(process.cwd(), 'dist/src/modules/coding/attachment-parser.js'));
  phase = 'raster-processing';
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#ee6688' } }).png().toBuffer();
  const jpeg = await parseAttachment({ operation: 'render', kind: 'image', data: png });
  assert.equal((await sharp(Buffer.from(jpeg.data)).metadata()).format, 'jpeg');
  await assert.rejects(parseAttachment({ operation: 'extract', kind: 'image',
    data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>') }));

  const text = '合成文档安全回归\nThis document is synthetic. 42';
  phase = 'docx-roundtrip';
  const docx = await parseAttachment({ operation: 'export', kind: 'docx', text });
  assert.equal(Buffer.from(docx.data).subarray(0, 2).toString(), 'PK');
  const word = await parseAttachment({ operation: 'extract', kind: 'docx', data: Buffer.from(docx.data) });
  assert.match(word.text, /合成文档安全回归/);

  phase = 'pdf-export';
  const pdf = await parseAttachment({ operation: 'export', kind: 'pdf', text });
  assert.equal(Buffer.from(pdf.data).subarray(0, 5).toString(), '%PDF-');
  phase = 'pdf-extract';
  const document = await parseAttachment({ operation: 'extract', kind: 'pdf', data: Buffer.from(pdf.data) });
  assert.equal(document.pageCount, 1); assert.match(document.text, /42/);
  phase = 'pdf-render';
  const page = await parseAttachment({ operation: 'render', kind: 'pdf', data: Buffer.from(pdf.data), page: 1 });
  assert.equal(Buffer.from(page.data).subarray(1, 4).toString(), 'PNG');
  phase = 'pdf-page-bounds';
  await assert.rejects(parseAttachment({ operation: 'render', kind: 'pdf', data: Buffer.from(pdf.data), page: 2 }));
  console.log(JSON.stringify({ ok: true, node: process.version, proxyAddr: '2.0.8', sharp: sharp.versions.sharp,
    librsvg: sharp.versions.rsvg, handlebars: handlebars?.VERSION || 'not-installed-in-runtime',
    checks: ['proxy-trust', handlebars ? 'template-escaping' : 'template-not-shipped', 'raster-processing', 'svg-rejected', 'docx-roundtrip', 'pdf-roundtrip', 'pdf-render', 'pdf-page-bounds'] }));
}
main().catch(error => {
  // Do not dump document contents or arbitrary worker error text.
  console.error(JSON.stringify({ ok: false, phase, failure: error?.name || 'RuntimeCompatibilityError', code: error?.code }));
  process.exitCode = 1;
});

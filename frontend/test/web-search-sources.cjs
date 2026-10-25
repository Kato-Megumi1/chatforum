const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', compile(readFileSync(join(__dirname, '../src/utils/web-search-sources.ts'), 'utf8')))(mod, mod.exports);
const { publicWebSourceUrl, webSearchSourceView } = mod.exports;
const source = (url = 'https://www.tju.edu.cn/news/fixture', more = {}) => ({ title: 'Synthetic source', url,
  snippet: 'Synthetic snippet', engine: 'Synthetic engine', retrievedAt: '2026-10-19T04:00:00.000Z', ...more });

test('public links use only absolute HTTP(S), no credentials, controls or local hostnames', () => {
  for (const url of ['https://www.tju.edu.cn/news?q=fixture#chapter', 'https://example.com/',
    'http://8.8.8.8/', 'https://[2606:4700:4700::1111]/']) assert.equal(publicWebSourceUrl(url), new URL(url).href);
  for (const url of [undefined, null, {}, '/relative', '//example.com', 'javascript:alert(1)', 'data:text/html,x',
    'file:///C:/private.txt', 'ftp://example.com/', 'https://user:secret@example.com/', 'https://example.com\n.evil/',
    'https://localhost/', 'https://LOCALHOST./', 'https://api.localhost/', 'http://%6cocalhost/',
    'http://intranet/', 'http://router.lan/', 'http://service.internal/', 'https://host.local/',
    'https://example.com/' + 'x'.repeat(4096)]) assert.equal(publicWebSourceUrl(url), undefined, String(url));
});

test('private, loopback, link-local, CGNAT and reserved IP encodings cannot become source links', () => {
  for (const host of ['0.0.0.0', '10.12.0.3', '127.0.0.1', '127.1', '2130706433', '0x7f000001',
    '0177.0.0.1', '0x7f.1', '100.64.1.1', '169.254.169.254', '172.16.2.3', '172.31.255.255',
    '192.168.1.1', '192.0.0.1', '192.0.2.1', '198.18.1.1', '198.51.100.1', '203.0.113.1',
    '224.0.0.1', '255.255.255.255', '[::]', '[::1]', '[fd00::1]', '[fe80::1]', '[ff02::1]',
    '[::ffff:127.0.0.1]', '[::ffff:a00:1]', '[2001:db8::1]', '[2002:7f00:1::]']) {
    assert.equal(publicWebSourceUrl('https://' + host + '/'), undefined, host);
  }
});

test('enabled alone and empty results never claim that a search was performed', () => {
  for (const value of [undefined, {}, { enabled: true }, { enabled: true, sources: [] },
    { enabled: false, sources: [source()], failure: 'SEARCH_UNAVAILABLE' },
    { enabled: true, sources: [source('javascript:alert(1)')] },
    { enabled: true, sources: [], failure: 'UNTRUSTED_ERROR_MESSAGE' }]) {
    assert.deepEqual(webSearchSourceView(value), { sources: [], failed: false, visible: false });
  }
});

test('actual partial and complete search failures remain explicit without arbitrary error text', () => {
  assert.deepEqual(webSearchSourceView({ enabled: true, sources: [], failure: 'SEARCH_UNAVAILABLE', error: 'PRIVATE_ERROR' }),
    { sources: [], failed: true, visible: true });
  const partial = webSearchSourceView({ enabled: true, sources: [source(), source('http://127.0.0.1/')], failure: 'SEARCH_UNAVAILABLE' });
  assert.equal(partial.failed, true); assert.equal(partial.visible, true); assert.equal(partial.sources.length, 1);
  assert.doesNotMatch(JSON.stringify(partial), /127\.0\.0\.1|PRIVATE_ERROR/);
});

test('source presentation is bounded, deduplicated and never mutates stored metadata', () => {
  const metadata = { enabled: true, sources: [source(), source(), ...Array.from({ length: 50 }, (_, i) => source('https://example.com/' + i))] };
  const before = structuredClone(metadata), view = webSearchSourceView(metadata);
  assert.equal(view.sources.length, 32); assert.equal(new Set(view.sources.map(item => item.url)).size, 32);
  assert.deepEqual(metadata, before);
  const cleaned = webSearchSourceView({ enabled: true, sources: [source(undefined, {
    title: 'X'.repeat(1000), snippet: 'Y'.repeat(2000), engine: 'Z'.repeat(100), retrievedAt: 'PRIVATE_NOT_A_DATE',
    reasoning: 'PRIVATE_REASONING', password: 'PRIVATE_PASSWORD',
  })] });
  assert.equal(cleaned.sources[0].title.length, 300); assert.equal(cleaned.sources[0].snippet.length, 600);
  assert.equal(cleaned.sources[0].engine.length, 40); assert.equal(cleaned.sources[0].retrievedAt, '');
  assert.doesNotMatch(JSON.stringify(cleaned), /PRIVATE_/);
});

const componentSource = readFileSync(join(__dirname, '../src/components/WebSearchSources.vue'), 'utf8');
const compiler = require('@vue/compiler-sfc');
const compiledComponent = compiler.compileScript(compiler.parse(componentSource).descriptor, { id: 'web-sources-fixture', inlineTemplate: true });
const componentModule = { exports: {} };
new Function('module', 'exports', 'require', compile(compiledComponent.content))(componentModule, componentModule.exports, name => {
  if (name === 'vue') return require('vue');
  if (name === '@/utils/web-search-sources') return mod.exports;
  throw Error('Unexpected component import ' + name);
});
const render = metadata => require('@vue/server-renderer').renderToString(require('vue').createSSRApp(componentModule.exports.default, { metadata }));

test('rendered sources use a native disclosure, safe external anchors and escaped plain text', async () => {
  const html = await render({ enabled: true, sources: [source(undefined, {
    title: '<img src=x onerror=alert(1)>', snippet: '<script>PRIVATE_MARKUP</script>', engine: '<b>fixture</b>',
  }), source('http://127.0.0.1/private')] });
  assert.match(html, /<details/); assert.match(html, /<summary/); assert.match(html, /联网来源 1/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /&lt;script&gt;PRIVATE_MARKUP&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|127\.0\.0\.1/);
  assert.doesNotMatch(componentSource, /v-html|favicon|<img|fetch\(|request\./);
});

test('rendered failure hints distinguish no usable results from partial results', async () => {
  const none = await render({ enabled: true, sources: [], failure: 'SEARCH_UNAVAILABLE' });
  assert.match(none, /联网搜索暂不可用/); assert.doesNotMatch(none, /联网来源/);
  const partial = await render({ enabled: true, sources: [source()], failure: 'SEARCH_UNAVAILABLE' });
  assert.match(partial, /联网来源 1/); assert.match(partial, /部分联网搜索失败/);
  const empty = await render({ enabled: true, sources: [] });
  assert.doesNotMatch(empty, /联网来源|联网搜索暂不可用/);
});

test('only ordinary answers display web metadata, separately from original novel citations', () => {
  const chat = readFileSync(join(__dirname, '../src/views/Chat.vue'), 'utf8');
  assert.match(chat, /<WebSearchSources v-if="isAssistant && msg\.role === 'assistant' && !msg\.pending" :metadata="msg\.ragMetadata\?\.webSearch"/);
  assert.match(chat, /<RagEvidence v-if="msg\.role === 'assistant'" :metadata="msg\.ragMetadata"/);
  assert.match(componentSource, /prefers-reduced-motion:reduce/); assert.match(componentSource, /summary:focus-visible/);
});

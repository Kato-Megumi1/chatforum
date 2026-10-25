const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path');
const ts = require('typescript'), { parse } = require('@vue/compiler-sfc'), { baseParse } = require('@vue/compiler-dom');

// Execute the actual component functions with synthetic HTTP. No production data or model calls.
function component(file, names, imports, props) {
  const source = readFileSync(join(__dirname, '../src/' + file), 'utf8');
  const { descriptor, errors } = parse(source); assert.deepEqual(errors, []);
  const script = descriptor.scriptSetup.content;
  const code = ts.transpileModule(script + '\nexport {' + names.join(',') + '};', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'defineProps', code)(name => {
    if (Object.hasOwn(imports, name)) return imports[name]; throw new Error('Unexpected import ' + name);
  }, mod, mod.exports, () => props);
  const elements = [], texts = [];
  function visit(node) {
    if (node.type === 1) elements.push(node);
    if (node.type === 2) texts.push(node.content);
    if (node.type === 5) texts.push(node.content.content);
    for (const child of node.children || []) visit(child);
  }
  visit(baseParse(descriptor.template.content));
  return { ...mod.exports, elements, texts, script };
}
const vue = {
  ref: value => ({ value }), computed: getter => ({ get value() { return getter(); } }),
  onMounted() {}, onUnmounted() {},
};
const attr = (node, name) => node.props.find(prop => prop.type === 6 && prop.name === name)?.value?.content;
function library() {
  const calls = [], confirmations = [], notices = [];
  let cancelConfirmation = false;
  const books = ['READ', 'WRITE', 'ADMIN'].map((permission, i) => ({
    id: i + 11, name: 'Synthetic ' + permission, permission, documents: [], activeIndexVersion: 2,
  }));
  const request = {
    async get(path) {
      calls.push({ method: 'get', path });
      if (path === '/rag/knowledge-bases') return books;
      if (/\/indexes$/.test(path)) return [{ version: 2, status: 'ACTIVE' }];
      throw new Error('Unexpected HTTP read ' + path);
    },
    async post(path, body) { calls.push({ method: 'post', path, body }); return {}; },
  };
  const f = component('views/KnowledgeBase.vue', ['load', 'books', 'indexes', 'loading', 'build', 'activate'], {
    vue, '@/utils/request': request, '@/utils/api': { apiUrl: path => '/api' + path },
    '@/stores/user': { useUserStore: () => ({ token: 'synthetic-only' }) }, '@/components/RagEvidence.vue': {},
    'element-plus': {
      ElMessage: Object.fromEntries(['success', 'error', 'warning'].map(kind => [kind, text => notices.push({ kind, text })])),
      ElMessageBox: { async confirm(message, title) {
        confirmations.push({ message, title }); if (cancelConfirmation) throw new Error('Synthetic cancel');
      } },
    },
  });
  return { ...f, calls, confirmations, notices, cancel(value) { cancelConfirmation = value; } };
}
function evidence(metadata, rejectSource = false) {
  const calls = [], record = { content: 'Synthetic source excerpt', documentVersion: 1, indexVersion: 2 };
  const f = component('components/RagEvidence.vue', ['stateLabel', 'openSource', 'source', 'visible', 'loading'], {
    vue, '@/utils/request': { async get(path) {
      calls.push(path); if (rejectSource) throw new Error('Synthetic ACL denial'); return record;
    } },
  }, { metadata });
  return { ...f, calls, record };
}

test('novel library initialization no longer requests review history for READ, WRITE or ADMIN', async () => {
  const f = library(); await f.load();
  assert.deepEqual(f.books.value.map(book => book.permission), ['READ', 'WRITE', 'ADMIN']);
  assert.deepEqual(f.calls.map(call => call.path).sort(), [
    '/rag/knowledge-bases', '/rag/knowledge-bases/12/indexes', '/rag/knowledge-bases/13/indexes',
  ]);
  assert.equal(f.indexes.value[11], undefined, 'Readers still do not request index administration');
  assert.equal(f.indexes.value[12][0].version, 2); assert.equal(f.indexes.value[13][0].version, 2);
  assert.equal(f.loading.value, false);
});

test('library removes only the review tab and actions while preserving evidence and administration', () => {
  const f = library(), tabs = f.elements.filter(node => node.tag === 'el-tab-pane').map(node => attr(node, 'label'));
  assert(!tabs.includes('原文复核'));
  for (const tab of ['原文版本', '检索预览', '人物与场景图谱', '索引发布', '访问权限']) assert(tabs.includes(tab), tab);
  assert(f.elements.some(node => node.tag === 'RagEvidence'), 'Graph facts retain their source component');
  const script = ts.createSourceFile('KnowledgeBase.ts', f.script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functions = script.statements.filter(ts.isFunctionDeclaration).map(node => node.name?.text);
  assert(!functions.includes('loadReviews')); assert(!functions.includes('resolve'));
  assert(!f.texts.join(' ').includes('填写复核结论'));
});

test('index build and publication still require confirmation, and cancellation performs no writes', async () => {
  const f = library(); f.cancel(true); await f.build(12); await f.activate(13, 2);
  assert.equal(f.confirmations.length, 2); assert.deepEqual(f.calls, []);
  f.cancel(false); await f.build(12); await f.activate(13, 2);
  assert.deepEqual(f.calls.filter(call => call.method === 'post').map(call => call.path), [
    '/rag/knowledge-bases/12/reindex', '/rag/knowledge-bases/13/indexes/2/activate',
  ]);
  assert.equal(f.confirmations.length, 4);
  assert(f.calls.every(call => !call.path.includes('/reviews')));
});

test('historical needs_review still conveys uncertainty without pointing to the removed progress page', () => {
  const f = evidence({ state: 'needs_review', reviewTaskId: 123, citations: [] });
  assert.equal(f.stateLabel.value, '部分细节待确认');
  assert(f.texts.join(' ').includes('有些细节尚未确认'));
  assert(!f.texts.join(' ').includes('可在小说库中查看进度'));
  assert(!f.texts.join(' ').includes('reviewTaskId'), 'Old stored task IDs are not rendered as a dead UI entry');
  assert(f.elements.some(node => node.tag === 'details'), 'Answer evidence remains available');
  assert(f.elements.some(node => node.tag === 'el-dialog' && attr(node, 'title') === '原文依据'));
});

test('source opening still uses the authenticated ID-based citation path, never a supplied URL', async () => {
  const f = evidence({ state: 'grounded', knowledgeBaseId: 11, citations: [{ label: 1, chunkId: 'synthetic-chunk' }] });
  await f.openSource({ label: 1, chunkId: 'synthetic-chunk', url: 'https://invalid.example/ignored' });
  assert.deepEqual(f.calls, ['/rag/knowledge-bases/11/citations/synthetic-chunk']);
  assert.equal(f.source.value, f.record); assert.equal(f.visible.value, true); assert.equal(f.loading.value, false);
  const denied = evidence({ state: 'needs_review', knowledgeBaseId: 11 }, true);
  await denied.openSource({ label: 1, chunkId: 'withdrawn-chunk' });
  assert.deepEqual(denied.calls, ['/rag/knowledge-bases/11/citations/withdrawn-chunk']);
  assert.equal(denied.source.value, null); assert.equal(denied.loading.value, false);
  assert(denied.elements.some(node => node.tag === 'el-alert'
    && attr(node, 'title') === '引用暂不可访问'));
});

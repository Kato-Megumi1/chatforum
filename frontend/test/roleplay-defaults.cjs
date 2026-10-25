const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const mod = { exports: {} };
new Function('module', 'exports', ts.transpileModule(readFileSync(join(__dirname, '../src/utils/roleplay-defaults.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(mod, mod.exports);
const { ensureConversationSettings, defaultKatoKnowledgeBaseId } = mod.exports;
const { reactive, computed, isReactive } = require('vue');
const kato = { conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona' };
const canonical = (id, more = {}) => ({ id, name: '路人女主 · 加藤惠的原作记忆', chatReady: true, ...more });
const original = (id, more = {}) => ({ id, name: '重新命名的小说原文库', chatReady: true,
  documents: [{ fileName: '不起眼女主角培育法(路人女主的养成方法).epub', isCurrent: true, status: 'COMPLETED' }], ...more });

test('first-use defaults remain reactive when asynchronous selection and manual choices change fields', () => {
  const records = reactive({});
  const selected = computed(() => ensureConversationSettings(records, 81, kato).knowledgeBaseId);
  assert.equal(selected.value, 0);
  assert(isReactive(ensureConversationSettings(records, 81, kato)));
  records[81].knowledgeBaseId = 73;
  assert.equal(selected.value, 73);
  records[81].knowledgeBaseId = 0;
  records[81].katoDefaultKnowledgePending = false;
  assert.equal(selected.value, 0);
  const mode = computed(() => ensureConversationSettings(records, 82, kato).agentMode);
  assert.equal(mode.value, 'agent');
  records[82].agentMode = 'normal';
  assert.equal(mode.value, 'normal');
});

test('new server-confirmed Kato conversation starts Agent with one pending source selection', () => {
  const records = {}, created = ensureConversationSettings(records, 71, kato);
  assert.equal(created.agentMode, 'agent');
  assert.equal(created.knowledgeBaseId, 0);
  assert.equal(created.katoDefaultKnowledgePending, true);
  assert.strictEqual(created, records[71]);
});

test('existing manual mode and no-library choices survive re-entry and refreshed identities', () => {
  const manual = { agentMode: 'normal', selectedPersona: '', customPersonaName: '', customPersonaPrompt: '', knowledgeBaseId: 0 };
  const records = { 71: manual };
  assert.strictEqual(ensureConversationSettings(records, 71, kato), manual);
  assert.deepEqual(manual, { agentMode: 'normal', selectedPersona: '', customPersonaName: '', customPersonaPrompt: '', knowledgeBaseId: 0 });
  const selected = ensureConversationSettings(records, 72, kato);
  selected.agentMode = 'normal'; selected.knowledgeBaseId = 593; selected.katoDefaultKnowledgePending = false;
  assert.strictEqual(ensureConversationSettings(records, 72, kato), selected);
  assert.equal(selected.knowledgeBaseId, 593); assert.equal(selected.katoDefaultKnowledgePending, false);
});

test('assistant, other roleplay, legacy and unknown identities remain normal without Kato source defaults', () => {
  for (const identity of [undefined, null, {}, { conversationType: 'ASSISTANT', personaKey: kato.personaKey },
    { conversationType: 'ROLEPLAY', personaKey: 'eriri_persona' }, { conversationType: 'ROLEPLAY' },
    { conversationType: 'LEGACY', personaKey: kato.personaKey }]) {
    const records = {}, created = ensureConversationSettings(records, 1, identity);
    assert.equal(created.agentMode, 'normal'); assert.equal(created.knowledgeBaseId, 0);
    assert.equal(created.katoDefaultKnowledgePending, undefined);
  }
  const records = {}, previous = ensureConversationSettings(records, 1);
  assert.strictEqual(ensureConversationSettings(records, 1, kato), previous);
  assert.equal(previous.agentMode, 'normal');
});

test('preferred canonical name is normalized and selected independently of list order or unrelated libraries', () => {
  const preferred = canonical(4892, { name: '  路人女主 ・ 加藤惠的原作记忆  ' });
  const unrelated = { id: 1, name: '其它小说', chatReady: true }, renamed = original(658);
  for (const books of [[unrelated, renamed, preferred], [preferred, renamed, unrelated], [renamed, preferred]]) {
    assert.equal(defaultKatoKnowledgeBaseId(books), 4892);
  }
});

test('only accessible ready libraries from the supplied list are eligible; no hard-coded or first-ID fallback', () => {
  assert.equal(defaultKatoKnowledgeBaseId([]), undefined);
  assert.equal(defaultKatoKnowledgeBaseId([{ id: 1, name: '其它小说', chatReady: true }]), undefined);
  assert.equal(defaultKatoKnowledgeBaseId([canonical(7, { chatReady: false }), canonical(8, { chatReady: undefined })]), undefined);
  assert.equal(defaultKatoKnowledgeBaseId([canonical(0), canonical(-1), canonical(1.5), canonical('7')]), undefined);
  assert.equal(defaultKatoKnowledgeBaseId([canonical(91, { chatReady: false }), original(412)]), 412);
  // The missing canonical library is not guessed from an earlier account's ID.
  assert.equal(defaultKatoKnowledgeBaseId([{ id: 91, name: '没有原作资料的库', chatReady: true }]), undefined);
});

test('unique recognizable names or current completed original-file metadata support renamed libraries', () => {
  assert.equal(defaultKatoKnowledgeBaseId([{ id: 88, name: '不起眼女主角：加藤惠原文', chatReady: true }]), 88);
  assert.equal(defaultKatoKnowledgeBaseId([original(265)]), 265);
  for (const documents of [
    [{ fileName: '路人女主.epub', isCurrent: false, status: 'COMPLETED' }],
    [{ fileName: '路人女主.epub', isCurrent: true, status: 'PENDING' }],
    [{ fileName: '无关.epub', isCurrent: true, status: 'COMPLETED' }],
  ]) assert.equal(defaultKatoKnowledgeBaseId([original(265, { documents })]), undefined);
});

test('ambiguous canonical names or fallback source candidates never depend on list ordering', () => {
  assert.equal(defaultKatoKnowledgeBaseId([canonical(7), canonical(8)]), undefined);
  assert.equal(defaultKatoKnowledgeBaseId([canonical(8), canonical(7), original(12)]), undefined);
  const named = { id: 88, name: '路人女主 加藤惠正史', chatReady: true };
  assert.equal(defaultKatoKnowledgeBaseId([named, original(265)]), undefined);
  assert.equal(defaultKatoKnowledgeBaseId([original(265), named]), undefined);
});

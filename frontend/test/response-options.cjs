const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const vue = require('vue'), pinia = require('pinia');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function loadFile(path, dependencies = {}) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'localStorage', 'sessionStorage', 'crypto', compile(readFileSync(join(__dirname, '../src/' + path), 'utf8')))(
    mod, mod.exports, name => {
      if (!Object.hasOwn(dependencies, name)) throw Error('Unexpected import ' + name); return dependencies[name];
    }, { getItem: () => null, setItem() {}, removeItem() {} }, { getItem: () => null, setItem() {}, removeItem() {} }, require('node:crypto').webcrypto);
  return mod.exports;
}
const defaults = loadFile('utils/roleplay-defaults.ts');

test('ordinary options persist independently while roleplay never enables deep thinking', () => {
  const records = {};
  const ordinary = defaults.ensureConversationSettings(records, 1, { conversationType: 'ASSISTANT' });
  const roleplay = defaults.ensureConversationSettings(records, 2, { conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona' });
  assert.equal(ordinary.deepThinking, true); assert.equal(ordinary.webSearch, false);
  assert.equal(roleplay.webSearch, false);
  ordinary.deepThinking = false; ordinary.webSearch = true;
  assert.deepEqual(defaults.conversationResponseOptions(ordinary), { deepThinking: false, webSearch: true });
  assert.deepEqual(defaults.conversationResponseOptions(roleplay, 'ROLEPLAY'), { deepThinking: false, webSearch: false });
  // Only per-conversation settings are persisted, not one shared global toggle.
  const restored = JSON.parse(JSON.stringify(records));
  assert.deepEqual(defaults.conversationResponseOptions(defaults.ensureConversationSettings(restored, 1)), { deepThinking: false, webSearch: true });
  assert.deepEqual(defaults.conversationResponseOptions(defaults.ensureConversationSettings(restored, 2), 'ROLEPLAY'), { deepThinking: false, webSearch: false });
});

test('old saved settings gain display/send defaults without overwriting their manual mode or source', () => {
  const old = { agentMode: 'normal', knowledgeBaseId: 0 }, before = structuredClone(old);
  const records = { 9: old };
  assert.strictEqual(defaults.ensureConversationSettings(records, 9), old);
  assert.deepEqual(defaults.conversationResponseOptions(old), { deepThinking: true, webSearch: false });
  assert.deepEqual(old, before);
  assert.deepEqual(defaults.conversationResponseOptions({ deepThinking: 'false', webSearch: 'true' }), { deepThinking: true, webSearch: false });
  for (const identity of ['ROLEPLAY', 'LEGACY', 'UNKNOWN'])
    assert.deepEqual(defaults.conversationResponseOptions({ deepThinking: true, webSearch: true }, identity), { deepThinking: false, webSearch: false });
});

function storeFixture() {
  const sent = [];
  const conversation = { id: 11, userId: 7, title: 'Synthetic', conversationType: 'ASSISTANT', personaKey: 'assistant' };
  const request = {
    async get(path) { return path.endsWith('/messages') ? [] : path === '/chat/conversations' ? [conversation] : {}; },
    async post(path, body) { if (path === '/chat/runs') { sent.push(body); return { id: 'synthetic-run' }; } return conversation; },
    async delete() {},
  };
  let watchRun = async () => ({ status: 'COMPLETED', result: { content: 'Synthetic answer', ragMetadata: {} } });
  const module = loadFile('stores/chat.ts', {
    pinia, vue, '@/utils/request': { default: request },
    '@/utils/chat-stream': { watchChatRun: (...args) => watchRun(...args) },
    '@/utils/local-workspace': { disconnectLocalWorkspace() {} },
    '@/utils/chat-navigation': loadFile('utils/chat-navigation.ts'),
    '@/utils/chat-files': { chatFileRef: file => ({ id: file.id, kind: file.kind, revision: file.revision }) },
    '@/utils/chat-model-selection': { selectedChatModel: () => 'qwen3.8-max' },
    '@/utils/roleplay-defaults': defaults,
    '@/utils/file-resume': loadFile('utils/file-resume.ts'),
  });
  pinia.setActivePinia(pinia.createPinia());
  const store = module.useChatStore(); store.currentConversation = conversation;
  return { store, sent, conversation, watch(handler) { watchRun = handler; } };
}

test('real store POST carries both booleans and ignores legacy implicit web_search skills', async () => {
  const f = storeFixture();
  await f.store.sendConfigured('Synthetic request', 'agent', ['forum_search', 'web_search', 'code_workspace']);
  assert.equal(f.sent[0].deepThinking, true); assert.equal(f.sent[0].webSearch, false);
  assert.deepEqual(f.sent[0].enabledSkills, ['forum_search', 'code_workspace']);
  assert.equal(f.sent[0].modelId, 'qwen3.8-max');
  f.store.saveConversationSettings(11, { deepThinking: false, webSearch: true });
  await f.store.sendConfigured('Synthetic follow-up', 'normal', []);
  assert.equal(f.sent[1].mode, 'normal'); assert.equal(f.sent[1].deepThinking, false); assert.equal(f.sent[1].webSearch, true);
  assert.deepEqual(f.sent[1].enabledSkills, []);
});

test('roleplay options are sent independently of tool mode and stay isolated on conversation switch', async () => {
  const f = storeFixture();
  f.store.currentConversation = { ...f.conversation, id: 12, conversationType: 'ROLEPLAY', personaKey: 'kato_megumi_persona' };
  // A stale saved value from the earlier UI must not re-enable roleplay thinking.
  f.store.saveConversationSettings(12, { deepThinking: true, webSearch: false });
  await f.store.sendConfigured('Synthetic roleplay', 'agent', ['web_search'], 'kato_megumi_persona', undefined, 73);
  assert.equal(f.sent[0].persona, 'kato_megumi_persona'); assert.equal(f.sent[0].knowledgeBaseId, 73);
  assert.equal(f.sent[0].deepThinking, false); assert.equal(f.sent[0].webSearch, false); assert.deepEqual(f.sent[0].enabledSkills, []);
  f.store.saveConversationSettings(12, { webSearch: true });
  await f.store.sendConfigured('Synthetic roleplay web', 'normal', [], 'kato_megumi_persona', undefined, 73);
  assert.equal(f.sent[1].deepThinking, false); assert.equal(f.sent[1].webSearch, false);
  f.store.currentConversation = f.conversation;
  await f.store.sendConfigured('Synthetic ordinary', 'normal', []);
  assert.equal(f.sent[2].deepThinking, true); assert.equal(f.sent[2].webSearch, false);
});

test('new settings remain within the existing account-reset and persistence boundary', () => {
  const f = storeFixture();
  f.store.saveConversationSettings(11, { deepThinking: false, webSearch: true });
  assert.equal(f.store.getConversationSettings(11).webSearch, true);
  f.store.resetForUser(); assert.deepEqual(f.store.conversationSettings, {});
  const source = readFileSync(join(__dirname, '../src/stores/chat.ts'), 'utf8');
  assert.match(source, /paths: \['conversationSettings', 'preferredModelId'\]/);
});

test('real settings computed values reject busy and roleplay deep-thinking changes', () => {
  const source = readFileSync(join(__dirname, '../src/views/Chat.vue'), 'utf8');
  const script = source.match(/const deepThinking = computed\([\s\S]*?(?=const selectedPersona = computed)/)[0];
  const settings = vue.reactive({}), uploadingFiles = vue.ref(false), draftDeepThinking = vue.ref(true), draftWebSearch = vue.ref(false);
  const chatStore = vue.reactive({ currentConversation: { id: 1, conversationType: 'ASSISTANT' }, isStreaming: false,
    getConversationSettings(id) { return defaults.ensureConversationSettings(settings, id, this.currentConversation); },
    saveConversationSettings(id, input) { Object.assign(this.getConversationSettings(id), input); },
  });
  const isAssistant = vue.computed(() => !chatStore.currentConversation || chatStore.currentConversation.conversationType === 'ASSISTANT');
  const isLegacy = vue.computed(() => chatStore.currentConversation?.conversationType === 'LEGACY');
  const mod = { exports: {} };
  new Function('module', 'exports', 'computed', 'chatStore', 'conversationResponseOptions', 'uploadingFiles', 'isAssistant', 'isLegacy',
    'draftDeepThinking', 'draftWebSearch', compile(script + '\nexport { deepThinking, webSearch };'))(
    mod, mod.exports, vue.computed, chatStore, defaults.conversationResponseOptions, uploadingFiles, isAssistant, isLegacy, draftDeepThinking, draftWebSearch);
  const { deepThinking, webSearch } = mod.exports;
  assert.equal(deepThinking.value, true); assert.equal(webSearch.value, false);
  deepThinking.value = false; webSearch.value = true;
  assert.deepEqual(defaults.conversationResponseOptions(settings[1]), { deepThinking: false, webSearch: true });
  for (const blocked of ['stream', 'upload']) {
    chatStore.isStreaming = blocked === 'stream'; uploadingFiles.value = blocked === 'upload';
    deepThinking.value = true; webSearch.value = false;
    assert.equal(deepThinking.value, false); assert.equal(webSearch.value, true);
  }
  chatStore.isStreaming = false; uploadingFiles.value = false;
  chatStore.currentConversation = { id: 2, conversationType: 'ROLEPLAY' };
  chatStore.saveConversationSettings(2, { deepThinking: true, webSearch: false });
  assert.equal(deepThinking.value, false); deepThinking.value = true; assert.equal(deepThinking.value, false);
  webSearch.value = true; assert.equal(webSearch.value, false);
  assert.equal(settings[1].webSearch, true); assert.equal(settings[1].deepThinking, false);
  chatStore.currentConversation = { id: 3, conversationType: 'LEGACY' };
  webSearch.value = true; assert.equal(webSearch.value, false); assert.equal(deepThinking.value, false);
});

test('ordinary answer-settings popover changes only explicit booleans and refuses busy updates', () => {
  const source = readFileSync(join(__dirname, '../src/components/AnswerPreferences.vue'), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const props = { deepThinking: true, webSearch: false, busy: false }, events = [], mod = { exports: {} };
  new Function('module', 'exports', 'require', 'defineProps', 'defineEmits', compile(script + '\nexport { set };'))(
    mod, mod.exports, name => name === 'vue' ? vue : {}, () => props, () => (...args) => events.push(args));
  mod.exports.set('deepThinking', false); assert.deepEqual(events.pop(), ['update:deepThinking', false]);
  mod.exports.set('webSearch', true); assert.deepEqual(events.pop(), ['update:webSearch', true]);
  assert.deepEqual(props, { deepThinking: true, webSearch: false, busy: false }, 'Control emits without mutating the other option');
  mod.exports.set('deepThinking', 'false'); mod.exports.set('webSearch', 1); assert.equal(events.length, 0);
  props.busy = true; mod.exports.set('deepThinking', false); mod.exports.set('webSearch', true); assert.equal(events.length, 0);
  assert.match(source, /aria-label="回答设置"/);
  assert.match(source, /aria-label="本次会话的回答设置"/);
  assert.match(source, /aria-label="深度思考" :disabled="busy"/);
  assert.match(source, /aria-label="联网搜索" :disabled="busy"/);
  assert.match(source, /模型设置/);
  assert.match(source, /@media\(max-width:900px\)/);
});

test('ordinary options use one settings popover, roleplay has no deep control, and model selection stays in the drawer', () => {
  const composer = readFileSync(join(__dirname, '../src/components/AssistantComposer.vue'), 'utf8');
  const chat = readFileSync(join(__dirname, '../src/views/Chat.vue'), 'utf8');
  assert.equal(/<ResponseOptions|composer-response-options|知识库|knowledgeBaseId/.test(composer), false, 'No standalone response-pill row or novel source control in ordinary composer');
  assert.equal(/<ResponseOptions|import ResponseOptions|ResponseOptions\.vue/.test(chat), false, 'Removed pill component cannot remain in chat');
  assert.equal((composer.match(/<AnswerPreferences/g) || []).length, 1, 'Exactly one compact answer-settings trigger');
  assert.match(composer, /<AnswerPreferences :deep-thinking="deepThinking" :web-search="webSearch" :busy="busy \|\| uploading \|\| removing"/);
  assert.equal(/<AnswerPreferences/.test(chat), false, 'Roleplay must not render the ordinary thinking popover');
  assert.equal(/设置中的对话模型/.test(composer), false);
  const drawer = chat.match(/<el-drawer v-model="showSettings"[\s\S]*?<\/el-drawer>/)[0];
  assert.match(drawer, /<div v-if="isAssistant" class="response-setting-row">[\s\S]*?深度思考/);
  assert.match(drawer, /<div v-if="isAssistant" class="response-settings">/);
  assert.match(drawer, /<el-switch v-model="deepThinking" aria-label="深度思考" :disabled="chatStore\.isStreaming \|\| uploadingFiles"/);
  assert.match(drawer, /<el-switch v-model="webSearch" aria-label="联网搜索" :disabled="chatStore\.isStreaming \|\| uploadingFiles"/);
  assert.match(drawer, /联网搜索/);
  assert.match(chat, /s\.name !== 'code_workspace' && s\.name !== 'web_search'/);
  assert.match(chat, /s !== 'code_workspace' && s !== 'web_search'/);
});

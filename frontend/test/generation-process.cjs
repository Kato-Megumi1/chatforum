const { test } = require('node:test'), assert = require('node:assert/strict');
const { readFileSync } = require('node:fs'), { join } = require('node:path'), ts = require('typescript');
const vue = require('vue');
const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const helperModule = { exports: {} };
new Function('module', 'exports', compile(readFileSync(join(__dirname, '../src/utils/generation-process.ts'), 'utf8')))(helperModule, helperModule.exports);
const { generationProcessView, generationSeconds } = helperModule.exports;
const fileResumeModule = { exports: {} };
new Function('module', 'exports', compile(readFileSync(join(__dirname, '../src/utils/file-resume.ts'), 'utf8')))(fileResumeModule, fileResumeModule.exports);
const resumePointer = { draftId: '39411c9b-62be-44da-b3bc-1eac374f3925', revision: 2, hash: 'a'.repeat(64) };

test('only received public phases, numeric timings and counts enter the process view', () => {
  const view = generationProcessView({ stage: 'generating', phase: 'retrieving', elapsedMs: 2000,
    firstTokenMs: null, phaseElapsedMs: 700, modelCalls: 3, activeModelCalls: 1, queueMs: 200,
    reasoning: 'SECRET_REASONING', system: 'SECRET_SYSTEM', description: 'SECRET_DESCRIPTION',
    phases: [{ phase: 'context', durationMs: 100, modelCalls: 0, content: 'SECRET_CONTENT' },
      { phase: 'unknown', durationMs: 900, text: 'SECRET_UNKNOWN' },
      { phase: 'retrieving', durationMs: 700, modelCalls: 3 },
      { phase: 'retrieving', durationMs: 999999, modelCalls: 999 },
      { phase: 'completed', durationMs: 2 }],
  }, true, 500);
  assert.equal(view.label, '检索原文'); assert.equal(view.description, undefined);
  assert.equal(view.elapsedMs, 2500); assert.equal(view.firstTokenMs, null);
  assert.equal(view.queueMs, 200); assert.equal(view.modelCalls, 3); assert.equal(view.activeModelCalls, 1);
  assert.deepEqual(view.phases, [
    { phase: 'context', label: '整理上下文', description: '读取本轮消息和最近对话，整理回答所需信息', durationMs: 100, modelCalls: 0, active: false },
    { phase: 'retrieving', label: '检索原文', description: '从当前有权限的资料中查找相关内容', durationMs: 1200, modelCalls: 3, active: true },
  ]);
  assert.doesNotMatch(JSON.stringify(view), /SECRET_|unknown|999999/);
});

test('legacy snapshots show their actual recorded stages, not an invented pipeline', () => {
  const view = generationProcessView({ stage: 'generating', elapsedMs: 5000, firstTokenMs: 4700,
    stages: [{ stage: 'preparing', durationMs: 800 }, { stage: 'generating', durationMs: 4200 }],
  }, true, 200);
  assert.deepEqual(view.phases.map(row => row.phase), ['context', 'generating']);
  assert.equal(view.phases[1].durationMs, 4400); assert.equal(view.firstTokenMs, 4700);
  assert.equal(view.modelCalls, null); assert.equal(view.queueMs, null);
  assert.equal(view.phases.some(row => ['retrieving', 'verifying'].includes(row.phase)), false);
});

test('missing or malformed progress cannot claim a stage or completion', () => {
  for (const source of [undefined, null, {}, [], { stage: 'untrusted label', elapsedMs: 1 },
    { phase: '__proto__', elapsedMs: 1 }, { stage: 'generating', elapsedMs: '50' },
    { stage: 'generating', elapsedMs: -1 }, { stage: 'generating', elapsedMs: Infinity }]) {
    const view = generationProcessView(source, true, 5000);
    assert.equal(view.hasProgress, false); assert.equal(view.label, '等待中');
    assert.equal(view.elapsedMs, null); assert.deepEqual(view.phases, []);
    assert.equal(view.modelCalls, null); assert.equal(view.activeModelCalls, null);
  }
});

test('bad detail values are discarded without interpolating strings or NaN', () => {
  const view = generationProcessView({ stage: 'tools', elapsedMs: 800, firstTokenMs: 900,
    phaseElapsedMs: 'INJECTED_TIME', modelCalls: 'INJECTED_COUNT', activeModelCalls: 1.1, queueMs: -3,
    phases: [{ phase: 'context', durationMs: NaN }, { phase: 'tools', durationMs: -1 },
      { phase: 'tools', durationMs: 100, modelCalls: -1 }],
  }, true, NaN);
  assert.equal(view.elapsedMs, 800); assert.equal(view.firstTokenMs, null);
  assert.equal(view.modelCalls, null); assert.equal(view.activeModelCalls, null); assert.equal(view.queueMs, null);
  assert.deepEqual(view.phases, [{ phase: 'tools', label: '处理任务', description: '执行已启用的工具并整理结果', durationMs: 100, modelCalls: null, active: true }]);
  assert.equal(generationSeconds(1234), '1.2'); assert.equal(generationSeconds(NaN), '0.0');
});

test('completed snapshots never tick or mark every earlier step successful', () => {
  const view = generationProcessView({ stage: 'completed', phase: 'completed', elapsedMs: 2300, firstTokenMs: 900,
    activeModelCalls: 4, phases: [{ phase: 'verifying', durationMs: 600, modelCalls: 1 }],
  }, true, 9000);
  assert.equal(view.elapsedMs, 2300); assert.equal(view.phases[0].durationMs, 600);
  assert.equal(view.phases[0].active, false); assert.equal(view.activeModelCalls, null);
  const stopped = generationProcessView({ stage: 'verifying', elapsedMs: 2300, stages: [] }, false);
  assert.equal(stopped.label, '已完成'); assert.equal(stopped.activeModelCalls, null);
  assert.equal(stopped.phases[0].active, false); assert.equal(stopped.phases[0].durationMs, null);
});

function componentFixture() {
  const source = readFileSync(join(__dirname, '../src/components/GenerationStatus.vue'), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1];
  const props = vue.reactive({ pending: true, progress: undefined, busy: false, allowThinking: false });
  const mounts = [], unmounts = [], timers = new Map(); let clock = 10000, nextTimer = 0;
  const imports = { vue: { ...vue, onMounted: fn => mounts.push(fn), onUnmounted: fn => unmounts.push(fn) },
    '@/utils/generation-process': helperModule.exports, '@/utils/file-resume': fileResumeModule.exports };
  const mod = { exports: {} }, scope = vue.effectScope();
  scope.run(() => new Function('require', 'module', 'exports', 'defineProps', 'defineEmits', 'Date', 'setInterval', 'clearInterval',
    compile(script + '\nexport { view, continuationLabel, resumeFile, statusLabel };'))(name => {
      if (!Object.hasOwn(imports, name)) throw Error('Unexpected import ' + name); return imports[name];
    }, mod, mod.exports, () => props, () => () => {}, { now: () => clock },
    fn => { const key = ++nextTimer; timers.set(key, fn); return key; }, key => timers.delete(key)));
  return { props, view: mod.exports.view, continuationLabel: mod.exports.continuationLabel, resumeFile: mod.exports.resumeFile, statusLabel: mod.exports.statusLabel, source, timers,
    mount: () => mounts.forEach(fn => fn()),
    advance: ms => { clock += ms; [...timers.values()].forEach(fn => fn()); },
    unmount: () => { unmounts.forEach(fn => fn()); scope.stop(); },
  };
}

test('component extends a pending sample, resets on server updates and freezes at pending end', async t => {
  const f = componentFixture(); t.after(f.unmount);
  assert.equal(f.timers.size, 0); f.mount();
  assert.equal(f.view.value.elapsedMs, null); assert.equal(f.view.value.phases.length, 0);
  f.props.progress = { stage: 'generating', elapsedMs: 1000, firstTokenMs: null, stages: [{ stage: 'generating', durationMs: 1000 }] };
  await vue.nextTick(); f.advance(1500); assert.equal(f.view.value.elapsedMs, 2500);
  f.props.progress = { stage: 'tools', elapsedMs: 3000, firstTokenMs: null, stages: [{ stage: 'tools', durationMs: 500 }] };
  await vue.nextTick(); assert.equal(f.view.value.elapsedMs, 3000);
  f.advance(1000); assert.equal(f.view.value.elapsedMs, 4000); assert.equal(f.timers.size, 1);
  f.props.pending = false; await vue.nextTick(); assert.equal(f.timers.size, 0);
  f.advance(90000); assert.equal(f.view.value.elapsedMs, 4000); assert.equal(f.view.value.label, '已完成');
  assert.equal(f.view.value.phases[0].active, false);
});

test('component releases its only timer on completion and unmount', async t => {
  const f = componentFixture(); t.after(f.unmount); f.mount();
  f.props.progress = { stage: 'completed', elapsedMs: 4000, firstTokenMs: 2000, stages: [] };
  await vue.nextTick(); assert.equal(f.timers.size, 0);
  f.advance(5000); assert.equal(f.view.value.elapsedMs, 4000);
  f.props.progress = { stage: 'generating', elapsedMs: 4100, firstTokenMs: 2000, stages: [] };
  await vue.nextTick(); assert.equal(f.timers.size, 1);
  f.unmount(); assert.equal(f.timers.size, 0);
});

test('incomplete file delivery offers regeneration while ordinary answer truncation offers continuation', async t => {
  const f = componentFixture(); t.after(f.unmount);
  f.props.generation = { truncated: true, canContinue: true };
  await vue.nextTick(); assert.equal(f.continuationLabel.value, '继续生成');
  f.props.generation = { truncated: true, canContinue: true, fileIncomplete: true, filePaths: ['demo.html'] };
  await vue.nextTick(); assert.equal(f.continuationLabel.value, '重新生成文件');
  f.props.pending = false; await vue.nextTick(); assert.equal(f.statusLabel.value, '文件未完成');
  assert.equal(f.resumeFile.value, undefined);
  f.props.generation.resumeFile = resumePointer; await vue.nextTick();
  assert.equal(f.continuationLabel.value, '继续完成文件'); assert.deepEqual(f.resumeFile.value, resumePointer);
  f.props.generation.resumeFile = { ...resumePointer, hash: 'INVALID' }; await vue.nextTick();
  assert.equal(f.continuationLabel.value, '重新生成文件'); assert.equal(f.resumeFile.value, undefined);
  f.props.generation.fileIncomplete = false; await vue.nextTick(); assert.equal(f.continuationLabel.value, '继续生成'); assert.equal(f.statusLabel.value, '已完成');
});

test('waiting and finished views share a keyboard-native disclosure with fixed text and reduced motion', () => {
  const f = componentFixture(); f.unmount();
  assert.match(f.source, /<details v-if="view\.phases\.length"/);
  assert.match(f.source, /v-else class="process-compact"/);
  assert.match(f.source, /<summary aria-label="处理过程">/);
  assert.match(f.source, /process-summary/); assert.match(f.source, /阶段累计用时/); assert.match(f.source, /总用时/);
  assert.doesNotMatch(f.source, /process-metrics|model-active|首段输出|次调用/);
  assert.match(f.source, /summary:focus-visible/); assert.match(f.source, /prefers-reduced-motion:reduce/);
  assert.doesNotMatch(f.source, /v-html|reasoning_content|chain_of_thought|思考链/);
  assert.match(f.source, /generation\?\.truncated && generation\?\.canContinue/);
  assert.match(f.source, /generation\?\.fileIncomplete && !resumeFile/);
  assert.match(f.source, /此回答未保留草稿，无法接着完成。/);
});

test('enabling deep thinking alone cannot claim the provider actually emitted reasoning', () => {
  const input = { phase: 'generating', stage: 'generating', elapsedMs: 1200, phaseElapsedMs: 1200,
    phases: [{ phase: 'generating', durationMs: 1200, modelCalls: 1 }],
    summary: 'SECRET_SUMMARY', description: 'SECRET_DESCRIPTION', reasoning_content: 'SECRET_REASONING' };
  const normal = generationProcessView(input, true, 0, false);
  const deep = generationProcessView(input, true, 0, true);
  assert.equal(normal.label, '生成回答'); assert.equal(normal.phases[0].description, '分析问题并组织回答');
  assert.equal(deep.label, '生成回答'); assert.equal(deep.phases[0].description, '分析问题并组织回答');
  assert.equal(generationProcessView(input, false, 0, true).label, '已完成');
  assert.doesNotMatch(JSON.stringify(deep), /SECRET_/);
});

test('a provider-confirmed thinking phase has its own public summary', () => {
  const view = generationProcessView({ phase: 'thinking', stage: 'generating', elapsedMs: 4200, phaseElapsedMs: 4000,
    phases: [{ phase: 'context', durationMs: 200, modelCalls: 0 }, { phase: 'thinking', durationMs: 4000, modelCalls: 1 }] }, true, 0, true);
  assert.equal(view.label, '深度思考中');
  assert.equal(generationProcessView({ phase: 'completed', elapsedMs: 4200,
    phases: [{ phase: 'thinking', durationMs: 4000 }] }, false, 0, true).label, '深度思考完成');
  const generating = generationProcessView({ phase: 'generating', elapsedMs: 5000,
    phases: [{ phase: 'context', durationMs: 200 }, { phase: 'generating', durationMs: 800 },
      { phase: 'thinking', durationMs: 4000 }] }, true, 0, true);
  assert.equal(generating.label, '生成回答');
  assert.deepEqual(generating.phases.map(row => row.phase), ['context', 'thinking', 'generating']);
  assert.deepEqual(view.phases.at(-1), { phase: 'thinking', label: '深度思考', description: '分析问题并形成回答思路',
    durationMs: 4000, modelCalls: 1, active: true });
  const roleplay = generationProcessView({ phase: 'thinking', stage: 'generating', elapsedMs: 4200,
    phases: [{ phase: 'thinking', durationMs: 4000, modelCalls: 1 }] }, true, 0, false);
  assert.equal(roleplay.label, '生成回答'); assert.equal(roleplay.phases.some(row => row.phase === 'thinking'), false);
  assert.doesNotMatch(JSON.stringify(roleplay), /深度思考/);
});

test('observed thinking remains visible with missing option metadata and receiving counters are actual data', () => {
  const snapshot = { phase: 'thinking', stage: 'generating', elapsedMs: 77600, phaseElapsedMs: 74400,
    phases: [{ phase: 'generating', durationMs: 2500, modelCalls: 1 }, { phase: 'thinking', durationMs: 74400, modelCalls: 0 }],
    modelOutput: { thinkingChars: 1234, textChars: 0, toolChars: 0, lastDataElapsedMs: 77500 },
    reasoning_content: 'SECRET_PRIVATE_REASONING' };
  const first = generationProcessView(snapshot, true, 300, true);
  assert.equal(first.label, '深度思考中'); assert.equal(first.elapsedMs, 77900);
  assert.equal(first.phases.find(row => row.phase === 'thinking').durationMs, 74700);
  assert.match(first.summary, /1,234 字思考数据/); assert.equal(first.lastDataAgeMs, 400);
  const next = generationProcessView({ ...snapshot, elapsedMs: 78600, phases: snapshot.phases.map(row =>
    row.phase === 'thinking' ? { ...row, durationMs: row.durationMs + 1000 } : row) }, true, 0, true);
  assert(next.phases.find(row => row.phase === 'thinking').durationMs > first.phases.find(row => row.phase === 'thinking').durationMs);
  assert(!JSON.stringify(first).includes('SECRET_'));
  assert.equal(generationProcessView({ ...snapshot, activity: 'preview_html' }, true, 0, true).summary, '正在生成手机和桌面的页面预览');
  assert(!generationProcessView({ ...snapshot, activity: 'SECRET_ACTIVITY' }, true, 0, true).summary.includes('SECRET_'));
});

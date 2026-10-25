import { AsyncLocalStorage } from 'node:async_hooks';
import { currentChatModel } from '../chat/chat-models';
import { assertContext } from './context-budget';
import { ModelRequestTimeoutError } from './model-output.error';

export interface ModelStep {
  [key: string]: string | number | null | undefined;
  stage: string; model: string; kind: 'chat' | 'embedding'; latencyMs: number;
  estimatedInputTokens: number; inputTokens?: number; outputTokens?: number;
  cachedInputTokens?: number; reasoningTokens?: number; costCny: number | null; status: 'ok' | 'error';
  finishReason?: string;
}
export const PUBLIC_MODEL_STAGES = ['preparing', 'generating', 'tools', 'verifying', 'completed'] as const;
export type PublicModelStage = typeof PUBLIC_MODEL_STAGES[number];
// These are fixed product-facing labels, never model-generated explanations or internal stage names.
export const PUBLIC_MODEL_PHASES = ['queued', 'context', 'understanding', 'retrieving', 'evidence',
  'thinking', 'generating', 'tools', 'verifying', 'delivering', 'completed'] as const;
export type PublicModelPhase = typeof PUBLIC_MODEL_PHASES[number];
export const PUBLIC_MODEL_ACTIVITIES = ['web_search', 'forum_search', 'read_files', 'save_file', 'preview_html', 'review_html', 'repair_html'] as const;
export type PublicModelActivity = typeof PUBLIC_MODEL_ACTIVITIES[number];
export interface PublicModelOutput { thinkingChars: number; textChars: number; toolChars: number; lastDataElapsedMs: number; }
export interface PerformanceSnapshot {
  stage: PublicModelStage; elapsedMs: number; firstTokenMs: number | null;
  stages: Array<{ stage: PublicModelStage; durationMs: number }>;
  phase?: PublicModelPhase; phaseElapsedMs?: number; queueMs?: number;
  phases?: Array<{ phase: PublicModelPhase; durationMs: number; modelCalls: number }>;
  modelCalls?: number; activeModelCalls?: number;
  activity?: PublicModelActivity; modelOutput?: PublicModelOutput;
}
export interface AssistantGeneration { finishReason: string | null; truncated: boolean; canContinue: boolean; fileIncomplete?: boolean; filePaths?: string[];
  fileFailureReason?: string; resumeFile?: {draftId:string;revision:number;hash:string}; }
export interface RuntimeUsage {
  inputTokens: number; outputTokens: number; embeddingTokens: number; calls: number;
  latencyMs: number; costCny: number | null; usageComplete: boolean;
  cachedInputTokens?: number; reasoningTokens?: number; steps?: ModelStep[];
}
export interface Runtime {
  signal: AbortSignal; started: number; stage: string; observedTokens: number;
  estimatedUnreportedTokens: number; calls: number;
  steps: ModelStep[];
  pending: Promise<void>[]; onStep?: (step: ModelStep, index: number) => Promise<void>;
  publicStage: PublicModelStage; stageStarted: number; stageDurations: Partial<Record<PublicModelStage, number>>;
  publicPhase: PublicModelPhase; phaseStarted: number; phaseDurations: Partial<Record<PublicModelPhase, number>>;
  phaseOrder: PublicModelPhase[]; phaseCalls: Partial<Record<PublicModelPhase, number>>;
  queueMs: number; activeModelCalls: number;
  semanticRevision: number; overlaySequence: number; currentOverlay?: number;
  modelOverlays: Map<number, { revision: number; stage: PublicModelStage; phase: PublicModelPhase }>;
  completedProgress?: PerformanceSnapshot;
  firstTokenMs: number | null; assistantGeneration?: AssistantGeneration;
  onStage?: (snapshot: PerformanceSnapshot) => void;
  activitySequence: number; activityOverlays: Map<number, PublicModelActivity>; modelOutput?: PublicModelOutput;
}
const runtime = new AsyncLocalStorage<Runtime>();
export const MODEL_NETWORK_TIMEOUT_MS = 60000;
export const THINKING_MODEL_NETWORK_TIMEOUT_MS = 180000;
export const runtimeState = () => runtime.getStore();
const publicStage = (stage: string): PublicModelStage => {
  if ((PUBLIC_MODEL_STAGES as readonly string[]).includes(stage)) return stage as PublicModelStage;
  if (stage === 'verification' || stage.includes('check')) return 'verifying';
  if (['generation', 'character_voice', 'continuation', 'attachment_vision'].includes(stage)) return 'generating';
  return 'preparing';
};
const publicPhase = (stage: string): PublicModelPhase => {
  if ((PUBLIC_MODEL_PHASES as readonly string[]).includes(stage)) return stage as PublicModelPhase;
  if (stage === 'routing' || stage === 'query_rewrite') return 'understanding';
  if (stage === 'retrieval' || stage === 'rerank') return 'retrieving';
  if (stage === 'quote_repair') return 'evidence';
  if (stage === 'verification' || stage.includes('check')) return 'verifying';
  if (stage === 'delivery') return 'delivering';
  if (['generation', 'voice', 'character_voice', 'conversation', 'continuation', 'attachment_vision', 'chat'].includes(stage)) return 'generating';
  return 'context';
};
const safeCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const safeTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Apply again when reading persisted progress: no extra properties or arbitrary labels can become SSE data.
export function publicPerformanceSnapshot(value: unknown): PerformanceSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, any>;
  if (!(PUBLIC_MODEL_STAGES as readonly unknown[]).includes(data.stage) || !safeTime(data.elapsedMs)) return undefined;
  const result: PerformanceSnapshot = { stage: data.stage, elapsedMs: data.elapsedMs,
    firstTokenMs: safeTime(data.firstTokenMs) ? data.firstTokenMs : null,
    stages: Array.isArray(data.stages) ? data.stages.filter((entry: any) => entry &&
      (PUBLIC_MODEL_STAGES as readonly unknown[]).includes(entry.stage) && safeTime(entry.durationMs))
      .slice(0, PUBLIC_MODEL_STAGES.length).map((entry: any) => ({ stage: entry.stage, durationMs: entry.durationMs })) : [] };
  if ((PUBLIC_MODEL_PHASES as readonly unknown[]).includes(data.phase)) {
    result.phase = data.phase;
    if (safeTime(data.phaseElapsedMs)) result.phaseElapsedMs = data.phaseElapsedMs;
  }
  if (safeTime(data.queueMs)) result.queueMs = data.queueMs;
  if (safeCount(data.modelCalls)) result.modelCalls = data.modelCalls;
  if (safeCount(data.activeModelCalls)) result.activeModelCalls = data.activeModelCalls;
  if ((PUBLIC_MODEL_ACTIVITIES as readonly unknown[]).includes(data.activity)) result.activity = data.activity;
  if (data.modelOutput && ['thinkingChars', 'textChars', 'toolChars', 'lastDataElapsedMs'].every(key => safeCount(data.modelOutput[key])))
    result.modelOutput = { thinkingChars: data.modelOutput.thinkingChars, textChars: data.modelOutput.textChars,
      toolChars: data.modelOutput.toolChars, lastDataElapsedMs: data.modelOutput.lastDataElapsedMs };
  if (Array.isArray(data.phases)) result.phases = data.phases.filter((entry: any) => entry &&
    (PUBLIC_MODEL_PHASES as readonly unknown[]).includes(entry.phase) && safeTime(entry.durationMs) && safeCount(entry.modelCalls))
    .slice(0, PUBLIC_MODEL_PHASES.length).map((entry: any) => ({ phase: entry.phase, durationMs: entry.durationMs, modelCalls: entry.modelCalls }));
  return result;
}

export function queuedPerformanceSnapshot(createdAt: Date, now = Date.now()): PerformanceSnapshot {
  const queueMs = Math.max(0, now - createdAt.getTime());
  return { stage: 'preparing', phase: 'queued', elapsedMs: queueMs, firstTokenMs: null,
    stages: [{ stage: 'preparing', durationMs: queueMs }], phaseElapsedMs: queueMs, queueMs,
    phases: [{ phase: 'queued', durationMs: queueMs, modelCalls: 0 }], modelCalls: 0, activeModelCalls: 0 };
}

export function advancePerformanceSnapshot(value: PerformanceSnapshot, elapsedMs: number): PerformanceSnapshot {
  const delta = Math.max(0, elapsedMs);
  if (value.stage === 'completed') return value;
  return { ...value, elapsedMs: value.elapsedMs + delta,
    ...(value.phaseElapsedMs === undefined ? {} : { phaseElapsedMs: value.phaseElapsedMs + delta }),
    stages: value.stages.map(stage => stage.stage === value.stage ? { ...stage, durationMs: stage.durationMs + delta } : stage),
    ...(value.phases ? { phases: value.phases.map(phase => phase.phase === value.phase
      ? { ...phase, durationMs: phase.durationMs + delta } : phase) } : {}) };
}
export function performanceSnapshot(r = runtime.getStore()): PerformanceSnapshot | undefined {
  if (!r) return undefined;
  // User-visible answer time ends at commit, not at later memory/usage-cache maintenance.
  if (r.completedProgress) return r.completedProgress;
  const now = Date.now(), durations = { ...r.stageDurations };
  durations[r.publicStage] = (durations[r.publicStage] || 0) + Math.max(0, now - r.stageStarted);
  const phaseDurations = { ...r.phaseDurations };
  phaseDurations[r.publicPhase] = (phaseDurations[r.publicPhase] || 0) + Math.max(0, now - r.phaseStarted);
  return { stage: r.publicStage, elapsedMs: Math.max(0, now - r.started) + r.queueMs, firstTokenMs: r.firstTokenMs,
    stages: PUBLIC_MODEL_STAGES.filter(stage => durations[stage] !== undefined)
      .map(stage => ({ stage, durationMs: durations[stage]! })),
    phase: r.publicPhase, phaseElapsedMs: Math.max(0, now - r.phaseStarted), queueMs: r.queueMs,
    phases: r.phaseOrder.map(phase => ({ phase, durationMs: phaseDurations[phase] || 0, modelCalls: r.phaseCalls[phase] || 0 })),
    modelCalls: r.calls, activeModelCalls: r.activeModelCalls,
    ...(r.activityOverlays.size ? { activity: [...r.activityOverlays.values()].at(-1) } : {}),
    ...(r.modelOutput ? { modelOutput: { ...r.modelOutput } } : {}) };
}
export async function withPublicActivity<T>(activity: PublicModelActivity, operation: () => Promise<T>): Promise<T> {
  const r = runtime.getStore();
  if (!r || r.completedProgress) return operation();
  const id = ++r.activitySequence; r.activityOverlays.set(id, activity);
  notifyPublicStage(r.publicStage, r.publicPhase, true, r);
  try { return await operation(); }
  finally { r.activityOverlays.delete(id); notifyPublicStage(r.publicStage, r.publicPhase, true, r); }
}
function observeModelOutput(thinkingChars: number, textChars: number, toolChars: number, r = runtime.getStore()) {
  if (!r || r.completedProgress || !(thinkingChars + textChars + toolChars)) return;
  const previous = r.modelOutput;
  r.modelOutput = { thinkingChars: (previous?.thinkingChars || 0) + thinkingChars,
    textChars: (previous?.textChars || 0) + textChars, toolChars: (previous?.toolChars || 0) + toolChars,
    lastDataElapsedMs: Math.max(0, Date.now() - r.started) + r.queueMs };
  notifyPublicStage(r.publicStage, r.publicPhase, true, r);
}
// A completion projection is written inside the answer transaction; it is visible only if that
// transaction commits. Do not change the live runtime until commit succeeds (cancel/failure races).
export function completedPerformanceSnapshot(): PerformanceSnapshot | undefined {
  const value = performanceSnapshot(); if (!value) return undefined;
  return { ...value, stage: 'completed', phase: 'completed', phaseElapsedMs: 0,
    stages: [...value.stages.filter(entry => entry.stage !== 'completed'), { stage: 'completed', durationMs: 0 }],
    phases: [...(value.phases || []).filter(entry => entry.phase !== 'completed'), { phase: 'completed', durationMs: 0, modelCalls: 0 }] };
}
function notifyPublicStage(stage: PublicModelStage, phase: PublicModelPhase, force = false, r = runtime.getStore()) {
  if (!r || r.completedProgress || (!force && stage === r.publicStage && phase === r.publicPhase)) return;
  const now = Date.now();
  if (stage !== r.publicStage) {
    r.stageDurations[r.publicStage] = (r.stageDurations[r.publicStage] || 0) + Math.max(0, now - r.stageStarted);
    r.publicStage = stage; r.stageStarted = now;
  }
  if (phase !== r.publicPhase) {
    r.phaseDurations[r.publicPhase] = (r.phaseDurations[r.publicPhase] || 0) + Math.max(0, now - r.phaseStarted);
    r.publicPhase = phase; r.phaseStarted = now;
    if (!r.phaseOrder.includes(phase)) r.phaseOrder.push(phase);
  }
  try { r.onStage?.(performanceSnapshot(r)!); } catch { /* Diagnostics must never break a task. */ }
}
export const setModelStage = (stage: string) => {
  const r = runtime.getStore(); if (!r) return;
  r.stage = stage; r.semanticRevision++;
  r.modelOverlays.clear(); r.currentOverlay = undefined;
  notifyPublicStage(publicStage(stage), publicPhase(stage));
  if (stage === 'completed' && !r.completedProgress) r.completedProgress = performanceSnapshot(r);
};
// Call only when public response text is delivered, not for internal RAG/model tokens.
export function markRuntimeFirstToken() {
  const r = runtime.getStore(); if (r && r.firstTokenMs === null) r.firstTokenMs = Math.max(0, Date.now() - r.started) + r.queueMs;
}
export function recordAssistantGeneration(): AssistantGeneration {
  const r = runtime.getStore();
  const finishReason = [...(r?.steps || [])].reverse().find(step => step.kind === 'chat')?.finishReason || null;
  const result = { finishReason, truncated: finishReason === 'length', canContinue: finishReason === 'length' };
  if (r) r.assistantGeneration = result;
  return result;
}
export function rethrowRuntimeStop(error: unknown) {
  runtime.getStore()?.signal.throwIfAborted();
}

export async function withModelRuntime<T>(signal: AbortSignal, operation: () => Promise<T>, complete?: (r: Runtime) => Promise<void>,
  onStep?: Runtime['onStep'], onStage?: Runtime['onStage'], queuedMs = 0) {
  // Observation only: no whole-task token, money or wall-clock limit.
  const started = Date.now();
  const queueMs = safeTime(queuedMs) ? queuedMs : 0;
  const r: Runtime = { signal, started, stage: 'routing', publicStage: 'preparing', stageStarted: started,
    stageDurations: { preparing: queueMs }, firstTokenMs: null,
    publicPhase: 'context', phaseStarted: started, phaseDurations: queueMs ? { queued: queueMs } : {},
    phaseOrder: queueMs ? ['queued', 'context'] : ['context'], phaseCalls: {}, queueMs, activeModelCalls: 0,
    semanticRevision: 0, overlaySequence: 0, modelOverlays: new Map(),
    activitySequence: 0, activityOverlays: new Map(),
    observedTokens: 0, estimatedUnreportedTokens: 0, calls: 0, steps: [], pending: [], onStep, onStage };
  return runtime.run(r, async () => { try {
    try { onStage?.(performanceSnapshot(r)!); } catch { /* Observation only. */ }
    return await operation();
  } finally {
    await Promise.allSettled(r.pending); await complete?.(r);
  } });
}

const rate = (name: string): number | null => {
  const v = process.env[name] === undefined ? NaN : Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : null;
};
export function tokenCost(kind: 'chat' | 'embedding', input: number, output: number, cached = 0) {
  const prefix = currentChatModel().pricingPrefix;
  if (kind === 'embedding') { const r = rate('RAG_EMBEDDING_CNY_PER_MILLION'); return r === null ? null : input * r / 1e6; }
  const a = rate(prefix + '_INPUT_CNY_PER_MILLION'), b = rate(prefix + '_OUTPUT_CNY_PER_MILLION');
  const c = cached ? rate(prefix + '_CACHED_INPUT_CNY_PER_MILLION') : 0;
  return a === null || b === null || c === null ? null : ((input - cached) * a + cached * c + output * b) / 1e6;
}

export function beginModelCall(kind: 'chat' | 'embedding', model: string, estimatedInput: number, maxOutput: number,
  usage?: RuntimeUsage, stageOverride?: string, externalSignal?: AbortSignal, networkTimeoutMs: number | null = MODEL_NETWORK_TIMEOUT_MS) {
  const r = runtime.getStore();
  const reserve = estimatedInput + maxOutput;
  r?.signal.throwIfAborted(); externalSignal?.throwIfAborted();
  if (r) r.calls++;
  if (usage) usage.calls++;
  const started = Date.now();
  const stage = stageOverride || r?.stage || kind;
  const phase = kind === 'embedding' ? 'retrieving' : stage === 'tools' ? 'generating' : publicPhase(stage);
  const overlay = r ? ++r.overlaySequence : undefined;
  const revision = r?.semanticRevision;
  const callStage = publicStage(stage) === 'verifying' ? 'verifying' : kind === 'chat' ? 'generating' : 'preparing';
  if (r) {
    r.activeModelCalls++; r.phaseCalls[phase] = (r.phaseCalls[phase] || 0) + 1;
    r.modelOverlays.set(overlay!, { revision: revision!, stage: callStage, phase }); r.currentOverlay = overlay;
  }
  notifyPublicStage(callStage, phase, true);
  let settled = false;
  // A per-network-request timeout is not a task deadline; callers opt in only for real thinking calls.
  const signals = [networkTimeoutMs === null ? undefined : AbortSignal.timeout(networkTimeoutMs), r?.signal, externalSignal].filter(Boolean) as AbortSignal[];
  return { signal: AbortSignal.any(signals), setResponsePhase(nextPhase: 'thinking' | 'generating') {
    if (!r || settled || kind !== 'chat' || overlay === undefined || revision === undefined || r.completedProgress) return;
    const entry = r.modelOverlays.get(overlay);
    // A provider frame may arrive after another model call or an explicit semantic
    // stage change. Only the still-current call may affect public progress.
    if (!entry || entry.revision !== revision || r.semanticRevision !== revision || r.currentOverlay !== overlay) return;
    entry.phase = nextPhase;
    notifyPublicStage(entry.stage, nextPhase, true, r);
  }, finish(providerUsage: any, failed = false, finishReason?: unknown) {
    if (settled) return; settled = true;
    const input = kind === 'embedding' ? providerUsage?.total_tokens ?? providerUsage?.prompt_tokens : providerUsage?.prompt_tokens;
    const output = kind === 'embedding' ? 0 : providerUsage?.completion_tokens;
    const valid = [input, output].every(v => Number.isSafeInteger(v) && v >= 0);
    const cachedRaw = providerUsage?.prompt_cache_hit_tokens ?? providerUsage?.prompt_tokens_details?.cached_tokens;
    const cached = Number.isSafeInteger(cachedRaw) && cachedRaw >= 0 && cachedRaw <= input ? cachedRaw : 0;
    const reasoning = providerUsage?.completion_tokens_details?.reasoning_tokens;
    const cost = valid ? tokenCost(kind, input, output, cached) : null;
    const step: ModelStep = { stage, model, kind, latencyMs: Date.now() - started,
      estimatedInputTokens: estimatedInput, ...(valid ? { inputTokens: input, outputTokens: output } : {}),
      ...(cachedRaw !== undefined ? { cachedInputTokens: cached } : {}),
      ...(Number.isSafeInteger(reasoning) && reasoning >= 0 ? { reasoningTokens: reasoning } : {}),
      ...(typeof finishReason === 'string' && ['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(finishReason) ? { finishReason } : {}),
      costCny: cost, status: failed ? 'error' : 'ok' };
    if (r) {
      r.activeModelCalls = Math.max(0, r.activeModelCalls - 1);
      r.steps.push(step);
      if (r.onStep) r.pending.push(r.onStep(step, r.steps.length - 1));
      if (valid) r.observedTokens += input + output;
      else r.estimatedUnreportedTokens += reserve;
      r.modelOverlays.delete(overlay!);
      if (r.currentOverlay === overlay && r.semanticRevision === revision) {
        // Restore only our still-current overlay. A late parallel ticket must not overwrite a
        // newer call or an explicit retrieval/tool/verification transition.
        const previous = [...r.modelOverlays.entries()].reverse().find(([,entry]) => entry.revision === revision);
        r.currentOverlay = previous?.[0];
        notifyPublicStage(previous?.[1].stage || publicStage(r.stage), previous?.[1].phase || publicPhase(r.stage), true, r);
      } else notifyPublicStage(r.publicStage, r.publicPhase, true, r);
    }
    if (usage) {
      (usage.steps ||= []).push(step);
      if (valid) {
        if (kind === 'embedding') usage.embeddingTokens += input;
        else { usage.inputTokens += input; usage.outputTokens += output; }
      } else usage.usageComplete = false;
      usage.cachedInputTokens = (usage.cachedInputTokens || 0) + cached;
      usage.reasoningTokens = (usage.reasoningTokens || 0) + (step.reasoningTokens || 0);
      usage.costCny = usage.usageComplete && usage.steps.every(s => s.costCny !== null)
        ? usage.steps.reduce((n, s) => n + s.costCny!, 0) : null;
    }
  } };
}

// Instrument at the HTTP boundary: every Agent/tool-loop model request is accounted for,
// including real provider streaming usage. Never capture headers, prompts or reasoning text.
export function meteredFetch(usage?: RuntimeUsage, externalSignal?: AbortSignal, networkTimeoutMs = MODEL_NETWORK_TIMEOUT_MS): typeof fetch {
  return (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const requestRuntime = runtime.getStore();
    const thinkingEnabled = body.enable_thinking === true || body.thinking?.type === 'enabled';
    const output = body.max_tokens ?? body.max_completion_tokens ?? 1000;
    const estimated = assertContext({ messages: body.messages, tools: body.tools }, output);
    // A model that is actively streaming may legitimately run for longer than the
    // inactivity timeout. Only time with no incoming data counts toward this timer.
    const idle = new AbortController();
    const transportSignal = AbortSignal.any([idle.signal, externalSignal, init?.signal].filter(Boolean) as AbortSignal[]);
    const ticket = beginModelCall('chat', body.model || 'unknown', estimated, output, usage, undefined, transportSignal, null);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(new ModelRequestTimeoutError()), networkTimeoutMs);
      idleTimer.unref?.();
    };
    // Keep only the fact that a provider emitted a thinking/content frame. Raw
    // reasoning text stays inside the provider byte stream and is never copied
    // into runtime state, progress, logs, persistence or the public SSE protocol.
    let sawReasoning = false, sawPublicContent = false;
    const observeDelta = (delta: any) => {
      observeModelOutput(thinkingEnabled && typeof delta?.reasoning_content === 'string' ? delta.reasoning_content.length : 0,
        typeof delta?.content === 'string' ? delta.content.length : 0,
        (Array.isArray(delta?.tool_calls) ? delta.tool_calls : []).reduce((total: number, call: any) =>
          total + (typeof call?.function?.arguments === 'string' ? call.function.arguments.length : 0), 0), requestRuntime);
      if (!thinkingEnabled) return;
      if (!sawReasoning && typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
        sawReasoning = true;
        ticket.setResponsePhase('thinking');
      }
      if (sawReasoning && !sawPublicContent && typeof delta?.content === 'string' && delta.content.length > 0) {
        sawPublicContent = true;
        ticket.setResponsePhase('generating');
      }
    };
    const clean = () => { if (idleTimer) clearTimeout(idleTimer); ticket.signal.removeEventListener('abort', aborted); };
    const aborted = () => { ticket.finish(undefined, true); clean(); };
    ticket.signal.addEventListener('abort', aborted, { once: true });
    touch();
    try {
      const response = await fetch(url, { ...init, signal: ticket.signal });
      touch();
      if (!response.ok) { ticket.finish(undefined, true); clean(); return response; }
      if (!body.stream) {
        const data = await response.clone().json(); ticket.finish(data.usage, false, data.choices?.[0]?.finish_reason); clean(); return response;
      }
      if (!response.body) { ticket.finish(undefined, true); clean(); return response; }
      let buffer = '', reported: unknown, finishReason: unknown;
      const decoder = new TextDecoder();
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          touch();
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop() || '';
          if (buffer.length > 262144) throw new Error('Provider event exceeds limit');
          for (const line of lines) if (line.startsWith('data:')) {
            try { const event = JSON.parse(line.slice(5).trim()); observeDelta(event.choices?.[0]?.delta);
              if (event.usage) reported = event.usage;
              if (event.choices?.[0]?.finish_reason) finishReason = event.choices[0].finish_reason;
            } catch { /* SSE sentinel/keepalive */ }
          }
          controller.enqueue(chunk);
        },
        flush() { ticket.finish(reported, false, finishReason); clean(); },
      });
      const reader = response.body.pipeThrough(transform).getReader();
      const monitored = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const part = await reader.read(); if (part.done) controller.close(); else controller.enqueue(part.value); }
          catch (error) { ticket.finish(reported, true); clean(); controller.error(idle.signal.aborted ? idle.signal.reason : error); }
        },
        async cancel(reason) { ticket.finish(reported, true); clean(); await reader.cancel(reason); },
      });
      return new Response(monitored, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { ticket.finish(undefined, true); clean(); throw idle.signal.aborted ? idle.signal.reason : error; }
  }) as typeof fetch;
}

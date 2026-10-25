import { apiUrl } from './api';
import request from './request';
import { useUserStore } from '@/stores/user';
import { readSse } from './sse';

export interface RunResult { status: string; error?: string; result?: { content: string; ragMetadata?: any } }
export type GenerationPhase = 'queued' | 'context' | 'understanding' | 'retrieving' | 'evidence' | 'thinking' | 'generating' | 'tools' | 'verifying' | 'delivering' | 'completed';
export type GenerationActivity = 'web_search' | 'forum_search' | 'read_files' | 'save_file' | 'preview_html' | 'review_html' | 'repair_html';
export interface GenerationProgress { stage: 'preparing' | 'generating' | 'tools' | 'verifying' | 'completed';
  elapsedMs: number; firstTokenMs: number | null; stages: Array<{ stage: string; durationMs: number }>;
  phase?: GenerationPhase; phaseElapsedMs?: number; queueMs?: number; modelCalls?: number; activeModelCalls?: number;
  phases?: Array<{ phase: GenerationPhase; durationMs: number; modelCalls: number }>;
  activity?: GenerationActivity; modelOutput?: { thinkingChars: number; textChars: number; toolChars: number; lastDataElapsedMs: number } }
const stages = ['preparing', 'generating', 'tools', 'verifying', 'completed'] as const;
const phases: GenerationPhase[] = ['queued', 'context', 'understanding', 'retrieving', 'evidence', 'thinking', 'generating', 'tools', 'verifying', 'delivering', 'completed'];
const activities: GenerationActivity[] = ['web_search', 'forum_search', 'read_files', 'save_file', 'preview_html', 'review_html', 'repair_html'];
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const count = (value: unknown): value is number => time(value) && Number.isSafeInteger(value);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
// Public telemetry only: never retain provider reasoning, arbitrary labels, prompts or tool data.
export function parseGenerationProgress(value: unknown): GenerationProgress | null {
  if (!object(value) || !stages.includes(value.stage) || !time(value.elapsedMs)) return null;
  const seen = new Set<string>(), seenPhases = new Set<string>();
  const result: GenerationProgress = { stage: value.stage, elapsedMs: value.elapsedMs,
    firstTokenMs: time(value.firstTokenMs) && value.firstTokenMs <= value.elapsedMs ? value.firstTokenMs : null,
    stages: Array.isArray(value.stages) ? value.stages.slice(0, 40).filter(row => {
      if (!object(row) || !stages.includes(row.stage) || !time(row.durationMs) || seen.has(row.stage)) return false;
      seen.add(row.stage); return true;
    }).map(row => ({ stage: row.stage, durationMs: row.durationMs })) : [] };
  if (phases.includes(value.phase)) result.phase = value.phase;
  for (const key of ['phaseElapsedMs', 'queueMs'] as const) if (time(value[key])) result[key] = value[key];
  for (const key of ['modelCalls', 'activeModelCalls'] as const) if (count(value[key])) result[key] = value[key];
  if (activities.includes(value.activity)) result.activity = value.activity;
  if (object(value.modelOutput) && ['thinkingChars', 'textChars', 'toolChars', 'lastDataElapsedMs'].every(key => count(value.modelOutput[key])) &&
      value.modelOutput.lastDataElapsedMs <= value.elapsedMs)
    result.modelOutput = { thinkingChars: value.modelOutput.thinkingChars, textChars: value.modelOutput.textChars,
      toolChars: value.modelOutput.toolChars, lastDataElapsedMs: value.modelOutput.lastDataElapsedMs };
  if (Array.isArray(value.phases)) result.phases = value.phases.slice(0, 40).filter(row => {
    if (!object(row) || !phases.includes(row.phase) || !time(row.durationMs) || !count(row.modelCalls) || seenPhases.has(row.phase)) return false;
    seenPhases.add(row.phase); return true;
  }).map(row => ({ phase: row.phase, durationMs: row.durationMs, modelCalls: row.modelCalls }));
  return result;
}
class StreamAccessError extends Error {}

export async function watchChatRun(id: string, signal: AbortSignal,
  onDelta: (text: string) => void, onProgress?: (progress: GenerationProgress) => void): Promise<RunResult> {
  let offset = 0, failures = 0;
  while (!signal.aborted) {
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let watchdog = setTimeout(abort, 45000);
    try {
      const response = await fetch(apiUrl(`/chat/runs/${id}/events?offset=${offset}`), {
        headers: { Authorization: `Bearer ${useUserStore().token}`, Accept: 'text/event-stream' },
        signal: connection.signal, cache: 'no-store',
      });
      if (response.status === 401) {
        // Reuse the existing single-flight token refresh; never put tokens in a URL.
        await request.get('/chat/runs/' + id, { signal });
        throw new Error('Reconnect after token refresh');
      }
      if (response.status >= 400 && response.status < 500)
        throw new StreamAccessError('无法读取回答，登录状态或访问权限可能已改变');
      if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('SSE connection unavailable');
      for await (const frame of readSse(response.body)) {
        clearTimeout(watchdog); watchdog = setTimeout(abort, 45000);
        const value = JSON.parse(frame.data);
        if (frame.event === 'delta') {
          if (typeof value.text !== 'string' || value.offset !== offset + value.text.length)
            throw new StreamAccessError('回答流顺序异常，请重新打开对话');
          offset = value.offset; failures = 0; onDelta(value.text);
        } else if (frame.event === 'progress') {
          const progress = parseGenerationProgress(value);
          if (progress) onProgress?.(progress);
        } else if (frame.event === 'complete' || frame.event === 'terminal') return value;
      }
      throw new Error('SSE disconnected');
    } catch (error) {
      if (signal.aborted) return { status: 'CANCELLED' };
      if (error instanceof StreamAccessError || ++failures >= 5) throw error;
    } finally {
      clearTimeout(watchdog); connection.abort(); signal.removeEventListener('abort', abort);
    }
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, 500 * failures);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  return { status: 'CANCELLED' };
}

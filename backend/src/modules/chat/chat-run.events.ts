import { setTimeout as delay } from 'node:timers/promises';
import { publicPerformanceSnapshot } from '../agent/model-runtime';
import { codePath } from '../coding/coding.policy';
import { RunPollPacer } from './chat-run.poll';

export interface PublicFileResume { draftId: string; revision: number; hash: string; }
interface PublicTerminalGeneration {
  finishReason?: string | null; truncated?: boolean; canContinue?: boolean; fileIncomplete?: boolean;
  filePaths?: string[]; fileFailureReason?: string; resumeFile?: PublicFileResume;
}
export interface PublicTerminalResult {
  failure?: { stage: string; code: string; message: string };
  ragMetadata?: { generation: PublicTerminalGeneration };
}
export function publicFileResume(value: unknown): PublicFileResume | undefined {
  const ref = value as Partial<PublicFileResume> | undefined;
  return ref && typeof ref.draftId === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(ref.draftId) &&
    Number.isSafeInteger(ref.revision) && ref.revision! > 0 && typeof ref.hash === 'string' && /^[a-f\d]{64}$/.test(ref.hash)
    ? { draftId: ref.draftId, revision: ref.revision!, hash: ref.hash } : undefined;
}
// Terminal delivery must not serialize buffered answer/code, private drafts or tool payloads.
// Ownership and epoch checks happen in ChatRunService.get before a resume reference enters here.
export function publicTerminalResult(value: unknown): PublicTerminalResult | undefined {
  const raw = value as any, result: PublicTerminalResult = {};
  const failure = raw?.failure;
  if (failure && typeof failure.stage === 'string' && /^[a-z_]{1,40}$/.test(failure.stage) &&
    typeof failure.code === 'string' && /^[A-Z_\d]{1,80}$/.test(failure.code) &&
    typeof failure.message === 'string' && failure.message.length <= 500)
    result.failure = { stage: failure.stage, code: failure.code, message: failure.message };
  const stored = raw?.ragMetadata?.generation;
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    const generation: PublicTerminalGeneration = {};
    for (const key of ['truncated', 'canContinue', 'fileIncomplete'] as const)
      if (typeof stored[key] === 'boolean') generation[key] = stored[key];
    if (stored.finishReason === null || ['stop', 'length', 'content_filter', 'tool_calls'].includes(stored.finishReason))
      generation.finishReason = stored.finishReason;
    if (['OUTPUT_LIMIT', 'UNCLOSED_FILE', 'HTML_SYNTAX', 'INVALID_FILE', 'SAVE_FAILED', 'SERVICE_ERROR', 'STOPPED', 'WORKER_INTERRUPTED'].includes(stored.fileFailureReason))
      generation.fileFailureReason = stored.fileFailureReason;
    if (Array.isArray(stored.filePaths)) {
      const paths = stored.filePaths.filter((path: unknown) => {
        try { return typeof path === 'string' && codePath(path) === path; } catch { return false; }
      }).slice(0, 60);
      if (paths.length) generation.filePaths = paths;
    }
    const ref = publicFileResume(stored.resumeFile);
    if (ref) generation.resumeFile = ref;
    if (Object.keys(generation).length) result.ragMetadata = { generation };
  }
  return Object.keys(result).length ? result : undefined;
}

export interface RunSnapshot {
  status: string;
  result?: unknown;
  error?: string | null;
  progress?: unknown;
}
export interface RunEvent { event: string; data: unknown; id?: number }
// Bound frame/memory size, not the user's reading speed. Revalidate ACL before each frame.
export const MAX_PUBLIC_TEXT_FRAME_UNITS = 2048;

// The shared database is the source of truth, so reconnects may land on any API instance.
// RAG/tool answers enter result only after verification; ordinary chat publishes live model text.
export async function* runEvents(read: () => Promise<RunSnapshot>, offset: number, signal: AbortSignal): AsyncGenerator<RunEvent> {
  let lastStatus = '', lastProgress = '', lastHeartbeat = Date.now();
  const pacer = new RunPollPacer();
  while (!signal.aborted) {
    const run = await read(); // Re-check current owner/account/KB/document ACL before every delivery.
    if (signal.aborted) return;
    if(run.status==='WAITING_APPROVAL'){
      yield{event:'terminal',data:{status:'WAITING_APPROVAL'}};
      return;
    }
    if (run.status === 'FAILED' || run.status === 'CANCELLED') {
      const result = publicTerminalResult(run.result);
      yield { event: 'terminal', data: { status: run.status, error: run.error, ...(result ? { result } : {}) } };
      return;
    }
    const result = run.result as { content?: string; ragMetadata?: unknown } | null;
    const content = result?.content || '';
    const progress = run.status === 'COMPLETED' ? undefined : publicPerformanceSnapshot(run.progress);
    // Numeric clocks/reasoning counters are not new public answer text. Poll idle
    // thinking/queued runs less often while preserving prompt text catch-up.
    const waitMs = pacer.observe(JSON.stringify([run.status, content.length,
      progress?.stage, progress?.phase, progress?.activity]), content.length > offset);
    if (offset > content.length) throw new Error('Invalid stream offset');
    if (offset > 0 && offset < content.length && /[\uD800-\uDBFF]/.test(content[offset - 1]) && /[\uDC00-\uDFFF]/.test(content[offset]))
      throw new Error('Invalid stream offset');
    if (run.status !== lastStatus) {
      yield { event: 'status', data: { status: run.status } };
      lastStatus = run.status;
    }
    if (progress) {
      const encoded = JSON.stringify(progress);
      if (encoded !== lastProgress) {
        yield { event: 'progress', data: progress };
        lastProgress = encoded;
      }
    }
    if (content.length > offset) {
      // Offset is UTF-16 (the browser's string indexing); never split a surrogate pair.
      let end = Math.min(content.length, offset + MAX_PUBLIC_TEXT_FRAME_UNITS);
      if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end])) end--;
      const text = content.slice(offset, end);
      offset += text.length;
      yield { event: 'delta', id: offset, data: { text, offset } };
    }
    if (run.status === 'COMPLETED' && offset === content.length) {
      yield { event: 'complete', data: { status: run.status, result } };
      return;
    }
    if (Date.now() - lastHeartbeat >= 10000) {
      yield { event: 'ping', data: {} };
      lastHeartbeat = Date.now();
    }
    // Catch up immediately when verified text is already available. The controller
    // still applies socket backpressure; never add an artificial typewriter delay.
    if (content.length > offset) continue;
    await delay(waitMs, undefined, { signal });
  }
}

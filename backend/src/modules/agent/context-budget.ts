import { BadRequestException } from '@nestjs/common';
import { conversationTurns, excerptOversizedTurn, MemoryMessage } from './conversation-memory.policy';

// Provider tokenizers differ; this is a capacity estimate, never a billable token count.
// Counting UTF-8 bytes treated ordinary Chinese as three tokens and prematurely dropped
// whole history turns. Estimate Unicode runs instead, with 25% headroom and framing.
// Non-Latin/emoji characters retain a byte-aware reserve; arbitrary code is not prose.
export const TOKEN_ESTIMATION_VERSION = 'unicode-runs-plus-visual-reserve-v3';
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const runs = text.match(/[A-Za-z]+|[0-9]+|[ \t\r]+|\n|[\s\S]/gu) || [];
  let units = 0;
  for (const run of runs) {
    if (/^[A-Za-z]+$/.test(run)) units += Math.max(1, run.length / 3);
    else if (/^[0-9]+$/.test(run)) units += Math.ceil(run.length / 3);
    else if (/^[ \t\r]+$/.test(run)) units += Math.max(1, run.length / 4);
    else if (/^\p{Script=Han}$/u.test(run)) units += 1.2;
    else if (run === '\n' || /^[\p{P}\p{S}]$/u.test(run) && run.codePointAt(0)! < 0x1f000) units += 1;
    else units += Math.max(1, Buffer.byteLength(run, 'utf8') / 1.5);
  }
  return Math.ceil(units * 1.25) + 16;
}
// Encoded image bytes are transport, not text tokens. Images are normalized to <=1280px;
// reserve conservatively per image, and keep provider-reported usage as the billing truth.
export const IMAGE_TOKEN_RESERVE = 4096;
export const ASSISTANT_MAX_OUTPUT_TOKENS = 32768;
// Ordinary AI reserves its actual larger answer plus a resumable file prefix.
// This is request capacity, not a task token/cost allowance; role/RAG defaults stay unchanged.
export const assistantContextTokenBudget = () => positiveSetting('ASSISTANT_CONTEXT_TOKEN_BUDGET', 96000);
export function estimateModelTokens(value: unknown): number {
  let images = 0;
  const text = JSON.stringify(value, (_key, item) => {
    if (item?.type === 'image_url' && typeof item.image_url?.url === 'string' &&
        /^data:image\/(?:jpeg|png|webp);base64,/.test(item.image_url.url)) {
      images++;
      return { ...item, image_url: { ...item.image_url, url: '[inline image bytes omitted from text estimate]' } };
    }
    return item;
  });
  return estimateTokens(text || '') + images * IMAGE_TOKEN_RESERVE;
}
export const positiveSetting = (name: string, fallback: number, max = 10000000) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
};

export function selectHistory<T extends { role: string; content: string }>(history: T[], budget: number): T[] {
  const turns = conversationTurns(history as unknown as MemoryMessage[]).turns as unknown as T[][];
  const chosen: T[][] = [];
  let tokens = 0;
  for (const turn of [...turns].reverse()) {
    let packed = turn, size = estimateTokens(turn);
    // Only a turn bigger than the ENTIRE allowance is excerpted. Ordinary older
    // turns that merely do not fit the remainder still stay whole or are omitted.
    if (size > budget) {
      for (let characters = Math.min(6000, Math.floor(budget)); characters >= 512; characters = Math.floor(characters * .7)) {
        const excerpt = excerptOversizedTurn(turn, characters);
        if (!excerpt) break;
        packed = excerpt; size = estimateTokens(packed);
        if (size <= budget) break;
      }
    }
    if (tokens + size > budget) break;
    chosen.unshift(packed); tokens += size;
    if (chosen.length === 30) break;
  }
  return chosen.flat();
}

export function compactMemory(memory: any, maxSummary = 5000) {
  if (!memory) return undefined;
  // Revision hashes, all source manifests and cache/window diagnostics belong in traces, not prompts.
  const topics = memory.summary?.topics || [];
  const selected: any[] = [];
  let used = 0;
  for (const topic of topics) {
    const size = estimateTokens(topic);
    if (used + size <= maxSummary) { selected.push(topic); used += size; }
  }
  const state = memory.personaKey === 'assistant' ? { name: memory.state?.name, address: memory.state?.address,
    preferences: memory.state?.preferences?.filter((p: any) => p.source?.speaker === 'user') } : memory.state;
  return { kind: 'sourced_dialogue_not_canon', state,
    summary: selected.length ? selected : memory.summary?.text ? String(memory.summary.text).slice(0, Math.floor(maxSummary / 3)) : [] };
}

export function stagePayload(data: unknown, stage: string) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const copy = { ...data } as Record<string, any>;
  if (Array.isArray(copy.history)) copy.history = selectHistory(copy.history,
    stage === 'routing' || stage === 'query_rewrite' ? 4000 : 6500);
  if (copy.memory) copy.memory = compactMemory(copy.memory, 3000);
  return copy;
}

export function assertContext(input: unknown, outputReserve: number) {
  const estimated = estimateModelTokens(input);
  const capacity = outputReserve >= ASSISTANT_MAX_OUTPUT_TOKENS ? assistantContextTokenBudget() : positiveSetting('MODEL_CONTEXT_TOKEN_BUDGET', 48000);
  if (estimated + outputReserve > capacity)
    throw new BadRequestException('本次上下文超过安全预算，请缩短消息或减少工具；未截断原文证据');
  return estimated;
}

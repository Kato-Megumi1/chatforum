import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import type { ModelStep } from '../modules/agent/model-runtime';

export interface UsageOwner { scope: 'CHAT' | 'INDEX'; sourceId: string; userId: number | null; createdAt: Date; attemptId?:string }
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2147483647;
const n = (v: unknown) => integer(v) ? v : 0;
const logger = new Logger('UsageLedger');

export function usageStepRow(owner: UsageOwner, step: Partial<ModelStep>, index: number) {
  const reported = integer(step.inputTokens) && integer(step.outputTokens);
  const {attemptId,...identity}=owner;
  return {
    ...identity, sourceKey: `${owner.scope}:${owner.sourceId}:${attemptId?'attempt:'+attemptId+':':''}${index}`,
    model: String(step.model || 'unknown').slice(0, 100), kind: step.kind === 'embedding' ? 'embedding' : 'chat',
    stage: String(step.stage || 'unknown').slice(0, 80), callCount: 1,
    inputTokens: reported ? step.inputTokens! : null, outputTokens: reported ? step.outputTokens! : null,
    cachedInputTokens: reported ? Math.min(n(step.cachedInputTokens), step.inputTokens!) : 0,
    reasoningTokens: reported ? Math.min(n(step.reasoningTokens), step.outputTokens!) : 0,
    estimatedInputTokens: n(step.estimatedInputTokens), latencyMs: n(step.latencyMs),
    costCny: reported && typeof step.costCny === 'number' && Number.isFinite(step.costCny) && step.costCny >= 0 ? step.costCny : null,
    outcome: step.status === 'error' ? 'error' : 'ok', quality: reported ? 'PROVIDER' : 'UNREPORTED',
  };
}

async function insert(db: PrismaClient, data: Prisma.ModelUsageEntryCreateManyInput[]) {
  if (!data.length) return;
  try { await db.modelUsageEntry.createMany({ data, skipDuplicates: true }); }
  catch (error: any) {
    // Deleted users retain anonymous aggregate accounting, never recreate their accounts.
    if (error?.code !== 'P2003') throw error;
    const ids = [...new Set(data.map(r => r.userId).filter((id): id is number => id != null))];
    const existing = new Set((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true } })).map(u => u.id));
    await db.modelUsageEntry.createMany({ data: data.map(r => ({ ...r, userId: existing.has(r.userId!) ? r.userId : null })), skipDuplicates: true });
  }
}

export async function recordUsageStep(db: PrismaClient, owner: UsageOwner, step: ModelStep, index: number) {
  try { await insert(db, [usageStepRow(owner, step, index)]); }
  catch { logger.error('Usage step persistence failed; retained task snapshot can repair it'); }
}

// Idempotent repair/backfill. Detailed steps take precedence over legacy aggregate counters.
// Zeroes from legacy incomplete usage are not proof that a request was free.
export async function recordUsageSnapshot(db: PrismaClient, owner: UsageOwner, usage: any) {
  if (!usage || typeof usage !== 'object') return;
  if(!owner.attemptId&&typeof usage.attemptId==='string'&&/^[a-f\d-]{36}$/i.test(usage.attemptId))owner={...owner,attemptId:usage.attemptId};
  if (Array.isArray(usage.steps) && usage.steps.length) {
    await insert(db, usage.steps.map((step: ModelStep, index: number) => usageStepRow(owner, step, index)));
    return;
  }
  if (Array.isArray(usage.steps) && usage.calls === undefined && usage.observedTokens === 0 || usage.calls === 0) {
    const row = usageStepRow(owner, {}, 0);
    await insert(db, [{ ...row, kind: 'none', stage: 'no-model-call', callCount: 0,
      inputTokens: 0, outputTokens: 0, costCny: 0, quality: 'NO_CALLS' }]);
    return;
  }
  if (![usage.inputTokens, usage.outputTokens, usage.embeddingTokens].some(integer)) return;
  // The historical model identity and full call chain were not recorded; do not guess them.
  const complete = usage.usageComplete === true;
  const base = usageStepRow(owner, {}, 0);
  const fields = (input: unknown, output: unknown) => ({
    inputTokens: integer(input) && (complete || input > 0) ? input : null,
    outputTokens: integer(output) && (complete || output > 0) ? output : null,
  });
  await insert(db, [{ ...base, sourceKey: `${owner.scope}:${owner.sourceId}:legacy-chat`,
    ...fields(usage.inputTokens, usage.outputTokens), model: 'historical-unattributed',
    stage: 'historical-aggregate', callCount: n(usage.calls), quality: 'HISTORICAL_PARTIAL',
    latencyMs: n(usage.latencyMs), costCny: null },
    ...(n(usage.embeddingTokens) ? [{ ...base, sourceKey: `${owner.scope}:${owner.sourceId}:legacy-embedding`,
      inputTokens: n(usage.embeddingTokens), outputTokens: 0, model: 'historical-unattributed', kind: 'embedding',
      stage: 'historical-aggregate', callCount: 0, quality: 'HISTORICAL_PARTIAL' }] : [])]);
}

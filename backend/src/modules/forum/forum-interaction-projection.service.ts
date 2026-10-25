import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const HOUR = 3600000;
export interface ForumInteractionEvent { id: bigint; postId: number; occurredAt: Date; payloadJson: unknown; }

/** Called inside forum-projections-v1's transaction. Its delivery ACK is committed
 * with this update; replay must go through that consumer, not call this alone.
 * Signed deltas describe net activity at mutation time, not unique visitors or
 * historic cumulative counters attributed to an invented past hour.
 */
@Injectable()
export class ForumInteractionProjectionService {
  async projectInTransaction(tx: Prisma.TransactionClient, event: ForumInteractionEvent) {
    const payload = event.payloadJson as any, delta = payload?.delta;
    if (!delta) return;
    const values = ['views', 'likes', 'comments'].map(key => delta[key] ?? 0);
    if (values.some(value => !Number.isSafeInteger(value) || Math.abs(value) > 2147483647) || values[0] < 0) throw Error('INVALID_INTERACTION_DELTA');
    if (values.every(value => value === 0)) return;
    const occurred = payload.hour ? new Date(payload.hour) : event.occurredAt;
    if (!Number.isFinite(occurred.getTime())) throw Error('INVALID_INTERACTION_HOUR');
    const hour = new Date(Math.floor(occurred.getTime() / HOUR) * HOUR);
    await tx.forumInteractionBucket.upsert({ where: { postId_hour: { postId: event.postId, hour } },
      create: { postId: event.postId, hour, viewDelta: BigInt(values[0]), likeDelta: values[1], commentDelta: values[2] },
      update: { viewDelta: { increment: BigInt(values[0]) }, likeDelta: { increment: values[1] }, commentDelta: { increment: values[2] } } });
  }
}

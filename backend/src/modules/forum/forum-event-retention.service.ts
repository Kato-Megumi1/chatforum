import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { FORUM_EVENT_CONSUMERS } from './forum-events.service';

export const FORUM_EVENT_RETENTION_DAYS = 14;
export const FORUM_EVENT_RETENTION_BATCH = 500;
const CONTROL = 'forum-search:control:v1', BUILD_PREFIX = 'forum-search:build:';
const enabled = () => /^(true|1)$/i.test(process.env.FORUM_EVENT_RETENTION_ENABLED || '');

/** Operational outbox history retention, not a model/task quota. Only old events
 * acknowledged by every required consumer (and any extra consumer) are removed.
 * Source posts/comments, notifications, view batch receipts and subscription
 * delivery/idempotency records are never touched.
 */
@Injectable()
export class ForumEventRetentionService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ForumEventRetentionService.name);
  private timer?: ReturnType<typeof setInterval>;
  private current?: Promise<unknown>;
  constructor(private readonly db: PrismaService) {}
  onApplicationBootstrap() {
    if (!enabled()) return;
    this.timer = setInterval(() => {
      if (!this.current) this.current = this.cleanupOnce().catch(() => this.logger.warn('Forum event retention deferred; no source data removed')).finally(() => { this.current = undefined; });
    }, 60000); this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.current; }

  async cleanupOnce(now = new Date()) {
    if (!enabled()) return { deleted: 0, status: 'disabled' as const };
    const cutoff = new Date(now.getTime() - FORUM_EVENT_RETENTION_DAYS * 86400000);
    if (!Number.isFinite(cutoff.getTime())) throw Error('INVALID_RETENTION_TIME');
    return this.db.$transaction(async tx => {
      // Same lock as search build creation/publication: the no-build check and
      // deletion cannot race a candidate starting catch-up from retained events.
      await tx.forumReadModelState.upsert({ where: { key: CONTROL }, create: { key: CONTROL, payloadJson: {} }, update: {} });
      await tx.$queryRaw(Prisma.sql`SELECT \`key\` FROM forum_read_model_states WHERE \`key\`=${CONTROL} FOR UPDATE`);
      const building = await tx.forumReadModelState.findFirst({ where: { key: { startsWith: BUILD_PREFIX }, status: { in: ['BUILDING', 'READY', 'PUBLISHING'] } }, select: { key: true } });
      if (building) return { deleted: 0, status: 'build_paused' as const };
      const eligible: Prisma.ForumEventWhereInput = { createdAt: { lt: cutoff }, deliveries: { every: { state: 'COMPLETED' } },
        AND: FORUM_EVENT_CONSUMERS.map(consumer => ({ deliveries: { some: { consumer, state: 'COMPLETED' } } })) };
      const candidates = await tx.forumEvent.findMany({ where: eligible, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: FORUM_EVENT_RETENTION_BATCH, select: { id: true } });
      if (!candidates.length) return { deleted: 0, status: 'idle' as const };
      await tx.$queryRaw(Prisma.sql`SELECT id FROM forum_events WHERE id IN (${Prisma.join(candidates.map(event => event.id))}) FOR UPDATE`);
      // Recheck all consumers in the transaction; deletion only cascades the
      // acknowledged ForumEventDelivery rows associated with these exact ids.
      const result = await tx.forumEvent.deleteMany({ where: { ...eligible, id: { in: candidates.map(event => event.id) } } });
      return { deleted: result.count, status: 'cleaned' as const };
    }, { timeout: 15000 });
  }
}

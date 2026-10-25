import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ForumEvent, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';

/** Fan-out is durable even in API processes where a consumer is disabled/not registered. */
export const FORUM_EVENT_CONSUMERS = ['forum-projections-v1', 'forum-search-v1', 'forum-subscriptions-v1'] as const;
export interface AppendForumEvent {
  kind: string; postId: number; postRevision: number; actorId?: number;
  payload?: Prisma.InputJsonValue; occurredAt?: Date; eventKey?: string;
}
export interface ForumEventContext {
  readonly signal: AbortSignal;
  /** DB projections and the delivery acknowledgement commit together. Do not do network I/O here. */
  transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  renew(): Promise<boolean>;
}
export type ForumEventHandler = (event: ForumEvent, context: ForumEventContext) => Promise<void>;
export class ForumConsumerError extends Error {
  constructor(readonly code: string, readonly permanent = false) { super(code); }
}
class LeaseLost extends Error { constructor() { super('FORUM_EVENT_LEASE_LOST'); } }
type Claim = { event: ForumEvent; consumer: string; token: string; attempts: number };

function setting(name: string, fallback: number, min: number, max: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

/** At-least-once outbox delivery. Event ids are never used as a commit-order high-water mark. */
@Injectable()
export class ForumEventsService implements OnModuleDestroy {
  private readonly logger = new Logger(ForumEventsService.name);
  private readonly handlers = new Map<string, ForumEventHandler>();
  private readonly active = new Set<AbortController>();
  private processing = false;
  private stopped = false;
  constructor(private readonly prisma: PrismaService) {}

  register(name: string, handler: ForumEventHandler) {
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(name) || typeof handler !== 'function') throw Error('INVALID_FORUM_CONSUMER');
    if (this.handlers.has(name)) throw Error('DUPLICATE_FORUM_CONSUMER');
    this.handlers.set(name, handler);
    return () => { if (this.handlers.get(name) === handler) this.handlers.delete(name); };
  }

  async append(tx: Prisma.TransactionClient, input: AppendForumEvent): Promise<ForumEvent> {
    if (!/^[A-Z][A-Z0-9_]{0,47}$/.test(input.kind) || !Number.isSafeInteger(input.postId) || input.postId < 1
      || !Number.isSafeInteger(input.postRevision) || input.postRevision < 0
      || input.actorId !== undefined && (!Number.isSafeInteger(input.actorId) || input.actorId < 1)
      || input.occurredAt && !Number.isFinite(input.occurredAt.getTime())) throw Error('INVALID_FORUM_EVENT');
    const eventKey = input.eventKey || randomUUID();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(eventKey)) throw Error('INVALID_FORUM_EVENT_KEY');
    const payload = input.payload ?? {}, serialized = JSON.stringify(payload);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 32768) throw Error('FORUM_EVENT_PAYLOAD_TOO_LARGE');
    const event = await tx.forumEvent.upsert({ where: { eventKey }, update: {}, create: {
      eventKey, kind: input.kind, postId: input.postId, postRevision: input.postRevision, actorId: input.actorId,
      payloadJson: payload, occurredAt: input.occurredAt || new Date(),
    } });
    if (event.kind !== input.kind || event.postId !== input.postId || event.postRevision !== input.postRevision
      || event.actorId !== (input.actorId ?? null) || canonical(event.payloadJson) !== canonical(payload)
      || input.occurredAt && event.occurredAt.getTime() !== input.occurredAt.getTime()) throw Error('FORUM_EVENT_KEY_CONFLICT');
    const consumers = [...new Set<string>([...FORUM_EVENT_CONSUMERS, ...this.handlers.keys()])];
    await tx.forumEventDelivery.createMany({ data: consumers.map(consumer => ({ eventId: event.id, consumer })), skipDuplicates: true });
    return event;
  }

  private leaseMs() { return setting('FORUM_EVENTS_LEASE_MS', 60000, 1000, 300000); }

  private async claimNext(): Promise<Claim | null> {
    const names = [...this.handlers.keys()];
    if (!names.length || this.stopped) return null;
    return this.prisma.$transaction(async tx => {
      const now = new Date();
      const rows = await tx.$queryRaw<Array<{ eventId: bigint; consumer: string; attempts: number }>>(Prisma.sql`
        SELECT eventId,consumer,attempts FROM forum_event_deliveries
        WHERE consumer IN (${Prisma.join(names)}) AND availableAt<=${now}
          AND (state='PENDING' OR (state='PROCESSING' AND leaseUntil<=${now}))
        ORDER BY availableAt ASC,eventId ASC LIMIT 1 FOR UPDATE SKIP LOCKED`);
      if (!rows.length) return null;
      const row = rows[0], token = randomUUID();
      if (row.attempts >= setting('FORUM_EVENTS_MAX_ATTEMPTS', 12, 1, 100)) {
        // Crashes can consume leases without ever reaching fail(); they must not retry forever either.
        await tx.forumEventDelivery.update({ where: { eventId_consumer: { eventId: row.eventId, consumer: row.consumer } },
          data: { state: 'DEAD', errorCode: 'LEASE_RETRY_EXHAUSTED', leaseToken: null, leaseUntil: null } });
        return null;
      }
      await tx.forumEventDelivery.update({ where: { eventId_consumer: { eventId: row.eventId, consumer: row.consumer } },
        data: { state: 'PROCESSING', attempts: { increment: 1 }, leaseToken: token,
          leaseUntil: new Date(now.getTime() + this.leaseMs()), errorCode: null } });
      const event = await tx.forumEvent.findUniqueOrThrow({ where: { id: row.eventId } });
      return { event, consumer: row.consumer, token, attempts: row.attempts + 1 };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 10000 });
  }

  private async renew(claim: Claim) {
    const now = new Date();
    const result = await this.prisma.forumEventDelivery.updateMany({ where: { eventId: claim.event.id, consumer: claim.consumer,
      state: 'PROCESSING', leaseToken: claim.token, leaseUntil: { gt: now } }, data: { leaseUntil: new Date(now.getTime() + this.leaseMs()) } });
    return result.count === 1;
  }

  private async deliver(claim: Claim) {
    const handler = this.handlers.get(claim.consumer), controller = new AbortController();
    this.active.add(controller);
    let completed = false, renewing = false;
    const context: ForumEventContext = {
      signal: controller.signal,
      renew: () => this.renew(claim),
      transaction: async <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> => {
        if (completed) throw Error('FORUM_DELIVERY_ALREADY_ACKNOWLEDGED');
        controller.signal.throwIfAborted();
        const result = await this.prisma.$transaction(async tx => {
          const [owned] = await tx.$queryRaw<Array<{ leaseUntil: Date }>>`SELECT leaseUntil FROM forum_event_deliveries
            WHERE eventId=${claim.event.id} AND consumer=${claim.consumer} AND state='PROCESSING' AND leaseToken=${claim.token} FOR UPDATE`;
          if (!owned || owned.leaseUntil.getTime() <= Date.now()) throw new LeaseLost();
          controller.signal.throwIfAborted();
          const value = await work(tx);
          controller.signal.throwIfAborted();
          const changed = await tx.forumEventDelivery.updateMany({ where: { eventId: claim.event.id, consumer: claim.consumer,
            state: 'PROCESSING', leaseToken: claim.token, leaseUntil: { gt: new Date() } }, data: {
            state: 'COMPLETED', completedAt: new Date(), leaseToken: null, leaseUntil: null, errorCode: null } });
          if (changed.count !== 1) throw new LeaseLost();
          return value;
        }, { timeout: 15000 });
        completed = true;
        return result;
      },
    };
    const heartbeat = setInterval(() => {
      if (renewing || completed || controller.signal.aborted) return;
      renewing = true;
      void this.renew(claim).then(owned => { if (!owned) controller.abort(new LeaseLost()); })
        .catch(() => controller.abort(new LeaseLost())).finally(() => { renewing = false; });
    }, Math.max(250, Math.floor(this.leaseMs() / 3)));
    heartbeat.unref();
    try {
      if (this.stopped || !handler) throw new ForumConsumerError('CONSUMER_NOT_AVAILABLE');
      await handler(claim.event, context);
      if (!completed) await context.transaction(async () => undefined);
    } catch (error) {
      if (!completed) await this.fail(claim, error);
    } finally {
      clearInterval(heartbeat); this.active.delete(controller);
    }
  }

  private async fail(claim: Claim, error: unknown) {
    const dead = error instanceof ForumConsumerError && error.permanent
      || claim.attempts >= setting('FORUM_EVENTS_MAX_ATTEMPTS', 12, 1, 100);
    const code = error instanceof ForumConsumerError && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code
      : error instanceof LeaseLost ? 'CONSUMER_LEASE_LOST' : this.stopped ? 'WORKER_STOPPED' : 'CONSUMER_FAILED';
    const backoffMs = Math.min(3600000, 1000 * 2 ** Math.min(20, claim.attempts - 1));
    try {
      await this.prisma.forumEventDelivery.updateMany({ where: { eventId: claim.event.id, consumer: claim.consumer,
        state: 'PROCESSING', leaseToken: claim.token }, data: { state: dead ? 'DEAD' : 'PENDING', errorCode: code,
          availableAt: new Date(Date.now() + backoffMs), leaseUntil: null, leaseToken: null } });
    } catch { this.logger.warn('Forum delivery retry deferred; the persisted lease remains reclaimable'); }
  }

  /** Finite polling batches are operational work units, not a user/model task quota. */
  async runBatch(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('INVALID_FORUM_EVENT_BATCH');
    if (this.processing || this.stopped) return 0;
    this.processing = true;
    let processed = 0;
    try {
      // Claim just before execution, so waiting items do not burn their lease behind slow HTTP calls.
      while (processed < limit && !this.stopped) {
        const claim = await this.claimNext(); if (!claim) break;
        await this.deliver(claim); processed++;
      }
      return processed;
    } finally { this.processing = false; }
  }

  async diagnostics() {
    const rows = await this.prisma.$queryRaw<Array<{ consumer: string; state: string; count: bigint; oldestAt: Date | null }>>`
      SELECT d.consumer,d.state,COUNT(*) AS count,MIN(e.createdAt) AS oldestAt
      FROM forum_event_deliveries d JOIN forum_events e ON e.id=d.eventId GROUP BY d.consumer,d.state`;
    const dead = await this.prisma.forumEventDelivery.findMany({ where: { state: 'DEAD' }, take: 20,
      orderBy: [{ availableAt: 'asc' }, { eventId: 'asc' }], select: { eventId: true, consumer: true, attempts: true, errorCode: true, availableAt: true } });
    return { observedAt: new Date().toISOString(), workerEnabled: process.env.FORUM_EVENTS_WORKER_ENABLED === 'true',
      registeredConsumers: [...this.handlers.keys()], delivery: 'at_least_once', commitCursor: 'per_delivery_not_max_event_id',
      queues: rows.map(row => ({ consumer: row.consumer, state: row.state, count: Number(row.count), oldestAt: row.oldestAt?.toISOString() ?? null,
        lagMs: ['PENDING', 'PROCESSING'].includes(row.state) && row.oldestAt ? Math.max(0, Date.now() - row.oldestAt.getTime()) : 0 })),
      dead: dead.map(row => ({ ...row, eventId: String(row.eventId), availableAt: row.availableAt.toISOString() })) };
  }

  /** Explicit operator retry only; DEAD deliveries are not silently discarded or auto-acknowledged. */
  async retryDead(consumer: string, limit = 20) {
    if (!/^[a-z][a-z0-9._-]{0,79}$/.test(consumer) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw Error('INVALID_FORUM_EVENT_RETRY');
    return this.prisma.$executeRaw`UPDATE forum_event_deliveries SET state='PENDING',attempts=0,errorCode=NULL,
      availableAt=CURRENT_TIMESTAMP(3),leaseToken=NULL,leaseUntil=NULL,updatedAt=CURRENT_TIMESTAMP(3)
      WHERE consumer=${consumer} AND state='DEAD' ORDER BY availableAt ASC,eventId ASC LIMIT ${limit}`;
  }

  stop() { this.stopped = true; for (const controller of this.active) controller.abort(new Error('WORKER_STOPPED')); }
  onModuleDestroy() { this.stop(); }
}

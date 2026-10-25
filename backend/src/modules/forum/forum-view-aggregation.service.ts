import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { ForumEventsService } from './forum-events.service';

const enabled = (key: string) => /^(true|1)$/i.test(process.env[key] || '');
const SHARDS = 32, GROUP = 'forum-view-db-v1', HOUR = 3600000;
export const FORUM_VIEW_DEDUPE_MS = 30 * 60000;
export const FORUM_VIEW_RECORD_LUA = `
if redis.call('SET',KEYS[1],'1','PX',ARGV[2],'NX') then
 redis.call('HINCRBY',KEYS[2],ARGV[1],1)
 redis.call('SADD',KEYS[3],ARGV[1])
 return 1
end
return 0`;
// XADD precedes removing the active counter. Never trim a pending/unread batch.
export const FORUM_VIEW_ROTATE_LUA = `
local fields=redis.call('SRANDMEMBER',KEYS[2],tonumber(ARGV[2]))
local moved=0
for i,field in ipairs(fields) do
 local count=redis.call('HGET',KEYS[1],field)
 if count and tonumber(count)>0 then
  redis.call('XADD',KEYS[3],'*','batchId',ARGV[1]..':'..i,'field',field,'count',count)
  redis.call('HDEL',KEYS[1],field)
  moved=moved+1
 end
 redis.call('SREM',KEYS[2],field)
end
return moved`;

export type ViewRecordResult = { counted: boolean; status: 'queued' | 'duplicate' | 'unavailable' | 'disabled'; persistence: 'redis_pending' | 'none' };
type ViewBatch = { batchId: string; postId: number; hour: Date; count: number; payloadHash: string };
const keys = (shard: number) => { const base = `forum:views:v1:{${shard}}`; return { counts: base + ':counts', dirty: base + ':dirty', stream: base + ':batches', dedupe: base + ':dedupe:' }; };

/** Best-effort Redis intake, durable/idempotent DB application only after stream rotation.
 * Redis/AOF loss can lose pending views or dedupe receipts. A timeout is ambiguous:
 * intake may have completed, so callers must never retry through a SQL fallback.
 */
@Injectable()
export class ForumViewAggregationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ForumViewAggregationService.name);
  private readonly consumer = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private unavailableUntil = 0;
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService, private readonly events: ForumEventsService) {}

  onModuleInit() {
    if (!enabled('FORUM_VIEW_AGGREGATION_ENABLED') || !enabled('FORUM_VIEW_WORKER_ENABLED')) return;
    this.timer = setInterval(() => { if (!this.running) this.running = this.flushOnce().catch(() => this.logger.warn('View batch worker deferred; pending batches retained')).finally(() => { this.running = undefined; }); }, 5000);
    this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running; }

  async record(postId: number, viewerHash: string, now = new Date()): Promise<ViewRecordResult> {
    const none = (status: 'unavailable' | 'disabled'): ViewRecordResult => ({ counted: false, status, persistence: 'none' });
    if (!enabled('FORUM_VIEW_AGGREGATION_ENABLED')) return none('disabled');
    if (!Number.isSafeInteger(postId) || postId <= 0 || !viewerHash || viewerHash.length > 512 || !Number.isFinite(now.getTime())) return none('unavailable');
    const client = this.redis.getClient();
    if (Date.now() < this.unavailableUntil || (client.status && client.status !== 'ready')) return none('unavailable');
    const k = keys(postId % SHARDS), digest = createHash('sha256').update(viewerHash).digest('hex');
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        client.eval(FORUM_VIEW_RECORD_LUA, 3, k.dedupe + postId + ':' + digest, k.counts, k.dirty,
          postId + '|' + Math.floor(now.getTime() / HOUR) * HOUR, FORUM_VIEW_DEDUPE_MS),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(Error('VIEW_INTAKE_TIMEOUT')), 100); }),
      ]);
      return { counted: Number(result) === 1, status: Number(result) === 1 ? 'queued' : 'duplicate', persistence: 'redis_pending' };
    } catch { this.unavailableUntil = Date.now() + 1000; return none('unavailable'); }
    finally { clearTimeout(timeout); }
  }

  private decode(fields: string[]): ViewBatch {
    const data = Object.fromEntries(Array.from({ length: fields.length / 2 }, (_, i) => [fields[i * 2], fields[i * 2 + 1]]));
    const [postId, hour] = (data.field || '').split('|').map(Number), count = Number(data.count);
    if (!/^[a-f0-9-]{36}:\d+$/.test(data.batchId || '') || !Number.isSafeInteger(postId) || postId <= 0
      || !Number.isSafeInteger(hour) || hour < 0 || hour % HOUR || !Number.isSafeInteger(count) || count <= 0 || count > 2147483647) throw Error('INVALID_VIEW_BATCH');
    return { batchId: data.batchId, postId, hour: new Date(hour), count,
      payloadHash: createHash('sha256').update(JSON.stringify([postId, hour, count])).digest('hex') };
  }

  private async merge(batch: ViewBatch) {
    try {
      await this.prisma.$transaction(async tx => {
        const previous = await tx.forumViewBatch.findUnique({ where: { id: batch.batchId } });
        if (previous) { if (previous.payloadHash !== batch.payloadHash) throw Error('VIEW_BATCH_HASH_MISMATCH'); return; }
        await tx.forumViewBatch.create({ data: { id: batch.batchId, payloadHash: batch.payloadHash, postId: batch.postId, count: batch.count, bucketStart: batch.hour } });
        const changed = await tx.$executeRaw`UPDATE posts SET viewCount=viewCount+${batch.count} WHERE id=${batch.postId}`;
        if (!changed) return; // Deleted posts are not recreated, but the batch is durably consumed.
        // Read the revision after acquiring the batch update lock, not an older RR snapshot.
        const post = await tx.post.findUnique({ where: { id: batch.postId }, select: { id: true, revision: true } });
        await this.events.append(tx, { kind: 'VIEW_AGGREGATED', postId: batch.postId, postRevision: post.revision,
          payload: { batchId: batch.batchId, delta: { views: batch.count }, hour: batch.hour.toISOString() } });
      });
    } catch (error) {
      if (error?.code !== 'P2002') throw error;
      const committed = await this.prisma.forumViewBatch.findUnique({ where: { id: batch.batchId } });
      if (!committed || committed.payloadHash !== batch.payloadHash) throw error;
    }
  }

  async flushOnce() {
    if (!enabled('FORUM_VIEW_AGGREGATION_ENABLED')) return;
    const client = this.redis.getClient();
    if (client.status && client.status !== 'ready') return;
    for (let shard = 0; shard < SHARDS; shard++) {
      const k = keys(shard);
      await client.eval(FORUM_VIEW_ROTATE_LUA, 3, k.counts, k.dirty, k.stream, randomUUID(), 100);
      try { await client.xgroup('CREATE', k.stream, GROUP, '0', 'MKSTREAM'); }
      catch (error) { if (!String(error?.message).includes('BUSYGROUP')) throw error; }
      const reclaimed = await client.xautoclaim(k.stream, GROUP, this.consumer, 60000, '0-0', 'COUNT', 100) as any;
      const fresh = await client.xreadgroup('GROUP', GROUP, this.consumer, 'COUNT', 100, 'STREAMS', k.stream, '>') as any;
      const entries = [...(reclaimed?.[1] || []), ...(fresh?.[0]?.[1] || [])] as Array<[string, string[]]>;
      for (const [entryId, fields] of entries) {
        try {
          await this.merge(this.decode(fields));
          // ACK only after DB/outbox commit. Delete only the exact acknowledged entry.
          if (await client.xack(k.stream, GROUP, entryId)) await client.xdel(k.stream, entryId);
        } catch { this.logger.warn('View batch not acknowledged; retained for reclaim'); }
      }
    }
  }
}

import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { forumHotScore } from './forum-query.sql';

export const FORUM_HOT_GENERATION_SECONDS = 600;
export const FORUM_HOT_REFRESH_SECONDS = 60;
export const FORUM_HOT_STALE_SECONDS = 180;
export const FORUM_HOT_CAPACITY = 200;
export const FORUM_HOT_PRECOMPUTE_VERSION = 'forum-hot-background-v2';
export type ForumRankingBasis = 'published' | 'interaction';
export interface HotScope { hours: 24 | 168; categoryId?: number; rankingBasis: ForumRankingBasis; }
const HOUR = 3600000, LEASE_MS = 120000;
const enabled = () => /^(true|1)$/i.test(process.env.FORUM_HOT_PRECOMPUTE_ENABLED || '');
const rowSchema = z.object({ id: z.number().int().positive(), createdAt: z.string().datetime(), viewCount: z.number().int().nonnegative(),
  likeCount: z.number().int().nonnegative(), commentCount: z.number().int().nonnegative(), score: z.number().finite(),
  windowViews: z.number().int().optional(), windowLikes: z.number().int().optional(), windowComments: z.number().int().optional() }).strict();
const snapshotSchema = z.object({ version: z.literal(FORUM_HOT_PRECOMPUTE_VERSION), id: z.string().regex(/^[a-f0-9]{64}\.[a-f0-9-]{36}$/),
  scopeKey: z.string().regex(/^[a-f0-9]{64}$/), asOf: z.string().datetime(), expiresAt: z.string().datetime(), rankingBasis: z.enum(['published', 'interaction']),
  hours: z.union([z.literal(24), z.literal(168)]), categoryId: z.number().int().positive().nullable(), interactionWindowStart: z.string().datetime().nullable(),
  hasMoreBeyondCoverage: z.boolean(), rows: z.array(rowSchema).max(FORUM_HOT_CAPACITY) }).strict();
export type PublishedHotSnapshot = z.infer<typeof snapshotSchema>;
export type HotPublishedHook = (tx: Prisma.TransactionClient, current: PublishedHotSnapshot, previous?: PublishedHotSnapshot) => Promise<void>;
export const FORUM_HOT_PUBLISH_LUA = `
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3])
redis.call('SET',KEYS[3],ARGV[2],'EX',ARGV[3])
return 1`;
const RENEW = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";

/** All expensive ranking is here, never in an HTTP/Agent cache miss. Redis stores
 * immutable generations separately from the current pointer so refresh does not
 * invalidate an existing cursor. No unacknowledged stream is trimmed here.
 */
@Injectable()
export class ForumHotWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ForumHotWorkerService.name);
  private readonly local = new Map<string, PublishedHotSnapshot>();
  private timer?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private publishedHook?: HotPublishedHook;
  constructor(private readonly prisma: PrismaService, @Optional() private readonly redis?: RedisService) {}
  onModuleInit() {
    if (!enabled()) return;
    const tick = () => { if (!this.running) this.running = this.rebuildOnce().catch(() => this.logger.warn('Hot precompute deferred; previous generations retained')).finally(() => { this.running = undefined; }); };
    this.startup = setTimeout(tick, 1000); this.startup.unref();
    this.timer = setInterval(tick, FORUM_HOT_REFRESH_SECONDS * 1000); this.timer.unref();
  }
  async onModuleDestroy() { if (this.startup) clearTimeout(this.startup); if (this.timer) clearInterval(this.timer); await this.running; }
  setPublishedHook(hook: HotPublishedHook) { this.publishedHook = hook; }

  private async persistPublished(value: PublishedHotSnapshot) {
    const stateKey = 'hot:v2:' + value.scopeKey;
    await this.prisma.$transaction(async tx => {
      // A read-model row is the publication hook's durable idempotency boundary.
      // This lock is only in the worker, never acquired by a forum read request.
      await tx.$executeRaw`INSERT IGNORE INTO forum_read_model_states (\`key\`,status,updatedAt) VALUES (${stateKey},'IDLE',${new Date()})`;
      const [previousRow] = await tx.$queryRaw<Array<{ payloadJson: unknown }>>(Prisma.sql`SELECT payloadJson FROM forum_read_model_states WHERE \`key\`=${stateKey} FOR UPDATE`);
      const previous = snapshotSchema.safeParse(previousRow?.payloadJson);
      if (previous.success && (previous.data.id === value.id || Date.parse(previous.data.asOf) > Date.parse(value.asOf))) return;
      await tx.forumReadModelState.update({ where: { key: stateKey }, data: { status: 'READY', payloadJson: value as any } });
      if (this.publishedHook) await this.publishedHook(tx, value, previous.success ? previous.data : undefined);
    });
  }

  scopeKey(scope: HotScope) { return createHash('sha256').update(JSON.stringify([FORUM_HOT_PRECOMPUTE_VERSION, scope.rankingBasis, scope.hours, scope.categoryId ?? null])).digest('hex'); }
  private keys(scope: HotScope) { const hash = this.scopeKey(scope), base = 'forum:hot:v2:{' + hash + '}'; return { hash, current: base + ':current', lease: base + ':lease', generation: (id: string) => base + ':generation:' + id }; }
  private remember(value: PublishedHotSnapshot) {
    for (const [id, row] of this.local) if (Date.parse(row.expiresAt) <= Date.now()) this.local.delete(id);
    this.local.delete(value.id); this.local.set(value.id, value);
    while (this.local.size > 256) this.local.delete(this.local.keys().next().value);
  }
  async read(scope: HotScope, generationId?: string): Promise<{ value?: PublishedHotSnapshot; backend: 'redis' | 'process_fallback' | 'none'; enabled: boolean }> {
    if (!enabled()) return { backend: 'none', enabled: false };
    const k = this.keys(scope);
    if (generationId && (!generationId.startsWith(k.hash + '.') || !/^[a-f0-9]{64}\.[a-f0-9-]{36}$/.test(generationId))) return { backend: 'none', enabled: true };
    try {
      if (this.redis) {
        const raw = await this.redis.get(generationId ? k.generation(generationId) : k.current);
        if (raw && raw.length <= 150000) {
          const parsed = snapshotSchema.safeParse(JSON.parse(raw));
          if (parsed.success && parsed.data.scopeKey === k.hash && (!generationId || parsed.data.id === generationId)
            && Date.parse(parsed.data.expiresAt) > Date.now() && Date.parse(parsed.data.asOf) <= Date.now()
            && Date.parse(parsed.data.expiresAt) - Date.parse(parsed.data.asOf) <= FORUM_HOT_GENERATION_SECONDS * 1000) {
            this.remember(parsed.data); return { value: parsed.data, backend: 'redis', enabled: true };
          }
        }
      }
    } catch { /* Last observed public generation only: no request-time SQL fallback. */ }
    const candidates = [...this.local.values()].filter(row => row.scopeKey === k.hash && Date.parse(row.expiresAt) > Date.now()
      && (!generationId || row.id === generationId)).sort((a, b) => Date.parse(b.asOf) - Date.parse(a.asOf));
    return { value: candidates[0], backend: candidates.length ? 'process_fallback' : 'none', enabled: true };
  }

  private async rank(scope: HotScope, asOf: Date) {
    const category = scope.categoryId ? Prisma.sql`AND p.categoryId=${scope.categoryId}` : Prisma.empty;
    if (scope.rankingBasis === 'published') {
      const score = forumHotScore(asOf);
      return this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT p.id,p.createdAt,p.viewCount,p.likeCount,p.commentCount,${score} AS score
        FROM posts p WHERE p.status='APPROVED' AND p.createdAt<=${asOf} AND p.createdAt>=${new Date(asOf.getTime() - scope.hours * HOUR)} ${category}
        ORDER BY score DESC,p.createdAt DESC,p.id DESC LIMIT ${FORUM_HOT_CAPACITY + 1}`);
    }
    // Includes the current partial hour plus the preceding H-1 complete hours.
    // Boundary is explicit in metadata; this is not an exact rolling-second count.
    const start = new Date((Math.floor(asOf.getTime() / HOUR) + 1 - scope.hours) * HOUR);
    return this.prisma.$queryRaw<any[]>(Prisma.sql`SELECT p.id,p.createdAt,p.viewCount,p.likeCount,p.commentCount,
      SUM(b.viewDelta) AS windowViews,SUM(b.likeDelta) AS windowLikes,SUM(b.commentDelta) AS windowComments,
      GREATEST(0,SUM((b.likeDelta*3+b.commentDelta*2+b.viewDelta*0.1)/POW(GREATEST(0,TIMESTAMPDIFF(SECOND,b.hour,${asOf})/3600)+2,1.5))) AS score
      FROM forum_interaction_buckets b JOIN posts p ON p.id=b.postId
      WHERE b.hour>=${start} AND b.hour<=${asOf} AND p.status='APPROVED' AND p.createdAt<=${asOf} ${category}
      GROUP BY p.id,p.createdAt,p.viewCount,p.likeCount,p.commentCount HAVING score>0
      ORDER BY score DESC,p.createdAt DESC,p.id DESC LIMIT ${FORUM_HOT_CAPACITY + 1}`);
  }

  async publishScope(scope: HotScope): Promise<boolean> {
    if (!enabled() || !this.redis) return false;
    const client = this.redis.getClient(), k = this.keys(scope), token = randomUUID();
    if (client.status && client.status !== 'ready') return false;
    if (!await client.set(k.lease, token, 'PX', LEASE_MS, 'NX')) return false;
    let lost = false;
    const renewal = setInterval(() => { void client.eval(RENEW, 1, k.lease, token, LEASE_MS).then(result => { if (!result) lost = true; }, () => { lost = true; }); }, LEASE_MS / 3);
    renewal.unref();
    try {
      // Crash after Redis publication but before DB/outbox commit is reconciled
      // before the next build. The DB snapshot id prevents repeated hook events.
      const previousPublication = await this.read(scope);
      if (previousPublication.backend === 'redis' && previousPublication.value) await this.persistPublished(previousPublication.value);
      const asOf = new Date(), ranked = await this.rank(scope, asOf);
      const rows = ranked.slice(0, FORUM_HOT_CAPACITY).map(row => ({ id: Number(row.id), createdAt: new Date(row.createdAt).toISOString(), viewCount: Number(row.viewCount),
        likeCount: Number(row.likeCount), commentCount: Number(row.commentCount), score: Number(row.score),
        ...(scope.rankingBasis === 'interaction' ? { windowViews: Number(row.windowViews), windowLikes: Number(row.windowLikes), windowComments: Number(row.windowComments) } : {}) }));
      const value = snapshotSchema.parse({ version: FORUM_HOT_PRECOMPUTE_VERSION, id: k.hash + '.' + randomUUID(), scopeKey: k.hash,
        asOf: asOf.toISOString(), expiresAt: new Date(asOf.getTime() + FORUM_HOT_GENERATION_SECONDS * 1000).toISOString(), rankingBasis: scope.rankingBasis,
        hours: scope.hours, categoryId: scope.categoryId ?? null, interactionWindowStart: scope.rankingBasis === 'interaction'
          ? new Date((Math.floor(asOf.getTime() / HOUR) + 1 - scope.hours) * HOUR).toISOString() : null,
        hasMoreBeyondCoverage: ranked.length > FORUM_HOT_CAPACITY, rows });
      if (lost || Date.parse(value.expiresAt) <= Date.now()) return false;
      const remaining = Math.ceil((Date.parse(value.expiresAt) - Date.now()) / 1000);
      const published = await client.eval(FORUM_HOT_PUBLISH_LUA, 3, k.lease, k.generation(value.id), k.current, token, JSON.stringify(value), remaining);
      if (!published) return false;
      this.remember(value);
      await this.persistPublished(value);
      return true;
    } finally { clearInterval(renewal); await client.eval(RELEASE, 1, k.lease, token).catch(() => undefined); }
  }

  async rebuildOnce() {
    if (!enabled()) return;
    let after = 0;
    const publish = async (categoryId?: number) => {
      for (const rankingBasis of ['published', 'interaction'] as const) for (const hours of [24, 168] as const) {
        try { await this.publishScope({ hours, rankingBasis, categoryId }); }
        catch { this.logger.warn('Hot scope build failed; previous generation retained'); }
      }
    };
    await publish();
    while (true) {
      const categories = await this.prisma.category.findMany({ where: { id: { gt: after } }, orderBy: { id: 'asc' }, take: 100, select: { id: true } });
      for (const category of categories) { await publish(category.id); after = category.id; }
      if (categories.length < 100) break;
    }
    // Buckets are a derived projection. Cleanup belongs only to the background
    // worker and is bounded; no historical cumulative counters are backfilled.
    await this.prisma.$executeRaw`DELETE FROM forum_interaction_buckets WHERE hour<${new Date(Date.now() - 8 * 24 * HOUR)} LIMIT 1000`;
  }
}

import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { forumSearchClauses } from './forum-query.sql';
import { ForumHotWorkerService, ForumRankingBasis, FORUM_HOT_CAPACITY, FORUM_HOT_GENERATION_SECONDS, FORUM_HOT_STALE_SECONDS } from './forum-hot-worker.service';

export const FORUM_HOT_SNAPSHOT_TTL_SECONDS = FORUM_HOT_GENERATION_SECONDS;
export const FORUM_HOT_SNAPSHOT_CAPACITY = FORUM_HOT_CAPACITY;
export interface ForumHotFilters {
  hours?: number; categoryId?: number; category?: string; tagId?: number; userId?: number; query?: string;
  sortBy?: 'hotness' | 'views' | 'likes' | 'comments'; sortOrder?: 'asc' | 'desc'; rankingBasis?: ForumRankingBasis;
}
export interface ForumHotRow {
  id: number; createdAt: Date; viewCount: number; likeCount: number; commentCount: number; score: number;
  windowViews?: number; windowLikes?: number; windowComments?: number;
}

/** Read published public IDs/metrics, then recheck public visibility and every
 * requested filter. A miss NEVER triggers full-set SQL ranking in this class.
 */
@Injectable()
export class ForumSnapshotService {
  private readonly published: ForumHotWorkerService;
  constructor(private readonly prisma: PrismaService, @Optional() redis?: RedisService, @Optional() worker?: ForumHotWorkerService) {
    this.published = worker || new ForumHotWorkerService(prisma, redis);
  }
  private where(filters: ForumHotFilters, asOf: Date) {
    const clauses = [Prisma.sql`p.status='APPROVED'`, Prisma.sql`p.createdAt<=${asOf}`];
    if (filters.rankingBasis !== 'interaction' && filters.hours !== undefined) clauses.push(Prisma.sql`p.createdAt>=${new Date(Math.max(0, asOf.getTime() - filters.hours * 3600000))}`);
    if (filters.categoryId) clauses.push(Prisma.sql`p.categoryId=${filters.categoryId}`);
    if (filters.category) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM categories c WHERE c.id=p.categoryId AND c.name=${filters.category})`);
    if (filters.tagId) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM post_tags pt WHERE pt.postId=p.id AND pt.tagId=${filters.tagId})`);
    if (filters.userId) clauses.push(Prisma.sql`p.userId=${filters.userId}`);
    clauses.push(...forumSearchClauses(filters.query)); return Prisma.join(clauses, ' AND ');
  }
  async hot(input: ForumHotFilters, page: { offset?: number; limit: number; snapshotId?: string }, db: Prisma.TransactionClient = this.prisma) {
    const filters = { ...input, query: input.query?.trim() || undefined, rankingBasis: input.rankingBasis || 'published' as ForumRankingBasis,
      sortBy: input.sortBy || 'hotness', sortOrder: input.sortOrder || 'desc' };
    const offset = page.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 50
      || !['published', 'interaction'].includes(filters.rankingBasis)) throw Error('INVALID_ARGUMENTS');
    const supported = (filters.hours === 24 || filters.hours === 168) && filters.sortOrder === 'desc';
    const stable = supported && filters.sortBy === 'hotness' && !filters.query && !filters.category && !filters.tagId && !filters.userId;
    if (!stable && (offset || page.snapshotId)) throw Error('FORUM_SNAPSHOT_EXPIRED');
    const read = supported ? await this.published.read({ hours: filters.hours as 24 | 168, categoryId: filters.categoryId, rankingBasis: filters.rankingBasis }, page.snapshotId)
      : { value: undefined, backend: 'none' as const, enabled: true };
    const stored = read.value;
    if (page.snapshotId && (!stored || stored.id !== page.snapshotId)) throw Error('FORUM_SNAPSHOT_EXPIRED');
    const asOf = stored ? new Date(stored.asOf) : new Date(), ageMs = Math.max(0, Date.now() - asOf.getTime());
    const snapshot = { id: stable && stored ? stored.id : null, asOf: asOf.toISOString(), ageMs,
      ttlSeconds: FORUM_HOT_GENERATION_SECONDS, expiresAt: stored?.expiresAt || null,
      mode: stable && stored ? 'shared_top_200' as const : 'live_query' as const, cacheBackend: read.backend,
      paging: stable && stored ? 'snapshot' as const : 'first_page_only' as const,
      status: !supported ? 'unsupported_scope' : !read.enabled ? 'disabled' : !stored ? 'not_ready' : ageMs > FORUM_HOT_STALE_SECONDS * 1000 ? 'stale' : 'ready',
      source: 'background_precomputed', rankingBasis: filters.rankingBasis,
      coverageLimit: FORUM_HOT_CAPACITY, rankedCount: stored?.rows.length ?? null, hasMoreBeyondCoverage: stored?.hasMoreBeyondCoverage || false,
      removedCount: 0, coverageLimited: !stable, coverage: stable ? 'published_top_200' : 'filtered_top_200_candidates',
      countBasis: 'cumulative_at_snapshot', windowCountsBasis: filters.rankingBasis === 'interaction' ? 'signed_net_deltas_since_activation' : null,
      interactionWindowStart: stored?.interactionWindowStart || null, interactionWindowEnd: filters.rankingBasis === 'interaction' ? stored?.asOf || null : null,
      bucketGranularity: filters.rankingBasis === 'interaction' ? 'hour_including_current_partial_hour' : null };
    if (!stored) return { rows: [] as ForumHotRow[], asOf, hasMore: false, snapshot };
    let candidates = stored.rows.map(row => ({ ...row, createdAt: new Date(row.createdAt) }));
    if (stable) candidates = candidates.slice(offset, offset + page.limit);
    // Bounded public ID lookup, never ranking an unbounded matching set in a request.
    const visible = candidates.length ? await db.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT p.id FROM posts p
      WHERE p.id IN (${Prisma.join(candidates.map(row => row.id))}) AND ${this.where(filters, asOf)}`) : [];
    const ids = new Set(visible.map(row => row.id));
    let kept = candidates.filter(row => ids.has(row.id)); snapshot.removedCount = candidates.length - kept.length;
    if (!stable) {
      const field = { hotness: 'score', views: 'viewCount', likes: 'likeCount', comments: 'commentCount' }[filters.sortBy];
      kept.sort((a, b) => Number(b[field]) - Number(a[field]) || b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
    }
    const hasMore = stable ? offset + page.limit < stored.rows.length : kept.length > page.limit;
    if (!stable) kept = kept.slice(0, page.limit);
    snapshot.ageMs = Math.max(0, Date.now() - asOf.getTime());
    return { rows: kept, asOf, hasMore, snapshot };
  }
}

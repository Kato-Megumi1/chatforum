import { Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import configuration from '../../config/configuration';
import { forumSearchClauses, FORUM_HOT_FORMULA } from './forum-query.sql';
import { ForumSnapshotService } from './forum-snapshot.service';
import { ForumSearchService } from './forum-search.service';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { z } from 'zod';
import { currentToolWriteApproval } from '../tool-runs/tool-run.policy';
import { decodeCursor, detailQuery, encodeCursor, filterKey, FORUM_DISCOVERY_VERSION, ForumScope,
  hotQuery, rankChanges, recentQuery, searchQuery, RankedPost } from './forum-discovery.policy';

type Db = Prisma.TransactionClient;
interface Row extends RankedPost { title: string; author: string; category: string; categoryId: number;
  createdAt: Date; score?: number; snippet?: string; content?: string; contentLength?: bigint; }
const fields = Prisma.sql`p.id, p.title, p.categoryId, u.username AS author, c.name AS category,
  p.createdAt, p.viewCount, p.likeCount, p.commentCount`;
const joins = Prisma.sql`FROM posts p JOIN users u ON u.id=p.userId JOIN categories c ON c.id=p.categoryId`;

/** Database read model shared by all forum tools. No model calls, no view-count side effects. */
@Injectable()
export class ForumDiscoveryService {
  private readonly snapshots: ForumSnapshotService;
  constructor(private readonly prisma: PrismaService, @Optional() snapshots?: ForumSnapshotService,
    @Optional() private readonly searchEngine?: ForumSearchService, @Optional() private readonly subscriptions?: ForumSubscriptionsService) {
    // Direct construction remains useful for isolated tests; application DI supplies the shared Redis-backed service.
    this.snapshots = snapshots || new ForumSnapshotService(prisma);
  }

  private async authorize(tx: Db, scope: ForumScope) {
    if (!scope.userId || !await tx.user.findFirst({ where: { id: scope.userId, status: 'ACTIVE' }, select: { id: true } }))
      throw Error('FORUM_ACCESS_DENIED');
    if (scope.conversationId) {
      // Serializes query checkpoints across workers; never shares state between conversations/personas.
      const owned = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM conversations
        WHERE id=${scope.conversationId} AND userId=${scope.userId} AND conversationType<>'LEGACY' FOR UPDATE`;
      if (!owned.length) throw Error('FORUM_ACCESS_DENIED');
    }
  }

  private filters(args: { categoryId?: number; category?: string; query?: string }, since: Date, asOf: Date) {
    const clauses = [Prisma.sql`p.status='APPROVED'`, Prisma.sql`p.createdAt>=${since}`, Prisma.sql`p.createdAt<=${asOf}`];
    if (args.categoryId) clauses.push(Prisma.sql`p.categoryId=${args.categoryId}`);
    if (args.category) clauses.push(Prisma.sql`c.name=${args.category}`);
    clauses.push(...forumSearchClauses(args.query));
    return Prisma.join(clauses, ' AND ');
  }

  private async present(tx: Db, rows: Row[]) {
    const tags = rows.length ? await tx.postTag.findMany({ where: { postId: { in: rows.map(p => p.id) } },
      select: { postId: true, tag: { select: { name: true } } }, orderBy: { id: 'asc' } }) : [];
    return rows.map(p => ({ id: p.id, title: p.title, url: `/forum/post/${p.id}`, author: p.author,
      category: p.category, categoryId: p.categoryId, tags: tags.filter(t => t.postId === p.id).map(t => t.tag.name).slice(0, 10),
      createdAt: p.createdAt.toISOString(), viewCount: p.viewCount, likeCount: p.likeCount, commentCount: p.commentCount,
      ...(p.score !== undefined ? { hotness: Math.round(Number(p.score) * 10000) / 10000 } : {}),
      ...(p.snippet !== undefined ? { snippet: p.snippet } : {}) }));
  }

  private checkpoint(tx: Db, scope: ForumScope, key: string) {
    return scope.conversationId ? tx.forumQueryCheckpoint.findUnique({ where: {
      conversationId_filterKey: { conversationId: scope.conversationId, filterKey: key } } }) : null;
  }

  private async save(tx: Db, scope: ForumScope, key: string, at: Date, snapshot: Prisma.InputJsonValue) {
    if (!scope.conversationId) return;
    await tx.forumQueryCheckpoint.upsert({ where: { conversationId_filterKey: { conversationId: scope.conversationId, filterKey: key } },
      create: { conversationId: scope.conversationId, filterKey: key, queriedAt: at, snapshot },
      update: { queriedAt: at, snapshot } });
    // Derived state only: keep the latest 50 different filters per conversation.
    const expired = await tx.forumQueryCheckpoint.findMany({ where: { conversationId: scope.conversationId },
      orderBy: [{ queriedAt: 'desc' }, { filterKey: 'asc' }], skip: 50, select: { filterKey: true } });
    if (expired.length) await tx.forumQueryCheckpoint.deleteMany({ where: { conversationId: scope.conversationId,
      filterKey: { in: expired.map(p => p.filterKey) } } });
  }

  async hot(input: unknown, scope: ForumScope) {
    const args = hotQuery.parse(input), hours = args.hours ?? 168;
    const key = filterKey(['hot-v3', args.rankingBasis, hours, args.categoryId ?? null, args.category ?? null, args.query ?? null, args.sortBy, args.limit]);
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, scope);
      const hot = await this.snapshots.hot({ ...args, hours }, { limit: args.limit }, tx);
      const asOf = hot.asOf, since = args.rankingBasis === 'interaction' ? new Date(0) : new Date(Math.max(0, asOf.getTime() - hours * 3600000));
      const previous = await this.checkpoint(tx, scope, key);
      const fresh = hot.rows.length ? await tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${fields} ${joins}
        WHERE p.id IN (${Prisma.join(hot.rows.map(row => row.id))}) AND ${this.filters(args, since, asOf)}`) : [];
      const byId = new Map(fresh.map(row => [row.id, row]));
      const rows = hot.rows.filter(row => byId.has(row.id)).map(row => ({ ...byId.get(row.id), ...row }));
      const posts = await this.present(tx, rows);
      const baseline = previous && asOf.getTime() - previous.queriedAt.getTime() <= 30 * 86400000 ? previous : null;
      const comparison = { status: !scope.conversationId ? 'unavailable' : baseline ? 'compared' : 'baseline_created',
        since: baseline?.queriedAt.toISOString() ?? null, changes: rankChanges(posts, baseline?.snapshot as unknown as RankedPost[]),
        scope: 'same_conversation_same_filters', mode: 'on_demand_not_subscription' };
      await this.save(tx, scope, key, asOf, posts.map(({ id, viewCount, likeCount, commentCount }) => ({ id, viewCount, likeCount, commentCount })));
      return { version: FORUM_DISCOVERY_VERSION, kind: 'hot', asOf: asOf.toISOString(), hours, filters: args, posts, comparison,
        hasMore: hot.hasMore, snapshot: { ...hot.snapshot, removedCount: hot.snapshot.removedCount + hot.rows.length - rows.length,
          ageMs: Math.max(0, Date.now() - asOf.getTime()) },
        ranking: { sortBy: args.sortBy, formula: FORUM_HOT_FORMULA, rankingBasis: args.rankingBasis,
          basis: args.rankingBasis === 'interaction' ? '按上线后记录的小时桶净互动增量和时间衰减预计算；老帖新互动可以入榜。窗口包含当前未完成小时，不表示独立访客；没有补造历史互动。'
            : 'asOf时点的累计互动数；时间窗筛选发帖时间，不表示窗内新增互动或独立访客。共享快照最多覆盖前200名，不代表全量帖子总数。' } };
    }, { timeout: 15000 });
  }

  async list(input: unknown, scope: ForumScope, searching = false): Promise<Record<string, any>> {
    const args = (searching ? searchQuery : recentQuery).parse(input), hours = args.hours ?? null;
    const searchable = searching && /[\p{L}\p{N}]/u.test(args.query || '');
    if (searchable && this.searchEngine && !args.cursor?.startsWith('sql:')) {
      const indexed = await this.searchList(args, scope);
      if (indexed) return indexed;
    }
    // New namespace: old 24h checkpoints must not become the baseline for an all-history query.
    const key = filterKey([searching ? 'search-v3' : 'recent-v3', hours, args.categoryId ?? null, args.category ?? null, args.query ?? null, args.sortOrder]);
    const secret = configuration().jwt.accessSecret;
    if (!secret) throw Error('FORUM_SERVICE_UNAVAILABLE');
    // The signature binds page bounds and filters; ACL is still rechecked independently on every page.
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, scope);
      const previous = await this.checkpoint(tx, scope, key);
      const pageSize = (previous?.snapshot as any)?.pageSize;
      if (args.cursor === 'next' && Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 20) args.limit = pageSize;
      const value = args.cursor === 'next' ? (previous?.snapshot as any)?.nextCursor : args.cursor;
      if (args.cursor === 'next' && !value) throw Error('NO_NEXT_PAGE');
      if (value?.startsWith('os:')) throw Error('INVALID_CURSOR');
      const cursor = value ? decodeCursor(value.startsWith('sql:') ? value.slice(4) : value, filterKey([key, scope.userId, scope.conversationId]), secret) : undefined;
      const asOf = cursor ? new Date(cursor.asOf) : new Date();
      const windowStart = hours === null ? new Date(0) : new Date(Math.max(0, asOf.getTime() - hours * 3600000));
      const since = cursor ? new Date(cursor.since) : args.sinceLastQuery && previous
        ? new Date(Math.max(windowStart.getTime(), previous.queriedAt.getTime() + 1)) : windowStart;
      const where = this.filters(args, since, asOf);
      // The signed first-page count is observational metadata, not a promise that posts remain public.
      // Later pages still recheck status/ACL but do not repeat an all-history COUNT for every 20 rows.
      let total = cursor?.total, totalObservedAt = cursor?.totalObservedAt;
      let maxId = cursor?.maxId ?? 0;
      if (total === undefined && args.includeTotal) {
        const [stats] = await tx.$queryRaw<Array<{ total: bigint; maxId: number | null }>>(Prisma.sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ COUNT(*) AS total,MAX(p.id) AS maxId ${joins}
          WHERE ${where} ${cursor ? Prisma.sql`AND p.id<=${cursor.maxId}` : Prisma.empty}`);
        total = Number(stats.total); maxId = cursor?.maxId ?? stats.maxId ?? 0;
        totalObservedAt = new Date().toISOString();
      }
      if (!cursor && maxId === 0) maxId = Number((await tx.$queryRaw<Array<{maxId:number}>>`SELECT COALESCE(MAX(id),0) AS maxId FROM posts`)[0]?.maxId || 0);
      const anchor = cursor ? (args.sortOrder === 'desc'
        ? Prisma.sql`AND (p.createdAt<${new Date(cursor.at)} OR (p.createdAt=${new Date(cursor.at)} AND p.id<${cursor.id}))`
        : Prisma.sql`AND (p.createdAt>${new Date(cursor.at)} OR (p.createdAt=${new Date(cursor.at)} AND p.id>${cursor.id}))`) : Prisma.empty;
      const order = args.sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
      const excerpt = searching ? Prisma.sql`,SUBSTRING(p.content,GREATEST(1,LOCATE(${args.query.split(/\s+/)[0]},p.content)-60),240) AS snippet` : Prisma.empty;
      const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ ${fields} ${excerpt} ${joins} WHERE ${where} AND p.id<=${maxId} ${anchor}
        ORDER BY p.createdAt ${order},p.id ${order} LIMIT ${args.limit + 1}`);
      const hasMore = rows.length > args.limit, kept = rows.slice(0, args.limit), last = kept[kept.length - 1];
      const posts = await this.present(tx, kept);
      const nextCursor = hasMore ? (searching ? 'sql:' : '') + encodeCursor({ v: 1,
        filter: filterKey([key, scope.userId, scope.conversationId]), asOf: asOf.toISOString(), since: since.toISOString(), maxId,
        id: last.id, at: last.createdAt.toISOString(), total, totalObservedAt }, secret) : null;
      // Persist the page pointer so a later conversational turn can ask for "next", without
      // putting a long opaque cursor into the assistant's visible reply or cross-session memory.
      await this.save(tx, scope, key, cursor && previous ? previous.queriedAt : asOf, { nextCursor, pageSize: args.limit });
      return { version: FORUM_DISCOVERY_VERSION, kind: searching ? 'search' : 'recent', asOf: asOf.toISOString(), since: since.toISOString(),
        hours, query: args.query, category: args.category, categoryId: args.categoryId, sortOrder: args.sortOrder,
        total: total ?? null, totalObservedAt: totalObservedAt ?? null, totalIsSnapshot: Boolean(cursor), totalScope: total === undefined ? 'not_requested' : 'matching_public_posts_in_effective_filters_at_count_observation',
        engine: searching ? 'mysql' : undefined, degraded: searchable, degradationReason: searching ? searchable ? 'search_unavailable_sql_fallback' : 'literal_query_sql_path' : undefined,
        requestedLimit: args.limit, returnedCount: posts.length,
        timeRange: args.sinceLastQuery && previous ? 'since_last_query' : hours === null ? 'all' : 'window',
        posts, hasMore, nextCursor,
        sinceLastQuery: args.sinceLastQuery, baselineAvailable: Boolean(previous),
        note: '按发布时间排序；不是未读数。total仅为计数观察时点、有效时间/分类/关键词范围内可公开读取的帖子数，不是当前全站总数；翻页沿用签名计数，不重复全量COUNT，已下架帖不会返回。' +
          '最新N条不限定时间；只有用户明确要求的时间窗才限制hours，不足时不擅自放宽。新查询清空cursor，明确下一页才沿用相同筛选和游标。' };
    }, { timeout: 15000 });
  }

  private async searchList(args: z.infer<typeof recentQuery>, scope: ForumScope) {
    const key = filterKey(['search-v3', args.hours ?? null, args.categoryId ?? null, args.category ?? null, args.query ?? null, args.sortOrder]);
    const setup = await this.prisma.$transaction(async tx => {
      await this.authorize(tx, scope);
      const previous = await this.checkpoint(tx, scope, key);
      const pageSize = (previous?.snapshot as any)?.pageSize;
      if (args.cursor === 'next' && Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 20) args.limit = pageSize;
      const value: string | undefined = args.cursor === 'next' ? (previous?.snapshot as any)?.nextCursor : args.cursor;
      if (args.cursor === 'next' && !value) throw Error('NO_NEXT_PAGE');
      const category = args.category ? await tx.category.findFirst({ where: { name: args.category }, select: { id: true } }) : null;
      return { value, categoryId: args.categoryId ?? category?.id, missingCategory: !!args.category && (!category || args.categoryId && category.id !== args.categoryId) };
    });
    if (setup.value?.startsWith('sql:')) return null;
    if (setup.value && !setup.value.startsWith('os:')) throw Error('INVALID_CURSOR');
    if (setup.missingCategory) return { version: FORUM_DISCOVERY_VERSION, kind: 'search', posts: [], hasMore: false,
      nextCursor: null, total: 0, totalScope: 'nonexistent_category', requestedLimit: args.limit, returnedCount: 0 };
    try {
      const result = await this.searchEngine.search({ query: args.query, categoryId: setup.categoryId, hours: args.hours,
        sort: 'createdAt', sortOrder: args.sortOrder, limit: args.limit, cursor: setup.value?.slice(3),
        scopeKey: `${scope.userId}:${scope.conversationId ?? 0}` });
      return this.prisma.$transaction(async tx => {
        await this.authorize(tx, scope);
        const ids = result.candidates.map(c => c.id), asOf = new Date(result.asOf);
        const since = args.hours ? new Date(Math.max(0, asOf.getTime()-args.hours*3600000)) : new Date(0);
        const rows = ids.length ? await tx.$queryRaw<Array<Row & {revision:number}>>(Prisma.sql`SELECT ${fields},p.revision ${joins}
          WHERE p.id IN (${Prisma.join(ids)}) AND ${this.filters({ ...args, query: undefined }, since, asOf)}`) : [];
        const byId = new Map(rows.map(row => [row.id,row]));
        const kept = result.candidates.filter(c => byId.get(c.id)?.revision === c.revision).map(c => ({ ...byId.get(c.id), snippet: c.snippet }));
        const posts = await this.present(tx, kept), nextCursor = result.nextCursor ? 'os:' + result.nextCursor : null;
        await this.save(tx, scope, key, asOf, { nextCursor, pageSize: args.limit });
        return { version: FORUM_DISCOVERY_VERSION, kind: 'search', posts, hasMore: result.hasMore, nextCursor,
          asOf: result.asOf, since: since.toISOString(), hours: args.hours ?? null, timeRange: args.hours ? 'window' : 'all',
          query: args.query, categoryId: setup.categoryId, requestedLimit: args.limit, returnedCount: posts.length,
          total: result.total.value, totalObservedAt: result.total.observedAt, totalScope: result.total.basis,
          totalRelation: result.total.relation, engine: result.engine, degraded: false, indexVersion: result.indexVersion,
          removedCount: ids.length-posts.length, note: '全文检索候选经SQL当前公开状态与版本复查；total是搜索索引快照的命中观察值，不是全站实时总量。' };
      });
    } catch (error) {
      if (setup.value || ['FORUM_SEARCH_INVALID_CURSOR','FORUM_SEARCH_EXPIRED'].includes(error?.message)) throw Error('INVALID_CURSOR');
      if (['FORUM_SEARCH_NOT_READY','FORUM_SEARCH_UNAVAILABLE'].includes(error?.message)) return null;
      throw error;
    }
  }

  async tracking(input: unknown, scope: ForumScope) {
    const schema = z.object({ action: z.enum(['list','create','pause','resume','remove']), confirmed: z.literal(true).optional(),
      id: z.number().int().positive().optional(), kind: z.enum(['NEW_POSTS','HOT_RISE','POST_ACTIVITY']).optional(),
      postId: z.number().int().positive().optional(), categoryId: z.number().int().positive().optional(), query: z.string().max(160).optional(),
      hours: z.union([z.literal(24),z.literal(168)]).optional(), rankingBasis: z.enum(['published','interaction']).optional(),
      cooldownSeconds: z.number().int().min(60).max(86400).optional() }).strict();
    const args = schema.parse(input);
    await this.prisma.$transaction(tx => this.authorize(tx, scope));
    if (!this.subscriptions) throw Error('FORUM_SERVICE_UNAVAILABLE');
    if (args.action === 'list') return { version: FORUM_DISCOVERY_VERSION, kind: 'tracking', watches: await this.subscriptions.list(scope.userId) };
    const approval=currentToolWriteApproval(scope,args);
    if(!approval)throw Error('FORUM_ACTION_APPROVAL_REQUIRED');
    const current=await this.prisma.user.findUnique({where:{id:scope.userId},select:{status:true,authVersion:true}});
    const conversation=await this.prisma.conversation.findFirst({where:{id:scope.conversationId,userId:scope.userId,
      conversationType:'ASSISTANT',memoryEpoch:approval.sourceEpoch},select:{id:true}});
    if(!current||current.status!=='ACTIVE'||current.authVersion!==approval.authVersion||!conversation)throw Error('FORUM_ACCESS_DENIED');
    if (!args.confirmed || args.action === 'create' && !args.kind || args.action !== 'create' && !args.id) throw Error('INVALID_ARGUMENTS');
    const data = args.action === 'create' ? await this.subscriptions.create(scope.userId, { ...args, kind: args.kind }, scope.conversationId)
      : args.action === 'remove' ? await this.subscriptions.remove(scope.userId,args.id)
      : await this.subscriptions.setEnabled(scope.userId,args.id,args.action==='resume');
    return { version: FORUM_DISCOVERY_VERSION, kind: 'tracking', data, note: '后台持久追踪已更新；仅站内合并通知，不发送邮件，不要求保持聊天窗口打开。' };
  }

  async detail(input: unknown, scope: ForumScope) {
    const args = detailQuery.parse(input);
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, scope);
      const [row] = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT ${fields},SUBSTRING(p.content,${args.offset + 1},1800) AS content,
        CHAR_LENGTH(p.content) AS contentLength ${joins} WHERE p.id=${args.postId} AND p.status='APPROVED'`);
      if (!row) throw Error('FORUM_POST_UNAVAILABLE');
      const comments = await tx.$queryRaw<Array<{ id: number; author: string; content: string; createdAt: Date }>>`
        SELECT c.id,u.username AS author,LEFT(c.content,240) AS content,c.createdAt FROM comments c JOIN users u ON u.id=c.userId
        WHERE c.postId=${args.postId} AND c.status='ACTIVE' ORDER BY c.createdAt DESC,c.id DESC LIMIT 3`;
      const [post] = await this.present(tx, [row]), length = Number(row.contentLength);
      return { version: FORUM_DISCOVERY_VERSION, kind: 'detail', asOf: new Date().toISOString(), post,
        content: row.content, offset: args.offset, contentLength: length,
        nextOffset: args.offset + 1800 < length ? args.offset + 1800 : null, comments,
        note: '正文按字符分段；评论仅最新3条有效评论，不代表全部讨论。作者观点不是已核实事实。读取不增加浏览量。' };
    }, { timeout: 15000 });
  }

  async categories(scope: ForumScope) {
    return this.prisma.$transaction(async tx => {
      await this.authorize(tx, scope);
      return { version: FORUM_DISCOVERY_VERSION, kind: 'categories', categories: await tx.category.findMany({
        select: { id: true, name: true }, orderBy: [{ order: 'asc' }, { id: 'asc' }], take: 100 }) };
    });
  }
}

import { Injectable, NotFoundException, ForbiddenException, ConflictException, BadRequestException, ServiceUnavailableException, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { Prisma } from '@prisma/client';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import configuration from '../../config/configuration';
import { XpService } from '../../common/xp.service';
import { CommentQueryDto, FeedQueryDto, NotificationQueryDto, PageQueryDto, PostQueryDto, TagOptionsQueryDto } from './forum.dto';
import { forumHotScore, forumSearchClauses, forumSummary } from './forum-query.sql';
import { HotFeedCursor, LatestFeedCursor, readWebCursor, signWebCursor, TagOptionCursor, webFilterKey } from './forum-feed.policy';
import { ForumSnapshotService } from './forum-snapshot.service';
import { ForumEventsService } from './forum-events.service';
import { ForumSearchService } from './forum-search.service';
import { ForumViewAggregationService } from './forum-view-aggregation.service';
import { ForumSubscriptionsService } from './forum-subscriptions.service';

const authorSelect = { id: true, username: true, avatar: true } as const;
const summarySelect = { id: true, title: true, categoryId: true, userId: true, contentFormat: true, revision: true,
  viewCount: true, likeCount: true, commentCount: true, isTop: true, isEssence: true, status: true, createdAt: true, updatedAt: true,
  user: { select: authorSelect }, category: true, tags: { include: { tag: true } } } as const;

@Injectable()
export class ForumService {
  private tagCache?: { expires: number; data: Array<{ id: number; name: string; count: number; _count: { posts: number } }> };
  private tagPending?: Promise<Array<{ id: number; name: string; count: number; _count: { posts: number } }>>;
  private categoryCache?: { expires: number; data: any[] };
  private categoryPending?: Promise<any[]>;
  constructor(private prisma: PrismaService, @Optional() private readonly snapshots?: ForumSnapshotService,
    @Optional() private readonly events?: ForumEventsService, @Optional() private readonly searchEngine?: ForumSearchService,
    @Optional() private readonly views?: ForumViewAggregationService, @Optional() private readonly subscriptions?: ForumSubscriptionsService) {}

  private async active(userId: number, db: Prisma.TransactionClient = this.prisma) {
    const user = await db.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true, role: true } });
    if (!user) throw new ForbiddenException('账号不可用');
    return user;
  }

  private async summaries(rows: Array<{ id: number; excerpt: string; lastReplyAt?: Date; revision?: number }>, currentUserId?: number, includeOwnStatus = false) {
    if (currentUserId) await this.active(currentUserId);
    const ids = rows.map(p => p.id);
    if (!ids.length) return [];
    const [posts, likes, favorites] = await Promise.all([
      this.prisma.post.findMany({ where: { id: { in: ids }, ...(includeOwnStatus ? { userId: currentUserId } : { status: 'APPROVED' }) }, select: summarySelect }),
      currentUserId ? this.prisma.like.findMany({ where: { userId: currentUserId, postId: { in: ids } }, select: { postId: true } }) : [],
      currentUserId ? this.prisma.favorite.findMany({ where: { userId: currentUserId, postId: { in: ids } }, select: { postId: true } }) : [],
    ]);
    const byId = new Map(posts.map(p => [p.id, p])), liked = new Set(likes.map(l => l.postId)), favorited = new Set(favorites.map(f => f.postId));
    const followed = new Set(currentUserId && posts.length ? (await this.prisma.follow.findMany({ where: {
      followerId: currentUserId, followingId: { in: [...new Set(posts.map(post => post.userId))] }, following: { status: 'ACTIVE' } },
      select: { followingId: true } })).map(item => item.followingId) : []);
    return rows.filter(row => byId.has(row.id) && (row.revision === undefined || byId.get(row.id).revision === row.revision)).map(row => {
      const post = byId.get(row.id);
      return { ...post, user: { ...post.user, isFollowing: followed.has(post.userId) }, summary: post.contentFormat === 'plain' ? row.excerpt.replace(/\s+/g, ' ').trim().slice(0, 240) : forumSummary(row.excerpt),
        lastReplyAt: row.lastReplyAt ?? null, isLiked: liked.has(row.id), isFavorited: favorited.has(row.id),
        canEdit: post.userId === currentUserId && post.status === 'APPROVED' };
    });
  }

  async createPost(userId: number, data: any) {
    const post = await this.prisma.$transaction(async tx => {
      await this.active(userId, tx);
      const user = await tx.user.update({ where: { id: userId }, data: { points: { increment: XpService.POST_XP } } });
      await tx.user.update({ where: { id: userId }, data: { level: XpService.getLevel(user.points) } });
      const post = await tx.post.create({ data: {
        title: data.title, content: data.content, contentFormat: data.contentFormat || 'plain', categoryId: data.categoryId, userId, status: 'APPROVED',
      } });
      for (const name of [...new Set<string>(data.tags || [])].sort()) {
        const tag = await tx.tag.upsert({ where: { name }, create: { name }, update: {} });
        await tx.postTag.create({ data: { postId: post.id, tagId: tag.id } });
      }
      await this.events?.append(tx, { kind: 'POST_PUBLISHED', postId: post.id, postRevision: post.revision, actorId: userId,
        payload: { categoryId: post.categoryId, status: 'APPROVED' } });
      return post;
    });
    return this.getPost(post.id, userId);
  }

  async getPosts(params: Partial<PostQueryDto> = {}, currentUserId?: number) {
    const { page = 1, limit = 20, categoryId, tagId, search, sortBy = 'createdAt', sortOrder = 'desc', hotPeriod = 'week' } = params;
    const sort = params.sort || (sortBy === 'popular' ? 'hot' : sortBy === 'likes' ? 'likes' : 'latest');
    const asOf = new Date(), clauses = [Prisma.sql`p.status='APPROVED'`, Prisma.sql`p.createdAt<=${asOf}`];
    if (categoryId) clauses.push(Prisma.sql`p.categoryId=${categoryId}`);
    if (tagId) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM post_tags pt WHERE pt.postId=p.id AND pt.tagId=${tagId})`);
    if (params.userId) clauses.push(Prisma.sql`p.userId=${params.userId}`);
    clauses.push(...forumSearchClauses(search));
    if (sort === 'hot' && hotPeriod !== 'all') clauses.push(Prisma.sql`p.createdAt>=${new Date(asOf.getTime() - (hotPeriod === 'today' ? 24 : 168) * 3600000)}`);
    const where = Prisma.join(clauses, ' AND '), direction = sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const order = sort === 'hot' ? forumHotScore(asOf) : sort === 'likes' ? Prisma.sql`p.likeCount` : Prisma.sql`p.createdAt`;
    const [rows, stats] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: number; excerpt: string; lastReplyAt: Date }>>(Prisma.sql`SELECT p.id,LEFT(p.content,480) AS excerpt,
        (SELECT MAX(cm.createdAt) FROM comments cm WHERE cm.postId=p.id AND cm.status='ACTIVE') AS lastReplyAt
        FROM posts p WHERE ${where} ORDER BY ${order} ${direction},p.createdAt ${direction},p.id ${direction}
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      params.includeTotal === false ? Promise.resolve(null) : this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT COUNT(*) AS total FROM posts p WHERE ${where}`),
    ]);
    const total = stats === null ? null : Number(stats[0]?.total || 0);
    return { data: await this.summaries(rows, currentUserId), total, page, limit, totalPages: total === null ? null : Math.ceil(total / limit),
      totalBasis: total === null ? 'not_requested' : 'exact_at_query',
      sort, hotPeriod: sort === 'hot' ? hotPeriod : null };
  }

  /** Seek pages bind time/id bounds and filters. They are not immutable content snapshots. */
  async getFeed(params: Partial<FeedQueryDto> = {}, currentUserId?: number) {
    const limit = params.limit ?? 20, sort = params.sort ?? 'latest', sortOrder = params.sortOrder ?? 'desc', hotPeriod = params.hotPeriod ?? 'week';
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !['latest', 'hot'].includes(sort) || !['asc', 'desc'].includes(sortOrder) ||
      !['today', 'week', 'all'].includes(hotPeriod)) throw new BadRequestException('论坛分页参数无效');
    const search = params.search?.trim() || undefined;
    const searchable = !!search && /[\p{L}\p{N}]/u.test(search);
    if (searchable && sort === 'latest' && this.searchEngine && !params.cursor?.startsWith('sql:')) {
      try {
        const result = await this.searchEngine.search({ query: search, categoryId: params.categoryId, tagId: params.tagId,
          userId: params.userId, sort: 'createdAt', sortOrder, limit, cursor: params.cursor,
          scopeKey: 'public-web' });
        const ids = result.candidates.map(row => row.id);
        const rows = ids.length ? await this.prisma.$queryRaw<Array<{id:number;revision:number;excerpt:string;lastReplyAt:Date}>>(Prisma.sql`
          SELECT p.id,p.revision,LEFT(p.content,480) AS excerpt,
            (SELECT MAX(c.createdAt) FROM comments c WHERE c.postId=p.id AND c.status='ACTIVE') AS lastReplyAt
          FROM posts p WHERE p.id IN (${Prisma.join(ids)}) AND ${Prisma.join(this.feedClauses({ ...params, search: undefined },new Date(result.asOf)), ' AND ')}`) : [];
        const byId = new Map(rows.map(row => [row.id,row]));
        const kept = result.candidates.filter(c => byId.get(c.id)?.revision === c.revision).map(c => byId.get(c.id));
        return { data: await this.summaries(kept, currentUserId), ...result, candidates: undefined, limit, sort, hotPeriod: null,
          total: result.total.value, totalBasis: 'search_index_' + result.total.relation, snapshot: null,
          totalObservedAt: result.total.observedAt, totalScope: result.total.basis,
          removedCount: ids.length-kept.length };
      } catch (error) {
        if (['FORUM_SEARCH_EXPIRED','FORUM_SEARCH_INVALID_CURSOR'].includes(error?.message) || params.cursor && !params.cursor.startsWith('sql:'))
          throw new ConflictException('搜索快照已过期或不可用，请刷新首屏');
        if (!['FORUM_SEARCH_UNAVAILABLE','FORUM_SEARCH_NOT_READY'].includes(error?.message)) throw error;
      }
    }
    const rawCursor = params.cursor?.startsWith('sql:') ? params.cursor.slice(4) : params.cursor;
    const filter = webFilterKey(['web-feed-v2', sort, sortOrder, sort === 'hot' ? hotPeriod : null, sort === 'hot' ? params.hotBasis || 'published' : null,
      params.categoryId ?? null, params.tagId ?? null, params.userId ?? null, search ?? null, limit]);
    const secret = configuration().jwt.accessSecret;
    const cursor = rawCursor ? readWebCursor(rawCursor, filter, sort, secret) : null;
    if (sort === 'hot') {
      if (!this.snapshots) throw new ServiceUnavailableException('热榜服务暂不可用');
      const hot = cursor as HotFeedCursor | null, offset = hot?.offset ?? 0;
      let result: Awaited<ReturnType<ForumSnapshotService['hot']>>;
      try {
        result = await this.snapshots.hot({ hours: hotPeriod === 'all' ? undefined : hotPeriod === 'today' ? 24 : 168,
          categoryId: params.categoryId, tagId: params.tagId, userId: params.userId, query: search, sortBy: 'hotness', sortOrder,
          rankingBasis: params.hotBasis || 'published' },
        { offset, limit, snapshotId: hot?.snapshotId });
      } catch (error) {
        if (error?.message === 'FORUM_SNAPSHOT_EXPIRED') throw new ConflictException('热榜快照已过期或筛选不匹配，请刷新首屏');
        if (error?.message === 'FORUM_SERVICE_UNAVAILABLE') throw new ServiceUnavailableException('热榜服务繁忙，请稍后重试');
        throw error;
      }
      const ids = result.rows.map(row => row.id), clauses = this.feedClauses(params, result.asOf);
      const rows = ids.length ? await this.prisma.$queryRaw<Array<{ id: number; excerpt: string; revision: number; lastReplyAt: Date }>>(Prisma.sql`
        SELECT p.id,p.revision,LEFT(p.content,480) AS excerpt,
        (SELECT MAX(cm.createdAt) FROM comments cm WHERE cm.postId=p.id AND cm.status='ACTIVE') AS lastReplyAt
        FROM posts p WHERE p.id IN (${Prisma.join(ids)}) AND ${Prisma.join(clauses, ' AND ')}`) : [];
      const rowMap = new Map(rows.map(row => [row.id, row]));
      const metrics = new Map(result.rows.map(row => [row.id, row]));
      const data = (await this.summaries(ids.filter(id => rowMap.has(id)).map(id => rowMap.get(id)), currentUserId)).map(post => {
        const metric = metrics.get(post.id);
        return { ...post, viewCount: metric.viewCount, likeCount: metric.likeCount, commentCount: metric.commentCount,
          hotness: Math.round(Number(metric.score) * 10000) / 10000 };
      });
      const stable = result.snapshot.mode === 'shared_top_200' && !!result.snapshot.id;
      const pageCursor = stable ? params.cursor || signWebCursor({ v: 1, kind: 'hot', filter, asOf: result.asOf.toISOString(),
        snapshotId: result.snapshot.id, offset }, secret) : null;
      const nextOffset = offset + limit;
      const nextCursor = stable && result.hasMore && nextOffset < 200 ? signWebCursor({ v: 1, kind: 'hot', filter,
        asOf: result.asOf.toISOString(), snapshotId: result.snapshot.id, offset: nextOffset }, secret) : null;
      return { data, limit, sort, hotPeriod, sortOrder, asOf: result.asOf.toISOString(), hasMore: !!nextCursor, nextCursor, pageCursor,
        metricsAsOf: result.asOf.toISOString(), total: null, totalBasis: 'not_requested', snapshot: { ...result.snapshot,
          removedCount: result.snapshot.removedCount + Math.max(0, ids.length - data.length),
          paging: stable ? 'snapshot' : 'first_page_only', moreMatchingResults: !stable && result.hasMore } };
    }
    const latest = cursor as LatestFeedCursor | null, asOf = latest ? new Date(latest.asOf) : new Date();
    // MAX(id) is index-backed and only establishes an insertion bound, not a row count.
    const maxId = latest?.maxId ?? Number((await this.prisma.$queryRaw<Array<{ maxId: number }>>`SELECT COALESCE(MAX(id),0) AS maxId FROM posts`)[0]?.maxId || 0);
    const clauses = this.feedClauses(params, asOf); clauses.push(Prisma.sql`p.id<=${maxId}`);
    const where = Prisma.join(clauses, ' AND '), direction = sortOrder === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    const anchor = latest?.at ? sortOrder === 'desc'
      ? Prisma.sql`AND (p.createdAt<${new Date(latest.at)} OR (p.createdAt=${new Date(latest.at)} AND p.id<${latest.id}))`
      : Prisma.sql`AND (p.createdAt>${new Date(latest.at)} OR (p.createdAt=${new Date(latest.at)} AND p.id>${latest.id}))` : Prisma.empty;
    const [rows, stats] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: number; createdAt: Date; excerpt: string; revision: number; lastReplyAt: Date }>>(Prisma.sql`
        SELECT /*+ MAX_EXECUTION_TIME(2000) */ p.id,p.createdAt,p.revision,LEFT(p.content,480) AS excerpt,
        (SELECT MAX(cm.createdAt) FROM comments cm WHERE cm.postId=p.id AND cm.status='ACTIVE') AS lastReplyAt
        FROM posts p WHERE ${where} ${anchor} ORDER BY p.createdAt ${direction},p.id ${direction} LIMIT ${limit + 1}`),
      params.includeTotal && !cursor ? this.prisma.$queryRaw<Array<{ total: bigint }>>(Prisma.sql`SELECT /*+ MAX_EXECUTION_TIME(2000) */ COUNT(*) AS total FROM posts p WHERE ${where}`) : Promise.resolve(null),
    ]);
    const hasMore = rows.length > limit, kept = rows.slice(0, limit), last = kept[kept.length - 1];
    const base: LatestFeedCursor = { v: 1, kind: 'latest', filter, asOf: asOf.toISOString(), maxId, at: latest?.at ?? null, id: latest?.id ?? null };
    const encode = (value: LatestFeedCursor) => (search ? 'sql:' : '') + signWebCursor(value, secret);
    return { data: await this.summaries(kept, currentUserId), limit, sort, hotPeriod: null, sortOrder, asOf: asOf.toISOString(),
      hasMore, nextCursor: hasMore && last ? encode({ ...base, at: last.createdAt.toISOString(), id: last.id }) : null,
      pageCursor: params.cursor || encode(base), total: stats ? Number(stats[0]?.total || 0) : null,
      engine: search ? 'mysql' : undefined, degraded: searchable, degradationReason: search ? searchable ? 'search_unavailable_sql_fallback' : 'literal_query_sql_path' : undefined,
      totalBasis: stats ? 'first_page_exact_at_query' : 'not_requested', snapshot: null };
  }

  private feedClauses(params: Partial<FeedQueryDto>, asOf: Date) {
    const clauses = [Prisma.sql`p.status='APPROVED'`, Prisma.sql`p.createdAt<=${asOf}`];
    if (params.categoryId) clauses.push(Prisma.sql`p.categoryId=${params.categoryId}`);
    if (params.tagId) clauses.push(Prisma.sql`EXISTS (SELECT 1 FROM post_tags pt WHERE pt.postId=p.id AND pt.tagId=${params.tagId})`);
    if (params.userId) clauses.push(Prisma.sql`p.userId=${params.userId}`);
    clauses.push(...forumSearchClauses(params.search));
    return clauses;
  }

  async getPost(postId: number, currentUserId?: number) {
    if (currentUserId) await this.active(currentUserId);
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
      include: {
        user: {
          select: { id: true, username: true, avatar: true },
        },
        category: true,
        tags: {
          include: { tag: true },
        },
      },
    });

    if (!post || (post.status !== 'APPROVED' && post.userId !== currentUserId)) {
      throw new NotFoundException('Post not found');
    }

    let isLiked = false;
    let isFavorited = false;
    let isFollowing = false;

    if (currentUserId) {
      [isLiked, isFavorited, isFollowing] = await Promise.all([
        this.prisma.like.findUnique({
          where: { userId_postId: { userId: currentUserId, postId } },
        }).then((l) => !!l),
        this.prisma.favorite.findUnique({
          where: { userId_postId: { userId: currentUserId, postId } },
        }).then((f) => !!f),
        this.prisma.follow.findFirst({ where: { followerId: currentUserId, followingId: post.userId,
          following: { status: 'ACTIVE' } }, select: { id: true } }).then(item => !!item),
      ]);
    }

    return { ...post, user: { ...post.user, isFollowing }, isLiked, isFavorited };
  }

  private viewerToken(token?: string) {
    const secret = configuration().jwt.accessSecret;
    if (!secret) throw new ServiceUnavailableException('阅读计数服务不可用');
    const sign = (value: string) => createHmac('sha256', secret).update('forum-viewer:' + value).digest('base64url');
    const [value, signature, extra] = (token || '').split('.');
    if (!extra && value && signature && /^\d+-[0-9a-f-]{36}$/.test(value)) {
      const at = Number(value.slice(0, value.indexOf('-'))), expected = Buffer.from(sign(value)), supplied = Buffer.from(signature);
      if (at <= Date.now() && at > Date.now() - 30 * 86400000 && expected.length === supplied.length && timingSafeEqual(expected, supplied)) return token;
    }
    const fresh = Date.now() + '-' + randomUUID();
    return fresh + '.' + sign(fresh);
  }

  async recordView(postId: number, currentUserId?: number, token?: string) {
    const viewerToken = currentUserId ? undefined : this.viewerToken(token);
    if (currentUserId) await this.active(currentUserId);
    const viewerHash = createHmac('sha256', configuration().jwt.accessSecret)
      .update(currentUserId ? 'user:' + currentUserId : 'anonymous:' + viewerToken).digest('hex');
    if (this.views && ['true','1'].includes(process.env.FORUM_VIEW_AGGREGATION_ENABLED || '')) {
      const visible = await this.prisma.post.findFirst({ where: { id: postId, status: 'APPROVED' }, select: { viewCount: true } });
      if (!visible) throw new NotFoundException('Post not found');
      return { ...await this.views.record(postId, viewerHash), viewCount: visible.viewCount, ...(viewerToken ? { viewerToken } : {}) };
    }
    const [visible, recent] = await Promise.all([
      this.prisma.post.findFirst({ where: { id: postId, status: 'APPROVED' }, select: { id: true, viewCount: true } }),
      this.prisma.postViewReceipt.findUnique({ where: { postId_viewerHash: { postId, viewerHash } } }),
    ]);
    if (!visible) throw new NotFoundException('Post not found');
    if (recent && Date.now() - recent.viewedAt.getTime() < 30 * 60000)
      return { counted: false, viewCount: visible.viewCount, ...(viewerToken ? { viewerToken } : {}) };
    return this.prisma.$transaction(async tx => {
      const [post] = await tx.$queryRaw<Array<{ id: number; viewCount: number }>>`SELECT id,viewCount FROM posts WHERE id=${postId} AND status='APPROVED' FOR UPDATE`;
      if (!post) throw new NotFoundException('Post not found');
      const previous = await tx.postViewReceipt.findUnique({ where: { postId_viewerHash: { postId, viewerHash } } });
      const now = new Date(), counted = !previous || now.getTime() - previous.viewedAt.getTime() >= 30 * 60000;
      if (counted) {
        await tx.postViewReceipt.upsert({ where: { postId_viewerHash: { postId, viewerHash } },
          create: { postId, viewerHash, viewedAt: now }, update: { viewedAt: now } });
        await tx.post.update({ where: { id: postId }, data: { viewCount: { increment: 1 } } });
      }
      return { counted, viewCount: post.viewCount + Number(counted), ...(viewerToken ? { viewerToken } : {}) };
    });
  }

  async updatePost(postId: number, userId: number, data: any) {
    await this.active(userId);
    if (!Number.isInteger(data.expectedRevision) || data.expectedRevision < 1) throw new BadRequestException('请提供编辑时的帖子版本');
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.status !== 'APPROVED') {
      throw new NotFoundException('Post not found');
    }

    if (post.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.$transaction(async tx => {
      const changed = await tx.post.updateMany({ where: { id: postId, userId, status: 'APPROVED', revision: data.expectedRevision }, data: {
        title: data.title, content: data.content, contentFormat: data.contentFormat, categoryId: data.categoryId, revision: { increment: 1 },
      } });
      if (!changed.count) throw new ConflictException('帖子已经被修改，请重新加载后合并你的草稿');
      if (data.tags) {
        await tx.postTag.deleteMany({ where: { postId } });
        for (const name of [...new Set<string>(data.tags)].sort()) {
          const tag = await tx.tag.upsert({ where: { name }, create: { name }, update: {} });
          await tx.postTag.create({ data: { postId, tagId: tag.id } });
        }
      }
      await this.events?.append(tx, { kind: 'POST_UPDATED', postId, postRevision: data.expectedRevision + 1, actorId: userId,
        payload: { categoryId: data.categoryId ?? post.categoryId } });
    });

    return this.getPost(postId, userId);
  }

  async deletePost(postId: number, userId: number) {
    await this.active(userId);
    const post = await this.prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.status !== 'APPROVED') {
      throw new NotFoundException('Post not found');
    }

    if (post.userId !== userId) {
      throw new ForbiddenException('Access denied');
    }

    await this.prisma.$transaction(async tx => {
      await this.active(userId, tx);
      const [current] = await tx.$queryRaw<Array<{revision:number;categoryId:number}>>`SELECT revision,categoryId FROM posts WHERE id=${postId} AND userId=${userId} AND status='APPROVED' FOR UPDATE`;
      if (!current) throw new NotFoundException('Post not found');
      await tx.post.delete({ where: { id: postId } });
      await this.events?.append(tx, { kind: 'POST_DELETED', postId, postRevision: current.revision + 1, actorId: userId,
        payload: { categoryId: current.categoryId } });
    });

    return { message: 'Post deleted' };
  }

  async likePost(postId: number, userId: number) {
    await this.active(userId);
    await this.prisma.$transaction(async tx => {
      const post = await tx.post.update({ where: { id: postId, status: 'APPROVED' }, data: { updatedAt: new Date() } });
      const inserted = await tx.like.createMany({ data: [{ userId, postId }], skipDuplicates: true });
      if (!inserted.count) return;
      await tx.post.update({ where: { id: postId }, data: { likeCount: { increment: 1 } } });
      await this.events?.append(tx, { kind: 'POST_LIKED', postId, postRevision: post.revision, actorId: userId,
        payload: { delta: { likes: 1 } } });
      if (post.userId !== userId) await tx.notification.create({ data: {
        userId: post.userId, type: 'LIKE', title: '收到点赞', content: '有人赞了你的帖子', relatedId: postId,
      } });
    });
    return { message: 'Post liked' };
  }

  async unlikePost(postId: number, userId: number) {
    await this.active(userId);
    await this.prisma.$transaction(async tx => {
      const post = await tx.post.update({ where: { id: postId, status: 'APPROVED' }, data: { updatedAt: new Date() } });
      const deleted = await tx.like.deleteMany({ where: { postId, userId } });
      if (deleted.count) {
        await tx.post.update({ where: { id: postId }, data: { likeCount: { decrement: 1 } } });
        await this.events?.append(tx, { kind: 'POST_UNLIKED', postId, postRevision: post.revision, actorId: userId, payload: { delta: { likes: -1 } } });
      }
    });
    return { message: 'Post unliked' };
  }

  async favoritePost(postId: number, userId: number) {
    return this.prisma.$transaction(async tx => {
      const actor = await tx.$queryRaw<Array<{ id: number; status: string }>>`SELECT id,status FROM users WHERE id=${userId} FOR SHARE`;
      if (!actor.length || actor[0].status !== 'ACTIVE') throw new ForbiddenException('账号不可用');
      const visible = await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM posts WHERE id=${postId} AND status='APPROVED' FOR UPDATE`;
      if (!visible.length) throw new NotFoundException('Post not found');
      await tx.favorite.createMany({ data: [{ userId, postId }], skipDuplicates: true });
      return { message: 'Post favorited', isFavorited: true };
    });
  }

  async unfavoritePost(postId: number, userId: number) {
    return this.prisma.$transaction(async tx => {
      const actor = await tx.$queryRaw<Array<{ id: number; status: string }>>`SELECT id,status FROM users WHERE id=${userId} FOR SHARE`;
      if (!actor.length || actor[0].status !== 'ACTIVE') throw new ForbiddenException('账号不可用');
      // Removing one's private bookmark is allowed even if the source post was hidden.
      await tx.favorite.deleteMany({ where: { userId, postId } });
      return { message: 'Post unfavorited', isFavorited: false };
    });
  }

  async getComments(postId: number, currentUserId?: number, params: Partial<CommentQueryDto> = {}) {
    const post = await this.prisma.post.findFirst({ where: { id: postId, status: 'APPROVED' }, select: { userId: true } });
    if (!post) throw new NotFoundException('Post not found');
    const { limit = 10, parentId, sortOrder = 'desc', onlyAuthor = false } = params;
    let page = params.page || 1;
    const replyWhere = { status: 'ACTIVE' as const, ...(onlyAuthor ? { userId: post.userId } : {}) };
    // A non-author root is a context container when the post author replied underneath it.
    // Filtering only root.userId would silently lose those author replies.
    const rootWhere = onlyAuthor ? { OR: [
      { status: 'ACTIVE' as const, userId: post.userId },
      { replies: { some: replyWhere } },
    ] } : { OR: [{ status: 'ACTIVE' as const }, { status: 'DELETED' as const, replies: { some: replyWhere } }] };
    if (parentId && !await this.prisma.comment.findFirst({ where: { id: parentId, postId, parentId: null, ...(onlyAuthor ? rootWhere : {}) } }))
      throw new NotFoundException('评论不存在');
    const where: any = { postId, parentId: parentId ?? null, ...(parentId ? replyWhere : rootWhere) };
    const focus = params.commentId ? await this.prisma.comment.findFirst({ where: { id: params.commentId, postId, ...replyWhere } }) : null;
    if (params.commentId && (!focus || parentId && focus.parentId !== parentId))
      throw new NotFoundException(onlyAuthor ? '该评论不在当前作者筛选范围内' : '评论不存在');
    if (focus) {
      const root = parentId || !focus.parentId ? focus : await this.prisma.comment.findFirst({
        where: { id: focus.parentId, postId, parentId: null, ...rootWhere },
      });
      if (!root) throw new NotFoundException('评论不存在');
      const comparison = sortOrder === 'asc' ? 'lt' : 'gt';
      const before = await this.prisma.comment.count({ where: { ...where, AND: [{ OR: [
        { createdAt: { [comparison]: root.createdAt } }, { createdAt: root.createdAt, id: { [comparison]: root.id } },
      ] }] } });
      page = Math.floor(before / limit) + 1;
    }
    const author = { select: { id: true, username: true, avatar: true } };
    const [rows, total, activeCount, allActiveCount] = await Promise.all([
      this.prisma.comment.findMany({ where, orderBy: [{ createdAt: sortOrder }, { id: sortOrder }],
        skip: (page - 1) * limit, take: limit, include: { user: author,
          replies: { where: replyWhere, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 3, include: { user: author } },
          _count: { select: { replies: { where: replyWhere } } },
        } }),
      this.prisma.comment.count({ where }),
      this.prisma.comment.count({ where: { postId, ...replyWhere } }),
      onlyAuthor ? this.prisma.comment.count({ where: { postId, status: 'ACTIVE' } }) : Promise.resolve(undefined),
    ]);
    if (focus?.parentId && !parentId) {
      const root = rows.find(c => c.id === focus.parentId);
      if (root && !root.replies.some(reply => reply.id === focus.id)) {
        const focused = await this.prisma.comment.findFirst({ where: { id: focus.id, postId, ...replyWhere }, include: { user: author } });
        if (focused) root.replies.push(focused);
      }
    }
    const ids = rows.flatMap(c => [c.id, ...c.replies.map(r => r.id)]);
    const likes = currentUserId && ids.length ? await this.prisma.commentLike.findMany({
      where: { userId: currentUserId, commentId: { in: ids } }, select: { commentId: true },
    }) : [];
    const liked = new Set(likes.map(l => l.commentId));
    const viewer = currentUserId ? await this.prisma.user.findUnique({ where: { id: currentUserId }, select: { role: true } }) : null;
    const present = (c: any) => {
      const contextOnly = onlyAuthor && c.parentId === null && c.userId !== post.userId;
      return { ...c, contextOnly, content: contextOnly ? '该楼层用于展示作者回复' : c.status === 'ACTIVE' ? c.content : '这条评论已删除',
        isLiked: !contextOnly && c.status === 'ACTIVE' && liked.has(c.id), likeCount: !contextOnly && c.status === 'ACTIVE' ? c.likeCount : 0,
        canDelete: !contextOnly && c.status === 'ACTIVE' && (c.userId === currentUserId || viewer?.role === 'ADMIN'),
      };
    };
    return { data: rows.map(c => ({ ...present(c), replyCount: c._count.replies, replies: c.replies.map(present) })),
      page, limit, total, totalPages: Math.ceil(total / limit), activeCount, totalActiveCount: allActiveCount ?? activeCount,
      onlyAuthor, focusId: focus?.id ?? null };
  }

  async deleteComment(commentId: number, userId: number) {
    const target = await this.prisma.comment.findUnique({ where: { id: commentId }, select: { postId: true } });
    if (!target) throw new NotFoundException('评论不存在');
    return this.prisma.$transaction(async tx => {
      // Same lock order as comment creation: post first, then comment.
      const post = await tx.post.update({ where: { id: target.postId, status: 'APPROVED' }, data: { updatedAt: new Date() } });
      const comment = await tx.comment.findUnique({ where: { id: commentId } });
      const actor = await tx.user.findUnique({ where: { id: userId } });
      if (!actor || actor.status !== 'ACTIVE' || (comment.userId !== userId && actor.role !== 'ADMIN'))
        throw new ForbiddenException('只能删除自己的评论');
      const changed = await tx.comment.updateMany({ where: { id: commentId, status: 'ACTIVE' }, data: { status: 'DELETED' } });
      if (changed.count) {
        await tx.post.update({ where: { id: target.postId }, data: { commentCount: { decrement: 1 } } });
        await this.events?.append(tx, { kind: 'COMMENT_DELETED', postId: target.postId, postRevision: post.revision, actorId: userId,
          payload: { commentId, delta: { comments: -1 } } });
      }
      // Preserve replies and keep the original row for recovery/moderation, never expose its deleted content.
      return { deleted: true };
    });
  }

  async createComment(postId: number, userId: number, data: any) {
    return this.prisma.$transaction(async tx => {
      await this.active(userId, tx);
      const post = await tx.post.update({ where: { id: postId, status: 'APPROVED' },
        data: { commentCount: { increment: 1 } } });
      const parent = data.parentId ? await tx.comment.findFirst({
        where: { id: data.parentId, postId, status: 'ACTIVE', parentId: null },
      }) : null;
      if (data.parentId && !parent) throw new NotFoundException('只能回复本帖的有效一级评论');
      const comment = await tx.comment.create({ data: {
        content: data.content, parentId: data.parentId, postId, userId,
      }, include: { user: { select: { id: true, username: true, avatar: true } } } });
      for (const recipient of new Set([post.userId, parent?.userId].filter(id => id && id !== userId))) {
        await tx.notification.create({ data: {
          userId: recipient, type: 'COMMENT', title: '收到评论', content: '你的讨论有新回复', relatedId: postId, relatedCommentId: comment.id,
        } });
      }
      await this.events?.append(tx, { kind: 'COMMENT_CREATED', postId, postRevision: post.revision, actorId: userId,
        payload: { commentId: comment.id, delta: { comments: 1 } } });
      return { ...comment, isLiked: false, canDelete: true, replies: [], replyCount: 0, contentFormat: 'plain' };
    });
  }

  async likeComment(commentId: number, userId: number) {
    await this.active(userId);
    await this.prisma.$transaction(async tx => {
      const comment = await tx.comment.update({ where: { id: commentId, status: 'ACTIVE' }, data: { updatedAt: new Date() } });
      if (!await tx.post.findFirst({ where: { id: comment.postId, status: 'APPROVED' } })) throw new NotFoundException();
      const inserted = await tx.commentLike.createMany({ data: [{ userId, commentId }], skipDuplicates: true });
      if (!inserted.count) return;
      await tx.comment.update({ where: { id: commentId }, data: { likeCount: { increment: 1 } } });
    });
    return { message: 'Comment liked' };
  }

  async unlikeComment(commentId: number, userId: number) {
    await this.active(userId);
    await this.prisma.$transaction(async tx => {
      await tx.comment.update({ where: { id: commentId }, data: { updatedAt: new Date() } });
      const deleted = await tx.commentLike.deleteMany({ where: { commentId, userId } });
      if (deleted.count) await tx.comment.update({ where: { id: commentId }, data: { likeCount: { decrement: 1 } } });
    });
    return { message: 'Comment unliked' };
  }

  async getCategories() {
    if (this.categoryCache?.expires > Date.now()) return this.categoryCache.data;
    if (!this.categoryPending) this.categoryPending = this.prisma.category.findMany({ orderBy: { order: 'asc' },
      include: { _count: { select: { posts: { where: { status: 'APPROVED' } } } } },
    }).then(rows => {
      const countObservedAt = new Date().toISOString(), data = rows.map(row => ({ ...row, countObservedAt }));
      this.categoryCache = { data, expires: Date.now() + 30000 }; return data;
    }).finally(() => { this.categoryPending = undefined; });
    return this.categoryPending;
  }

  async getTags(limit = 30) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('标签数量无效');
    if (this.tagCache?.expires > Date.now()) return this.tagCache.data.slice(0, limit);
    // All limits share one bounded Top100 snapshot/single-flight, not 100 full aggregates.
    if (!this.tagPending) this.tagPending = this.prisma.$queryRaw<Array<{ id: number; name: string; count: bigint }>>(Prisma.sql`
        SELECT t.id,t.name,COUNT(*) AS count FROM tags t JOIN post_tags pt ON pt.tagId=t.id
        JOIN posts p ON p.id=pt.postId AND p.status='APPROVED'
        GROUP BY t.id,t.name ORDER BY count DESC,t.id ASC LIMIT 100`).then(rows => {
        const data = rows.map(t => ({ id: t.id, name: t.name, count: Number(t.count), _count: { posts: Number(t.count) } }));
        this.tagCache = { data, expires: Date.now() + 30000 }; return data;
      }).finally(() => { this.tagPending = undefined; });
    return (await this.tagPending).slice(0, limit);
  }

  async getTagOptions(params: Partial<TagOptionsQueryDto> = {}) {
    const limit = params.limit ?? 20, q = params.q?.trim() || '';
    if (!Number.isInteger(limit) || limit < 1 || limit > 30 || q.length > 80) throw new BadRequestException('标签查询参数无效');
    const filter = webFilterKey(['web-tag-options-v1', q, limit]), secret = configuration().jwt.accessSecret;
    const cursor = params.cursor ? readWebCursor(params.cursor, filter, 'tags', secret) as TagOptionCursor : null;
    const where = q ? Prisma.sql`AND LOCATE(${q},t.name)>0` : Prisma.empty;
    const anchor = cursor ? Prisma.sql`AND (t.name>${cursor.name} OR (t.name=${cursor.name} AND t.id>${cursor.id}))` : Prisma.empty;
    // Name-index seek selects only the bounded options; no all-association aggregate per keystroke.
    const rows = await this.prisma.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
      SELECT t.id,t.name FROM tags t WHERE EXISTS (SELECT 1 FROM post_tags pt JOIN posts p ON p.id=pt.postId
        WHERE pt.tagId=t.id AND p.status='APPROVED') ${where} ${anchor}
      ORDER BY t.name ASC,t.id ASC LIMIT ${limit + 1}`);
    const kept = rows.slice(0, limit), last = kept[kept.length - 1], hasMore = rows.length > limit;
    return { data: kept.map(t => ({ id: t.id, name: t.name })), limit, hasMore,
      nextCursor: hasMore && last ? signWebCursor({ v: 1, kind: 'tags', filter, asOf: cursor?.asOf ?? new Date().toISOString(), name: last.name, id: last.id }, secret) : null };
  }

  async getNotifications(userId: number, params: Partial<NotificationQueryDto> = {}) {
    await this.active(userId);
    const { page = 1, limit = 20, unreadOnly = false, type } = params;
    const where = { userId, ...(unreadOnly ? { isRead: false } : {}), ...(type ? { type } : {}) };
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.notification.count({ where }), this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    const postIds = rows.filter(n => n.type === 'COMMENT' || n.type === 'LIKE').map(n => n.relatedId).filter(Boolean);
    const followIds = rows.filter(n => n.type === 'FOLLOW').map(n => n.relatedId).filter(Boolean);
    const reportIds=rows.filter(n=>n.type==='SYSTEM'&&n.relatedReportId).map(n=>n.relatedReportId);
    const [posts, users, watches, reports] = await Promise.all([
      this.prisma.post.findMany({ where: { id: { in: postIds }, OR: [{ status: 'APPROVED' }, { userId }] }, select: { id: true } }),
      this.prisma.user.findMany({ where: { id: { in: followIds }, status: 'ACTIVE' }, select: { id: true } }),
      this.subscriptions?.notificationTargets(userId, rows.filter(n => n.type === 'SYSTEM').map(n => n.id)) || new Map<number,number>(),
      reportIds.length?this.prisma.report.findMany({where:{id:{in:reportIds},OR:[{reporterId:userId},{targetUserId:userId}]},
        select:{id:true,reporterId:true}}):Promise.resolve([]),
    ]);
    const visiblePosts = new Set(posts.map(p => p.id)), visibleUsers = new Set(users.map(u => u.id));
    const reportTargets=new Map(reports.map(r=>[r.id,r.reporterId===userId?'mine':'decisions']));
    const data = rows.map(n => ({ ...n, url: n.type==='SYSTEM'&&reportTargets.has(n.relatedReportId)
      ? `/reports?case=${n.relatedReportId}&tab=${reportTargets.get(n.relatedReportId)}` : watches.has(n.id) ? watches.get(n.id) ? `/forum/post/${watches.get(n.id)}` : null : (n.type === 'COMMENT' || n.type === 'LIKE') && visiblePosts.has(n.relatedId)
      ? `/forum/post/${n.relatedId}${n.relatedCommentId ? '?comment=' + n.relatedCommentId : ''}`
      : n.type === 'FOLLOW' && visibleUsers.has(n.relatedId) ? `/user/${n.relatedId}` : null }));
    return { data, total, page, limit, totalPages: Math.ceil(total / limit), unreadCount };
  }

  async unreadNotificationCount(userId: number) {
    await this.active(userId);
    return { unreadCount: await this.prisma.notification.count({ where: { userId, isRead: false } }) };
  }

  async markAllNotificationsRead(userId: number) {
    await this.active(userId);
    const result = await this.prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
    return { updated: result.count };
  }

  async markNotificationRead(notificationId: number, userId: number) {
    await this.active(userId);
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });

    return { message: 'Notification marked as read' };
  }

  async personalPosts(userId: number, kind: 'posts' | 'favorites', params: Partial<PageQueryDto> = {}) {
    await this.active(userId);
    const { page = 1, limit = 20 } = params;
    const where = kind === 'posts' ? Prisma.sql`p.userId=${userId}` : Prisma.sql`p.status='APPROVED' AND EXISTS
      (SELECT 1 FROM favorites f WHERE f.postId=p.id AND f.userId=${userId})`;
    const order = kind === 'posts' ? Prisma.sql`p.createdAt` : Prisma.sql`(SELECT f.createdAt FROM favorites f WHERE f.postId=p.id AND f.userId=${userId})`;
    const [rows, stats] = await Promise.all([
      this.prisma.$queryRaw<Array<{id:number;excerpt:string;lastReplyAt:Date}>>(Prisma.sql`SELECT p.id,LEFT(p.content,480) AS excerpt,
        (SELECT MAX(c.createdAt) FROM comments c WHERE c.postId=p.id AND c.status='ACTIVE') AS lastReplyAt
        FROM posts p WHERE ${where} ORDER BY ${order} DESC,p.id DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.prisma.$queryRaw<Array<{total:bigint}>>(Prisma.sql`SELECT COUNT(*) AS total FROM posts p WHERE ${where}`),
    ]);
    const total = Number(stats[0]?.total || 0);
    return { data: await this.summaries(rows, userId, kind === 'posts'), total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async personalReplies(userId: number, params: Partial<PageQueryDto> = {}) {
    await this.active(userId);
    const { page = 1, limit = 20 } = params, where = { userId, status: 'ACTIVE' as const, post: { status: 'APPROVED' as const } };
    const [data, total] = await Promise.all([
      this.prisma.comment.findMany({ where, select: { id: true, content: true, parentId: true, postId: true, createdAt: true,
        post: { select: { id: true, title: true, status: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.comment.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async personalFollowing(userId: number, params: Partial<PageQueryDto> = {}) {
    await this.active(userId);
    const { page = 1, limit = 20 } = params, where = { followerId: userId, following: { status: 'ACTIVE' as const } };
    const [rows, total] = await Promise.all([
      this.prisma.follow.findMany({ where, select: { createdAt: true, following: { select: { ...authorSelect, bio: true, level: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * limit, take: limit }),
      this.prisma.follow.count({ where }),
    ]);
    return { data: rows.map(row => ({ ...row.following, followedAt: row.createdAt })), total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}

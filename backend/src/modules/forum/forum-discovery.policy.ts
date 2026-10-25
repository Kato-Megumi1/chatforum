import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

export const FORUM_DISCOVERY_VERSION = 'forum-discovery-v3';
const common = {
  hours: z.number().int().min(1).max(720).optional(),
  limit: z.number().int().min(1).max(20).default(5),
  categoryId: z.number().int().positive().optional(),
  category: z.string().trim().min(1).max(50).optional(),
  query: z.string().trim().min(1).max(80).refine(v => v.split(/\s+/).length <= 8, '关键词最多8项').optional(),
};
export const hotQuery = z.object({ ...common, rankingBasis: z.enum(['published','interaction']).default('published'),
  sortBy: z.enum(['hotness', 'views', 'likes', 'comments']).default('hotness') }).strict();
const listQuery = z.object({ ...common,
  // A result count is not a time window. Omitted hours means all published history.
  hours: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  timeRange: z.enum(['all', 'window']).optional(), sinceLastQuery: z.boolean().default(false),
  includeTotal: z.boolean().default(false),
  sortOrder: z.enum(['asc', 'desc']).default('desc'), cursor: z.string().max(16003).optional() }).strict();
function checkTimeRange(args: { timeRange?: string; hours?: number }, ctx: z.RefinementCtx) {
  if (args.timeRange === 'all' && args.hours !== undefined)
    ctx.addIssue({ code: 'custom', path: ['hours'], message: '全部历史不应同时传hours；最新N条用timeRange=all和limit=N。' });
  if (args.timeRange === 'window' && args.hours === undefined)
    ctx.addIssue({ code: 'custom', path: ['hours'], message: '按时间查询必须提供用户指定的hours。' });
}
export const recentQuery = listQuery.superRefine(checkTimeRange);
export const searchQuery = listQuery.extend({ query: common.query.unwrap(), sinceLastQuery: z.literal(false).default(false) }).superRefine(checkTimeRange);
export const detailQuery = z.object({ postId: z.number().int().positive(), offset: z.number().int().min(0).max(50000).default(0) }).strict();
export type ForumScope = { userId?: number; conversationId?: number };
export const filterKey = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export interface ForumCursor { v: 1; filter: string; asOf: string; since: string; maxId: number; id: number; at: string;
  total?: number; totalObservedAt?: string; }
export function encodeCursor(cursor: ForumCursor, secret: string) {
  const data = Buffer.from(JSON.stringify(cursor)).toString('base64url');
  return data + '.' + createHmac('sha256', secret).update(data).digest('base64url');
}
export function decodeCursor(value: string, filter: string, secret: string): ForumCursor {
  const [data, signature, extra] = value.split('.');
  const expected = createHmac('sha256', secret).update(data || '').digest();
  const supplied = Buffer.from(signature || '', 'base64url');
  if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw Error('INVALID_CURSOR');
  const parsed = z.object({ v: z.literal(1), filter: z.literal(filter), asOf: z.string().datetime(), since: z.string().datetime(),
    maxId: z.number().int().nonnegative(), id: z.number().int().positive(), at: z.string().datetime(),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), totalObservedAt: z.string().datetime().optional(),
  }).strict().refine(p => (p.total === undefined) === (p.totalObservedAt === undefined), 'Incomplete count observation')
    .parse(JSON.parse(Buffer.from(data, 'base64url').toString()));
  if (Date.parse(parsed.asOf) < Date.now() - 24 * 3600000 || Date.parse(parsed.since) > Date.parse(parsed.asOf)) throw Error('INVALID_CURSOR');
  return parsed as ForumCursor;
}

export interface RankedPost { id: number; viewCount: number; likeCount: number; commentCount: number; }
// Only compare surviving public posts. Absence from a top-N list is not proof of deletion or an exact rank.
export function rankChanges(current: RankedPost[], previous?: RankedPost[]) {
  if (!previous) return [];
  const old = new Map(previous.map((p, i) => [p.id, { ...p, rank: i + 1 }]));
  return current.map((p, i) => { const before = old.get(p.id); return { postId: p.id, rank: i + 1,
    previousRank: before?.rank ?? null, rankChange: before ? before.rank - i - 1 : null,
    enteredTop: !before, delta: before ? { views: p.viewCount - before.viewCount,
      likes: p.likeCount - before.likeCount, comments: p.commentCount - before.commentCount } : null }; });
}

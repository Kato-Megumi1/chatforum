import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import configuration from '../../config/configuration';
import { ForumSearchAdapter, ForumSearchError, ForumSearchFilters, forumIndexName } from './forum-search.adapter';
import { ForumSearchIndexService } from './forum-search-index.service';

export interface ForumSearchRequest extends ForumSearchFilters { limit?: number; cursor?: string; scopeKey?: string; hours?: number; }
const dateFilter = z.union([z.string().datetime(), z.date()]).transform(value => value instanceof Date ? value.toISOString() : value).optional();
const requestSchema = z.object({ query: z.string().trim().min(1).max(200), categoryId: z.number().int().positive().optional(),
  tagId: z.number().int().positive().optional(), userId: z.number().int().positive().optional(),
  sort: z.enum(['relevance', 'createdAt']).default('relevance'), sortOrder: z.enum(['asc', 'desc']).default('desc'),
  limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(16000).optional(), scopeKey: z.string().max(200).default('public'),
  since: dateFilter, until: dateFilter, hours: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict()
  .refine(value => (!value.since || value.hours === undefined) && (!value.since || !value.until || value.since <= value.until));
const cursorSchema = z.object({ v: z.literal(1), filter: z.string(), index: z.string().refine(forumIndexName), buildId: z.string().max(80),
  pit: z.string().min(1).max(10000), asOf: z.string().datetime(), expiresAt: z.number().int(),
  after: z.array(z.union([z.string(), z.number().finite()])).min(2).max(3).nullable(),
  total: z.object({ value: z.number().int().nonnegative(), relation: z.enum(['eq', 'gte']) }).strict() }).strict();
type SearchCursor = z.infer<typeof cursorSchema>;
function sign(value: SearchCursor, secret: string) {
  if (!secret || secret.length < 32) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
  const data = Buffer.from(JSON.stringify(value)).toString('base64url');
  return data + '.' + createHmac('sha256', secret).update('forum-search-pit-v1\0' + data).digest('base64url');
}
function decode(value: string, filter: string, secret: string): SearchCursor {
  if (!secret || secret.length < 32) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
  try {
    if (!/^[\w-]+\.[\w-]+$/.test(value)) throw Error('Invalid encoding');
    const [data, signature] = value.split('.'), expected = createHmac('sha256', secret).update('forum-search-pit-v1\0' + data).digest();
    const supplied = Buffer.from(signature, 'base64url'); if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) throw Error('Invalid signature');
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
    if (cursor.filter !== filter) throw Error('Different filters');
    if (cursor.expiresAt < Date.now() || Date.parse(cursor.asOf) < Date.now() - 30 * 60000) throw new ForumSearchError('FORUM_SEARCH_EXPIRED', 409);
    return cursor;
  } catch (error) { if (error instanceof ForumSearchError) throw error; throw new ForumSearchError('FORUM_SEARCH_INVALID_CURSOR', 400); }
}

/** Only candidates. The caller MUST re-read SQL APPROVED + exact revision immediately before delivery. */
@Injectable()
export class ForumSearchService {
  constructor(private readonly adapter: ForumSearchAdapter, private readonly indices: ForumSearchIndexService) {}
  async search(input: ForumSearchRequest) {
    if (process.env.FORUM_SEARCH_ENABLED !== 'true' || !this.adapter.configured()) throw new ForumSearchError('FORUM_SEARCH_NOT_READY');
    const parsed = requestSchema.safeParse(input); if (!parsed.success) throw new ForumSearchError('FORUM_SEARCH_INVALID_CURSOR', 400);
    const args = parsed.data, filter = createHash('sha256').update(JSON.stringify(['forum-search-pit-v1', args.query,
      args.categoryId ?? null, args.tagId ?? null, args.userId ?? null, args.sort, args.sortOrder, args.limit, args.scopeKey,
      args.since ?? null, args.until ?? null, args.hours ?? null])).digest('hex');
    const secret = configuration().jwt.accessSecret;
    if (!secret || secret.length < 32) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
    let cursor: SearchCursor;
    if (args.cursor) cursor = decode(args.cursor, filter, secret);
    else {
      const active = await this.indices.activeIndex(), asOf = new Date().toISOString();
      try { cursor = { v: 1, filter, index: active.indexName, buildId: active.buildId, pit: await this.adapter.createPit(active.indexName),
        asOf, expiresAt: Date.now() + 120000, after: null, total: { value: 0, relation: 'eq' } }; }
      catch (error) { await this.indices.markDegraded().catch(() => undefined); throw error; }
    }
    try {
      const filters = { ...args, ...(args.hours === undefined ? {} : { since: new Date(Math.max(0, Date.parse(cursor.asOf) - args.hours * 3600000)).toISOString() }) };
      const result = await this.adapter.search(cursor.pit, filters as ForumSearchFilters, cursor.asOf, args.limit, cursor.after ?? undefined, !args.cursor);
      const hits = result.hits.hits, kept = hits.slice(0, args.limit), hasMore = hits.length > args.limit;
      if (!args.cursor) {
        const total = result.hits.total;
        cursor.total = typeof total === 'number' ? { value: total, relation: 'eq' } : total;
        if (!cursor.total || !Number.isSafeInteger(cursor.total.value) || cursor.total.value < 0 || !['eq', 'gte'].includes(cursor.total.relation)) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
      }
      if (result.pit_id) cursor.pit = result.pit_id;
      cursor.expiresAt = Date.now() + 120000;
      const candidates = kept.map(hit => {
        const id = hit._source?.postId, revision = hit._source?.revision;
        if (!Number.isSafeInteger(id) || id < 1 || String(id) !== String(hit._id) || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(hit.sort))
          throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
        const snippet = String(hit.highlight?.content?.[0] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
        return { id, revision, snippet, score: Number(hit._score) || 0 };
      });
      return { candidates, hasMore, nextCursor: hasMore && kept.length ? sign({ ...cursor, after: kept[kept.length - 1].sort }, secret) : null,
        pageCursor: sign(cursor, secret), asOf: cursor.asOf, total: { ...cursor.total, observedAt: cursor.asOf, basis: 'index_pit_not_live_acl' },
        engine: 'opensearch' as const, indexVersion: cursor.buildId, degraded: false };
    } catch (error) {
      if (!(error instanceof ForumSearchError) || error.code === 'FORUM_SEARCH_UNAVAILABLE') await this.indices.markDegraded().catch(() => undefined);
      if (!args.cursor) await this.adapter.closePit(cursor.pit).catch(() => undefined);
      throw error;
    }
  }
}

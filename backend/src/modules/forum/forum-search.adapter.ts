import { Injectable } from '@nestjs/common';

export const FORUM_SEARCH_MAPPING_VERSION = 'forum-search-cjk-bm25-v1';
export class ForumSearchError extends Error {
  constructor(public readonly code: 'FORUM_SEARCH_UNAVAILABLE' | 'FORUM_SEARCH_EXPIRED' | 'FORUM_SEARCH_INVALID_CURSOR' | 'FORUM_SEARCH_NOT_READY' | 'FORUM_SEARCH_CONFLICT', public readonly status = 503) { super(code); }
}
export interface ForumSearchDocument {
  postId: number; revision: number; status: string; title: string; content: string;
  categoryId: number; userId: number; tagIds: number[]; createdAt: string;
}
export interface ForumSearchFilters { query: string; categoryId?: number; tagId?: number; userId?: number;
  sort?: 'relevance' | 'createdAt'; sortOrder?: 'asc' | 'desc'; since?: string | Date; until?: string | Date; }
export const forumIndexName = (name: string) => /^chatforum-forum-[a-z0-9-]{1,100}$/.test(name);

/** Server-only configuration; callers cannot supply endpoints, credentials or arbitrary REST paths. */
@Injectable()
export class ForumSearchAdapter {
  private readonly base: string;
  private readonly authorization?: string;
  readonly alias: string;
  constructor() {
    this.alias = process.env.FORUM_SEARCH_ALIAS || 'chatforum-forum-read';
    if (!forumIndexName(this.alias)) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
    const input = process.env.FORUM_SEARCH_URL;
    if (!input) { this.base = ''; return; }
    try {
      const url = new URL(input);
      if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || process.env.FORUM_SEARCH_ALLOW_INSECURE === 'true')))
        throw Error('Invalid endpoint');
      this.base = url.origin;
      if (process.env.FORUM_SEARCH_USERNAME || process.env.FORUM_SEARCH_PASSWORD) {
        if (!process.env.FORUM_SEARCH_USERNAME || !process.env.FORUM_SEARCH_PASSWORD) throw Error('Incomplete credentials');
        this.authorization = 'Basic ' + Buffer.from(process.env.FORUM_SEARCH_USERNAME + ':' + process.env.FORUM_SEARCH_PASSWORD).toString('base64');
      }
    } catch { throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'); }
  }
  configured() { return !!this.base; }
  private index(name: string) { if (!forumIndexName(name)) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'); return encodeURIComponent(name); }
  private async request(method: string, path: string, body?: unknown, allowed: number[] = [], ndjson = false): Promise<any> {
    if (!this.base) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
    try {
      const response = await fetch(this.base + path, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': ndjson ? 'application/x-ndjson' : 'application/json', ...(this.authorization ? { Authorization: this.authorization } : {}) },
        ...(body === undefined ? {} : { body: ndjson ? body as string : JSON.stringify(body) }) });
      if (allowed.includes(response.status)) { await response.body?.cancel(); return { status: response.status }; }
      if (!response.ok) { await response.body?.cancel(); throw new ForumSearchError(response.status === 404 && path === '/_search' ? 'FORUM_SEARCH_EXPIRED' : 'FORUM_SEARCH_UNAVAILABLE', response.status === 404 && path === '/_search' ? 409 : 503); }
      if (method === 'HEAD') return { status: response.status };
      const reader = response.body?.getReader(); if (!reader) throw Error('No response');
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
        if (bytes > 5 * 1024 * 1024) { await reader.cancel(); throw Error('Oversize response'); } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (error instanceof ForumSearchError) throw error; throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'); }
  }
  async createIndex(index: string) {
    return this.request('PUT', '/' + this.index(index), { settings: { number_of_shards: 1, number_of_replicas: 0,
      analysis: { analyzer: { forum_cjk: { type: 'custom', tokenizer: 'standard', filter: ['cjk_width', 'lowercase', 'forum_cjk_bigrams'] } },
        filter: { forum_cjk_bigrams: { type: 'cjk_bigram', output_unigrams: true } } },
      similarity: { forum_bm25: { type: 'BM25', k1: 1.2, b: 0.75 } } },
      mappings: { dynamic: 'strict', _meta: { version: FORUM_SEARCH_MAPPING_VERSION }, properties: {
        postId: { type: 'integer' }, revision: { type: 'integer' }, status: { type: 'keyword' },
        title: { type: 'text', analyzer: 'forum_cjk', similarity: 'forum_bm25' }, content: { type: 'text', analyzer: 'forum_cjk', similarity: 'forum_bm25' },
        categoryId: { type: 'integer' }, userId: { type: 'integer' }, tagIds: { type: 'integer' }, createdAt: { type: 'date' },
      } } });
  }
  async bulk(index: string, docs: ForumSearchDocument[]) {
    if (!docs.length) return;
    const target = this.index(index);
    const body = docs.map(doc => JSON.stringify({ index: { _index: target, _id: String(doc.postId), version: doc.revision, version_type: 'external' } }) + '\n' + JSON.stringify(doc)).join('\n') + '\n';
    const result = await this.request('POST', '/_bulk?refresh=false', body, [], true);
    if (!Array.isArray(result.items) || result.items.length !== docs.length || result.items.some(item => {
      const op = item.index; return !op || !(op.status >= 200 && op.status < 300 || op.status === 409 && op.error?.type === 'version_conflict_engine_exception');
    })) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
  }
  async refresh(index: string) { await this.request('POST', '/' + this.index(index) + '/_refresh'); }
  async count(index: string) { const result = await this.request('POST', '/' + this.index(index) + '/_count', { query: { term: { status: 'APPROVED' } } }); return Number(result.count); }
  async documents(index: string, ids: number[]) {
    const result = await this.request('POST', '/' + this.index(index) + '/_mget', { docs: ids.map(id => ({ _id: String(id), _source: ['postId', 'revision', 'status'] })) });
    if (!Array.isArray(result.docs)) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
    return result.docs.filter(doc => doc.found).map(doc => doc._source) as Array<Pick<ForumSearchDocument, 'postId' | 'revision' | 'status'>>;
  }
  async aliasIndices() {
    const result = await this.request('GET', '/_alias/' + this.index(this.alias), undefined, [404]);
    if (result.status === 404) return [] as string[];
    const indices = Object.keys(result); if (indices.some(name => !forumIndexName(name))) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409); return indices;
  }
  async switchAlias(index: string) {
    this.index(index); const previous = await this.aliasIndices();
    const result = await this.request('POST', '/_aliases', { actions: [
      ...previous.map(old => ({ remove: { index: old, alias: this.alias, must_exist: true } })), { add: { index, alias: this.alias } },
    ] });
    if (result.acknowledged !== true) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
  }
  async createPit(index: string) {
    const result = await this.request('POST', '/' + this.index(index) + '/_search/point_in_time?keep_alive=2m&allow_partial_pit_creation=false');
    if (!result.pit_id || result._shards?.failed) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE'); return String(result.pit_id);
  }
  async closePit(id: string) { await this.request('DELETE', '/_search/point_in_time', { pit_id: [id] }); }
  async inspectPage(pit: string, after?: Array<string | number>) {
    const result = await this.request('POST', '/_search', { pit: { id: pit, keep_alive: '2m' }, size: 200,
      track_total_hits: false, _source: ['postId', 'revision', 'status'], query: { match_all: {} }, sort: [{ postId: 'asc' }],
      ...(after ? { search_after: after } : {}) });
    if (result.timed_out || result._shards?.failed || !Array.isArray(result.hits?.hits)) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
    return { docs: result.hits.hits.map(hit => hit._source) as Array<Pick<ForumSearchDocument, 'postId' | 'revision' | 'status'>>,
      after: result.hits.hits.length === 200 ? result.hits.hits[199].sort as Array<string | number> : null };
  }
  async search(pit: string, filters: ForumSearchFilters, asOf: string, limit: number, after?: Array<string | number>, withTotal = true) {
    const since = filters.since instanceof Date ? filters.since.toISOString() : filters.since;
    const until = filters.until instanceof Date ? filters.until.toISOString() : filters.until;
    const filter: any[] = [{ term: { status: 'APPROVED' } }, { range: { createdAt: { lte: until && until < asOf ? until : asOf, ...(since ? { gte: since } : {}) } } }];
    for (const key of ['categoryId', 'userId'] as const) if (filters[key]) filter.push({ term: { [key]: filters[key] } });
    if (filters.tagId) filter.push({ term: { tagIds: filters.tagId } });
    const order = filters.sortOrder || 'desc';
    const result = await this.request('POST', '/_search', { pit: { id: pit, keep_alive: '2m' }, size: limit + 1,
      track_total_hits: withTotal, _source: ['postId', 'revision'], query: { bool: { filter,
        must: [{ multi_match: { query: filters.query, fields: ['title^3', 'content'], type: 'best_fields', operator: 'and' } }] } },
      sort: filters.sort === 'createdAt' ? [{ createdAt: order }, { postId: order }] : [{ _score: 'desc' }, { createdAt: 'desc' }, { postId: 'desc' }],
      highlight: { pre_tags: [''], post_tags: [''], fields: { content: { fragment_size: 240, number_of_fragments: 1, no_match_size: 240 } } },
      ...(after ? { search_after: after } : {}) });
    if (result.timed_out || result._shards?.failed || !Array.isArray(result.hits?.hits)) throw new ForumSearchError('FORUM_SEARCH_UNAVAILABLE');
    return result;
  }
}

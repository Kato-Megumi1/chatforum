// A short-lived display cache only. The background request still revalidates the
// signed page and the server's current visibility/permission rules.
export interface ForumFeedScope { userId: number | null; epoch: number; }
export interface ForumFeedCacheQuery {
  categoryId: string; tagId: string; search: string; sortBy: string;
  hotBasis: string; hotPeriod: string; pageSize: number; page: number; cursor: string;
}
export const FORUM_FEED_CACHE_TTL = 30_000;
export const FORUM_FEED_CACHE_MAX_PAGES = 16;

const scopeKey = (scope: ForumFeedScope) => JSON.stringify([scope.userId, scope.epoch]);
const queryKey = (query: ForumFeedCacheQuery) => JSON.stringify([
  query.categoryId, query.tagId, query.search, query.sortBy, query.hotBasis,
  query.hotPeriod, query.pageSize, query.page, query.cursor,
]);
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class ForumFeedCache<T> {
  private entries = new Map<string, { value: T; savedAt: number }>();
  private currentScope = '';
  private generation = 0;
  constructor(private now: () => number = Date.now) {}

  revision(scope?: ForumFeedScope) {
    if (scope) {
      const next = scopeKey(scope);
      if (this.currentScope !== next) {
        this.currentScope = next;
        this.invalidate();
      }
    }
    return this.generation;
  }

  invalidate() {
    this.entries.clear();
    this.generation++;
  }

  read(scope: ForumFeedScope, query: ForumFeedCacheQuery): { value: T; expiresAt: number } | null {
    this.revision(scope);
    const key = queryKey(query), entry = this.entries.get(key);
    if (!entry) return null;
    const age = this.now() - entry.savedAt;
    if (age < 0 || age >= FORUM_FEED_CACHE_TTL) { this.entries.delete(key); return null; }
    // LRU order changes; reading a page never extends its validity window.
    this.entries.delete(key); this.entries.set(key, entry);
    return { value: copy(entry.value), expiresAt: entry.savedAt + FORUM_FEED_CACHE_TTL };
  }

  write(scope: ForumFeedScope, query: ForumFeedCacheQuery, value: T, expectedRevision: number): boolean {
    // An old account response cannot select its scope again or repopulate a cache
    // that a successful favourite/follow/comment mutation already invalidated.
    if (this.currentScope !== scopeKey(scope) || expectedRevision !== this.generation) return false;
    const key = queryKey(query);
    this.entries.delete(key); this.entries.set(key, { value: copy(value), savedAt: this.now() });
    while (this.entries.size > FORUM_FEED_CACHE_MAX_PAGES) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }
}

export interface ForumFeedSnapshot { data: any; likesTotal: number | null; }
export const forumFeedCache = new ForumFeedCache<ForumFeedSnapshot>();
export const invalidateForumFeedCache = () => forumFeedCache.invalidate();
export const forumFeedCacheRevision = (scope?: ForumFeedScope) => forumFeedCache.revision(scope);

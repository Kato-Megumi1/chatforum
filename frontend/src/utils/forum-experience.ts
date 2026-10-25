export interface ForumFilters {
  categoryId: string; tagId: string; search: string; sortBy: string; hotPeriod: string; page: number; limit: number; cursor: string;
}
const scalar = (v: unknown) => typeof v === 'string' ? v : '';
export function forumFilters(query: Record<string, unknown>): ForumFilters {
  const positive = (v: unknown, fallback: number, max: number) => /^\d+$/.test(scalar(v)) ? Math.min(max, Math.max(1, Number(v))) : fallback;
  return { categoryId: /^\d+$/.test(scalar(query.category)) ? scalar(query.category) : '',
    tagId: /^\d+$/.test(scalar(query.tag)) ? scalar(query.tag) : '', search: scalar(query.q).slice(0, 200),
    sortBy: ['createdAt', 'popular', 'likes'].includes(scalar(query.sort)) ? scalar(query.sort) : 'createdAt',
    hotPeriod: ['today', 'week', 'all'].includes(scalar(query.period)) ? scalar(query.period) : 'week',
    page: positive(query.page, 1, Number.MAX_SAFE_INTEGER), limit: [10, 20, 50].includes(Number(query.limit)) ? Number(query.limit) : 20,
    cursor: scalar(query.cursor).length <= 16000 ? scalar(query.cursor) : '' };
}
export function forumQuery(filters: ForumFilters) {
  const query: Record<string, string> = {};
  if (filters.categoryId) query.category = filters.categoryId;
  if (filters.tagId) query.tag = filters.tagId;
  if (filters.search.trim()) query.q = filters.search.trim();
  if (filters.sortBy !== 'createdAt') query.sort = filters.sortBy;
  if (filters.sortBy === 'popular') query.period = filters.hotPeriod;
  if (filters.page > 1) query.page = String(filters.page);
  if (filters.cursor) query.cursor = filters.cursor;
  if (filters.limit !== 20) query.limit = String(filters.limit);
  return query;
}
const navigationKey = (userId: number) => 'chatforum-forum-navigation-v1:' + userId;
export interface ForumFeedNavigation { filterKey: string; cursors: Record<string, string>; }
// Navigation is optional derived state, not an unbounded archive of every PIT token ever read.
function navigationCursors(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const current = Number(new URLSearchParams(path.split('?')[1] || '').get('page') || 1);
  return Object.fromEntries(Object.entries(value).filter(([page, cursor]) => /^[1-9]\d*$/.test(page)
    && Number.isSafeInteger(Number(page)) && typeof cursor === 'string' && cursor.length <= 16000)
    .sort(([a], [b]) => (a === b ? 0 : a === '1' ? -1 : b === '1' ? 1 : Math.abs(Number(a) - current) - Math.abs(Number(b) - current)))
    .slice(0, 32));
}
export function forumFilterKey(filters: ForumFilters): string {
  return JSON.stringify(forumQuery({ ...filters, page: 1, cursor: '' }));
}
export function readForumNavigation(userId: number): { path: string; scroll: number; feed?: ForumFeedNavigation } | null {
  try { const value = JSON.parse(sessionStorage.getItem(navigationKey(userId)) || 'null');
    return value?.userId === userId && /^\/forum(?:\?|$)/.test(value.path) && typeof value.scroll === 'number' && Number.isFinite(value.scroll)
      ? { path: value.path, scroll: Math.max(0, value.scroll),
        ...(value.feed && typeof value.feed.filterKey === 'string' && value.feed.cursors && typeof value.feed.cursors === 'object' && !Array.isArray(value.feed.cursors)
          && Object.entries(value.feed.cursors).every(([page, cursor]) => /^[1-9]\d*$/.test(page) && typeof cursor === 'string' && cursor.length <= 16000)
          ? { feed: { filterKey: value.feed.filterKey, cursors: navigationCursors(value.feed.cursors, value.path) } } : {}) } : null;
  } catch { return null; }
}
export function saveForumNavigation(userId: number, path: string, scroll: number, feed?: ForumFeedNavigation) {
  try { sessionStorage.setItem(navigationKey(userId), JSON.stringify({ userId, path, scroll: Math.max(0, scroll),
    ...(feed ? { feed: { filterKey: feed.filterKey, cursors: navigationCursors(feed.cursors, path) } } : {}) })); } catch { /* navigation is optional */ }
}
export const forumDraftKey = (userId: number, postId?: string) => `chatforum-post-draft-v1:${userId}:${postId || 'new'}`;
export function notificationTarget(item: any): string | null {
  const data = item.data && typeof item.data === 'object' ? item.data : {};
  const postId = Number(item.postId || data.postId);
  const commentId = Number(item.commentId || data.commentId);
  if (Number.isSafeInteger(postId) && postId > 0) return `/forum/post/${postId}${Number.isSafeInteger(commentId) && commentId > 0 ? '?comment=' + commentId : ''}`;
  const userId = Number(item.actorId || item.relatedUserId || data.actorId || data.userId);
  return Number.isSafeInteger(userId) && userId > 0 ? '/user/' + userId : null;
}

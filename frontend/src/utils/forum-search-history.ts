export interface ForumSearchEntry { query: string; submittedAt: number; }
export interface SearchHistoryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; }
export const FORUM_SEARCH_HISTORY_LIMIT = 10;
export const FORUM_SEARCH_HISTORY_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const MAX_QUERY = 200, VERSION = 1;

export function forumSearchHistoryKey(accountId: number | undefined) {
  return Number.isSafeInteger(accountId) && Number(accountId) > 0 ? `chatforum-forum-search-history-v1:${accountId}` : null;
}
export function submittedForumQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  const query = value.trim();
  return query.length <= MAX_QUERY && !/[\u0000-\u001f\u007f]/.test(query) ? query : '';
}
export function readForumSearchHistory(accountId: number | undefined, storage?: SearchHistoryStorage, now = Date.now()): ForumSearchEntry[] {
  const key = forumSearchHistoryKey(accountId);
  if (!key || !storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw || raw.length > 16000) return [];
    const saved = JSON.parse(raw);
    if (saved?.version !== VERSION || saved.accountId !== accountId || !Array.isArray(saved.entries) || saved.entries.length > FORUM_SEARCH_HISTORY_LIMIT) return [];
    const seen = new Set<string>();
    return saved.entries.filter((entry: any) => entry && typeof entry.query === 'string' && entry.query === submittedForumQuery(entry.query) && !!entry.query &&
      Number.isSafeInteger(entry.submittedAt) && entry.submittedAt > now - FORUM_SEARCH_HISTORY_MAX_AGE && entry.submittedAt <= now + 300000)
      .sort((a: ForumSearchEntry, b: ForumSearchEntry) => b.submittedAt - a.submittedAt)
      .filter((entry: ForumSearchEntry) => { if (seen.has(entry.query)) return false; seen.add(entry.query); return true; })
      .map(({ query, submittedAt }: ForumSearchEntry) => ({ query, submittedAt }));
  } catch { return []; }
}
function write(accountId: number | undefined, entries: ForumSearchEntry[], storage?: SearchHistoryStorage): boolean {
  const key = forumSearchHistoryKey(accountId);
  if (!key || !storage) return false;
  try {
    if (entries.length) storage.setItem(key, JSON.stringify({ version: VERSION, accountId, entries }));
    else storage.removeItem(key);
    return true;
  } catch { return false; }
}
// Only a completed user submission calls this function, never a v-model/input watcher.
export function rememberForumSearch(accountId: number | undefined, value: unknown, storage?: SearchHistoryStorage, now = Date.now()): boolean {
  const query = submittedForumQuery(value);
  if (!query) return false;
  const old = readForumSearchHistory(accountId, storage, now);
  return write(accountId, [{ query, submittedAt: now }, ...old.filter(entry => entry.query !== query)].slice(0, FORUM_SEARCH_HISTORY_LIMIT), storage);
}
export function removeForumSearch(accountId: number | undefined, query: string, storage?: SearchHistoryStorage, now = Date.now()): boolean {
  return write(accountId, readForumSearchHistory(accountId, storage, now).filter(entry => entry.query !== query), storage);
}
export function clearForumSearchHistory(accountId: number | undefined, storage?: SearchHistoryStorage): boolean {
  return write(accountId, [], storage);
}

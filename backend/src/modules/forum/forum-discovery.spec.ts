import { hotQuery, recentQuery, searchQuery, encodeCursor, decodeCursor, rankChanges } from './forum-discovery.policy';
import { serializeToolResult } from '../agent/skills/forum-output';
import { jsonSchemaToZod } from '../agent/skills/json-schema-to-zod';
import { ForumHotTopicsSkill } from '../agent/skills/forum-hot-topics.skill';
import { ForumRecentPostsSkill } from '../agent/skills/forum-recent-posts.skill';

describe('forum discovery boundaries', () => {
  test('latest N is all-history by default; explicit windows allow more than 30 days and contradictory ranges fail', () => {
    const latest = recentQuery.parse({ limit: 7, timeRange: 'all' });
    expect(latest.limit).toBe(7); expect(latest.hours).toBeUndefined();
    expect(recentQuery.parse({ limit: 7 }).hours).toBeUndefined();
    const schema = jsonSchemaToZod(new ForumRecentPostsSkill({} as any).tool.parameters);
    for (const hours of [168, 2160, 8760]) {
      expect(recentQuery.parse({ timeRange: 'window', hours }).hours).toBe(hours);
      expect(schema.safeParse({ timeRange: 'window', hours }).success).toBe(true);
      expect(searchQuery.parse({ query: '测试', timeRange: 'window', hours }).hours).toBe(hours);
    }
    for (const args of [{ timeRange: 'all', hours: 720 }, { timeRange: 'window' }, { hours: -1 }, { hours: Infinity }, { hours: 1.5 }])
      expect(recentQuery.safeParse(args).success).toBe(false);
  });
  test('integer/time/limit and unknown arguments are checked, not silently coerced', () => {
    for (const args of [{ limit: -1 }, { limit: 0 }, { limit: 21 }, { limit: 1.2 }, { hours: NaN }, { hours: 721 }, { query: '  ' }, { userId: 1 }])
      expect(hotQuery.safeParse(args).success).toBe(false);
    expect(recentQuery.parse({})).toMatchObject({ limit: 5, sinceLastQuery: false, sortOrder: 'desc' });
    const schema = jsonSchemaToZod(new ForumHotTopicsSkill({} as any).tool.parameters);
    for (const args of [{ hours: -1 }, { hours: 1.1 }, { limit: 21 }]) expect(schema.safeParse(args).success).toBe(false);
  });
  test('signed cursor rejects tampering and cross-filter/cross-user reuse', () => {
    const cursor = { v: 1 as const, filter: 'user-1-filter', asOf: new Date().toISOString(), since: new Date(Date.now()-3600000).toISOString(), maxId: 7, id: 6, at: new Date().toISOString() };
    const token = encodeCursor(cursor, 'fixture-secret');
    expect(decodeCursor(token, cursor.filter, 'fixture-secret')).toEqual(cursor);
    expect(() => decodeCursor(token + 'x', cursor.filter, 'fixture-secret')).toThrow();
    expect(() => decodeCursor(token, 'user-2-filter', 'fixture-secret')).toThrow();
    expect(() => decodeCursor(token, cursor.filter, 'other-secret')).toThrow();
  });
  test('new to top-N does not pretend to have a previous rank or observed growth', () => {
    expect(rankChanges([{ id: 2, viewCount: 9, likeCount: 3, commentCount: 1 }, { id: 1, viewCount: 5, likeCount: 0, commentCount: 0 }],
      [{ id: 1, viewCount: 4, likeCount: 1, commentCount: 1 }])).toEqual([
      { postId: 2, rank: 1, previousRank: null, rankChange: null, enteredTop: true, delta: null },
      { postId: 1, rank: 2, previousRank: 1, rankChange: -1, enteredTop: false, delta: { views: 1, likes: -1, comments: -1 } },
    ]);
  });
  test('compact model data stays valid JSON and preserves all IDs, URLs and pagination', () => {
    const posts = Array.from({ length: 20 }, (_, i) => ({ id: i+1, title: '长标题'.repeat(40), url: `/forum/post/${i+1}`, snippet: '长正文'.repeat(100) }));
    const result = JSON.parse(serializeToolResult({ success: true, displayText: '', modelData: { posts, nextCursor: 'signed-cursor', hasMore: true } }, 3000));
    expect(result.data.posts.map((p: any) => p.id)).toEqual(posts.map(p => p.id));
    expect(result.data.nextCursor).toBe('signed-cursor'); expect(result.data.compacted).toBe(true);
    expect(result.data.posts[19].url).toBe('/forum/post/20');
  });
  test('driver errors are redacted, failures distinguish from empty results, per-run duplicate queries memoize', async () => {
    const service = { hot: jest.fn().mockRejectedValueOnce(new Error('password=private sql internal'))
      .mockResolvedValue({ version: 'forum-discovery-v2', posts: [] }) };
    const skill = new ForumHotTopicsSkill(service as any), context = { userId: 3, conversationId: 4, forumMemo: new Map() };
    const fail = await skill.execute({}, context); expect(fail.success).toBe(false);
    expect(JSON.stringify(fail)).not.toContain('private'); expect(fail.result.error.code).toBe('FORUM_SERVICE_UNAVAILABLE');
    expect((await skill.execute({}, context)).success).toBe(true);
    await skill.execute({}, context); expect(service.hot).toHaveBeenCalledTimes(2);
    await Promise.all([skill.execute({ limit: 2 }, context), skill.execute({ limit: 2 }, context)]);
    expect(service.hot).toHaveBeenCalledTimes(3);
    const cancelled = new AbortController(); cancelled.abort();
    await expect(skill.execute({}, { ...context, signal: cancelled.signal })).rejects.toThrow();
  });
});

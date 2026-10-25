import { ForumRecentPostsSkill } from './forum-recent-posts.skill';
import { ForumSearchSkill } from './forum-search.skill';
import { SkillExecutionContext } from './skill.interface';

describe('forum task-local page memo', () => {
  const context = (): SkillExecutionContext => ({ userId: 11, conversationId: 22, forumMemo: new Map(), forumPostIds: new Set() });
  test.each([false, true])('stateful next advances on repeated identical calls (search=%s)', async searching => {
    let page = 1;
    const service: any = { list: jest.fn(async () => ({ posts: [{ id: ++page }], nextCursor: 'signed-' + page })) };
    const skill = searching ? new ForumSearchSkill(service) : new ForumRecentPostsSkill(service);
    const scope = context(), args = { cursor: 'next', limit: 7, ...(searching ? { query: '校园' } : {}) };
    const first = await skill.execute(args, scope), second = await skill.execute(args, scope);
    expect(first.result.posts[0].id).toBe(2); expect(second.result.posts[0].id).toBe(3);
    expect(service.list).toHaveBeenCalledTimes(2); expect([...scope.forumPostIds!]).toEqual([2, 3]);
  });
  test('explicit page tokens coalesce within a task but not across contexts', async () => {
    const service: any = { list: jest.fn(async () => ({ posts: [{ id: 5 }] })) };
    const skill = new ForumRecentPostsSkill(service), args = { cursor: 'signed-page-token', limit: 7 }, scope = context();
    await Promise.all([skill.execute(args, scope), skill.execute(args, scope)]);
    expect(service.list).toHaveBeenCalledTimes(1);
    await skill.execute(args, context()); expect(service.list).toHaveBeenCalledTimes(2);
  });
  test('failures are not memoized and cancelled next never queries', async () => {
    const service: any = { list: jest.fn().mockRejectedValueOnce(Error('NO_NEXT_PAGE')).mockResolvedValueOnce({ posts: [] }) };
    const skill = new ForumRecentPostsSkill(service), scope = context();
    expect((await skill.execute({ limit: 7 }, scope)).success).toBe(false);
    expect((await skill.execute({ limit: 7 }, scope)).success).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(skill.execute({ cursor: 'next' }, { ...context(), signal: controller.signal })).rejects.toThrow();
    expect(service.list).toHaveBeenCalledTimes(2);
  });
});

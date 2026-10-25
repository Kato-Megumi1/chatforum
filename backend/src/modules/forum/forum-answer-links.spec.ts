import { attachForumLinks, legacyForumTitles } from './forum-answer-links';
describe('forum navigation independent of model Markdown', () => {
  const posts = [{ id: 7, title: '【测试帖】移动端记录' }, { id: 9, title: '第二篇' }];
  it('links bold titles and appends known posts omitted by model', () => {
    const result = attachForumLinks('1. **【测试帖】移动端记录** — 分类', posts);
    expect(result).toContain('[【测试帖】移动端记录](/forum/post/7)');
    expect(result).toContain('[第二篇](/forum/post/9)');
  });
  it('preserves existing links and code and only repairs matching legacy bold titles', () => {
    expect(attachForumLinks('[第二篇](/forum/post/9)', [posts[1]])).toBe('[第二篇](/forum/post/9)');
    const text = '```\n**第二篇**\n```\n1. **【测试帖】移动端记录**';
    expect(legacyForumTitles(text)).toEqual([posts[0].title]);
    expect(attachForumLinks(text, posts, false)).not.toContain('/forum/post/9');
  });
  it('escapes untrusted titles and never emits arbitrary URLs', () => {
    const text = attachForumLinks('结果', [{ id: 5, title: '[x](javascript:evil) <img>' }]);
    expect(text).toContain('\\[x\\]\\(javascript:evil\\) \\<img\\>');
    expect(text).toContain('](/forum/post/5)');
  });
});

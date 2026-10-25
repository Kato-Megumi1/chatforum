import { ForumService } from './forum.service';
import { forumHotScore, forumSearchClauses, forumSummary } from './forum-query.sql';
import { PostDto, UpdatePostDto, NotificationQueryDto } from './forum.dto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

describe('forum read model boundaries', () => {
  test('Chinese terms use ngram, short terms and SQL-looking punctuation stay literal parameters', () => {
    const chinese = forumSearchClauses('眼镜 礼物');
    expect(chinese).toHaveLength(2);
    expect(chinese[0].sql).toContain('MATCH(p.title,p.content)');
    expect(chinese[0].values).toEqual(['+"眼镜"']);
    for (const query of ['惠', '%', '_', "x'", '*', '-foo', 'OpenAI', 'AI', 'PDF']) {
      const [term] = forumSearchClauses(query);
      expect(term.sql).toContain('LOCATE');
      expect(term.sql).not.toContain(query);
      expect(term.values).toEqual([query, query]);
    }
  });
  test('hot ranking stays parameterized and summaries do not expose raw markup/full content', () => {
    const at = new Date();
    expect(forumHotScore(at).sql).toContain('POW');
    expect(forumHotScore(at).values).toEqual([at]);
    expect(forumSummary('## 标题\n**你好** [查看](https://example.test) ![图](a.png)<script>不执行</script>')).toBe('标题 你好 查看 不执行');
    expect(forumSummary('很长'.repeat(1000))).toHaveLength(240);
  });
  test('detail reading is read-only; creating a view receipt is an explicit different method', async () => {
    const db = { post: { findUnique: jest.fn().mockResolvedValue({ id: 4, status: 'APPROVED', userId: 1 }), update: jest.fn() } };
    const service = new ForumService(db as any);
    expect(await service.getPost(4)).toMatchObject({ id: 4, isLiked: false });
    expect(db.post.update).not.toHaveBeenCalled();
  });
  test('editing needs a valid revision; notification boolean query parses explicit false correctly', async () => {
    expect((await validate(plainToInstance(UpdatePostDto, { content: '草稿' }))).some(e => e.property === 'expectedRevision')).toBe(true);
    expect(await validate(plainToInstance(UpdatePostDto, { content: '草稿', contentFormat: 'plain', expectedRevision: 1 }))).toEqual([]);
    expect((await validate(plainToInstance(PostDto, { title: '  ', content: '\n\t', categoryId: 1 }))).map(e => e.property)).toEqual(expect.arrayContaining(['title', 'content']));
    expect(plainToInstance(NotificationQueryDto, { unreadOnly: 'false' }).unreadOnly).toBe(false);
    expect(plainToInstance(NotificationQueryDto, { unreadOnly: 'true' }).unreadOnly).toBe(true);
    expect(await validate(plainToInstance(NotificationQueryDto, { unreadOnly: 'nonsense' }))).not.toEqual([]);
  });
  test('notification operations enforce current ACTIVE ownership; mark-all never touches others', async () => {
    const db = { user: { findFirst: jest.fn().mockResolvedValue({ id: 2, role: 'USER' }) },
      notification: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) } };
    expect(await new ForumService(db as any).markAllNotificationsRead(2)).toEqual({ updated: 3 });
    expect(db.notification.updateMany).toHaveBeenCalledWith({ where: { userId: 2, isRead: false }, data: { isRead: true } });
    db.user.findFirst.mockResolvedValue(null);
    await expect(new ForumService(db as any).markAllNotificationsRead(2)).rejects.toThrow('账号不可用');
  });
});

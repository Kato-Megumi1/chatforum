import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService, FORUM_EVENT_CONSUMERS } from './forum-events.service';
import { ForumReportsService } from './forum-reports.service';

const suite = process.env.RUN_FORUM_REPORTS_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated MySQL forum report, decision and appeal lifecycle', () => {
  let db: PrismaService, service: ForumReportsService, categoryId: number;
  let reporter: number, author: number, admin: number, stranger: number;
  const users: number[] = [], posts: number[] = [];
  const prefix = 'reports_' + randomUUID().slice(0, 8);

  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test')
      throw Error('Refusing non-fixture DB');
    db = new PrismaService();
    await db.$connect();
    for (const name of ['reporter', 'author', 'admin', 'stranger']) {
      const user = await db.user.create({ data: {
        username: prefix + '_' + name, email: prefix + '_' + name + '@example.test',
        password: 'disabled-fixture', role: name === 'admin' ? 'ADMIN' : 'USER',
      } });
      users.push(user.id);
    }
    [reporter, author, admin, stranger] = users;
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    // Deliberately do not start event consumers or the Nest application.
    service = new ForumReportsService(db, new ForumEventsService(db));
  }, 30000);

  afterAll(async () => {
    if (!db) return;
    try {
      // Every deletion is restricted to IDs created by this suite, including outbox rows.
      if (posts.length) await db.forumEvent.deleteMany({ where: { postId: { in: posts } } });
      if (users.length) {
        await db.notification.deleteMany({ where: { userId: { in: users } } });
        await db.operationLog.deleteMany({ where: { userId: { in: users }, module: 'FORUM_REPORTS' } });
        await db.report.deleteMany({ where: { reporterId: { in: users } } });
      }
      if (categoryId) await db.category.delete({ where: { id: categoryId } });
      if (users.length) await db.user.deleteMany({ where: { id: { in: users } } });
    } finally { await db.$disconnect(); }
  }, 30000);

  const newPost = async () => {
    const post = await db.post.create({ data: {
      userId: author, categoryId, title: prefix + ' synthetic post ' + posts.length,
      content: '仅用于隔离测试的纯文本正文。', contentFormat: 'plain', status: 'APPROVED',
    } });
    posts.push(post.id); return post;
  };
  const report = async (targetId: number, type: 'POST' | 'COMMENT' = 'POST', requestId = randomUUID()) =>
    service.create(reporter, 0, { targetId, type, requestId, reason: '垃圾广告', detail: '虚构举报原因，不应泄露给作者' });
  const decide = (id: number, action = 'HIDE', expectedRevision = 1) => service.decide(admin, 0, id,
    { action, expectedRevision, confirmation: String(id), reason: '按社区规则处理虚构测试内容' }, '127.0.0.1');

  test('concurrent repeated requests create one pending case and never hide automatically', async () => {
    const post = await newPost(), requestId = randomUUID();
    const [a, b] = await Promise.all([report(post.id, 'POST', requestId), report(post.id, 'POST', requestId)]);
    expect(a.id).toBe(b.id);
    expect(await db.report.count({ where: { reporterId: reporter, clientRequestId: requestId } })).toBe(1);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('APPROVED');
    expect(await db.forumEvent.count({ where: { postId: post.id } })).toBe(0);
    await expect(service.create(reporter, 0, { targetId: post.id, type: 'POST', requestId,
      reason: '其他', detail: 'different payload' })).rejects.toThrow('请求编号');
  });

  test('hide then author appeal restores exact version with atomic outbox, audit and private projections', async () => {
    const post = await newPost(), item = await report(post.id);
    await decide(item.id);
    await decide(item.id); // Explicit retry does not emit or notify twice.
    expect(await db.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'REJECTED', revision: 2 });
    const own = (await service.mine(reporter, 0)).rows.find(row => row.id === item.id);
    expect(own).toMatchObject({ status: 'RESOLVED', decision: 'HIDE' });
    const affected = (await service.decisions(author, 0)).rows.find(row => row.id === item.id);
    expect(affected).toBeDefined();
    expect(affected).not.toHaveProperty('reporter'); expect(affected).not.toHaveProperty('reporterId');
    expect(affected).not.toHaveProperty('reason'); expect(affected).not.toHaveProperty('clientRequestId');
    expect((await service.mine(stranger, 0)).rows).toEqual([]);
    expect((await service.decisions(stranger, 0)).rows).toEqual([]);
    await expect(service.appeal(stranger, 0, item.id, { expectedRevision: 2, reason: '越权' })).rejects.toThrow('不存在');
    await service.appeal(author, 0, item.id, { expectedRevision: 2, reason: '虚构作者请求重新核对' });
    await service.appeal(author, 0, item.id, { expectedRevision: 2, reason: '虚构作者请求重新核对' });
    const appeal = await db.reportAppeal.findUniqueOrThrow({ where: { reportId: item.id } });
    await service.decideAppeal(admin, 0, appeal.id,
      { action: 'ACCEPT', expectedRevision: 1, confirmation: String(appeal.id), reason: '复核后恢复' });
    await service.decideAppeal(admin, 0, appeal.id,
      { action: 'ACCEPT', expectedRevision: 1, confirmation: String(appeal.id), reason: '复核后恢复' });
    expect(await db.post.findUniqueOrThrow({ where: { id: post.id } })).toMatchObject({ status: 'APPROVED', revision: 3 });
    expect(await db.report.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ decision: 'RESTORED', revision: 4 });
    const events = await db.forumEvent.findMany({ where: { postId: post.id }, orderBy: { id: 'asc' }, include: { deliveries: true } });
    expect(events.map(event => event.kind)).toEqual(['POST_HIDDEN', 'POST_APPROVED']);
    for (const event of events) expect(event.deliveries.map(row => row.consumer).sort()).toEqual([...FORUM_EVENT_CONSUMERS].sort());
    expect(await db.operationLog.count({ where: { userId: admin, module: 'FORUM_REPORTS', details: { contains: '"reportId":' + item.id + ',' } } })).toBe(2);
    const notifications = await db.notification.findMany({ where: { relatedReportId: item.id } });
    expect(notifications).toHaveLength(3);
    expect(JSON.stringify(notifications.filter(row => row.userId === author))).not.toContain('虚构举报原因');
  });

  test('comment report uses its parent FK and restore changes counts once through comment events', async () => {
    const post = await newPost();
    const comment = await db.comment.create({ data: { postId: post.id, userId: author, content: '虚构评论' } });
    await db.post.update({ where: { id: post.id }, data: { commentCount: 1 } });
    const item = await report(comment.id, 'COMMENT');
    expect(await db.report.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ targetId: post.id, postId: post.id, commentId: comment.id });
    await decide(item.id);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(0);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).status).toBe('DELETED');
    await service.appeal(author, 0, item.id, { expectedRevision: 2, reason: '评论复核' });
    const appeal = await db.reportAppeal.findUniqueOrThrow({ where: { reportId: item.id } });
    const input = { action: 'ACCEPT', expectedRevision: 1, confirmation: String(appeal.id), reason: '恢复评论' };
    await service.decideAppeal(admin, 0, appeal.id, input); await service.decideAppeal(admin, 0, appeal.id, input);
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).commentCount).toBe(1);
    expect((await db.comment.findUniqueOrThrow({ where: { id: comment.id } })).status).toBe('ACTIVE');
    expect((await db.forumEvent.findMany({ where: { postId: post.id }, orderBy: { id: 'asc' } })).map(event => event.kind))
      .toEqual(['COMMENT_DELETED', 'COMMENT_RESTORED']);
  });

  test('current admin role/version and source revision are rechecked before a decision', async () => {
    const post = await newPost(), item = await report(post.id);
    const input = { action: 'HIDE', expectedRevision: 1, confirmation: String(item.id), reason: '验证权限' };
    await expect(service.decide(stranger, 0, item.id, input)).rejects.toThrow('管理员');
    await expect(service.decide(admin, 1, item.id, input)).rejects.toThrow('登录状态');
    await db.user.update({ where: { id: admin }, data: { role: 'USER' } });
    try { await expect(service.decide(admin, 0, item.id, input)).rejects.toThrow('管理员'); }
    finally { await db.user.update({ where: { id: admin }, data: { role: 'ADMIN' } }); }
    await db.post.update({ where: { id: post.id }, data: { revision: { increment: 1 }, content: '作者已修改正文' } });
    await expect(decide(item.id)).rejects.toThrow('已改变');
    expect(await db.forumEvent.count({ where: { postId: post.id } })).toBe(0);
    await decide(item.id, 'DISMISS');
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).status).toBe('APPROVED');
  });

  test('hard deletion retains case and pending appeal but cannot resurrect missing content', async () => {
    const post = await newPost(), item = await report(post.id);
    await decide(item.id);
    await service.appeal(author, 0, item.id, { expectedRevision: 2, reason: '内容删除后仍保留复核记录' });
    const appeal = await db.reportAppeal.findUniqueOrThrow({ where: { reportId: item.id } });
    await db.post.delete({ where: { id: post.id } });
    expect(await db.report.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({ postId: null, targetId: post.id });
    expect((await service.mine(reporter, 0)).rows.find(row => row.id === item.id)?.post).toBeNull();
    expect((await service.decisions(author, 0)).rows.some(row => row.id === item.id)).toBe(true);
    await expect(service.decideAppeal(admin, 0, appeal.id,
      { action: 'ACCEPT', expectedRevision: 1, confirmation: String(appeal.id), reason: '不能恢复已删正文' })).rejects.toThrow('不能恢复');
    await service.decideAppeal(admin, 0, appeal.id,
      { action: 'REJECT', expectedRevision: 1, confirmation: String(appeal.id), reason: '原文已删除，结束复核' });
    expect((await db.reportAppeal.findUniqueOrThrow({ where: { id: appeal.id } })).status).toBe('REJECTED');
  });
});

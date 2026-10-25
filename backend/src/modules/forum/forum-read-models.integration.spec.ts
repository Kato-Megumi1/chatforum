import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumService } from './forum.service';
import { ForumDiscoveryService } from './forum-discovery.service';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { JwtService, JwtModule } from '@nestjs/jwt';
import { ForumController } from './forum.controller';

const suite = process.env.RUN_FORUM_DISCOVERY_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated forum read model SQL integration', () => {
  let db: PrismaService, service: ForumService, discovery: ForumDiscoveryService;
  let owner: number, other: number, categoryId: number;
  const userIds: number[] = [];
  const post = (data: any = {}) => db.post.create({ data: { title: '虚构论坛测试', content: '眼镜礼物讨论'.repeat(1000),
    userId: owner, categoryId, status: 'APPROVED', createdAt: new Date(Date.now() - 3600000), ...data } });
  beforeAll(async () => {
    if (process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test') throw Error('Refusing non-fixture DB');
    process.env.JWT_ACCESS_SECRET = 'forum-views-fixture-only-not-production';
    db = new PrismaService(); await db.$connect(); service = new ForumService(db); discovery = new ForumDiscoveryService(db);
    categoryId = (await db.category.create({ data: { name: 'read-models-' + randomUUID() } })).id;
    for (let i = 0; i < 2; i++) { const name = 'read_' + randomUUID(); userIds.push((await db.user.create({ data: {
      username: name, email: name + '@example.test', password: 'disabled-fixture' } })).id); }
    [owner, other] = userIds;
  });
  afterAll(async () => {
    await db.category.delete({ where: { id: categoryId } });
    await db.user.deleteMany({ where: { id: { in: userIds } } }); await db.$disconnect();
  });
  test('summary rows omit body; literal punctuation/one-letter terms and Agent share ngram results', async () => {
    const p = await post({ title: '眼镜 礼物 惠 x%_x OpenAI AI PDF', contentFormat: 'plain' });
    for (const search of ['眼镜 礼物', '惠', '%_', 'OpenAI', 'AI', 'PDF']) {
      const result = await service.getPosts({ categoryId, search }, owner);
      expect(result.data.some(row => row.id === p.id)).toBe(true);
      const row = result.data.find(row => row.id === p.id);
      expect(row.summary.length).toBeLessThanOrEqual(240); expect(row).not.toHaveProperty('content');
      const tool = await discovery.list({ categoryId, query: search }, { userId: owner }, true);
      expect(tool.posts.map(row => row.id)).toEqual(result.data.map(row => row.id));
    }
    expect((await service.getPosts({ categoryId, search: "%' OR 1=1 --" })).data).toEqual([]);
  });
  test('hot page and Agent use one decay formula and same 24h/7d windows', async () => {
    const recent = await post({ title: '今天', likeCount: 10 });
    const week = await post({ title: '本周', likeCount: 1000, createdAt: new Date(Date.now() - 48 * 3600000) });
    await post({ title: '旧帖', likeCount: 100000, createdAt: new Date(Date.now() - 20 * 86400000) });
    const today = await service.getPosts({ categoryId, sort: 'hot', hotPeriod: 'today' });
    expect(today.data.map(row => row.id)).toContain(recent.id); expect(today.data.map(row => row.id)).not.toContain(week.id);
    const page = await service.getPosts({ categoryId, sort: 'hot', hotPeriod: 'week', limit: 20 });
    const tool = await discovery.hot({ categoryId, hours: 168, limit: 20 }, { userId: owner });
    expect(page.data.map(row => row.id)).toEqual(tool.posts.map(row => row.id));
  });
  test('detail/create/edit do not count reads; parallel view events dedupe and stale revision conflicts', async () => {
    const p = await service.createPost(owner, { title: '新帖子', content: '普通文字 *不用Markdown*', categoryId });
    expect(p.contentFormat).toBe('plain'); expect(p.viewCount).toBe(0);
    await service.getPost(p.id, owner); await service.getPost(p.id, owner);
    const counted = await Promise.all(Array.from({ length: 4 }, () => service.recordView(p.id, owner)));
    expect(counted.filter(result => result.counted)).toHaveLength(1);
    const anonymous = await service.recordView(p.id);
    expect(anonymous.viewerToken).toBeTruthy(); expect(anonymous.counted).toBe(true);
    expect((await service.recordView(p.id, undefined, anonymous.viewerToken)).counted).toBe(false);
    const edited = await service.updatePost(p.id, owner, { content: '新内容', expectedRevision: p.revision });
    expect(edited.revision).toBe(2); expect(edited.viewCount).toBe(2);
    await expect(service.updatePost(p.id, owner, { content: '旧页面覆盖', expectedRevision: p.revision })).rejects.toMatchObject({ status: 409 });
    await expect(service.updatePost(p.id, other, { content: '他人修改', expectedRevision: 2 })).rejects.toMatchObject({ status: 403 });
  });
  test('plain comments return local-update shape and focus pagination; notifications/centers stay owner scoped', async () => {
    const p = await post({ title: '讨论页' });
    const root = await service.createComment(p.id, other, { content: '<b>普通文字</b>' });
    expect(root).toMatchObject({ canDelete: true, replyCount: 0, contentFormat: 'plain', replies: [] });
    for (let i = 0; i < 4; i++) await service.createComment(p.id, owner, { content: '回复' + i, parentId: root.id });
    const reply = await service.createComment(p.id, other, { content: '最后回复', parentId: root.id });
    for (let i = 0; i < 12; i++) await service.createComment(p.id, owner, { content: '新楼层' + i });
    const focus = await service.getComments(p.id, owner, { commentId: reply.id, limit: 10 });
    expect(focus.page).toBeGreaterThan(1); expect(focus.data.find(c => c.id === root.id).replies.some(c => c.id === reply.id)).toBe(true);
    const notes = await service.getNotifications(owner, { limit: 1 });
    expect(notes.total).toBeGreaterThan(1); expect(notes.data[0].url).toContain('?comment=');
    expect(notes.data.every(n => n.userId === owner)).toBe(true);
    await service.markAllNotificationsRead(owner); expect(await service.unreadNotificationCount(owner)).toEqual({ unreadCount: 0 });
    expect((await service.unreadNotificationCount(other)).unreadCount).toBeGreaterThan(0);
    await service.favoritePost(p.id, other);
    await db.follow.create({ data: { followerId: other, followingId: owner } });
    expect((await service.personalPosts(other, 'favorites')).data.map(c => c.id)).toContain(p.id);
    expect((await service.personalReplies(other)).data.some(c => c.id === root.id)).toBe(true);
    expect((await service.personalFollowing(other)).data[0]).not.toHaveProperty('email');
    await db.post.update({ where: { id: p.id }, data: { status: 'REJECTED' } });
    expect((await service.personalPosts(other, 'favorites')).data).toEqual([]);
    expect((await service.getNotifications(other)).data.filter(n => n.relatedId === p.id).every(n => n.url === null)).toBe(true);
    await db.user.update({ where: { id: other }, data: { status: 'BANNED' } });
    await expect(service.personalFollowing(other)).rejects.toMatchObject({ status: 403 });
  });
  test('actual HTTP contracts validate plain form input, revision and notifications routing without model workers', async () => {
    const app = (await Test.createTestingModule({ imports: [JwtModule.register({})], controllers: [ForumController],
      providers: [ForumService, { provide: PrismaService, useValue: db }] }).compile()).createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.setGlobalPrefix('api'); await app.listen(0, '127.0.0.1');
    const base = await app.getUrl(), token = new JwtService().sign({ sub: owner }, { secret: process.env.JWT_ACCESS_SECRET });
    const call = (path: string, method = 'GET', body?: unknown, authenticated = true) => fetch(base + '/api/forum/' + path, {
      method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    try {
      expect((await call('posts', 'POST', { title: ' ', content: '\n', categoryId })).status).toBe(400);
      const created = await call('posts', 'POST', { title: '  HTTP帖子  ', content: '  普通文字  ', contentFormat: 'plain', categoryId });
      expect(created.status).toBe(201);
      const { data: p } = await created.json(); expect(p).toMatchObject({ title: 'HTTP帖子', content: '普通文字', revision: 1, viewCount: 0, contentFormat: 'plain' });
      expect((await call('posts/' + p.id, 'PUT', { content: '没有版本' })).status).toBe(400);
      const firstView = await call(`posts/${p.id}/view`, 'POST', {}, false);
      const viewed = (await firstView.json()).data; expect(viewed.counted).toBe(true);
      expect(firstView.headers.get('set-cookie')).toContain('HttpOnly');
      expect((await (await call(`posts/${p.id}/view`, 'POST', { viewerToken: viewed.viewerToken }, false)).json()).data.counted).toBe(false);
      expect((await (await call('notifications/unread-count')).json()).data).toHaveProperty('unreadCount');
      expect((await (await call('notifications/read-all', 'PUT')).json()).data).toHaveProperty('updated');
      expect((await (await call('me/posts')).json()).data.data.some(row => row.id === p.id && !('content' in row))).toBe(true);
    } finally { await app.close(); }
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ForumService } from './forum.service';
import { CommentQueryDto, NotificationQueryDto } from './forum.dto';

// Bounded relational fixture: it evaluates the Prisma filters before slicing the page,
// so tests catch lost author replies under other people's roots and mismatched counts.
const comment = (id: number, userId: number, parentId: number | null = null, status = 'ACTIVE') => ({
  id, postId: 7, userId, parentId, status, content: userId === 1 ? 'author-' + id : 'other-original-' + id,
  createdAt: new Date(1700000000000 + id), likeCount: 2,
});
const comments = [comment(100, 9), comment(101, 1, 100), comment(102, 9, 100), comment(103, 1, 100, 'DELETED'),
  comment(200, 1), comment(201, 9, 200), ...[202, 203, 204, 205].map(id => comment(id, 1, 200)),
  comment(300, 9, null, 'DELETED'), comment(301, 1, 300), comment(400, 9),
  comment(500, 1, null, 'DELETED'), comment(600, 9, null, 'DELETED'), comment(601, 9, 600)];

function matches(row: any, where: any): boolean {
  return Object.entries(where || {}).every(([key, value]: [string, any]) => {
    if (value === undefined) return true;
    if (key === 'AND') return (Array.isArray(value) ? value : [value]).every(part => matches(row, part));
    if (key === 'OR') return value.some(part => matches(row, part));
    if (key === 'replies') return comments.some(reply => reply.parentId === row.id && matches(reply, value.some));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('lt' in value) return row[key] < value.lt;
      if ('gt' in value) return row[key] > value.gt;
      if ('in' in value) return value.in.includes(row[key]);
    }
    return row[key] instanceof Date && value instanceof Date ? row[key].getTime() === value.getTime() : row[key] === value;
  });
}
function ordered<T>(rows: T[], orderBy: Array<Record<string, string>> = []) {
  return [...rows].sort((a: any, b: any) => {
    for (const part of orderBy) {
      const [key, direction] = Object.entries(part)[0];
      if (a[key] < b[key]) return direction === 'asc' ? -1 : 1;
      if (a[key] > b[key]) return direction === 'asc' ? 1 : -1;
    }
    return 0;
  });
}
function commentFixture() {
  const project = (row: any, include: any = {}) => {
    const replies = ordered(comments.filter(reply => reply.parentId === row.id && matches(reply, include.replies?.where)), include.replies?.orderBy);
    return { ...row, user: { id: row.userId, username: 'fixture-' + row.userId },
      ...(include.replies ? { replies: replies.slice(0, include.replies.take ?? replies.length).map(reply => project(reply)) } : {}),
      ...(include._count ? { _count: { replies: comments.filter(reply => reply.parentId === row.id && matches(reply, include._count.select.replies.where)).length } } : {}),
    };
  };
  const db = { post: { findFirst: jest.fn().mockResolvedValue({ userId: 1 }) }, comment: {
    findFirst: jest.fn(async (args: any) => { const row = comments.find(c => matches(c, args.where)); return row ? project(row, args.include) : null; }),
    findMany: jest.fn(async (args: any) => ordered(comments.filter(c => matches(c, args.where)), args.orderBy)
      .slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? comments.length)).map(c => project(c, args.include))),
    count: jest.fn(async (args: any) => comments.filter(c => matches(c, args.where)).length),
  }, commentLike: { findMany: jest.fn().mockResolvedValue([{ commentId: 100 }, { commentId: 101 }]) },
  user: { findUnique: jest.fn().mockResolvedValue({ role: 'USER' }) } };
  return { db, service: new ForumService(db as any) };
}

describe('mobile forum filters apply before pagination', () => {
  test('only-author keeps contextual roots carrying author replies, without disclosing others’ text/actions', async () => {
    const { service, db } = commentFixture();
    const result = await service.getComments(7, 1, { onlyAuthor: true, limit: 10 });
    expect(result).toMatchObject({ onlyAuthor: true, total: 3, activeCount: 7, totalActiveCount: 12 });
    expect(result.data.map(row => row.id)).toEqual([300, 200, 100]);
    const container = result.data.find(row => row.id === 100);
    expect(container).toMatchObject({ contextOnly: true, content: '该楼层用于展示作者回复',
      replyCount: 1, isLiked: false, likeCount: 0, canDelete: false });
    expect(container.replies.map(row => row.id)).toEqual([101]);
    expect(JSON.stringify(result.data)).not.toContain('other-original');
    expect(result.data.find(row => row.id === 300)).toMatchObject({ contextOnly: true, replyCount: 1 });
    expect(db.comment.findMany.mock.calls[0][0].include.replies.where).toEqual({ status: 'ACTIVE', userId: 1 });
    expect(db.comment.findMany.mock.calls[0][0].include._count.select.replies.where).toEqual({ status: 'ACTIVE', userId: 1 });
  });

  test('root totals/pages and explicit author reply focus share the same filter', async () => {
    const { service } = commentFixture();
    const result = await service.getComments(7, undefined, { onlyAuthor: true, limit: 1, commentId: 205 });
    expect(result).toMatchObject({ page: 2, limit: 1, total: 3, totalPages: 3, focusId: 205 });
    expect(result.data[0].id).toBe(200);
    expect(result.data[0].replyCount).toBe(4);
    expect(result.data[0].replies.map(row => row.id)).toEqual([202, 203, 204, 205]);
  });

  test('expanded reply pages contain only author replies and can locate a focused reply beyond page one', async () => {
    const { service } = commentFixture();
    const first = await service.getComments(7, undefined, { onlyAuthor: true, parentId: 200, limit: 2, sortOrder: 'asc' });
    expect(first.data.map(row => row.id)).toEqual([202, 203]);
    expect(first).toMatchObject({ total: 4, totalPages: 2, activeCount: 7, totalActiveCount: 12 });
    const focused = await service.getComments(7, undefined, { onlyAuthor: true, parentId: 200, commentId: 205, limit: 2, sortOrder: 'asc' });
    expect(focused.page).toBe(2);
    expect(focused.data.map(row => row.id)).toEqual([204, 205]);
  });

  test('filtered-out/deleted focus, mismatched parent and invisible threads never reintroduce other content', async () => {
    const { service } = commentFixture();
    for (const params of [{ commentId: 102 }, { commentId: 103 }, { parentId: 100, commentId: 205 }, { parentId: 400 }]) {
      await expect(service.getComments(7, undefined, { onlyAuthor: true, ...params })).rejects.toMatchObject({ status: 404 });
    }
  });

  test('omitted/false author filter keeps ordinary comments and preserves the overall discussion count', async () => {
    const { service, db } = commentFixture();
    const result = await service.getComments(7, undefined, { onlyAuthor: false });
    expect(result).toMatchObject({ onlyAuthor: false, total: 5, activeCount: 12, totalActiveCount: 12 });
    expect(result.data.find(row => row.id === 100)).toMatchObject({ contextOnly: false, content: 'other-original-100', replyCount: 2 });
    expect(result.data.find(row => row.id === 600)).toMatchObject({ content: '这条评论已删除' });
    expect(db.comment.count).toHaveBeenCalledTimes(2); // No extra all-comments COUNT when already unfiltered.
  });

  test('post visibility is rechecked before querying comments', async () => {
    const { service, db } = commentFixture(); db.post.findFirst.mockResolvedValue(null);
    await expect(service.getComments(7, undefined, { onlyAuthor: true })).rejects.toMatchObject({ status: 404 });
    expect(db.comment.findMany).not.toHaveBeenCalled();
  });

  test('notification type and unread filters scope both rows and totals, not the global unread badge', async () => {
    const notes = [
      { id: 8, userId: 1, type: 'LIKE', isRead: false, relatedId: 7, createdAt: new Date(8) },
      { id: 7, userId: 1, type: 'COMMENT', isRead: false, relatedId: 7, createdAt: new Date(7) },
      { id: 6, userId: 1, type: 'LIKE', isRead: false, relatedId: 7, createdAt: new Date(6) },
      { id: 5, userId: 1, type: 'FOLLOW', isRead: false, relatedId: 9, createdAt: new Date(5) },
      { id: 4, userId: 1, type: 'LIKE', isRead: true, relatedId: 7, createdAt: new Date(4) },
      { id: 3, userId: 2, type: 'LIKE', isRead: false, relatedId: 7, createdAt: new Date(3) },
    ];
    const db = { user: { findFirst: jest.fn().mockResolvedValue({ id: 1, status: 'ACTIVE' }), findMany: jest.fn().mockResolvedValue([]) },
      post: { findMany: jest.fn().mockResolvedValue([{ id: 7 }]) }, notification: {
        findMany: jest.fn(async (args: any) => ordered(notes.filter(n => matches(n, args.where)), args.orderBy).slice(args.skip, args.skip + args.take)),
        count: jest.fn(async (args: any) => notes.filter(n => matches(n, args.where)).length),
      } };
    const result = await new ForumService(db as any).getNotifications(1, { type: 'LIKE', unreadOnly: true, page: 2, limit: 1 });
    expect(result).toMatchObject({ total: 2, page: 2, totalPages: 2, unreadCount: 4 });
    expect(result.data.map(n => n.id)).toEqual([6]);
    expect(db.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 1, type: 'LIKE', isRead: false }, skip: 1, take: 1 }));
    expect(db.notification.count.mock.calls.map(args => args[0].where)).toEqual([
      { userId: 1, type: 'LIKE', isRead: false }, { userId: 1, isRead: false },
    ]);
  });

  test('notification categories still require a currently active account', async () => {
    const db = { user: { findFirst: jest.fn().mockResolvedValue(null) }, notification: { findMany: jest.fn() } };
    await expect(new ForumService(db as any).getNotifications(1, { type: 'COMMENT' })).rejects.toMatchObject({ status: 403 });
    expect(db.notification.findMany).not.toHaveBeenCalled();
  });

  test('query DTOs accept explicit booleans and actual notification enums only', async () => {
    for (const [wire, expected] of [['true', true], ['false', false], [true, true], [false, false]] as const) {
      const dto = plainToInstance(CommentQueryDto, { onlyAuthor: wire });
      expect(dto.onlyAuthor).toBe(expected); expect(await validate(dto)).toEqual([]);
    }
    for (const invalid of ['1', 'yes', ['true'], {}]) {
      expect(await validate(plainToInstance(CommentQueryDto, { onlyAuthor: invalid }))).not.toEqual([]);
    }
    for (const field of ['parentId', 'commentId']) {
      expect(await validate(plainToInstance(CommentQueryDto, { [field]: '2147483647' }))).toEqual([]);
      for (const invalid of ['2147483648', '9007199254740993', '0', '-1', '1.5', 'not-an-id']) {
        expect(await validate(plainToInstance(CommentQueryDto, { [field]: invalid }))).not.toEqual([]);
      }
    }
    for (const type of ['COMMENT', 'LIKE', 'FOLLOW', 'SYSTEM']) {
      expect(await validate(plainToInstance(NotificationQueryDto, { type }))).toEqual([]);
    }
    for (const type of ['REPLY', 'comment', 'DIRECT_MESSAGE', '', ['LIKE'], {}]) {
      expect(await validate(plainToInstance(NotificationQueryDto, { type }))).not.toEqual([]);
    }
  });
});

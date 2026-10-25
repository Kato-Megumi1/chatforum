import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { UserService } from './user.service';
import { SocialListQueryDto, UpdateProfileDto } from './user.dto';

describe('forum follow and public social graph contracts', () => {
  const people = [{ id: 1, status: 'ACTIVE', username: 'fixture-a' }, { id: 2, status: 'ACTIVE', username: 'fixture-b' }];
  const fixture = () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(people), follow: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }), deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(3),
    }, notification: { create: jest.fn().mockResolvedValue({ id: 1 }) } };
    const db = { $transaction: jest.fn(fn => fn(tx)), ...tx };
    return { service: new UserService(db as any), tx, db };
  };
  test('follow locks both identities in deterministic order and returns server truth; repeated requests do not notify twice', async () => {
    const { service, tx } = fixture();
    expect(await service.followUser(1, 2)).toEqual({ isFollowing: true, followers: 3 });
    const sql = tx.$queryRaw.mock.calls[0][0];
    expect(sql.sql).toContain('ORDER BY id FOR UPDATE'); expect(sql.values).toEqual([1, 2]);
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create.mock.calls[0][0].data).toMatchObject({ userId: 2, type: 'FOLLOW', relatedId: 1 });
    tx.follow.createMany.mockResolvedValue({ count: 0 });
    expect((await service.followUser(1, 2)).isFollowing).toBe(true);
    expect(tx.notification.create).toHaveBeenCalledTimes(1);
  });
  test('database errors are not mistaken for an already-followed success', async () => {
    const { service, tx } = fixture();
    tx.follow.createMany.mockRejectedValue(new Error('fixture DB failure'));
    await expect(service.followUser(1, 2)).rejects.toThrow('fixture DB failure');
    expect(tx.notification.create).not.toHaveBeenCalled();
  });
  test('self-follow, invalid ids and a currently disabled actor or target fail closed', async () => {
    const { service, tx } = fixture();
    await expect(service.followUser(1, 1)).rejects.toMatchObject({ status: 400 });
    await expect(service.followUser(-1, 2)).rejects.toMatchObject({ status: 400 });
    tx.$queryRaw.mockResolvedValue([{ ...people[0], status: 'BANNED' }, people[1]]);
    await expect(service.followUser(1, 2)).rejects.toMatchObject({ status: 403 });
    tx.$queryRaw.mockResolvedValue([people[0], { ...people[1], status: 'BANNED' }]);
    await expect(service.followUser(1, 2)).rejects.toMatchObject({ status: 404 });
    expect(tx.follow.createMany).not.toHaveBeenCalled();
  });
  test('cancel can remove an old edge to a disabled target and is idempotent', async () => {
    const { service, tx } = fixture();
    tx.$queryRaw.mockResolvedValue([people[0], { ...people[1], status: 'BANNED' }]);
    expect(await service.unfollowUser(1, 2)).toEqual({ isFollowing: false, followers: 3 });
    tx.follow.deleteMany.mockResolvedValue({ count: 0 });
    expect((await service.unfollowUser(1, 2)).isFollowing).toBe(false);
    expect(tx.notification.create).not.toHaveBeenCalled();
  });
  test('profile counts use actual endpoints rather than reversed legacy Prisma relation names', async () => {
    const db = { user: { findFirst: jest.fn().mockResolvedValue({ id: 2, username: 'fixture-b' }) },
      post: { count: jest.fn().mockResolvedValue(4) }, follow: { count: jest.fn().mockResolvedValueOnce(7).mockResolvedValueOnce(3), findUnique: jest.fn().mockResolvedValue({ id: 5 }) } };
    const result = await new UserService(db as any).getUserProfile(2, 1);
    expect(result).toMatchObject({ _count: { posts: 4, followers: 7, following: 3 }, isFollowing: true });
    expect(db.post.count.mock.calls[0][0].where).toEqual({ userId: 2, status: 'APPROVED' });
    expect(db.follow.count.mock.calls.map(args => args[0].where)).toEqual([
      { followingId: 2, follower: { status: 'ACTIVE' } }, { followerId: 2, following: { status: 'ACTIVE' } },
    ]);
    expect(db.user.findFirst.mock.calls[1][0].select).not.toHaveProperty('email');
  });
  test('public lists are bounded seek pages containing public fields, correct direction and viewer follow state', async () => {
    const publicUser = (id: number) => ({ id, username: 'fixture-' + id });
    const db = { user: { findFirst: jest.fn().mockResolvedValue({ id: 2 }) }, follow: { findMany: jest.fn()
      .mockResolvedValueOnce([10, 9, 8].map(id => ({ id, createdAt: new Date(), follower: publicUser(id), following: publicUser(2) })))
      .mockResolvedValueOnce([{ followingId: 10 }]) } };
    const result = await new UserService(db as any).getUserFollowers(2, { limit: 2, cursor: 20 }, 1);
    expect(result.hasMore).toBe(true); expect(result.nextCursor).toBe(9);
    expect(result.data).toEqual([expect.objectContaining({ id: 10, isFollowing: true }), expect.objectContaining({ id: 9, isFollowing: false })]);
    expect(db.follow.findMany.mock.calls[0][0]).toMatchObject({ where: { followingId: 2, follower: { status: 'ACTIVE' }, id: { lt: 20 } }, take: 3, orderBy: { id: 'desc' } });
    expect(db.follow.findMany.mock.calls[0][0].select.follower.select).not.toHaveProperty('email');
  });
  test('unavailable profiles and private operations recheck ACTIVE rather than trusting old JWT identity', async () => {
    const db = { user: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new UserService(db as any);
    await expect(service.getUserProfile(2)).rejects.toMatchObject({ status: 404 });
    await expect(service.getUserFollowing(2)).rejects.toMatchObject({ status: 404 });
    await expect(service.findOne(1)).rejects.toMatchObject({ status: 403 });
    await expect(service.updateProfile(1, { bio: 'fixture' })).rejects.toMatchObject({ status: 403 });
  });
  test('query/profile DTOs enforce bounded input and reject role or email mutation', async () => {
    for (const data of [{ limit: 51 }, { cursor: -1 }, { cursor: 1.5 }]) expect((await validate(plainToInstance(SocialListQueryDto, data))).length).toBeGreaterThan(0);
    for (const data of [{ username: ' ' }, { avatar: 'https://example.test/x' }, { role: 'ADMIN' }, { email: 'different@example.test' }]) {
      expect((await validate(plainToInstance(UpdateProfileDto, data), { whitelist: true, forbidNonWhitelisted: true })).length).toBeGreaterThan(0);
    }
    expect(await validate(plainToInstance(UpdateProfileDto, { username: ' fixture ', bio: 'hello' }))).toHaveLength(0);
  });

  test('profile name conflicts return an actionable 409 without disguising other database failures', async () => {
    const db = { user: { findFirst: jest.fn().mockResolvedValue({ id: 1 }), update: jest.fn() } };
    const service = new UserService(db as any);
    db.user.update.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002', clientVersion: 'fixture', meta: { target: 'users_username_key' },
    }));
    await expect(service.updateProfile(1, { username: ' 已有人使用 ' })).rejects.toMatchObject({
      status: 409, message: '这个用户名已被使用，请换一个',
    });
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 1 }, data: { username: '已有人使用' } }));
    const outage = new Error('fixture database unavailable');
    db.user.update.mockRejectedValueOnce(outage);
    await expect(service.updateProfile(1, { bio: '保留输入' })).rejects.toBe(outage);
    db.user.update.mockResolvedValueOnce({ id: 1, username: '新的名字' });
    await expect(service.updateProfile(1, { username: '新的名字' })).resolves.toMatchObject({ id: 1, username: '新的名字' });
  });
});

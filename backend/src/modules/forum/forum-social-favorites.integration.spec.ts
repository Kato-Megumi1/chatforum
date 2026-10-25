import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ForumService } from './forum.service';
import { ForumController } from './forum.controller';
import { ForumSubscriptionsService } from './forum-subscriptions.service';

const suite = process.env.RUN_FORUM_SOCIAL_FAVORITES_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated forum bookmarks, personalized follow state and seek indexes', () => {
  let db: PrismaService,
    forum: ForumService,
    app: any,
    base: string,
    jwt: JwtService,
    categoryId: number;
  const ids: number[] = [],
    posts: number[] = [],
    prefix = 'bookmark_' + randomUUID().slice(0, 8),
    oldSecret = process.env.JWT_ACCESS_SECRET;
  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !== 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test'
    )
      throw Error('Refusing non-fixture DB');
    process.env.JWT_ACCESS_SECRET = 'isolated-bookmarks-integration-secret-32';
    db = new PrismaService();
    await db.$connect();
    forum = new ForumService(db);
    for (let n = 0; n < 24; n++)
      ids.push(
        (
          await db.user.create({
            data: {
              username: prefix + n,
              email: prefix + n + '@example.test',
              password: 'disabled-fixture',
            },
          })
        ).id,
      );
    categoryId = (await db.category.create({ data: { name: prefix } })).id;
    for (let n = 0; n < 3; n++)
      posts.push(
        (
          await db.post.create({
            data: {
              userId: ids[n === 2 ? 2 : 1],
              categoryId,
              title: prefix + n,
              content: 'plain synthetic content',
              contentFormat: 'plain',
              status: n === 1 ? 'PENDING' : 'APPROVED',
            },
          })
        ).id,
      );
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      controllers: [ForumController],
      providers: [
        { provide: ForumService, useValue: forum },
        { provide: ForumSubscriptionsService, useValue: {} },
        { provide: PrismaService, useValue: db },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    jwt = module.get(JwtService);
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    if (db) {
      if (categoryId) await db.category.delete({ where: { id: categoryId } });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    }
    if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = oldSecret;
  }, 30000);
  const http = async (path: string, method = 'GET', actor = ids[0], version = 0) =>
    fetch(base + '/api/forum/' + path, {
      method,
      headers: {
        Authorization:
          'Bearer ' +
          (await jwt.signAsync(
            { sub: actor, authVersion: version, role: 'ADMIN' },
            { secret: process.env.JWT_ACCESS_SECRET },
          )),
      },
    });

  test('concurrent repeated bookmarks and removals are idempotent and never change public counts', async () => {
    const before = await db.post.findUnique({ where: { id: posts[0] } });
    expect(
      (
        await Promise.all(Array.from({ length: 6 }, () => forum.favoritePost(posts[0], ids[0])))
      ).every((r) => r.isFavorited),
    ).toBe(true);
    expect(await db.favorite.count({ where: { userId: ids[0], postId: posts[0] } })).toBe(1);
    expect((await forum.getPost(posts[0], ids[0])).isFavorited).toBe(true);
    expect((await forum.getPost(posts[0], ids[2])).isFavorited).toBe(false);
    const after = await db.post.findUnique({ where: { id: posts[0] } });
    expect([after.viewCount, after.likeCount, after.commentCount, after.revision]).toEqual([
      before.viewCount,
      before.likeCount,
      before.commentCount,
      before.revision,
    ]);
    await Promise.all(Array.from({ length: 4 }, () => forum.unfavoritePost(posts[0], ids[0])));
    expect(await db.favorite.count({ where: { userId: ids[0], postId: posts[0] } })).toBe(0);
  });
  test('hidden posts cannot be newly bookmarked or leak through private collection; cancellation remains possible', async () => {
    expect((await http(`posts/${posts[1]}/favorite`, 'POST')).status).toBe(404);
    await forum.favoritePost(posts[0], ids[0]);
    await db.post.update({ where: { id: posts[0] }, data: { status: 'REJECTED' } });
    expect((await http(`posts/${posts[0]}/favorite`, 'POST')).status).toBe(404);
    const personal = await (await http('me/favorites')).json();
    expect(personal.data.data.some((p: any) => p.id === posts[0])).toBe(false);
    expect((await http(`posts/${posts[0]}/favorite`, 'DELETE')).status).toBe(200);
    expect(await db.favorite.count({ where: { userId: ids[0], postId: posts[0] } })).toBe(0);
    await db.post.update({ where: { id: posts[0] }, data: { status: 'APPROVED' } });
  });
  test('list/detail follow badges share active endpoint direction and use one bulk follow query', async () => {
    await db.follow.create({ data: { followerId: ids[0], followingId: ids[1] } });
    await db.follow.create({ data: { followerId: ids[2], followingId: ids[0] } }); // reverse does not mark author2 followed
    const spy = jest.spyOn(db.follow, 'findMany');
    try {
      const feed = await forum.getFeed({ categoryId, limit: 20 }, ids[0]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(feed.data.find((p) => p.id === posts[0]).user.isFollowing).toBe(true);
      expect(feed.data.find((p) => p.id === posts[2]).user.isFollowing).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect((await forum.getPost(posts[0], ids[0])).user.isFollowing).toBe(true);
    await db.user.update({ where: { id: ids[1] }, data: { status: 'INACTIVE' } });
    expect((await forum.getPost(posts[0], ids[0])).user.isFollowing).toBe(false);
    expect(
      (await forum.getFeed({ categoryId, limit: 20 }, ids[0])).data.find((p) => p.id === posts[0])
        .user.isFollowing,
    ).toBe(false);
    await db.user.update({ where: { id: ids[1] }, data: { status: 'ACTIVE' } });
  });
  test('disabled/changed-password credentials cannot mutate or read private bookmarks', async () => {
    expect((await http(`posts/${posts[0]}abc/favorite`, 'POST')).status).toBe(400);
    expect((await http(`posts/${posts[0]}abc/favorite`, 'DELETE')).status).toBe(400);
    await db.user.update({ where: { id: ids[0] }, data: { status: 'BANNED' } });
    for (const [path, method] of [
      [`posts/${posts[0]}/favorite`, 'POST'],
      [`posts/${posts[0]}/favorite`, 'DELETE'],
      ['me/favorites', 'GET'],
    ])
      expect((await http(path, method)).status).toBe(401);
    await expect(forum.favoritePost(posts[0], ids[0])).rejects.toMatchObject({ status: 403 });
    await expect(forum.unfavoritePost(posts[0], ids[0])).rejects.toMatchObject({ status: 403 });
    await db.user.update({ where: { id: ids[0] }, data: { status: 'ACTIVE', authVersion: 1 } });
    expect((await http(`posts/${posts[0]}/favorite`, 'POST')).status).toBe(401);
    expect((await http('me/favorites')).status).toBe(401);
    await db.user.update({ where: { id: ids[0] }, data: { authVersion: 0 } });
  });
  test('disable lock winning before favorite prevents a stale permission write', async () => {
    let release!: () => void, ready!: () => void;
    const canCommit = new Promise<void>((resolve) => (release = resolve)),
      locked = new Promise<void>((resolve) => (ready = resolve));
    const disabling = db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: ids[0] }, data: { status: 'BANNED' } });
      ready();
      await canCommit;
    });
    await locked;
    const favorite = forum.favoritePost(posts[2], ids[0]).then(
      () => 200,
      (error) => error.status,
    );
    release();
    await disabling;
    expect(await favorite).toBe(403);
    expect(await db.favorite.count({ where: { userId: ids[0], postId: posts[2] } })).toBe(0);
    await db.user.update({ where: { id: ids[0] }, data: { status: 'ACTIVE' } });
  });
  test('incoming/outgoing seek indexes exist and EXPLAIN uses bounded pair-direction access', async () => {
    await db.follow.createMany({
      data: [
        ...ids.slice(3).flatMap((id) => [
          { followerId: id, followingId: ids[0] },
          { followerId: ids[0], followingId: id },
        ]),
        ...ids.slice(3).flatMap(followerId => ids.slice(3).filter(id => id!==followerId)
          .map(followingId => ({followerId,followingId}))),
      ],
      skipDuplicates: true,
    });
    const indexes = await db.$queryRaw<
      Array<{ Key_name: string; Column_name: string; Seq_in_index: bigint }>
    >`SHOW INDEX FROM follows`;
    expect(
      indexes.some((i) => i.Key_name === 'follows_followerId_id_idx' && i.Column_name === 'id'),
    ).toBe(true);
    expect(
      indexes.some((i) => i.Key_name === 'follows_followingId_id_idx' && i.Column_name === 'id'),
    ).toBe(true);
    // A newly built tiny fixture table may have obsolete optimizer cardinality.
    await db.$queryRaw`ANALYZE TABLE follows`;
    const incoming = await db.$queryRaw<
      Array<{ table: string; possible_keys: string; key: string; type: string; Extra: string }>
    >`EXPLAIN FORMAT=TRADITIONAL SELECT f.id FROM follows f WHERE f.followingId=${ids[0]} AND f.id<2147483647 AND EXISTS(SELECT 1 FROM users u WHERE u.id=f.followerId AND u.status='ACTIVE') ORDER BY f.id DESC LIMIT 5`;
    const outgoing = await db.$queryRaw<
      Array<{ table: string; possible_keys: string; key: string; type: string; Extra: string }>
    >`EXPLAIN FORMAT=TRADITIONAL SELECT f.id FROM follows f WHERE f.followerId=${ids[0]} AND f.id<2147483647 AND EXISTS(SELECT 1 FROM users u WHERE u.id=f.followingId AND u.status='ACTIVE') ORDER BY f.id DESC LIMIT 5`;
    const forcedIncoming = await db.$queryRaw<Array<Record<string,any>>>`EXPLAIN FORMAT=TRADITIONAL SELECT f.id FROM follows f FORCE INDEX (follows_followingId_id_idx) WHERE f.followingId=${ids[0]} AND f.id<2147483647 AND EXISTS(SELECT 1 FROM users u WHERE u.id=f.followerId AND u.status='ACTIVE') ORDER BY f.id DESC LIMIT 5`;
    const forcedOutgoing = await db.$queryRaw<Array<Record<string,any>>>`EXPLAIN FORMAT=TRADITIONAL SELECT f.id FROM follows f FORCE INDEX (follows_followerId_id_idx) WHERE f.followerId=${ids[0]} AND f.id<2147483647 AND EXISTS(SELECT 1 FROM users u WHERE u.id=f.followingId AND u.status='ACTIVE') ORDER BY f.id DESC LIMIT 5`;
    for (const [plan, key, forced] of [
      [incoming, 'follows_followingId_id_idx',forcedIncoming],
      [outgoing, 'follows_followerId_id_idx',forcedOutgoing],
    ] as const) {
      // Prisma/MySQL prepared EXPLAIN can label its columns f0..f11 rather than
      // returning the native metadata names. Their traditional positions are fixed.
      const normalized=plan.map((row:any)=>({table:row.table??row.f2,possible_keys:row.possible_keys??row.f5,
        key:row.key??row.f6,type:row.type??row.f4,Extra:row.Extra??row.f11}));
      const f = normalized.find((row) => row.table === 'f');
      expect(f).toBeDefined();
      expect(f.possible_keys).toContain(key);
      // FORCE is verification of index capability, not a promise that the cost
      // optimizer chooses it for every small or differently distributed table.
      const chosen=forced.map((row:any)=>({table:row.table??row.f2,key:row.key??row.f6,type:row.type??row.f4,Extra:row.Extra??row.f11})).find(row=>row.table==='f');
      expect(chosen.key).toBe(key);
      expect(['range', 'ref']).toContain(chosen.type);
      expect(chosen.Extra ?? '').not.toMatch(/filesort/i);
    }
  });
});

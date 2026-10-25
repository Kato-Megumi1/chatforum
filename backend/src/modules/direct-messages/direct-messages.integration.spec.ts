import { randomUUID } from 'crypto';
import { Test } from '@nestjs/testing';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { ValidationPipe } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { DirectActor, DirectMessagesService } from './direct-messages.service';
import { DirectMessagesController } from './direct-messages.controller';

const suite = process.env.RUN_DIRECT_MESSAGES_INTEGRATION === '1' ? describe : describe.skip;
suite('isolated private messages, requests, ownership and durable read cursors', () => {
  let db: PrismaService,
    redis: RedisService,
    dm: DirectMessagesService,
    app: any,
    base: string,
    jwt: JwtService;
  const actors: DirectActor[] = [],
    prefix = 'dm_' + randomUUID().slice(0, 8),
    oldAccess = process.env.JWT_ACCESS_SECRET,
    oldRefresh = process.env.JWT_REFRESH_SECRET;
  beforeAll(async () => {
    if (
      process.env.DATABASE_URL !==
        'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test' ||
      process.env.REDIS_HOST !== '127.0.0.1' ||
      process.env.REDIS_PORT !== '36386' ||
      process.env.REDIS_PASSWORD
    )
      throw Error('Refusing non-fixture DB/Redis');
    process.env.JWT_ACCESS_SECRET = 'isolated-direct-messages-access-32-secret';
    process.env.JWT_REFRESH_SECRET = 'isolated-direct-messages-refresh-32-secret';
    db = new PrismaService();
    await db.$connect();
    redis = new RedisService();
    redis.onModuleInit();
    dm = new DirectMessagesService(db, redis);
    for (let i = 0; i < 12; i++) {
      const u = await db.user.create({
        data: {
          username: prefix + '_' + i,
          email: prefix + '_' + i + '@example.test',
          password: 'disabled-fixture',
          role: i === 7 ? 'ADMIN' : 'USER',
        },
      });
      actors.push({ id: u.id, authVersion: 0 });
    }
    const module = await Test.createTestingModule({
      imports: [JwtModule.register({})],
      controllers: [DirectMessagesController],
      providers: [
        { provide: PrismaService, useValue: db },
        { provide: DirectMessagesService, useValue: dm },
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
    if (redis) {
      for (const a of actors)
        await redis
          .getClient()
          .del(`chatforum:dm:send:v1:${a.id}`, `chatforum:dm:intro:v1:${a.id}`);
      await redis.getClient().quit();
    }
    if (db) {
      await db.user.deleteMany({ where: { id: { in: actors.map((a) => a.id) } } });
      await db.$disconnect();
    }
    if (oldAccess === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = oldAccess;
    if (oldRefresh === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = oldRefresh;
  }, 30000);
  const send = (a: DirectActor, id: number, content: string, clientMessageId = randomUUID()) =>
    dm.send(a, id, { content, clientMessageId });
  const http = async (a: DirectActor, path: string, options: RequestInit = {}) =>
    fetch(base + '/api/direct-messages/' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization:
          'Bearer ' +
          (await jwt.signAsync(
            { sub: a.id, authVersion: a.authVersion },
            { secret: process.env.JWT_ACCESS_SECRET },
          )),
        ...options.headers,
      },
    });

  test('pair creation is unique from either side; recipient-follow direction alone grants permission', async () => {
    const [a, b, c, d] = actors;
    await db.follow.create({ data: { followerId: b.id, followingId: a.id } });
    await dm.create(a, b.id);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => dm.create(i % 2 ? a : b, i % 2 ? b.id : a.id)),
    );
    expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
    // Either opener may win; send-time revalidation uses exact recipient→initiator direction.
    const thread = await dm.create(a, b.id);
    await dm.request(b, thread.conversation.id, 'accept');
    expect((await send(a, thread.conversation.id, 'plain fixture')).conversation.state).toBe(
      'ACCEPTED',
    );
    await db.follow.create({ data: { followerId: c.id, followingId: d.id } });
    const reverse = await dm.create(c, d.id);
    expect(reverse.conversation.state).toBe('PENDING');
    const accepted = await dm.create(d, c.id);
    expect(accepted.conversation.id).toBe(reverse.conversation.id); // no recreation changes initiator/permission
  });
  test('competing first opens use the same durable pair without duplicate-key errors', async () => {
    const [a, b] = actors.slice(8, 10),
      results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => dm.create(i % 2 ? a : b, i % 2 ? b.id : a.id)),
      );
    expect(new Set(results.map((r) => r.conversation.id)).size).toBe(1);
    expect(
      await db.directMessageThread.count({
        where: { userLowId: Math.min(a.id, b.id), userHighId: Math.max(a.id, b.id) },
      }),
    ).toBe(1);
  });
  test('different concurrent introduction ids still allow only one pending message', async () => {
    const [a, b] = actors.slice(10),
      id = (await dm.create(a, b.id)).conversation.id;
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => send(a, id, 'concurrent introduction ' + i)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 'rejected').every((r: any) => r.reason.status === 403),
    ).toBe(true);
    expect(await db.directMessage.count({ where: { threadId: id } })).toBe(1);
  });
  test('strangers get exactly one intro until recipient accepts; sender cannot accept their own request', async () => {
    const [, , a, b] = actors,
      thread = (await dm.create(a, b.id)).conversation,
      id = thread.id;
    const intro = await send(a, id, 'only one introduction');
    expect(intro.conversation.canSend).toBe(false);
    await expect(send(a, id, 'second intro')).rejects.toMatchObject({ status: 403 });
    await expect(send(b, id, 'reply without accept')).rejects.toMatchObject({ status: 403 });
    await expect(dm.request(a, id, 'accept')).rejects.toMatchObject({ status: 403 });
    const inbox = await dm.list(b, { box: 'requests' });
    expect(inbox.data.some((t) => t.id === id)).toBe(true);
    expect((await dm.unread(b)).requests).toBe(1);
    await dm.request(b, id, 'accept');
    expect((await send(b, id, 'accepted reply')).conversation.state).toBe('ACCEPTED');
  });
  test('idempotency handles concurrent duplicates and rejects conflicting replay; plain content unchanged', async () => {
    const [a, b] = actors,
      id = (await dm.create(a, b.id)).conversation.id,
      key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => send(a, id, '<b>literal</b> **not markdown**', key)),
    );
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results[0].message.content).toBe('<b>literal</b> **not markdown**');
    await expect(send(a, id, 'different', key)).rejects.toMatchObject({ status: 409 });
    const [, , , , other] = actors,
      another = (await dm.create(a, other.id)).conversation.id;
    await expect(send(a, another, 'same UUID different conversation', key)).rejects.toMatchObject({
      status: 409,
    });
    expect(await db.directMessage.count({ where: { senderId: a.id, clientMessageId: key } })).toBe(
      1,
    );
  });
  test('mark read only consumes delivered id, preserves new arrival and cannot advance another thread', async () => {
    const [a, b] = actors,
      id = (await dm.create(a, b.id)).conversation.id;
    const first = await send(a, id, 'first received'),
      second = await send(a, id, 'arrival after render');
    const read = await dm.read(b, id, first.message.id);
    expect(read.unreadCount).toBe(1);
    expect((await dm.unread(b)).inbox).toBeGreaterThanOrEqual(1);
    const stale = await dm.read(b, id, first.message.id);
    expect(stale.lastReadMessageId).toBe(first.message.id);
    await dm.read(b, id, second.message.id);
    expect((await dm.get(b, id)).conversation.unreadCount).toBe(0);
    const [, , c, d] = actors,
      other = (await dm.create(c, d.id)).conversation.id,
      m = await send(c, other, 'another thread');
    await expect(dm.read(b, id, m.message.id)).rejects.toMatchObject({ status: 400 });
    await expect(dm.read(b, id, '9223372036854775807')).rejects.toMatchObject({ status: 400 });
  });
  test('simultaneous read/send uses supplied rendered cursor and leaves the new arrival unread', async () => {
    const [a, b] = actors,
      id = (await dm.create(a, b.id)).conversation.id,
      rendered = await send(a, id, 'rendered before race');
    await Promise.all([
      dm.read(b, id, rendered.message.id),
      send(a, id, 'new arrival during markread'),
    ]);
    const final = (await dm.get(b, id)).conversation;
    expect(final.unreadCount).toBe(1);
    expect((await dm.messages(b, id, { limit: 1 })).lastReadMessageId).toBe(rendered.message.id);
  });
  test('history is bounded cursor pagination and forward polling; signed cursors reject cross-user/thread/tamper', async () => {
    const [a, b] = actors,
      id = (await dm.create(a, b.id)).conversation.id;
    for (let i = 0; i < 4; i++) await send(b, id, 'page ' + i);
    const one = await dm.messages(a, id, { limit: 2 });
    expect(one.data).toHaveLength(2);
    expect(one.hasMore).toBe(true);
    const two = await dm.messages(a, id, { limit: 2, cursor: one.nextCursor });
    expect(two.data).toHaveLength(2);
    expect(two.data.every((m) => !one.data.some((n) => n.id === m.id))).toBe(true);
    const poll = await dm.messages(a, id, { afterId: one.data[0].id, limit: 2 });
    expect(poll.data[0].id).toBe(one.data[1].id);
    await expect(dm.messages(b, id, { limit: 2, cursor: one.nextCursor })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      dm.messages(a, id, { limit: 2, cursor: one.nextCursor + 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(dm.messages(a, id, { limit: 3, cursor: one.nextCursor })).rejects.toMatchObject({
      status: 400,
    });
    const list = await dm.list(a, { limit: 1 });
    expect(list.hasMore).toBe(true);
    await expect(
      dm.list(a, { box: 'requests', limit: 1, cursor: list.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
  });
  test('refusal persists across reopen; only recipient can restore consent; either block hides all text', async () => {
    const [, , , , a, b] = actors,
      id = (await dm.create(a, b.id)).conversation.id;
    const intro = await send(a, id, 'private request content');
    await dm.request(b, id, 'decline');
    expect((await dm.create(a, b.id)).conversation.state).toBe('DECLINED');
    await expect(send(a, id, 'retry bypass')).rejects.toMatchObject({ status: 403 });
    await dm.request(b, id, 'accept');
    expect((await dm.read(b, id, intro.message.id)).unreadCount).toBe(0);
    await send(a, id, 'consented');
    await dm.block(b, a.id, true);
    const metadata = (await dm.get(a, id)).conversation;
    expect(metadata.blocked).toBe(true);
    expect(metadata.lastMessage).toBeNull();
    expect(metadata.unreadCount).toBe(0);
    await expect(dm.messages(a, id)).rejects.toMatchObject({ status: 403 });
    await expect(send(a, id, 'blocked')).rejects.toMatchObject({ status: 403 });
    expect((await dm.list(a)).data.find((t) => t.id === id).lastMessage).toBeNull();
    await dm.block(b, a.id, false);
    expect((await dm.create(a, b.id)).conversation.state).toBe('DECLINED');
    await expect(send(a, id, 'unblock is not permission')).rejects.toMatchObject({ status: 403 });
    await dm.request(b, id, 'accept');
    expect((await dm.read(b, id, intro.message.id)).unreadCount).toBe(0);
    await send(a, id, 'explicitly reopened');
    expect((await dm.read(b, id, intro.message.id)).unreadCount).toBe(1);
    await dm.request(a, id, 'block');
    await expect(dm.messages(b, id)).rejects.toMatchObject({ status: 403 });
  });
  test('only participants see content, even ADMIN has no read bypass; disabled/version-revoked actors fail', async () => {
    const [a, b, , , , , outsider, admin] = actors,
      id = (await dm.create(a, b.id)).conversation.id;
    for (const actor of [outsider, admin]) {
      await expect(dm.get(actor, id)).rejects.toMatchObject({ status: 404 });
      await expect(dm.messages(actor, id)).rejects.toMatchObject({ status: 404 });
      await expect(send(actor, id, 'intrude')).rejects.toMatchObject({ status: 404 });
    }
    await db.user.update({ where: { id: outsider.id }, data: { status: 'BANNED' } });
    await expect(dm.unread(outsider)).rejects.toMatchObject({ status: 401 });
    await expect(dm.create(a, outsider.id)).rejects.toMatchObject({ status: 404 });
    await db.user.update({
      where: { id: outsider.id },
      data: { status: 'ACTIVE', authVersion: 1 },
    });
    await expect(dm.contacts(outsider, prefix)).rejects.toMatchObject({ status: 401 });
  });
  test('HTTP strict DTOs/authVersion and minimal contacts never expose emails or account hashes', async () => {
    const [a] = actors;
    const contactsResponse = await http(a, 'contacts?query=' + prefix);
    expect(contactsResponse.status).toBe(200);
    expect(contactsResponse.headers.get('cache-control')).toBe('private, no-store');
    const data = await (await http(a, 'contacts?query=' + prefix)).json();
    expect(data.data.data.length).toBeGreaterThan(0);
    expect(Object.keys(data.data.data[0]).sort()).toEqual(['avatar', 'id', 'username']);
    expect(
      (
        await http(a, 'conversations', {
          method: 'POST',
          body: JSON.stringify({ recipientId: actors[1].id, userId: actors[7].id }),
        })
      ).status,
    ).toBe(400);
    expect((await http(a, 'conversations/-1/messages')).status).toBe(404);
    expect((await http(a, 'conversations?limit=1000')).status).toBe(400);
    const id = (await dm.create(a, actors[1].id)).conversation.id;
    expect(
      (
        await http(a, `conversations/${id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'x', clientMessageId: randomUUID(), model: 'qwen' }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await http(a, `conversations/${id}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: 'x'.repeat(2001), clientMessageId: randomUUID() }),
        })
      ).status,
    ).toBe(400);
    const revoked = actors[6];
    expect((await http(revoked, 'unread-count')).status).toBe(401);
    expect((await fetch(base + '/api/direct-messages/unread-count')).status).toBe(401);
  });
  test('atomic rate limit is shared and fails closed without Redis; model/task quotas are not introduced', async () => {
    const a = actors[7],
      other = actors[1],
      id = (await dm.create(a, other.id)).conversation.id;
    await dm.request(other, id, 'accept');
    await redis.getClient().set(`chatforum:dm:send:v1:${a.id}`, '30', 'EX', 60);
    await expect(send(a, id, 'over rate')).rejects.toMatchObject({ status: 429 });
    expect(await db.directMessage.count({ where: { threadId: id } })).toBe(0);
    await redis.getClient().del(`chatforum:dm:send:v1:${a.id}`);
    const spy = jest.spyOn(redis, 'getClient').mockImplementation(() => {
      throw Error('offline');
    });
    try {
      await expect(send(a, id, 'redis unavailable')).rejects.toMatchObject({ status: 503 });
    } finally {
      spy.mockRestore();
    }
    expect(await db.directMessage.count({ where: { threadId: id } })).toBe(0);
  });
});

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { DirectMessage, DirectMessageThread, Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import configuration from '../../config/configuration';

export type DirectActor = { id: number; authVersion: number };
type Tx = Prisma.TransactionClient;
type Cursor = { v: 1; user: number; scope: string; before: string; id?: number; exp: number };
const userSelect = { id: true, username: true, avatar: true, status: true } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new NotFoundException('私信会话不可用');
const messageDto = (m: DirectMessage) => ({
  id: m.id.toString(),
  senderId: m.senderId,
  content: m.content,
  clientMessageId: m.clientMessageId,
  createdAt: m.createdAt,
});

/** Private messages are a separate domain, never AI/RAG input. All writes serialize
 * on the participant pair and thread; no administrative role grants content access. */
@Injectable()
export class DirectMessagesService {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private async active(actor: DirectActor, tx: Tx = this.db) {
    const u = await tx.user.findUnique({
      where: { id: actor.id },
      select: { id: true, status: true, authVersion: true },
    });
    if (!u || u.status !== 'ACTIVE' || u.authVersion !== actor.authVersion)
      throw new UnauthorizedException('登录状态已失效');
  }
  private async lockPair(tx: Tx, actor: DirectActor, other: number, peerMustBeActive = false) {
    const rows = await tx.$queryRaw<Array<{ id: number; status: string; authVersion: number }>>`
      SELECT id,status,authVersion FROM users WHERE id IN (${actor.id},${other}) ORDER BY id FOR SHARE`;
    const own = rows.find((u) => u.id === actor.id),
      peer = rows.find((u) => u.id === other);
    if (!own || own.status !== 'ACTIVE' || own.authVersion !== actor.authVersion)
      throw new UnauthorizedException('登录状态已失效');
    if (!peer || (peerMustBeActive && peer.status !== 'ACTIVE')) throw unavailable();
  }
  private participant(thread: DirectMessageThread, user: number) {
    return thread.userLowId === user || thread.userHighId === user;
  }
  private peer(thread: DirectMessageThread, user: number) {
    return thread.userLowId === user ? thread.userHighId : thread.userLowId;
  }
  private async owned(actor: DirectActor, id: number, tx: Tx = this.db) {
    const thread = await tx.directMessageThread.findUnique({ where: { id } });
    if (!thread || !this.participant(thread, actor.id)) throw unavailable();
    return thread;
  }
  private async withThread<T>(
    actor: DirectActor,
    id: number,
    fn: (tx: Tx, t: DirectMessageThread) => Promise<T>,
    peerActive = false,
  ): Promise<T> {
    await this.active(actor);
    const preliminary = await this.owned(actor, id);
    return this.db.$transaction(async (tx) => {
      await this.lockPair(tx, actor, this.peer(preliminary, actor.id), peerActive);
      await tx.$queryRaw`SELECT id FROM direct_message_threads WHERE id=${id} FOR UPDATE`;
      return fn(tx, await this.owned(actor, id, tx));
    });
  }
  private async blocks(tx: Tx, thread: DirectMessageThread) {
    return tx.directMessageBlock.findMany({
      where: {
        OR: [
          { blockerId: thread.userLowId, blockedId: thread.userHighId },
          { blockerId: thread.userHighId, blockedId: thread.userLowId },
        ],
      },
      select: { blockerId: true },
    });
  }
  private async ensureUnblocked(tx: Tx, thread: DirectMessageThread) {
    if ((await this.blocks(tx, thread)).length) throw new ForbiddenException('此会话当前不可用');
  }
  private summary(
    t: DirectMessageThread,
    user: number,
    peer: { id: number; username: string; avatar: string | null; status: string },
    blockedBy: number[],
    last?: DirectMessage,
  ) {
    const blocked = blockedBy.length > 0,
      outgoing = t.state === 'PENDING' && t.initiatorId === user;
    return {
      id: t.id,
      peer,
      state: t.state,
      requestDirection: t.state === 'PENDING' ? (outgoing ? 'outgoing' : 'incoming') : null,
      canSend:
        !blocked &&
        peer.status === 'ACTIVE' &&
        (t.state === 'ACCEPTED' || (outgoing && t.lastMessageId === 0n)),
      canAccept:
        !blocked && peer.status === 'ACTIVE' && t.recipientId === user && t.state !== 'ACCEPTED',
      canDecline: !blocked && t.recipientId === user && t.state === 'PENDING',
      blocked,
      blockedByMe: blockedBy.includes(user),
      unreadCount: blocked ? 0 : t.userLowId === user ? t.lowUnread : t.highUnread,
      lastMessage:
        !blocked && last
          ? {
              id: last.id.toString(),
              content: last.content.slice(0, 120),
              senderId: last.senderId,
              createdAt: last.createdAt,
            }
          : null,
      lastMessageAt: t.lastMessageAt,
      createdAt: t.createdAt,
    };
  }
  private async summaries(actor: DirectActor, threads: DirectMessageThread[], tx: Tx = this.db) {
    if (!threads.length) return [];
    const peerIds = threads.map((t) => this.peer(t, actor.id));
    const [peers, blocks, messages] = await Promise.all([
      tx.user.findMany({ where: { id: { in: peerIds } }, select: userSelect }),
      tx.directMessageBlock.findMany({
        where: {
          OR: [
            { blockerId: actor.id, blockedId: { in: peerIds } },
            { blockedId: actor.id, blockerId: { in: peerIds } },
          ],
        },
        select: { blockerId: true, blockedId: true },
      }),
      tx.directMessage.findMany({
        where: { id: { in: threads.map((t) => t.lastMessageId).filter((id) => id > 0n) } },
      }),
    ]);
    const pm = new Map(peers.map((p) => [p.id, p])),
      mm = new Map(messages.map((m) => [m.id.toString(), m]));
    return threads.map((t) =>
      this.summary(
        t,
        actor.id,
        pm.get(this.peer(t, actor.id))!,
        blocks
          .filter(
            (b) => b.blockerId === this.peer(t, actor.id) || b.blockedId === this.peer(t, actor.id),
          )
          .map((b) => b.blockerId),
        mm.get(t.lastMessageId.toString()),
      ),
    );
  }
  private key() {
    const secret = configuration().jwt.refreshSecret;
    if (!secret || secret.length < 16) throw new ServiceUnavailableException('私信分页暂不可用');
    return createHmac('sha256', secret).update('direct-message-cursors-v1').digest();
  }
  private encode(data: Omit<Cursor, 'v' | 'exp'>) {
    const body = Buffer.from(
      JSON.stringify({ ...data, v: 1, exp: Date.now() + 15 * 60000 }),
    ).toString('base64url');
    return `${body}.${createHmac('sha256', this.key()).update(body).digest('base64url')}`;
  }
  private decode(value: string, actor: DirectActor, scope: string): Cursor {
    try {
      if (value.length > 2048) throw Error();
      const [body, signature, ...rest] = value.split('.'),
        expected = createHmac('sha256', this.key()).update(body).digest(),
        actual = Buffer.from(signature || '', 'base64url');
      if (rest.length || actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw Error();
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor;
      if (
        parsed.v !== 1 ||
        parsed.user !== actor.id ||
        parsed.scope !== scope ||
        !Number.isSafeInteger(parsed.exp) ||
        parsed.exp < Date.now() ||
        !/^\d{1,19}$/.test(parsed.before) ||
        BigInt(parsed.before) > 9223372036854775807n ||
        (scope.startsWith('inbox:') && (!Number.isSafeInteger(parsed.id) || parsed.id < 1))
      )
        throw Error();
      return parsed;
    } catch {
      throw new BadRequestException('私信分页已失效，请刷新重试');
    }
  }
  private limit(value: number | undefined, max: number, fallback: number) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > max)
      throw new BadRequestException('分页数量无效');
    return value;
  }
  private id(value: string) {
    if (
      typeof value !== 'string' ||
      !/^[1-9]\d{0,18}$/.test(value) ||
      BigInt(value) > 9223372036854775807n
    )
      throw new BadRequestException('消息编号无效');
    return BigInt(value);
  }

  async contacts(actor: DirectActor, query: string) {
    await this.active(actor);
    const q = query?.trim();
    if (!q || q.length < 2 || q.length > 40) return { data: [] };
    // Literal prefix search, not a wildcard or an email/phone directory.
    const literal = q.replace(/[!%_]/g, '!$&') + '%';
    const data = await this.db.$queryRaw<
      Array<{ id: number; username: string; avatar: string | null }>
    >`
      SELECT u.id,u.username,u.avatar FROM users u WHERE u.status='ACTIVE' AND u.id<>${actor.id}
      AND u.username LIKE ${literal} ESCAPE '!'
      AND NOT EXISTS(SELECT 1 FROM direct_message_blocks b WHERE (b.blockerId=${actor.id} AND b.blockedId=u.id) OR (b.blockerId=u.id AND b.blockedId=${actor.id}))
      ORDER BY u.username,u.id LIMIT 20`;
    await this.active(actor);
    return { data };
  }
  async create(actor: DirectActor, recipientId: number) {
    if (!Number.isSafeInteger(recipientId) || recipientId < 1 || recipientId === actor.id)
      throw new BadRequestException('请选择其他用户');
    const low = Math.min(actor.id, recipientId),
      high = Math.max(actor.id, recipientId);
    // Pair upsert is atomic: simultaneous opens from either side yield one thread.
    const result = await this.db.$transaction(async (tx) => {
      await this.lockPair(tx, actor, recipientId, true);
      const blocked = await tx.directMessageBlock.count({
        where: {
          OR: [
            { blockerId: actor.id, blockedId: recipientId },
            { blockerId: recipientId, blockedId: actor.id },
          ],
        },
      });
      if (blocked) throw unavailable();
      const follow = await tx.follow.findUnique({
        where: { followerId_followingId: { followerId: recipientId, followingId: actor.id } },
        select: { id: true },
      });
      // MySQL does not use Prisma's native-upsert optimization. An explicit
      // unique-key no-op handles competing first opens without P2002 races.
      await tx.$executeRaw`INSERT INTO direct_message_threads (userLowId,userHighId,initiatorId,recipientId,state,updatedAt)
        VALUES (${low},${high},${actor.id},${recipientId},${follow ? 'ACCEPTED' : 'PENDING'},NOW(3))
        ON DUPLICATE KEY UPDATE id=id`;
      const thread = await tx.directMessageThread.findUniqueOrThrow({
        where: { userLowId_userHighId: { userLowId: low, userHighId: high } },
      });
      return { conversation: (await this.summaries(actor, [thread], tx))[0] };
    });
    return result;
  }
  async get(actor: DirectActor, id: number) {
    return this.withThread(actor, id, async (tx, thread) => ({
      conversation: (await this.summaries(actor, [thread], tx))[0],
    }));
  }
  async list(
    actor: DirectActor,
    q: { box?: 'inbox' | 'requests'; cursor?: string; limit?: number } = {},
  ) {
    await this.active(actor);
    const box = q.box ?? 'inbox';
    if (!['inbox', 'requests'].includes(box)) throw new BadRequestException('消息列表无效');
    const limit = this.limit(q.limit, 30, 20),
      scope = `inbox:${box}:${limit}`,
      c = q.cursor ? this.decode(q.cursor, actor, scope) : null;
    const where: Prisma.DirectMessageThreadWhereInput = {
      AND: [
        { OR: [{ userLowId: actor.id }, { userHighId: actor.id }] },
        box === 'requests'
          ? { state: 'PENDING', recipientId: actor.id, lastMessageId: { gt: 0n } }
          : { NOT: { state: 'PENDING', recipientId: actor.id } },
        ...(c
          ? [
              {
                OR: [
                  { lastMessageId: { lt: BigInt(c.before) } },
                  { lastMessageId: BigInt(c.before), id: { lt: c.id } },
                ],
              },
            ]
          : []),
      ],
    };
    const rows = await this.db.directMessageThread.findMany({
      where,
      orderBy: [{ lastMessageId: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit,
      data = rows.slice(0, limit),
      last = data[data.length - 1];
    // Snippets are private content too. Lock only this bounded page's users and
    // threads, in stable order, so a committed block/revocation cannot be skipped
    // by an earlier metadata read. Never fetch one query per conversation.
    const summaries = await this.db.$transaction(async (tx) => {
      const users = [...new Set([actor.id, ...data.map((t) => this.peer(t, actor.id))])].sort(
        (a, b) => a - b,
      );
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM users WHERE id IN (${Prisma.join(users)}) ORDER BY id FOR SHARE`,
      );
      await this.active(actor, tx);
      if (!data.length) return [];
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM direct_message_threads WHERE id IN (${Prisma.join(data.map((t) => t.id))}) ORDER BY id FOR UPDATE`,
      );
      const current = await tx.directMessageThread.findMany({
          where: {
            id: { in: data.map((t) => t.id) },
            OR: [{ userLowId: actor.id }, { userHighId: actor.id }],
          },
        }),
        map = new Map(current.map((t) => [t.id, t]));
      return this.summaries(
        actor,
        data.map((t) => map.get(t.id)).filter((t): t is DirectMessageThread => !!t),
        tx,
      );
    });
    return {
      data: summaries,
      hasMore,
      nextCursor:
        hasMore && last
          ? this.encode({
              user: actor.id,
              scope,
              before: last.lastMessageId.toString(),
              id: last.id,
            })
          : null,
    };
  }
  async messages(
    actor: DirectActor,
    id: number,
    q: { cursor?: string; afterId?: string; limit?: number } = {},
  ) {
    return this.withThread(actor, id, async (tx, thread) => {
      await this.ensureUnblocked(tx, thread);
      const limit = this.limit(q.limit, 50, 30),
        scope = `messages:${id}:${limit}`;
      if (q.cursor && q.afterId) throw new BadRequestException('不能同时向前和向后翻页');
      const before = q.cursor ? BigInt(this.decode(q.cursor, actor, scope).before) : null,
        after = q.afterId ? this.id(q.afterId) : null;
      if (
        after &&
        !(await tx.directMessage.findFirst({
          where: { id: after, threadId: id },
          select: { id: true },
        }))
      )
        throw new BadRequestException('消息游标无效');
      const rows = await tx.directMessage.findMany({
        where: {
          threadId: id,
          ...(before ? { id: { lt: before } } : after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: after ? 'asc' : 'desc' },
        take: limit + 1,
      });
      const hasMore = rows.length > limit,
        selected = rows.slice(0, limit),
        data = after ? selected : [...selected].reverse();
      // Pair/thread locks serialize delivery with block and account revocation.
      // A polling response is one bounded page, never an unguarded cached transcript.
      return {
        conversation: (await this.summaries(actor, [thread], tx))[0],
        data: data.map(messageDto),
        hasMore,
        nextCursor:
          !after && hasMore && selected.length
            ? this.encode({
                user: actor.id,
                scope,
                before: selected[selected.length - 1].id.toString(),
              })
            : null,
        lastReadMessageId: (thread.userLowId === actor.id
          ? thread.lowReadMessageId
          : thread.highReadMessageId
        ).toString(),
      };
    });
  }
  private async rate(actor: DirectActor, introduction: boolean) {
    const key = `chatforum:dm:send:v1:${actor.id}`,
      intro = `chatforum:dm:intro:v1:${actor.id}`;
    // Atomic account-wide abuse protection, not an AI task/token/fee quota.
    const lua = `local n=tonumber(redis.call('GET',KEYS[1]) or '0'); local i=tonumber(redis.call('GET',KEYS[2]) or '0'); if n>=30 then return 0 end; if ARGV[1]=='1' and i>=20 then return 0 end; n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; if ARGV[1]=='1' then i=redis.call('INCR',KEYS[2]); if i==1 then redis.call('EXPIRE',KEYS[2],86400) end end; return 1`;
    let result: unknown;
    try {
      result = await this.redis.getClient().eval(lua, 2, key, intro, introduction ? '1' : '0');
    } catch {
      throw new ServiceUnavailableException('私信发送暂不可用，请稍后重试');
    }
    if (result !== 1) throw new HttpException('发送过于频繁，请稍后再试', 429);
  }
  async send(actor: DirectActor, id: number, input: { content: string; clientMessageId: string }) {
    const content = input.content?.trim();
    if (
      !content ||
      content.length > 2000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content) ||
      !uuid.test(input.clientMessageId || '')
    )
      throw new BadRequestException('请输入 1～2000 字纯文本消息及有效发送标识');
    const clientMessageId = input.clientMessageId.toLowerCase();
    return this.withThread(
      actor,
      id,
      async (tx, thread) => {
        await this.ensureUnblocked(tx, thread);
        const existing = await tx.directMessage.findUnique({
          where: { senderId_clientMessageId: { senderId: actor.id, clientMessageId } },
        });
        if (existing) {
          if (existing.threadId !== id || existing.content !== content)
            throw new ConflictException('发送标识已用于另一条消息');
          return {
            message: messageDto(existing),
            conversation: (await this.summaries(actor, [thread], tx))[0],
            replayed: true,
          };
        }
        if (!['PENDING', 'ACCEPTED'].includes(thread.state))
          throw new ForbiddenException('对方暂未接受私信');
        // Following by the recipient is permission to message, never the inverse relation.
        if (thread.state === 'PENDING') {
          const follows = await tx.follow.findUnique({
            where: {
              followerId_followingId: {
                followerId: thread.recipientId,
                followingId: thread.initiatorId,
              },
            },
            select: { id: true },
          });
          if (follows)
            thread = await tx.directMessageThread.update({
              where: { id },
              data: { state: 'ACCEPTED' },
            });
          else if (thread.initiatorId !== actor.id || thread.lastMessageId > 0n)
            throw new ForbiddenException('请等待对方接受私信请求');
        }
        await this.rate(actor, thread.state === 'PENDING');
        const message = await tx.directMessage.create({
          data: { threadId: id, senderId: actor.id, clientMessageId, content },
        });
        const ownLow = thread.userLowId === actor.id;
        const updated = await tx.directMessageThread.update({
          where: { id },
          data: {
            lastMessageId: message.id,
            lastMessageAt: message.createdAt,
            ...(ownLow ? { highUnread: { increment: 1 } } : { lowUnread: { increment: 1 } }),
          },
        });
        return {
          message: messageDto(message),
          conversation: (await this.summaries(actor, [updated], tx))[0],
          replayed: false,
        };
      },
      true,
    ).catch((error) => {
      // Concurrent use of the same sender UUID in different threads cannot
      // become an unhandled database error or duplicate a logical send.
      if (error?.code === 'P2002') throw new ConflictException('发送标识已用于另一条消息');
      throw error;
    });
  }
  async read(actor: DirectActor, id: number, lastReadMessageId: string) {
    const last = this.id(lastReadMessageId);
    return this.withThread(actor, id, async (tx, t) => {
      await this.ensureUnblocked(tx, t);
      if (
        !(await tx.directMessage.findFirst({
          where: { id: last, threadId: id },
          select: { id: true },
        }))
      )
        throw new BadRequestException('消息不属于此会话');
      const ownLow = t.userLowId === actor.id,
        previous = ownLow ? t.lowReadMessageId : t.highReadMessageId,
        next = last > previous ? last : previous;
      const remaining = await tx.directMessage.count({
        where: { threadId: id, senderId: { not: actor.id }, id: { gt: next } },
      });
      await tx.directMessageThread.update({
        where: { id },
        data: ownLow
          ? { lowReadMessageId: next, lowUnread: remaining }
          : { highReadMessageId: next, highUnread: remaining },
      });
      return { lastReadMessageId: next.toString(), unreadCount: remaining };
    });
  }
  async request(actor: DirectActor, id: number, action: 'accept' | 'decline' | 'block') {
    if (!['accept', 'decline', 'block'].includes(action))
      throw new BadRequestException('请求操作无效');
    return this.withThread(
      actor,
      id,
      async (tx, t) => {
        if (action === 'block') {
          await tx.directMessageBlock.upsert({
            where: {
              blockerId_blockedId: { blockerId: actor.id, blockedId: this.peer(t, actor.id) },
            },
            create: { blockerId: actor.id, blockedId: this.peer(t, actor.id) },
            update: {},
          });
          t = await tx.directMessageThread.update({
            where: { id },
            data: { state: 'DECLINED', lowUnread: 0, highUnread: 0,
              lowReadMessageId: t.lastMessageId, highReadMessageId: t.lastMessageId },
          });
        } else {
          await this.ensureUnblocked(tx, t);
          if (t.recipientId !== actor.id) throw new ForbiddenException('只能由接收方处理请求');
          if (action === 'decline' && t.state === 'ACCEPTED')
            throw new BadRequestException('已接受的会话请使用屏蔽');
          t = await tx.directMessageThread.update({
            where: { id },
            data: {
              state: action === 'accept' ? 'ACCEPTED' : 'DECLINED',
              ...(action === 'decline' ? { lowUnread: 0, highUnread: 0,
                lowReadMessageId: t.lastMessageId, highReadMessageId: t.lastMessageId } : {}),
            },
          });
        }
        return { conversation: (await this.summaries(actor, [t], tx))[0] };
      },
      action === 'accept',
    );
  }
  async block(actor: DirectActor, other: number, blocked: boolean) {
    if (
      !Number.isSafeInteger(other) ||
      other < 1 ||
      other === actor.id ||
      typeof blocked !== 'boolean'
    )
      throw new BadRequestException('屏蔽对象无效');
    return this.db.$transaction(async (tx) => {
      await this.lockPair(tx, actor, other);
      // Same lock order as request(block)/send; never hold a block row while
      // waiting for a thread another transaction is about to block.
      await tx.$queryRaw`SELECT id FROM direct_message_threads WHERE userLowId=${Math.min(actor.id, other)} AND userHighId=${Math.max(actor.id, other)} FOR UPDATE`;
      if (blocked)
        await tx.directMessageBlock.upsert({
          where: { blockerId_blockedId: { blockerId: actor.id, blockedId: other } },
          create: { blockerId: actor.id, blockedId: other },
          update: {},
        });
      else
        await tx.directMessageBlock.deleteMany({
          where: { blockerId: actor.id, blockedId: other },
        });
      // Unblocking never recreates permission or sends a new request behind a refusal.
      if (blocked)
        await tx.$executeRaw`UPDATE direct_message_threads SET state='DECLINED',lowUnread=0,highUnread=0,
          lowReadMessageId=lastMessageId,highReadMessageId=lastMessageId,updatedAt=NOW(3)
          WHERE userLowId=${Math.min(actor.id, other)} AND userHighId=${Math.max(actor.id, other)}`;
      return { blocked };
    });
  }
  async unread(actor: DirectActor) {
    await this.active(actor);
    const rows = await this.db.$queryRaw<
      Array<{ box: string; n: bigint | number | Prisma.Decimal }>
    >`
      SELECT CASE WHEN t.state='PENDING' AND t.recipientId=${actor.id} THEN 'requests' ELSE 'inbox' END box,
      SUM(CASE WHEN t.userLowId=${actor.id} THEN t.lowUnread ELSE t.highUnread END) n
      FROM direct_message_threads t WHERE (t.userLowId=${actor.id} OR t.userHighId=${actor.id})
      AND t.state IN ('PENDING','ACCEPTED') AND NOT EXISTS(SELECT 1 FROM direct_message_blocks b
       WHERE (b.blockerId=t.userLowId AND b.blockedId=t.userHighId) OR (b.blockerId=t.userHighId AND b.blockedId=t.userLowId))
      GROUP BY box`;
    await this.active(actor);
    const inbox = Number(rows.find((r) => r.box === 'inbox')?.n ?? 0),
      requests = Number(rows.find((r) => r.box === 'requests')?.n ?? 0);
    return { inbox, requests, total: inbox + requests };
  }
}

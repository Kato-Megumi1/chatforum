import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { SocialListQueryDto, UpdateProfileDto } from './user.dto';

const privateProfile = { id: true, email: true, username: true, avatar: true, bio: true,
  role: true, level: true, points: true, createdAt: true } as const;
const publicProfile = { id: true, username: true, avatar: true, bio: true,
  level: true, points: true, createdAt: true } as const;

@Injectable()
export class UserService {
  constructor(private prisma: PrismaService) {}

  private validId(id: number) {
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new BadRequestException('无效的用户编号');
  }

  private async active(id: number, db: any = this.prisma) {
    this.validId(id);
    const user = await db.user.findFirst({ where: { id, status: 'ACTIVE' }, select: { id: true, username: true } });
    if (!user) throw new ForbiddenException('账号当前不可用');
    return user;
  }

  async findOne(id: number) {
    await this.active(id);
    return this.prisma.user.findUnique({ where: { id }, select: privateProfile });
  }

  async updateProfile(userId: number, data: UpdateProfileDto) {
    await this.active(userId);
    try { return await this.prisma.user.update({ where: { id: userId }, data: {
      ...(typeof data.username === 'string' ? { username: data.username.trim() } : {}),
      ...(typeof data.bio === 'string' ? { bio: data.bio } : {}),
      ...(typeof data.avatar === 'string' && /^\/uploads\/avatars\/[\w.-]+$/.test(data.avatar) ? { avatar: data.avatar } : {}),
    }, select: privateProfile });
    } catch (error: unknown) {
      // The unique constraint is authoritative even when two edits race.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('这个用户名已被使用，请换一个');
      throw error;
    }
  }

  async getUserProfile(id: number, currentUserId?: number) {
    this.validId(id);
    if (currentUserId) await this.active(currentUserId);
    const user = await this.prisma.user.findFirst({ where: { id, status: 'ACTIVE' }, select: publicProfile });
    if (!user) throw new NotFoundException('用户暂不可访问');
    // Legacy relation names point in the opposite direction; preserve stored edges and count their real endpoints.
    const [posts, followers, following, ownFollow] = await Promise.all([
      this.prisma.post.count({ where: { userId: id, status: 'APPROVED' } }),
      this.prisma.follow.count({ where: { followingId: id, follower: { status: 'ACTIVE' } } }),
      this.prisma.follow.count({ where: { followerId: id, following: { status: 'ACTIVE' } } }),
      currentUserId && currentUserId !== id ? this.prisma.follow.findUnique({ where: {
        followerId_followingId: { followerId: currentUserId, followingId: id },
      }, select: { id: true } }) : null,
    ]);
    return { ...user, _count: { posts, followers, following }, isFollowing: !!ownFollow };
  }

  private async lockPeople(tx: any, followerId: number, followingId: number, requireTargetActive = true) {
    this.validId(followerId); this.validId(followingId);
    if (followerId === followingId) throw new BadRequestException('不能关注自己');
    // A deterministic pair lock serializes follow/unfollow across tabs; no global graph lock or swallowed database failure.
    const ids = [followerId, followingId].sort((a, b) => a - b);
    const rows = await tx.$queryRaw(Prisma.sql`SELECT id, status, username FROM users WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`) as any[];
    const actor = rows.find(row => row.id === followerId), target = rows.find(row => row.id === followingId);
    if (!actor || actor.status !== 'ACTIVE') throw new ForbiddenException('账号当前不可用');
    if (!target || (requireTargetActive && target.status !== 'ACTIVE')) throw new NotFoundException('用户暂不可访问');
    return actor;
  }

  async followUser(followerId: number, followingId: number) {
    return this.prisma.$transaction(async tx => {
      const actor = await this.lockPeople(tx, followerId, followingId);
      const created = await tx.follow.createMany({ data: [{ followerId, followingId }], skipDuplicates: true });
      if (created.count) await tx.notification.create({ data: { userId: followingId, type: 'FOLLOW',
        title: '有新的关注者', content: `${actor.username} 关注了你`, relatedId: followerId } });
      const followers = await tx.follow.count({ where: { followingId, follower: { status: 'ACTIVE' } } });
      return { isFollowing: true, followers };
    });
  }

  async unfollowUser(followerId: number, followingId: number) {
    return this.prisma.$transaction(async tx => {
      // A previously followed account can be removed even after it becomes unavailable.
      await this.lockPeople(tx, followerId, followingId, false);
      await tx.follow.deleteMany({ where: { followerId, followingId } });
      const followers = await tx.follow.count({ where: { followingId, follower: { status: 'ACTIVE' } } });
      return { isFollowing: false, followers };
    });
  }

  private async socialList(userId: number, direction: 'followers' | 'following', params: SocialListQueryDto, currentUserId?: number) {
    this.validId(userId);
    if (currentUserId) await this.active(currentUserId);
    if (!await this.prisma.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })) {
      throw new NotFoundException('用户暂不可访问');
    }
    const { limit = 20, cursor } = params;
    const inbound = direction === 'followers';
    const rows = await this.prisma.follow.findMany({ where: {
      ...(inbound ? { followingId: userId, follower: { status: 'ACTIVE' as const } } : { followerId: userId, following: { status: 'ACTIVE' as const } }),
      ...(cursor ? { id: { lt: cursor } } : {}),
    }, select: { id: true, createdAt: true, follower: { select: publicProfile }, following: { select: publicProfile } },
    orderBy: { id: 'desc' }, take: limit + 1 });
    const page = rows.slice(0, limit), ids = page.map(row => (inbound ? row.follower : row.following)!.id);
    const ownEdges = currentUserId && ids.length ? await this.prisma.follow.findMany({ where: {
      followerId: currentUserId, followingId: { in: ids },
    }, select: { followingId: true } }) : [];
    const followed = new Set(ownEdges.map(row => row.followingId));
    return { data: page.map(row => ({ ...(inbound ? row.follower : row.following), followedAt: row.createdAt,
      isFollowing: followed.has((inbound ? row.follower : row.following)!.id) })),
      hasMore: rows.length > limit, nextCursor: rows.length > limit ? page.at(-1)!.id : null };
  }

  getUserFollowers(userId: number, params: SocialListQueryDto = {}, currentUserId?: number) {
    return this.socialList(userId, 'followers', params, currentUserId);
  }

  getUserFollowing(userId: number, params: SocialListQueryDto = {}, currentUserId?: number) {
    return this.socialList(userId, 'following', params, currentUserId);
  }
}

import { Injectable, UnauthorizedException, ConflictException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { randomUUID } from 'crypto';
import { XpService } from '../../common/xp.service';
import configuration from '../../config/configuration';
import { LoginContext, recordLogin } from '../../common/login-audit';
import { ChangePasswordDto } from './dto/change-password.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private redisService: RedisService,
  ) {}

  async register(registerDto: RegisterDto, context: LoginContext = {}) {
    const { email, username, password } = registerDto;
    // Empty optional numbers must be NULL, not the same unique empty string for everyone.
    const phone = registerDto.phone?.trim() || null;

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username },
          ...(phone ? [{ phone }] : []),
        ],
      },
    });

    if (existingUser) {
      throw new ConflictException('邮箱、用户名或手机号已被使用');
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await this.prisma.user.create({
      data: {
        email,
        username,
        password: hashedPassword,
        phone,
      },
      select: {
        id: true,
        email: true,
        username: true,
        avatar: true,
        bio: true,
        role: true,
        level: true,
        points: true,
        createdAt: true,
      },
    }).catch(error => {
      // The database remains authoritative if two registrations race after the lookup.
      if (error?.code === 'P2002') throw new ConflictException('邮箱、用户名或手机号已被使用');
      throw error;
    });

    const tokens = await this.generateTokens(user.id, user.role, undefined, 0);
    await recordLogin(this.prisma, user.id, 'REGISTERED', 'WEB', context);
    return { user, ...tokens };
  }

  async login(loginDto: LoginDto, context: LoginContext = {}) {
    const { email, password } = loginDto;

    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || user.status !== 'ACTIVE' || !(await bcrypt.compare(password, user.password))) {
      await recordLogin(this.prisma, user?.id ?? null, 'FAILED', 'WEB', context);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Daily login XP (once per day)
    const today = new Date().toISOString().slice(0, 10);
    const xpKey = `login_xp:${user.id}:${today}`;
    const awarded = await this.redisService.getClient().set(xpKey, '1', 'EX', 86400, 'NX');
    if (awarded) {
      try {
        const updated = await this.prisma.$transaction(async tx => {
          const incremented = await tx.user.update({ where: { id: user.id }, data: { points: { increment: XpService.LOGIN_XP } } });
          return tx.user.update({ where: { id: user.id }, data: { level: XpService.getLevel(incremented.points) } });
        });
        user.points = updated.points; user.level = updated.level;
      } catch (error) { await this.redisService.del(xpKey); throw error; }
    }

    const tokens = await this.generateTokens(user.id, user.role, undefined, user.authVersion);
    await recordLogin(this.prisma, user.id, 'SUCCESS', 'WEB', context);
    return {
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        avatar: user.avatar,
        bio: user.bio,
        role: user.role,
        level: user.level,
        points: user.points,
        createdAt: user.createdAt,
      },
      ...tokens,
    };
  }

  async refreshTokens(refreshToken: string) {
    try {
      const payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: configuration().jwt.refreshSecret,
      });

      const storedToken = await this.redisService.get(`refresh_token:${payload.sub}`);
      if (!storedToken || storedToken !== refreshToken) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          status: true,
          authVersion: true,
          email: true,
          username: true,
          avatar: true,
          bio: true,
          role: true,
          level: true,
          points: true,
          createdAt: true,
        },
      });

      if (!user || user.status !== 'ACTIVE' || (payload.authVersion ?? 0) !== user.authVersion) {
        throw new UnauthorizedException('User not found');
      }

      const tokens = await this.generateTokens(user.id, user.role, refreshToken, user.authVersion);
      const { authVersion: _version, ...publicUser } = user;
      return { user: publicUser, ...tokens };
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async changePassword(userId: number, data: ChangePasswordDto, context: LoginContext = {}) {
    if (data.confirmPassword !== data.newPassword) throw new BadRequestException('两次输入的新密码不一致');
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, status: true, password: true, authVersion: true } });
    if (!user || user.status !== 'ACTIVE') throw new ForbiddenException('账号不可用');
    if (!await bcrypt.compare(data.oldPassword, user.password)) throw new BadRequestException('当前密码不正确');
    if (data.oldPassword === data.newPassword) throw new BadRequestException('新密码不能与当前密码相同');
    return this.replaceVerifiedPassword(userId, user.password, user.authVersion, data.newPassword, context);
  }

  /** Internal credential flow only: callers must first verify the old password or a
   * single-use reset proof. Never expose raw userId/newPassword as a public reset route. */
  async replaceVerifiedPassword(userId: number, expectedHash: string, expectedVersion: number, newPassword: string,
    context: LoginContext = {}, action: 'PASSWORD_CHANGE' | 'PASSWORD_RESET' = 'PASSWORD_CHANGE', expectedEmail?: string) {
    if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !expectedHash)
      throw new BadRequestException('无效的密码更新凭据');
    if (typeof newPassword !== 'string' || [...newPassword].length < 6 || Buffer.byteLength(newPassword, 'utf8') > 72 || !/\S/u.test(newPassword))
      throw new BadRequestException('新密码至少6个字符且不超过72字节，不能全部为空格');
    let previousRefresh: string | null = null;
    try { previousRefresh = await this.redisService.get('refresh_token:' + userId); }
    catch { this.logger.warn('Refresh cleanup lookup deferred; database authentication version remains authoritative'); }
    const password = await bcrypt.hash(newPassword, 12);
    await this.prisma.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: userId, status: 'ACTIVE', password: expectedHash, authVersion: expectedVersion,
        ...(expectedEmail !== undefined ? { email: expectedEmail } : {}) },
        data: { password, authVersion: { increment: 1 } } });
      if (!changed.count) throw new ConflictException('账号或密码已发生变化，请重新登录后再试');
      await tx.operationLog.create({ data: { userId, action, module: 'AUTH',
        details: 'Password changed; earlier authentication versions revoked', ip: context.ip?.slice(0, 64) } });
    });
    // Database version checks are the revocation authority. Cleanup failure cannot reactivate
    // old access/refresh/monitor sessions or falsely report that the password stayed unchanged.
    try { if (previousRefresh) await this.redisService.compareDelete('refresh_token:' + userId, previousRefresh); }
    catch { this.logger.warn('Password changed; stale refresh entry cleanup deferred (authentication version already revoked)'); }
    return { requiresLogin: true, message: '密码已修改，请使用新密码重新登录' };
  }

  async logout(refreshToken?: string) {
    if (!refreshToken) {
      return { message: 'Logged out successfully' };
    }

    try {
      const payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: configuration().jwt.refreshSecret,
      });
      await this.redisService.compareDelete(`refresh_token:${payload.sub}`, refreshToken);
    } catch {
      // Unverified tokens cannot revoke sessions.
    }

    return { message: 'Logged out successfully' };
  }

  private async generateTokens(userId: number, role: string, previous?: string, authVersion = 0) {
    const config = configuration().jwt;
    const payload = { sub: userId, role, authVersion, jti: randomUUID() };

    const accessToken = await this.jwtService.signAsync(payload, {
      secret: config.accessSecret,
      expiresIn: this.parseTTL(config.accessExpiresIn),
    });

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: config.refreshSecret,
      expiresIn: this.parseTTL(config.refreshExpiresIn),
    });

    const ttl = this.parseTTL(config.refreshExpiresIn);
    const current = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, authVersion: true } });
    if (!current || current.status !== 'ACTIVE' || current.authVersion !== authVersion)
      throw new UnauthorizedException('Authentication changed; please sign in again');
    if (previous) {
      if (!await this.redisService.compareReplace('refresh_token:' + userId, previous, refreshToken, ttl))
        throw new UnauthorizedException('Refresh token already rotated');
    } else await this.redisService.set('refresh_token:' + userId, refreshToken, ttl);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.parseTTL(config.accessExpiresIn) * 1000,
    };
  }

  private parseTTL(expiresIn: string): number {
    const unit = expiresIn.slice(-1);
    const value = parseInt(expiresIn.slice(0, -1), 10);

    switch (unit) {
      case 's': return value;
      case 'm': return value * 60;
      case 'h': return value * 60 * 60;
      case 'd': return value * 24 * 60 * 60;
      default: return 3600;
    }
  }
}

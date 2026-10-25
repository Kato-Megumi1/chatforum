import { BadRequestException, HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { RedisService } from '../../common/redis.service';
import { LoginContext } from '../../common/login-audit';
import configuration from '../../config/configuration';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../admin-settings/mail.service';
import { ResetRecoveredPasswordDto } from './dto/password-recovery.dto';

const INVALID_CODE = '验证码无效或已过期，请重新获取';
const ACCEPTED = '请求已受理。若该邮箱关联可用账号，将尝试发送验证码；本响应不代表送达，未收到请稍后重试或联系管理员。';
const TTL = 600;

// All reservations happen in one operation: multiple workers cannot race cooldowns or hourly counters.
export const RECOVERY_REQUEST_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
local emailCount = tonumber(redis.call('GET', KEYS[3]) or '0')
local ipCount = tonumber(redis.call('GET', KEYS[4]) or '0')
if emailCount >= 5 or ipCount >= 20 then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', 60)
redis.call('SET', KEYS[2], '1', 'EX', 60)
if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
if redis.call('INCR', KEYS[4]) == 1 then redis.call('EXPIRE', KEYS[4], 3600) end
return 1`;

// This is the verification authority, NOT a GET-then-DEL check. A successful code is consumed once;
// failed concurrent attempts share the same count, and cannot revive or consume a newer challenge.
export const RECOVERY_CONSUME_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return nil end
local data = cjson.decode(value)
if data.nonce ~= ARGV[1] or data.attempts >= 5 then return nil end
if data.digest ~= ARGV[2] then
  data.attempts = data.attempts + 1
  if data.attempts >= 5 then redis.call('DEL', KEYS[1])
  else local ttl = redis.call('PTTL', KEYS[1]); if ttl > 0 then redis.call('SET', KEYS[1], cjson.encode(data), 'PX', ttl) end end
  return nil
end
redis.call('DEL', KEYS[1])
return value`;

export const RECOVERY_VERIFY_RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], 3600) end
return count <= 60 and 1 or 0`;

type RecoveryChallenge = { userId: number; email: string; authVersion: number; nonce: string; digest: string; attempts: number };

@Injectable()
export class PasswordRecoveryService implements OnModuleDestroy {
  private readonly logger = new Logger(PasswordRecoveryService.name);
  private readonly pendingDeliveries = new Set<Promise<void>>();
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService,
    private readonly auth: AuthService, private readonly mail: MailService) {}

  private email(value: string): string {
    if (typeof value !== 'string') throw new BadRequestException('请输入正确的邮箱');
    const email = value.trim().toLowerCase();
    if (email.length > 191 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('请输入正确的邮箱');
    return email;
  }
  private fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex'); }
  private challengeKey(email: string): string { return 'password_recovery:challenge:' + this.fingerprint(email); }
  private digest(nonce: string, email: string, code: string): string {
    // Purpose-bound HMAC means a six-digit challenge is not cheaply brute-forced from a Redis dump.
    const secret = configuration().jwt.refreshSecret;
    if (!secret || secret.length < 32) throw new ServiceUnavailableException('密码找回服务暂不可用');
    return createHmac('sha256', secret).update('chatforum-password-recovery-v1\0' + nonce + '\0' + email + '\0' + code).digest('hex');
  }
  private async ready() {
    if (!await this.mail.isReady()) throw new ServiceUnavailableException('邮箱验证码服务尚未配置，请联系站点管理员');
  }
  private unavailable(): never { throw new ServiceUnavailableException('密码找回服务暂不可用，请稍后再试'); }
  async onModuleDestroy() { await Promise.all([...this.pendingDeliveries]); }
  private async deliver(email: string, code: string, key: string, serialized: string) {
    try { await this.mail.sendPasswordResetCode(email, code); }
    catch {
      // Identical public responses and non-blocking SMTP dispatch prevent response-body and
      // delivery-duration account enumeration. This acknowledges requests, never delivery.
      await this.redis.compareDelete(key, serialized).catch(() => undefined);
      this.logger.warn('Password recovery email delivery failed; request acknowledged without delivery confirmation');
    }
  }

  async requestCode(value: string, context: LoginContext = {}) {
    const email = this.email(value);
    await this.ready();
    const emailKey = this.fingerprint(email), ipKey = this.fingerprint(context.ip || 'unknown');
    let reserved: unknown;
    try { reserved = await this.redis.getClient().eval(RECOVERY_REQUEST_SCRIPT, 4,
      'password_recovery:cooldown:email:' + emailKey, 'password_recovery:cooldown:ip:' + ipKey,
      'password_recovery:hour:email:' + emailKey, 'password_recovery:hour:ip:' + ipKey); }
    catch { return this.unavailable(); }
    if (reserved !== 1) throw new HttpException('验证码请求过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
    const user = await this.prisma.user.findUnique({ where: { email }, select: { id: true, email: true, status: true, authVersion: true } });
    const eligible = user?.status === 'ACTIVE';
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const nonce = randomBytes(24).toString('hex');
    const challenge: RecoveryChallenge = { userId: eligible ? user.id : 0, email: eligible ? user.email : email,
      authVersion: eligible ? user.authVersion : 0, nonce, digest: this.digest(nonce, email, code), attempts: 0 };
    const key = this.challengeKey(email), serialized = JSON.stringify(challenge);
    try { await this.redis.set(key, serialized, TTL); } catch { return this.unavailable(); }
    if (eligible) {
      const delivery = this.deliver(user.email, code, key, serialized);
      this.pendingDeliveries.add(delivery);
      void delivery.then(() => this.pendingDeliveries.delete(delivery));
    }
    return { message: ACCEPTED, retryAfterSeconds: 60, expiresInSeconds: TTL };
  }

  async resetPassword(data: ResetRecoveredPasswordDto, context: LoginContext = {}) {
    const email = this.email(data.email);
    if (typeof data.code !== 'string' || !/^\d{6}$/.test(data.code)) throw new BadRequestException(INVALID_CODE);
    if (typeof data.newPassword !== 'string' || [...data.newPassword].length < 6 || Buffer.byteLength(data.newPassword, 'utf8') > 72 || !/\S/u.test(data.newPassword))
      throw new BadRequestException('新密码至少6个字符且不超过72字节，不能全部为空格');
    if (data.confirmPassword !== data.newPassword) throw new BadRequestException('两次输入的新密码不一致');
    const key = this.challengeKey(email);
    let value: string | null;
    try {
      const permitted = await this.redis.getClient().eval(RECOVERY_VERIFY_RATE_SCRIPT, 1,
        'password_recovery:verify:ip:' + this.fingerprint(context.ip || 'unknown'));
      if (permitted !== 1) throw new HttpException('验证码尝试过于频繁，请稍后再试', HttpStatus.TOO_MANY_REQUESTS);
      value = await this.redis.get(key);
    } catch (error) { if (error instanceof HttpException) throw error; return this.unavailable(); }
    if (!value) throw new BadRequestException(INVALID_CODE);
    let challenge: RecoveryChallenge;
    try { challenge = JSON.parse(value); } catch { return this.unavailable(); }
    let consumed: unknown;
    try { consumed = await this.redis.getClient().eval(RECOVERY_CONSUME_SCRIPT, 1, key, challenge.nonce,
      this.digest(challenge.nonce, email, data.code)); } catch { return this.unavailable(); }
    if (typeof consumed !== 'string') throw new BadRequestException(INVALID_CODE);
    const proof: RecoveryChallenge = JSON.parse(consumed);
    if (!proof.userId) throw new BadRequestException(INVALID_CODE);
    const user = await this.prisma.user.findUnique({ where: { id: proof.userId }, select: { id: true, email: true, status: true, authVersion: true, password: true } });
    if (!user || user.status !== 'ACTIVE' || user.email !== proof.email || user.email.trim().toLowerCase() !== email || user.authVersion !== proof.authVersion)
      throw new BadRequestException(INVALID_CODE);
    return this.auth.replaceVerifiedPassword(user.id, user.password, proof.authVersion, data.newPassword, context, 'PASSWORD_RESET', proof.email);
  }
}

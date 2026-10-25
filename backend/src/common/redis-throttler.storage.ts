import { ServiceUnavailableException } from '@nestjs/common';
import { RedisService } from './redis.service';

export class RedisThrottlerStorage {
  constructor(private readonly redis: RedisService) {}
  async increment(key: string, ttl: number) {
    try {
      const value = await this.redis.getClient().eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}",
        1, 'http:throttle:' + key, ttl) as number[];
      return { totalHits: Number(value[0]), timeToExpire: Math.max(1, Math.ceil(Number(value[1]) / 1000)) };
    } catch { throw new ServiceUnavailableException('请求保护服务暂不可用，请稍后重试'); }
  }
}

import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './common/prisma.service';
import { QdrantVectorService } from './modules/agent/qdrant-vector.service';
import { ApiResponse } from './common/response.class';
import { RedisService } from './common/redis.service';
import { SkipThrottle } from '@nestjs/throttler';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly vectors: QdrantVectorService, private readonly redis: RedisService) {}
  @Get('live') @SkipThrottle() live() { return ApiResponse.ok({ status: 'ok' }); }
  @Get('ready') @SkipThrottle() async ready() {
    const result = await this.check();
    if ((result as any).data?.status !== 'ok') throw new ServiceUnavailableException('依赖服务暂不可用');
    return result;
  }
  @Get() async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const rag = await this.vectors.healthCheck().then(() => 'up', () => 'unavailable');
      const redis = await this.redis.getClient().ping().then(() => 'up', () => 'unavailable');
      return ApiResponse.ok({ status: rag === 'up' && redis === 'up' ? 'ok' : 'degraded', rag, redis });
    } catch { throw new ServiceUnavailableException('数据库不可用'); }
  }
}

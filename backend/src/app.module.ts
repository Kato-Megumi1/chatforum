import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { PrismaService } from './common/prisma.service';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { RequestThrottlerGuard } from './guards/request-throttler.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UserModule } from './modules/user/user.module';
import { ChatModule } from './modules/chat/chat.module';
import { ForumModule } from './modules/forum/forum.module';
import { AgentModule } from './modules/agent/agent.module';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { RedisService } from './common/redis.service';
import { RedisThrottlerStorage } from './common/redis-throttler.storage';
import { MonitorModule } from './modules/monitor/monitor.module';
import { AdminSettingsModule } from './modules/admin-settings/admin-settings.module';
import { PasswordRecoveryModule } from './modules/password-recovery/password-recovery.module';
import { DirectMessagesModule } from './modules/direct-messages/direct-messages.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ThrottlerModule.forRootAsync({ imports: [AuthModule], inject: [RedisService],
      useFactory: (redis: RedisService) => ({ storage: new RedisThrottlerStorage(redis),
        throttlers: [{ ttl: 60000, limit: 100 }] }) }),
    AuthModule,
    UserModule,
    ChatModule,
    ForumModule,
    AgentModule,
    MonitorModule,
    AdminSettingsModule,
    PasswordRecoveryModule,
    DirectMessagesModule,
  ],
  providers: [
    PrismaService,
    {
      provide: APP_GUARD,
      useClass: RequestThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}

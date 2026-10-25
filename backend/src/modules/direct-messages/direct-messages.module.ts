import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../../common/prisma.service';
import { JwtAuthGuard } from '../../guards/jwt-auth.guard';
import { DirectMessagesController } from './direct-messages.controller';
import { DirectMessagesService } from './direct-messages.service';

@Module({
  imports: [AuthModule, JwtModule.register({})],
  controllers: [DirectMessagesController],
  providers: [PrismaService, JwtAuthGuard, DirectMessagesService],
  exports: [DirectMessagesService],
})
export class DirectMessagesModule {}

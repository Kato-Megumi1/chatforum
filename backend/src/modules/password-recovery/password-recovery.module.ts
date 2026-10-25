import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module';
import { PasswordRecoveryController } from './password-recovery.controller';
import { PasswordRecoveryService } from './password-recovery.service';

@Module({ imports: [AuthModule, AdminSettingsModule], controllers: [PasswordRecoveryController],
  providers: [PasswordRecoveryService, PrismaService] })
export class PasswordRecoveryModule {}

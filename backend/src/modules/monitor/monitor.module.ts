import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../../common/prisma.service';
import { MonitorService } from './monitor.service';
import { AdminSettingsModule } from '../admin-settings/admin-settings.module';
import { ForumModule } from '../forum/forum.module';

// No Nest controllers: none of the operations APIs are mounted on the public listener.
@Module({ imports: [AuthModule, AdminSettingsModule, ForumModule], providers: [PrismaService, MonitorService] })
export class MonitorModule {}

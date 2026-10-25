import { Module } from '@nestjs/common';
import { AdminSettingsService } from './admin-settings.service';
import { MailService } from './mail.service';
@Module({ providers: [AdminSettingsService, MailService], exports: [AdminSettingsService, MailService] })
export class AdminSettingsModule {}

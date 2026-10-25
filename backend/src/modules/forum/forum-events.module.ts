import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { ForumEventsWorker } from './forum-events.worker';

@Module({ providers: [PrismaService, ForumEventsService, ForumEventsWorker], exports: [ForumEventsService] })
export class ForumEventsModule {}

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ForumService } from './forum.service';
import { ForumController } from './forum.controller';
import { PrismaService } from '../../common/prisma.service';
import { OptionalJwtAuthGuard } from '../../guards/optional-jwt-auth.guard';
import { AuthModule } from '../auth/auth.module';
import { ForumSnapshotService } from './forum-snapshot.service';
import { ForumReceiptCleanupService } from './forum-receipt-cleanup.service';
import { ForumEventsModule } from './forum-events.module';
import { ForumSearchAdapter } from './forum-search.adapter';
import { ForumSearchService } from './forum-search.service';
import { ForumSearchIndexService } from './forum-search-index.service';
import { ForumSearchConsumer } from './forum-search-consumer.service';
import { ForumHotWorkerService } from './forum-hot-worker.service';
import { ForumInteractionProjectionService } from './forum-interaction-projection.service';
import { ForumViewAggregationService } from './forum-view-aggregation.service';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumProjectionsService } from './forum-projections.service';
import { ForumEventRetentionService } from './forum-event-retention.service';
import { ForumReportsService } from './forum-reports.service';
import { ForumReportsController } from './forum-reports.controller';

@Module({
  imports: [JwtModule.register({}), AuthModule, ForumEventsModule],
  controllers: [ForumController, ForumReportsController],
  providers: [ForumService, ForumSnapshotService, ForumReceiptCleanupService, PrismaService, OptionalJwtAuthGuard,
    ForumSearchAdapter, ForumSearchService, ForumSearchIndexService, ForumSearchConsumer, ForumHotWorkerService,
    ForumInteractionProjectionService, ForumViewAggregationService, ForumSubscriptionsService, ForumProjectionsService, ForumEventRetentionService, ForumReportsService],
  exports: [ForumSnapshotService, ForumSearchService, ForumSearchIndexService, ForumSubscriptionsService, ForumHotWorkerService, ForumViewAggregationService, ForumEventsModule, ForumReportsService],
})
export class ForumModule {}

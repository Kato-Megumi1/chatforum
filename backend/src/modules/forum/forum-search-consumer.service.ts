import { Injectable, OnModuleInit } from '@nestjs/common';
import { ForumEventsService } from './forum-events.service';
import { ForumSearchAdapter } from './forum-search.adapter';
import { ForumSearchIndexService } from './forum-search-index.service';

@Injectable()
export class ForumSearchConsumer implements OnModuleInit {
  constructor(private readonly events: ForumEventsService, private readonly adapter: ForumSearchAdapter,
    private readonly indices: ForumSearchIndexService) {}
  onModuleInit() {
    // No handler when disabled: deliveries remain replayable PENDING, never silently acknowledged.
    if (process.env.FORUM_SEARCH_ENABLED !== 'true' || !this.adapter.configured()) return;
    this.events.register('forum-search-v1', async (event, context) => {
      await this.indices.syncEvent(event);
      await context.transaction(async () => undefined);
    });
  }
}

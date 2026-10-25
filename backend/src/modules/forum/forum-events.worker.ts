import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ForumEventsService } from './forum-events.service';

/** Dedicated forum worker, independent of chat/model/RAG task loops. Disabled unless explicitly configured. */
@Injectable()
export class ForumEventsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ForumEventsWorker.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  private stopped = false;
  constructor(private readonly events: ForumEventsService) {}
  onApplicationBootstrap() {
    if (process.env.FORUM_EVENTS_WORKER_ENABLED !== 'true') return;
    const configured = Number(process.env.FORUM_EVENTS_POLL_MS);
    const interval = Number.isInteger(configured) && configured >= 100 && configured <= 60000 ? configured : 1000;
    this.timer = setInterval(() => this.tick(), interval); this.timer.unref(); this.tick();
  }
  private tick() {
    if (this.stopped || this.current) return;
    const configured = Number(process.env.FORUM_EVENTS_BATCH_SIZE);
    const batch = Number.isInteger(configured) && configured > 0 && configured <= 50 ? configured : 50;
    this.current = this.events.runBatch(batch).then(() => undefined)
      .catch(() => { this.logger.warn('Forum outbox polling delayed; persisted deliveries will be retried'); })
      .finally(() => { this.current = undefined; });
  }
  async onModuleDestroy() {
    this.stopped = true; if (this.timer) clearInterval(this.timer); this.events.stop();
    if (this.current) {
      // Handlers receive cancellation; an uncooperative remote call cannot block application shutdown forever.
      let timeout: NodeJS.Timeout;
      await Promise.race([this.current, new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); timeout.unref(); })]);
      if (timeout) clearTimeout(timeout);
    }
  }
}

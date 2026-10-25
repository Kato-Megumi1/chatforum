import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

/** Receipts are derived 30-minute dedup state, not post history or independent visitor records. */
@Injectable()
export class ForumReceiptCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ForumReceiptCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  constructor(private readonly prisma: PrismaService) {}
  onApplicationBootstrap() {
    // No startup full-table delete; one indexed, bounded batch per interval.
    this.timer = setInterval(() => void this.cleanupExpired(), 5 * 60000); this.timer.unref();
  }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
  async cleanupExpired(now = new Date()) {
    if (this.running || this.stopped) return 0;
    this.running = true;
    try {
      const cutoff = new Date(now.getTime() - 48 * 3600000);
      return await this.prisma.$executeRaw`DELETE FROM post_view_receipts WHERE viewedAt<${cutoff} ORDER BY viewedAt ASC LIMIT 500`;
    } catch { this.logger.warn('Forum receipt cleanup delayed; bounded batch will retry later'); return 0; }
    finally { this.running = false; }
  }
}

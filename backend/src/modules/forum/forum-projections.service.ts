import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { ForumInteractionProjectionService } from './forum-interaction-projection.service';
import { ForumHotWorkerService } from './forum-hot-worker.service';

@Injectable()
export class ForumProjectionsService implements OnModuleInit {
  constructor(private readonly db: PrismaService, private readonly events: ForumEventsService,
    private readonly interactions: ForumInteractionProjectionService, private readonly hot: ForumHotWorkerService) {}
  onModuleInit() {
    this.events.register('forum-projections-v1', (event, context) => context.transaction(async tx => {
      // Continuation pages must not count the original interaction twice.
      if (event.kind !== 'SUBSCRIPTION_SCAN') await this.interactions.projectInTransaction(tx, event);
    }));
    this.hot.setPublishedHook(async (tx, snapshot, previous) => {
      if (!await tx.forumSubscription.findFirst({ where: { enabled: true, kind: 'HOT_RISE', categoryId: snapshot.categoryId }, select: { id: true } })) return;
      // Activation creates a baseline, not a storm of historical "rises".
      if (!previous) return;
      const previousRanks = new Map(previous.rows.map((row,index) => [row.id,index+1]));
      const rising = snapshot.rows.slice(0,20).map((row,index) => ({ ...row, rank: index+1, previousRank: previousRanks.get(row.id) }))
        .filter(row => !row.previousRank || row.previousRank-row.rank >= 5);
      const posts = rising.length ? await tx.post.findMany({ where: { id: { in: rising.map(row => row.id) }, status: 'APPROVED' }, select: { id: true, revision: true } }) : [];
      for (const row of rising) {
        const post = posts.find(post => post.id === row.id); if (!post) continue;
        await this.events.append(tx, { kind: 'HOT_RANK_CHANGED', postId: post.id, postRevision: post.revision,
          payload: { rankingBasis: snapshot.rankingBasis, hours: snapshot.hours, categoryId: snapshot.categoryId,
            rank: row.rank, previousRank: row.previousRank ?? null, score: row.score } });
      }
    });
  }
}

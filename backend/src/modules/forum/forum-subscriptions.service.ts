import { BadRequestException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ForumEvent, Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { currentApprovedToolWrite } from '../tool-runs/tool-run.policy';

export type ForumWatchKind = 'NEW_POSTS' | 'POST_ACTIVITY' | 'HOT_RISE';
export interface ForumWatchInput { kind: ForumWatchKind; categoryId?: number; postId?: number; query?: string;
  hours?: 24 | 168; rankingBasis?: 'published' | 'interaction'; cooldownSeconds?: number; }
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
const eventKinds = new Set(['POST_PUBLISHED', 'POST_APPROVED', 'POST_UPDATED', 'COMMENT_CREATED', 'COMMENT_RESTORED', 'HOT_RANK_CHANGED']);
const uuid = (value: string) => { const h = createHash('sha256').update(value).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };

/** Persistent watches are independent of an open chat, SSE connection or model call.
 * Fan-out continues in bounded, transactional outbox pages, not one giant transaction. */
@Injectable()
export class ForumSubscriptionsService implements OnModuleInit {
  constructor(private readonly db: PrismaService, private readonly events: ForumEventsService) {}
  onModuleInit() { this.events.register('forum-subscriptions-v1', (event, context) => context.transaction(tx => this.deliver(tx, event))); }

  private async active(userId: number, tx: Prisma.TransactionClient = this.db) {
    const proof=currentApprovedToolWrite();
    if(proof){
      if(proof.userId!==userId)throw new ForbiddenException('工具操作权限已改变');
      await tx.$queryRaw`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM conversations WHERE id=${proof.conversationId} AND userId=${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM chat_runs WHERE id=${proof.runId} AND userId=${userId} FOR UPDATE`;
      const user=await tx.user.findFirst({where:{id:userId,status:'ACTIVE',authVersion:proof.authVersion},select:{id:true}});
      const conversation=await tx.conversation.findFirst({where:{id:proof.conversationId,userId,conversationType:'ASSISTANT',
        memoryEpoch:proof.sourceEpoch},select:{id:true}});
      const run=await tx.chatRun.findFirst({where:{id:proof.runId,userId,conversationId:proof.conversationId,
        status:'RUNNING',workerToken:proof.workerToken,leaseUntil:{gt:new Date()}},select:{id:true}});
      if(!user||!conversation||!run)throw new ForbiddenException('工具操作权限、任务或历史已改变');
    }
    if (!await tx.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })) throw new ForbiddenException('账号不可用');
  }
  async list(userId: number) {
    await this.active(userId);
    return this.db.forumSubscription.findMany({ where: { userId }, orderBy: { id: 'desc' }, take: 100,
      select: { id: true, kind: true, filtersJson: true, enabled: true, cooldownSeconds: true, startedAt: true, createdAt: true } });
  }
  private parse(input: ForumWatchInput) {
    if (!input || !['NEW_POSTS','POST_ACTIVITY','HOT_RISE'].includes(input.kind)) throw new BadRequestException('追踪类型无效');
    for (const key of ['categoryId','postId'] as const) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1)) throw new BadRequestException('追踪范围无效');
    const query = input.query?.trim().replace(/\s+/g, ' ') || undefined;
    if (query && (Array.from(query).length < 2 || query.length > 160)) throw new BadRequestException('关键词需要 2～160 个字符');
    const cooldownSeconds = input.cooldownSeconds ?? 3600;
    if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 60 || cooldownSeconds > 86400) throw new BadRequestException('提醒合并间隔应为 1 分钟～24 小时');
    if (input.kind === 'POST_ACTIVITY' && !input.postId || input.kind !== 'POST_ACTIVITY' && input.postId) throw new BadRequestException('帖子追踪范围无效');
    if (input.kind !== 'HOT_RISE' && (input.hours !== undefined || input.rankingBasis !== undefined)) throw new BadRequestException('仅热榜追踪可指定排行窗口');
    if (input.hours !== undefined && ![24,168].includes(input.hours) || input.rankingBasis !== undefined && !['published','interaction'].includes(input.rankingBasis)) throw new BadRequestException('热榜范围无效');
    const filters = { kind: input.kind, categoryId: input.categoryId ?? null, postId: input.postId ?? null, query: query ?? null,
      hours: input.kind === 'HOT_RISE' ? input.hours ?? 24 : null,
      rankingBasis: input.kind === 'HOT_RISE' ? input.rankingBasis ?? 'interaction' : null };
    return { filters, query, cooldownSeconds, filterKey: createHash('sha256').update(JSON.stringify(filters)).digest('hex'),
      anchorKey: query ? Array.from(normalize(query).split(/\s+/)[0]).slice(0,2).join('') : null };
  }
  async create(userId: number, input: ForumWatchInput, conversationId?: number) {
    const parsed = this.parse(input);
    return this.db.$transaction(async tx => {
      await this.active(userId, tx);
      const users = await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR UPDATE`;
      if (!users.length) throw new ForbiddenException('账号不可用');
      if (conversationId && !await tx.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } })) throw new ForbiddenException('会话不可用');
      if (input.categoryId && !await tx.category.findUnique({ where: { id: input.categoryId }, select: { id: true } })) throw new NotFoundException('分类不存在');
      if (input.postId && !await tx.post.findFirst({ where: { id: input.postId, status: 'APPROVED' }, select: { id: true } })) throw new NotFoundException('帖子不可访问');
      const existing = await tx.forumSubscription.findUnique({ where: { userId_filterKey: { userId, filterKey: parsed.filterKey } } });
      // A UI capacity boundary, never a model/task usage quota. Do not silently truncate active watches.
      if (!existing && await tx.forumSubscription.count({ where: { userId } }) >= 100) throw new BadRequestException('追踪列表已满，请先移除不用的追踪');
      return tx.forumSubscription.upsert({ where: { userId_filterKey: { userId, filterKey: parsed.filterKey } },
        create: { userId, conversationId, kind: input.kind, categoryId: input.categoryId, postId: input.postId,
          filterKey: parsed.filterKey, filtersJson: parsed.filters, anchorKey: parsed.anchorKey, cooldownSeconds: parsed.cooldownSeconds },
        update: { enabled: true, cooldownSeconds: parsed.cooldownSeconds, ...(!existing?.enabled ? { startedAt: new Date() } : {}) },
        select: { id: true, kind: true, filtersJson: true, enabled: true, cooldownSeconds: true } });
    });
  }
  async setEnabled(userId: number, id: number, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new BadRequestException('追踪开关无效');
    return this.db.$transaction(async tx => {
      await this.active(userId, tx);
      const item = await tx.forumSubscription.findFirst({ where: { id, userId } });
      if (!item) throw new NotFoundException('追踪不存在');
      await tx.forumSubscription.update({ where: { id }, data: { enabled, ...(enabled && !item.enabled ? { startedAt: new Date() } : {}) } });
      return { ok: true };
    });
  }
  async remove(userId: number, id: number) {
    return this.db.$transaction(async tx=>{
      await this.active(userId,tx);
      await tx.forumSubscription.deleteMany({ where: { id, userId } });
      return { ok: true };
    });
  }

  private async deliver(tx: Prisma.TransactionClient, event: ForumEvent) {
    const envelope = event.payloadJson as any;
    const continuation = event.kind === 'SUBSCRIPTION_SCAN';
    const kind = continuation ? envelope.sourceKind : event.kind;
    if (!eventKinds.has(kind)) return;
    const payload = continuation ? envelope.sourcePayload : envelope;
    const sourceKey = continuation ? envelope.sourceKey : event.eventKey;
    const afterId = continuation ? Number(envelope.afterId) : 0;
    if (!Number.isSafeInteger(afterId) || afterId < 0 || typeof sourceKey !== 'string') throw Error('INVALID_SUBSCRIPTION_PAGE');
    const post = await tx.post.findFirst({ where: { id: event.postId, status: 'APPROVED' }, select: { id: true, revision: true, userId: true, title: true, content: true, categoryId: true } });
    if (!post) return;
    const watchKind: ForumWatchKind = kind === 'HOT_RANK_CHANGED' ? 'HOT_RISE' : kind === 'POST_PUBLISHED' || kind === 'POST_APPROVED' ? 'NEW_POSTS' : 'POST_ACTIVITY';
    const text = normalize(post.title + '\n' + post.content), letters = Array.from(text), anchors = new Set<string>();
    for (let i=0; i<letters.length; i++) { anchors.add(letters[i]); if (i+1<letters.length) anchors.add(letters[i]+letters[i+1]); }
    const where: Prisma.ForumSubscriptionWhereInput = { id: { gt: afterId }, enabled: true, kind: watchKind,
      startedAt: { lte: event.occurredAt }, user: { status: 'ACTIVE' }, userId: event.actorId ? { not: event.actorId } : undefined,
      ...(watchKind === 'POST_ACTIVITY' ? { postId: post.id } : { OR: [{ categoryId: null }, { categoryId: post.categoryId }] }),
    };
    // Pagination covers every candidate, including keyword false positives; no arbitrary audience cap.
    const anchorList = [...anchors], byId = new Map<number, Awaited<ReturnType<typeof tx.forumSubscription.findMany>>[number]>();
    // Very long Unicode text can exceed MySQL's prepared-parameter ceiling if
    // all anchor terms are sent at once. Merge bounded indexed keyset results.
    for (let offset=0; offset<Math.max(1,anchorList.length); offset+=8000) {
      const anchorWhere: Prisma.ForumSubscriptionWhereInput = { OR: [
        ...(offset === 0 ? [{ anchorKey: null }] : []), { anchorKey: { in: anchorList.slice(offset,offset+8000) } }] };
      const part = await tx.forumSubscription.findMany({ where: { ...where, AND: [anchorWhere] }, orderBy: { id: 'asc' }, take: 201 });
      for (const row of part) byId.set(row.id,row);
    }
    const candidates = [...byId.values()].sort((a,b)=>a.id-b.id).slice(0,201);
    for (const candidate of candidates.slice(0,200)) {
      const f = candidate.filtersJson as any;
      if (f.query && !normalize(String(f.query)).split(/\s+/).every(term => text.includes(term))) continue;
      if (watchKind === 'HOT_RISE' && (f.hours !== payload.hours || f.rankingBasis !== payload.rankingBasis ||
        (f.categoryId ?? null) !== (payload.categoryId ?? null))) continue;
      // Lock the watch before its merge-window row: disables, re-enables and competing deliveries serialize.
      await tx.$queryRaw`SELECT id FROM forum_subscriptions WHERE id=${candidate.id} FOR UPDATE`;
      const current = await tx.forumSubscription.findFirst({ where: { id: candidate.id, enabled: true, startedAt: { lte: event.occurredAt }, user: { status: 'ACTIVE' } } });
      if (!current) continue;
      const at = Math.floor(event.occurredAt.getTime() / (current.cooldownSeconds * 1000)) * current.cooldownSeconds * 1000;
      const windowStart = new Date(at), key = { subscriptionId: current.id, windowStart };
      const old = await tx.forumSubscriptionDelivery.findUnique({ where: { subscriptionId_windowStart: key } });
      const samples = (Array.isArray(old?.postIdsJson) ? old.postIdsJson : []) as any[];
      const nextSamples = [{ id: post.id, revision: post.revision }, ...samples.filter(s => s.id !== post.id)].slice(0,10);
      const count = (old?.count || 0) + 1;
      const title = watchKind === 'NEW_POSTS' ? '新帖追踪有更新' : watchKind === 'HOT_RISE' ? '热帖排行有变化' : '关注的帖子有更新';
      const content = `${count} 次更新已合并提醒，点击查看最新可访问帖子`;
      let notificationId = old?.notificationId;
      if (notificationId && await tx.notification.count({ where: { id: notificationId, userId: current.userId } })) {
        await tx.notification.update({ where: { id: notificationId }, data: { title, content, relatedId: post.id, isRead: false } });
      } else notificationId = (await tx.notification.create({ data: { userId: current.userId, type: 'SYSTEM', title, content, relatedId: post.id } })).id;
      await tx.forumSubscriptionDelivery.upsert({ where: { subscriptionId_windowStart: key },
        create: { ...key, userId: current.userId, notificationId, count, postIdsJson: nextSamples },
        update: { notificationId, count, postIdsJson: nextSamples } });
    }
    if (candidates.length > 200) {
      const last = candidates[199].id;
      await this.events.append(tx, { kind: 'SUBSCRIPTION_SCAN', postId: event.postId, postRevision: event.postRevision,
        actorId: event.actorId ?? undefined, occurredAt: event.occurredAt,
        eventKey: uuid(`forum-watch:${sourceKey}:${last}`), payload: { sourceKey, sourceKind: kind,
          sourcePayload: payload || {}, afterId: last } });
    }
  }

  /** No post body/title is persisted in the reminder; every link is re-authorized on read. */
  async notificationTargets(userId: number, ids: number[]) {
    const rows = ids.length ? await this.db.forumSubscriptionDelivery.findMany({ where: { userId, notificationId: { in: ids } }, select: { notificationId: true, postIdsJson: true } }) : [];
    const allIds = [...new Set(rows.flatMap(row => Array.isArray(row.postIdsJson) ? row.postIdsJson.map((s: any) => s.id).filter(Number.isSafeInteger) : []))] as number[];
    const posts = allIds.length ? await this.db.post.findMany({ where: { id: { in: allIds }, status: 'APPROVED' }, select: { id: true, revision: true } }) : [];
    const visible = new Map(posts.map(p => [p.id,p.revision]));
    return new Map(rows.map(row => [row.notificationId, ((row.postIdsJson as any[]) || []).find(s => visible.get(s.id) === s.revision)?.id as number | undefined]));
  }
}

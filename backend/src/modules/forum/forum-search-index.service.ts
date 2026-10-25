import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { ForumSearchAdapter, ForumSearchDocument, ForumSearchError, FORUM_SEARCH_MAPPING_VERSION } from './forum-search.adapter';

const CONTROL_KEY = 'forum-search:control:v1';
const SEARCH_POST_KINDS = ['POST_PUBLISHED', 'POST_UPDATED', 'POST_HIDDEN', 'POST_DELETED', 'POST_APPROVED', 'POST_CREATED', 'POST_STATUS_CHANGED'];
const buildKey = (id: string) => 'forum-search:build:' + id;
type Db = Prisma.TransactionClient;
export interface SearchBuild {
  version: 1; id: string; indexName: string; status: 'BUILDING' | 'READY' | 'PUBLISHING' | 'ACTIVE' | 'RETIRED' | 'FAILED';
  initialized: boolean; maxPostId: number; postCursor: number; scanDone: boolean; startEventId: string; eventCursor: string;
  validatedEventId?: string; expectedCount?: number; createdAt: string; updatedAt: string;
  lease?: { token: string; until: number }; publicationToken?: string; errorCode?: string;
}
interface SearchControl { activeIndex?: string; activeBuildId?: string; candidateId?: string; degraded?: string; }
export interface SearchEvent { id: bigint | string; kind: string; postId: number; postRevision: number; }
const postSelect = { id: true, title: true, content: true, status: true, revision: true, categoryId: true, userId: true,
  createdAt: true, tags: { select: { tagId: true } } } as const;

/** Durable, resumable staging builds. The SQL pointer is the publication truth; alias is a mirror. */
@Injectable()
export class ForumSearchIndexService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ForumSearchIndexService.name);
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly adapter: ForumSearchAdapter) {}
  private state(db: Db = this.prisma) { return (db as any).forumReadModelState; }
  private async control(db: Db = this.prisma): Promise<SearchControl> {
    return (await this.state(db).findUnique({ where: { key: CONTROL_KEY } }))?.payloadJson || {};
  }
  private async build(id: string, db: Db = this.prisma): Promise<SearchBuild> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
    const value = (await this.state(db).findUnique({ where: { key: buildKey(id) } }))?.payloadJson;
    if (!value || value.id !== id || value.version !== 1) throw new ForumSearchError('FORUM_SEARCH_NOT_READY', 409);
    return value;
  }
  private async saveBuild(db: Db, build: SearchBuild) {
    build.updatedAt = new Date().toISOString();
    await this.state(db).upsert({ where: { key: buildKey(build.id) }, create: { key: buildKey(build.id), status: build.status, payloadJson: build },
      update: { status: build.status, payloadJson: build } });
  }
  private async locked<T>(operation: (tx: Db, control: SearchControl) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      await this.state(tx).upsert({ where: { key: CONTROL_KEY }, create: { key: CONTROL_KEY, payloadJson: {} }, update: {} });
      await tx.$queryRaw`SELECT \`key\` FROM forum_read_model_states WHERE \`key\`=${CONTROL_KEY} FOR UPDATE`;
      const control = await this.control(tx), result = await operation(tx, control);
      await this.state(tx).update({ where: { key: CONTROL_KEY }, data: { payloadJson: control } }); return result;
    });
  }
  private async highWater(db: Db = this.prisma) { return String((await (db as any).forumEvent.aggregate({
    where: { kind: { in: SEARCH_POST_KINDS } }, _max: { id: true } }))._max.id ?? 0); }
  private async pendingEvents(db: Db = this.prisma) {
    // Auto-increment ids are NOT commit order. An older transaction can commit after a newer id.
    return (db as any).forumEventDelivery.count({ where: { consumer: 'forum-search-v1', state: { not: 'COMPLETED' },
      event: { kind: { in: SEARCH_POST_KINDS } } } });
  }
  async status() {
    if (!this.adapter.configured()) return { configured: false, activeIndex: null, candidate: null, degraded: 'NOT_CONFIGURED' };
    const control = await this.control();
    const candidate = control.candidateId ? await this.build(control.candidateId) : null;
    const safeCandidate = candidate ? (({ lease: _lease, publicationToken: _publication, ...safe }) => safe)(candidate) : null;
    return { configured: true, enabled: process.env.FORUM_SEARCH_ENABLED === 'true', activeIndex: control.activeIndex ?? null,
      activeBuildId: control.activeBuildId ?? null, candidate: safeCandidate,
      degraded: control.degraded ?? null, mappingVersion: FORUM_SEARCH_MAPPING_VERSION };
  }
  async activeIndex() {
    if (process.env.FORUM_SEARCH_ENABLED !== 'true' || !this.adapter.configured()) throw new ForumSearchError('FORUM_SEARCH_NOT_READY');
    const control = await this.control(); if (!control.activeIndex) throw new ForumSearchError('FORUM_SEARCH_NOT_READY');
    return { indexName: control.activeIndex, buildId: control.activeBuildId, degraded: control.degraded ?? null };
  }
  async markDegraded(code = 'FORUM_SEARCH_UNAVAILABLE') {
    await this.locked(async (_tx, control) => { control.degraded = code; });
  }
  async startBuild(input: { confirmation: string }) {
    if (input?.confirmation !== 'BUILD_FORUM_SEARCH' || !this.adapter.configured()) throw new ForumSearchError('FORUM_SEARCH_NOT_READY', 409);
    const created = await this.locked(async (tx, control) => {
      if (control.candidateId && !['FAILED', 'RETIRED'].includes((await this.build(control.candidateId, tx)).status)) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
      const id = randomUUID(), now = new Date().toISOString(), highWater = await this.highWater(tx);
      const build: SearchBuild = { version: 1, id, indexName: 'chatforum-forum-v-' + Date.now() + '-' + id.slice(0, 8), status: 'BUILDING', initialized: false,
        maxPostId: (await tx.post.aggregate({ _max: { id: true } }))._max.id ?? 0, postCursor: 0, scanDone: false,
        startEventId: highWater, eventCursor: highWater, createdAt: now, updatedAt: now };
      control.candidateId = id; await this.saveBuild(tx, build); return build;
    });
    try {
      await this.adapter.createIndex(created.indexName);
      return await this.locked(async (tx, _control) => { const current = await this.build(created.id, tx); current.initialized = true; await this.saveBuild(tx, current); return current; });
    } catch (error) { await this.fail(created.id); throw error; }
  }
  private async fail(id: string, token?: string) {
    await this.locked(async (tx, control) => { const build = await this.build(id, tx); build.status = 'FAILED';
      if (token && build.lease?.token !== token) return;
      build.errorCode = 'FORUM_SEARCH_UNAVAILABLE'; delete build.lease; await this.saveBuild(tx, build); control.degraded = build.errorCode; });
  }
  private async claim(id: string, allowed: SearchBuild['status'][] = ['BUILDING']) {
    return this.locked(async (tx, _control) => {
      const build = await this.build(id, tx);
      if (!build.initialized || !allowed.includes(build.status) || build.lease?.until > Date.now()) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
      build.lease = { token: randomUUID(), until: Date.now() + 120000 }; await this.saveBuild(tx, build); return build;
    });
  }
  private async checkpoint(id: string, token: string, change: (build: SearchBuild) => void, release = true) {
    return this.locked(async (tx, _control) => { const build = await this.build(id, tx);
      if (build.lease?.token !== token || build.lease.until <= Date.now()) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
      change(build); if (release) delete build.lease; else build.lease.until = Date.now() + 120000;
      await this.saveBuild(tx, build); return build; });
  }
  private document(post: any): ForumSearchDocument {
    const visible = post.status === 'APPROVED';
    return { postId: post.id, revision: post.revision, status: post.status,
      title: visible ? post.title : '', content: visible ? post.content : '', categoryId: post.categoryId,
      userId: post.userId, tagIds: visible ? post.tags.map(tag => tag.tagId) : [], createdAt: post.createdAt.toISOString() };
  }
  private tombstone(event: SearchEvent): ForumSearchDocument {
    return { postId: event.postId, revision: event.postRevision, status: 'DELETED', title: '', content: '',
      categoryId: 0, userId: 0, tagIds: [], createdAt: '1970-01-01T00:00:00.000Z' };
  }
  async syncEvent(event: SearchEvent, targetIndex?: string) {
    if (!SEARCH_POST_KINDS.includes(event.kind)) return;
    if (!Number.isSafeInteger(event.postId) || event.postId < 1 || !Number.isSafeInteger(event.postRevision) || event.postRevision < 1)
      throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
    const control = await this.control(), candidate = control.candidateId ? await this.build(control.candidateId) : null;
    const targets = targetIndex ? [targetIndex] : [...new Set([control.activeIndex,
      candidate?.initialized && ['BUILDING', 'READY', 'PUBLISHING'].includes(candidate.status) ? candidate.indexName : undefined].filter(Boolean))];
    if (!targets.length) throw new ForumSearchError('FORUM_SEARCH_NOT_READY');
    // Never trust an event's title/body/status. A delayed DELETE after a restore reads the newer DB version.
    const post = await this.prisma.post.findUnique({ where: { id: event.postId }, select: postSelect });
    const doc = post ? this.document(post) : this.tombstone(event);
    try { for (const index of targets) await this.adapter.bulk(index, [doc]); }
    catch (error) { await this.markDegraded(); throw error; }
  }
  async runBuildBatch(id: string, limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
    const build = await this.claim(id, ['BUILDING', 'READY']), token = build.lease.token;
    try {
      if (!build.scanDone) {
        const rows = await this.prisma.post.findMany({ where: { id: { gt: build.postCursor, lte: build.maxPostId } },
          orderBy: { id: 'asc' }, take: limit, select: postSelect });
        await this.adapter.bulk(build.indexName, rows.map(post => this.document(post)));
        return await this.checkpoint(id, token, next => { next.postCursor = rows[rows.length - 1]?.id ?? next.maxPostId;
          next.scanDone = rows.length < limit || next.postCursor >= next.maxPostId; });
      }
      const events: SearchEvent[] = await (this.prisma as any).forumEvent.findMany({ where: {
        kind: { in: SEARCH_POST_KINDS },
        deliveries: { some: { consumer: 'forum-search-v1', state: { not: 'COMPLETED' } } } },
        orderBy: { id: 'asc' }, take: limit, select: { id: true, kind: true, postId: true, postRevision: true } });
      for (const [index, event] of events.entries()) { await this.syncEvent(event, build.indexName);
        if (index % 10 === 0) await this.checkpoint(id, token, () => {}, false); }
      return await this.checkpoint(id, token, next => { next.eventCursor = events.length ? String(events[events.length - 1].id) : next.eventCursor;
        if (events.length) { next.status = 'BUILDING'; delete next.validatedEventId; } });
    } catch (error) { if (!(error instanceof ForumSearchError && error.code === 'FORUM_SEARCH_CONFLICT')) await this.fail(id, token); throw error; }
  }
  async validateBuild(id: string) {
    const build = await this.claim(id), token = build.lease.token;
    try {
      if (!build.scanDone || await this.pendingEvents()) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
      await this.adapter.refresh(build.indexName);
      let cursor = 0, visibleCount = 0, repaired = false;
      while (true) {
        const rows = await this.prisma.post.findMany({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 200,
          select: { id: true, revision: true, status: true } });
        if (!rows.length) break;
        const docs = new Map((await this.adapter.documents(build.indexName, rows.map(post => post.id))).map(doc => [doc.postId, doc]));
        const stale = rows.filter(post => !docs.has(post.id) || docs.get(post.id).revision !== post.revision || docs.get(post.id).status !== post.status);
        if (stale.length) { const latest = await this.prisma.post.findMany({ where: { id: { in: stale.map(post => post.id) } }, select: postSelect });
          await this.adapter.bulk(build.indexName, latest.map(post => this.document(post))); repaired = true; }
        visibleCount += rows.filter(post => post.status === 'APPROVED').length; cursor = rows[rows.length - 1].id;
        await this.checkpoint(id, token, () => {}, false);
      }
      // Reverse coverage catches hard-deleted SQL rows even if their low event id committed late.
      const pit = await this.adapter.createPit(build.indexName);
      try {
        let after: Array<string | number> | undefined;
        do {
          const page = await this.adapter.inspectPage(pit, after), live = page.docs.filter(doc => doc.status !== 'DELETED');
          const existing = live.length ? await this.prisma.post.findMany({ where: { id: { in: live.map(doc => doc.postId) } }, select: { id: true } }) : [];
          const ids = new Set(existing.map(post => post.id));
          for (const doc of live.filter(doc => !ids.has(doc.postId))) {
            const deletion = await (this.prisma as any).forumEvent.findFirst({ where: { postId: doc.postId, kind: 'POST_DELETED' }, orderBy: { postRevision: 'desc' } });
            if (!deletion || deletion.postRevision <= doc.revision) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
            await this.adapter.bulk(build.indexName, [this.tombstone(deletion)]); repaired = true;
          }
          await this.checkpoint(id, token, () => {}, false); after = page.after ?? undefined;
        } while (after);
      } finally { await this.adapter.closePit(pit).catch(() => undefined); }
      if (repaired || await this.adapter.count(build.indexName) !== visibleCount || await this.pendingEvents())
        throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
      const observed = await this.highWater();
      return await this.checkpoint(id, token, next => { next.status = 'READY'; next.validatedEventId = observed;
        next.expectedCount = visibleCount; delete next.errorCode; });
    } catch (error) {
      if (error instanceof ForumSearchError && error.code === 'FORUM_SEARCH_CONFLICT') await this.checkpoint(id, token, () => {});
      else await this.fail(id, token);
      throw error;
    }
  }
  async publish(id: string, input: { confirmation: string }) {
    if (input?.confirmation !== id) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
    const build = await this.locked(async (tx, control) => {
      const build = await this.build(id, tx);
      if (control.candidateId !== id || !['READY', 'PUBLISHING'].includes(build.status) || !build.validatedEventId ||
        await this.pendingEvents(tx)) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
      build.status = 'PUBLISHING'; build.publicationToken = randomUUID(); await this.saveBuild(tx, build); return build;
    });
    try {
      // No remove_index action: old indices and in-flight PITs survive. SQL readers keep the old index until commit below.
      await this.adapter.switchAlias(build.indexName);
      return await this.locked(async (tx, control) => {
        const current = await this.build(id, tx);
        if (control.candidateId !== id || current.publicationToken !== build.publicationToken) throw new ForumSearchError('FORUM_SEARCH_CONFLICT', 409);
        if (control.activeBuildId) { const old = await this.build(control.activeBuildId, tx); old.status = 'RETIRED'; await this.saveBuild(tx, old); }
        current.status = 'ACTIVE'; delete current.publicationToken; await this.saveBuild(tx, current);
        control.activeIndex = current.indexName; control.activeBuildId = id; delete control.candidateId; delete control.degraded;
        return current;
      });
    } catch (error) { await this.markDegraded(); throw error; }
  }
  onApplicationBootstrap() {
    if (process.env.FORUM_SEARCH_ENABLED !== 'true' || !this.adapter.configured()) return;
    this.timer = setInterval(() => void this.tick(), 2000); this.timer.unref();
  }
  onModuleDestroy() { this.stopped = true; if (this.timer) clearInterval(this.timer); }
  async tick() {
    if (this.ticking || this.stopped) return; this.ticking = true;
    try { const control = await this.control(); if (!control.candidateId) return; const build = await this.build(control.candidateId);
      if ((build.status === 'BUILDING' || build.status === 'READY' && await this.pendingEvents()) &&
        build.initialized && !(build.lease?.until > Date.now())) await this.runBuildBatch(build.id); }
    catch { this.logger.warn('Forum search build batch deferred; inspect persisted build status'); }
    finally { this.ticking = false; }
  }
}

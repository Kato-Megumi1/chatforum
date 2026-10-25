import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { KnowledgeBase, KnowledgePermission, Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../../common/prisma.service';
import { normalizeUploadName } from '../../common/upload-name';
import configuration from '../../config/configuration';
import { KnowledgeBaseDto } from '../chat/rag.dto';
import { QdrantVectorService } from './qdrant-vector.service';
import { RagModelService, RagUsage, embeddingFingerprint } from './rag-model.service';
import { fusePassages, hasPermission, novelKeywords, novelChapterScope, routeIndex, novelSourceAllowed } from './rag-policy';
import { RagCitation, RagPassage, RagPrincipal, RagSearchDecision } from './rag.types';
import { NovelGraphService } from './novel-graph.service';
import { NOVEL_ENTITIES, NOVEL_GRAPH_VERSION } from './novel-graph.policy';

const docSelect = {
  id: true, logicalId: true, version: true, isCurrent: true, fileName: true, fileType: true,
  fileSize: true, status: true, createdAt: true, visibility: true, chunkCount: true,
} satisfies Prisma.KnowledgeBaseDocumentSelect;

@Injectable()
export class RagService {
  constructor(private readonly prisma: PrismaService, private readonly vectors: QdrantVectorService,
    private readonly models: RagModelService, private readonly graph: NovelGraphService) {}

  async principal(userId: number) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
    if (!user || user.status !== 'ACTIVE') throw new ForbiddenException('账号不可用');
    return user;
  }

  async authorize(id: number, who: RagPrincipal, permission: KnowledgePermission = 'READ') {
    const user = await this.principal(who.userId);
    const kb = await this.prisma.knowledgeBase.findUnique({ where: { id }, include: { acls: true } });
    if (!kb) throw new NotFoundException('小说库不存在');
    const granted = user.role === 'ADMIN' || kb.ownerId === user.id ? 'ADMIN' :
      kb.acls.find(a => a.userId === user.id)?.permission || (kb.visibility === 'PUBLIC' ? 'READ' : undefined);
    if (!hasPermission(granted, permission)) throw new ForbiddenException('没有小说库访问权限');
    return { kb, user, permission: granted };
  }

  private documentWhere(kb: KnowledgeBase, user: { id: number; role: string }): Prisma.KnowledgeBaseDocumentWhereInput {
    return { knowledgeBaseId: kb.id, isDeleted: false,
      ...(user.role === 'ADMIN' || kb.ownerId === user.id ? {} : { OR: [
        { visibility: { in: ['INHERIT', 'PUBLIC'] } }, { ownerId: user.id }, { acls: { some: { userId: user.id } } },
      ] }),
    };
  }

  async createKnowledgeBase(data: KnowledgeBaseDto, who: RagPrincipal) {
    const user = await this.principal(who.userId);
    if (!data.name?.trim()) throw new BadRequestException('请填写小说库名称');
    this.validateChunking(data.chunkSize ?? 500, data.chunkOverlap ?? 50);
    const kb = await this.prisma.knowledgeBase.create({ data: {
      ...data, name: data.name.trim(), ownerId: user.id,
      embeddingModel: configuration().embedding.defaultModel, visibility: data.visibility || 'PRIVATE',
    } });
    return this.getKnowledgeBase(kb.id, who);
  }

  private validateChunking(size: number, overlap: number) {
    if (overlap >= size) throw new BadRequestException('重叠必须小于分块大小');
  }

  async listKnowledgeBases(who: RagPrincipal) {
    const user = await this.principal(who.userId);
    const ids = await this.prisma.knowledgeBase.findMany({
      where: user.role === 'ADMIN' ? {} : { OR: [
        { ownerId: user.id }, { visibility: 'PUBLIC' }, { acls: { some: { userId: user.id } } },
      ] }, select: { id: true }, orderBy: { updatedAt: 'desc' },
    });
    return Promise.all(ids.map(kb => this.getKnowledgeBase(kb.id, who)));
  }

  async getKnowledgeBase(id: number, who: RagPrincipal) {
    const { kb, user, permission } = await this.authorize(id, who);
    const documents = await this.prisma.knowledgeBaseDocument.findMany({
      where: this.documentWhere(kb, user), select: docSelect, orderBy: { version: 'desc' },
    });
    const selectedVersion = routeIndex(kb, user.id);
    const index = selectedVersion === null ? null : await this.prisma.ragIndexVersion.findUnique({
      where: { knowledgeBaseId_version: { knowledgeBaseId: id, version: selectedVersion } }, select: { id: true, status: true },
    });
    const readable = index && ['READY', 'ACTIVE', 'ARCHIVED'].includes(index.status) &&
      !!await this.prisma.knowledgeChunk.findFirst({ where: { indexVersionId: index.id, document: this.documentWhere(kb, user) }, select: { id: true } });
    return {
      id: kb.id, name: kb.name, description: kb.description, visibility: kb.visibility,
      ownerId: kb.ownerId, permission, chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap,
      embeddingModel: kb.embeddingModel, minConfidence: kb.minConfidence, updatedAt: kb.updatedAt,
      activeIndexVersion: kb.activeIndexVersion, candidateIndexVersion: kb.candidateIndexVersion,
      indexCanaryPercent: kb.indexCanaryPercent, documents,
      chatReady: !!readable,
      chatUnavailableReason: readable ? null : !index ? '尚未发布索引，请先上传、构建并发布' : '当前索引没有你可读取的原文',
    };
  }

  async updateKnowledgeBase(id: number, data: KnowledgeBaseDto, who: RagPrincipal) {
    const { kb } = await this.authorize(id, who, 'ADMIN');
    this.validateChunking(data.chunkSize ?? kb.chunkSize, data.chunkOverlap ?? kb.chunkOverlap);
    await this.prisma.knowledgeBase.update({ where: { id }, data });
    return this.getKnowledgeBase(id, who);
  }

  async deleteKnowledgeBase(id: number, who: RagPrincipal) {
    await this.authorize(id, who, 'ADMIN');
    // Revoke access; external files/collections are retained for offline cleanup.
    await this.prisma.knowledgeBase.delete({ where: { id } });
  }

  async setAcl(id: number, userId: number, permission: KnowledgePermission | null, who: RagPrincipal) {
    await this.authorize(id, who, 'ADMIN');
    if (permission) {
      await this.principal(userId);
      return this.prisma.knowledgeBaseAcl.upsert({
        where: { knowledgeBaseId_userId: { knowledgeBaseId: id, userId } },
        create: { knowledgeBaseId: id, userId, permission }, update: { permission },
      });
    }
    return this.prisma.knowledgeBaseAcl.deleteMany({ where: { knowledgeBaseId: id, userId } });
  }

  async addDocument(id: number, file: { originalname: string; buffer: Buffer; size: number; mimetype: string },
    who: RagPrincipal, previousId?: number) {
    await this.authorize(id, who, 'WRITE');
    if (!file?.buffer?.length) throw new BadRequestException('文件不能为空');
    const name = path.basename(normalizeUploadName(file.originalname).replace(/\\/g, '/'));
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!['txt', 'epub', 'pdf'].includes(ext)) throw new BadRequestException('仅支持 TXT / EPUB / PDF');
    if (file.size > 50 * 1024 * 1024) throw new BadRequestException('文件不能超过 50MB');
    const dir = path.resolve(process.cwd(), 'storage/documents', String(id));
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, randomUUID() + '.' + ext);
    await fs.writeFile(filePath, file.buffer, { flag: 'wx' });
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.knowledgeBase.update({ where: { id }, data: { revision: { increment: 1 } } });
        const current = await tx.knowledgeBaseDocument.findFirst({
          where: { knowledgeBaseId: id, isCurrent: true, isDeleted: false },
        });
        if (current && previousId !== current.id) throw new ConflictException('每个角色库仅维护一本小说，请上传该小说的新版本');
        if (!current && previousId) throw new ConflictException('只能替换当前文档版本');
        if (current) await tx.knowledgeBaseDocument.update({ where: { id: current.id }, data: { isCurrent: false } });
        const doc = await tx.knowledgeBaseDocument.create({ data: {
          knowledgeBaseId: id, logicalId: current?.logicalId || randomUUID(), version: current ? current.version + 1 : 1,
          fileName: name, fileType: ext, filePath, fileSize: file.size, mimeType: file.mimetype,
          checksum: createHash('sha256').update(file.buffer).digest('hex'), ownerId: current?.ownerId || who.userId,
          visibility: current?.visibility || 'INHERIT',
        } });
        if (current) {
          const acls = await tx.knowledgeDocumentAcl.findMany({ where: { documentId: current.id } });
          if (acls.length) await tx.knowledgeDocumentAcl.createMany({
            data: acls.map(a => ({ documentId: doc.id, userId: a.userId, permission: a.permission })),
          });
        }
        return { id: doc.id, version: doc.version, status: doc.status,
          message: '版本已保存，请构建并验证新索引后发布' };
      });
    } catch (error) {
      await fs.unlink(filePath).catch(() => undefined);
      throw error;
    }
  }

  private async mutateDocumentVersions(id: number, docId: number, who: RagPrincipal,
    action: (tx: Prisma.TransactionClient, ids: number[]) => Promise<unknown>) {
    await this.authorize(id, who, 'ADMIN');
    return this.prisma.$transaction(async tx => {
      // Same lock as upload: a newly cloned version cannot retain a revoked ACL.
      await tx.knowledgeBase.update({ where: { id }, data: { revision: { increment: 1 } } });
      const doc = await tx.knowledgeBaseDocument.findFirst({ where: { id: docId, knowledgeBaseId: id, isDeleted: false } });
      if (!doc) throw new NotFoundException();
      const versions = await tx.knowledgeBaseDocument.findMany({
        where: { knowledgeBaseId: id, logicalId: doc.logicalId }, select: { id: true },
      });
      return action(tx, versions.map(d => d.id));
    });
  }

  async deleteDocument(id: number, docId: number, who: RagPrincipal) {
    return this.mutateDocumentVersions(id, docId, who, (tx, ids) =>
      tx.knowledgeBaseDocument.updateMany({ where: { id: { in: ids } }, data: { isDeleted: true, isCurrent: false } }));
  }

  async documentAccess(id: number, docId: number, visibility: 'INHERIT' | 'PRIVATE' | 'PUBLIC', who: RagPrincipal) {
    return this.mutateDocumentVersions(id, docId, who, (tx, ids) =>
      tx.knowledgeBaseDocument.updateMany({ where: { id: { in: ids } }, data: { visibility } }));
  }

  async documentAcl(id: number, docId: number, userId: number, permission: KnowledgePermission | null, who: RagPrincipal) {
    return this.mutateDocumentVersions(id, docId, who, async (tx, ids) => {
      for (const documentId of ids) {
        if (permission) await tx.knowledgeDocumentAcl.upsert({
          where: { documentId_userId: { documentId, userId } },
          create: { documentId, userId, permission }, update: { permission },
        });
        else await tx.knowledgeDocumentAcl.deleteMany({ where: { documentId, userId } });
      }
      return null;
    });
  }

  async citation(id: number, chunkId: string, who: RagPrincipal) {
    const { kb, user, permission } = await this.authorize(id, who);
    const chunk = await this.prisma.knowledgeChunk.findFirst({
      where: { id: chunkId, knowledgeBaseId: id, document: this.documentWhere(kb, user) },
      include: { document: true, indexVersion: true },
    });
    if (!chunk || !['READY', 'ACTIVE', 'ARCHIVED'].includes(chunk.indexVersion.status) ||
      (chunk.indexVersion.status === 'READY' && !hasPermission(permission, 'WRITE') &&
        chunk.indexVersion.version !== kb.candidateIndexVersion)) throw new NotFoundException('引用不可访问');
    return { content: chunk.content, ...this.toPassage(chunk, chunk.indexVersion.version).citation };
  }

  async historyPassages(id: number, references: Array<Pick<RagCitation, 'chunkId' | 'documentId' | 'documentVersion' | 'indexVersion'>>,
    who: RagPrincipal, version: number, question: string): Promise<RagPassage[]> {
    if (!version || !references.length) return [];
    const { kb, user } = await this.authorize(id, who);
    const eligible = references.slice(0, 6).filter(c => c.indexVersion === version);
    if (!eligible.length) return [];
    const chunks = await this.prisma.knowledgeChunk.findMany({ where: {
      knowledgeBaseId: id, indexVersion: { version, status: { in: ['READY', 'ACTIVE', 'ARCHIVED'] } },
      document: this.documentWhere(kb, user),
      OR: eligible.map(c => ({ id: c.chunkId, documentId: c.documentId, documentVersion: c.documentVersion })),
    }, include: { document: true } });
    const scope = novelChapterScope(question);
    return chunks.filter(c => (!scope || scope(c.chapter)) && novelSourceAllowed(c.chapter, question))
      .map(c => this.toPassage(c, version));
  }

  async search(id: number, query: string, who: RagPrincipal, topK = 6, usage?: RagUsage,
    options: { graph?: boolean; strategy?: 'balanced' | 'semantic' | 'lexical'; scopeQuery?: string; indexVersion?: number } = {}): Promise<RagSearchDecision> {
    const { kb, user } = await this.authorize(id, who);
    const version = options.indexVersion ?? routeIndex(kb, user.id);
    if (version === null) return { passages: [], confidence: 0, needsExpertReview: true, indexVersion: 0, retrieval: { status: 'no_active_index' } };
    const index = await this.prisma.ragIndexVersion.findUnique({ where: { knowledgeBaseId_version: { knowledgeBaseId: id, version } } });
    if (!index || !['READY', 'ACTIVE', 'ARCHIVED'].includes(index.status)) throw new ConflictException('索引未就绪');
    const docs = await this.prisma.knowledgeBaseDocument.findMany({ where: this.documentWhere(kb, user), select: { id: true } });
    const ids = docs.map(d => d.id);
    if (!ids.length) return { passages: [], confidence: 0, needsExpertReview: true, indexVersion: version, retrieval: { status: 'no_accessible_documents' } };
    const scope = novelChapterScope(options.scopeQuery ?? query);
    let chapters: string[] | undefined;
    if (scope) {
      const labels = await this.prisma.knowledgeChunk.findMany({
        where: { indexVersionId: index.id, documentId: { in: ids }, chapter: { not: null } },
        select: { chapter: true }, distinct: ['chapter'],
      });
      chapters = labels.map(c => c.chapter).filter(scope);
      if (!chapters.length) return { passages: [], confidence: 0, needsExpertReview: true, indexVersion: version, retrieval: { status: 'scope_no_match' } };
    }
    let degraded = false;
    const terms = novelKeywords(query);
    const lexicalQuery = terms.map(t => '"' + t + '"').join(' ');
    const graphEnabled = options.graph !== false && index.graphVersion === NOVEL_GRAPH_VERSION;
    const channels: NonNullable<RagSearchDecision['retrieval']>['channels'] = {
      semantic: 'ok', lexical: terms.length ? 'ok' : 'skipped', graph: graphEnabled ? 'ok' : 'skipped',
    };
    const [semantic, lexical, graphHits] = await Promise.all([
      (async () => {
        const manifest = index.manifest as any;
        if (manifest?.embeddingFingerprint && manifest.embeddingFingerprint !== embeddingFingerprint(manifest.embeddingModel))
          throw new ConflictException('嵌入配置已变化，请构建新索引');
        const [vector] = await this.models.embed([query], manifest?.embeddingModel || kb.embeddingModel, usage);
        const hits = await this.vectors.search(index.collectionName, vector, ids, 30, chapters);
        const chunks = await this.prisma.knowledgeChunk.findMany({
          where: { id: { in: hits.map(h => String(h.id)) }, indexVersionId: index.id,
            document: this.documentWhere(kb, user) }, include: { document: true },
        });
        const byId = new Map(chunks.map(c => [c.id, c]));
        return hits.filter(h => byId.has(String(h.id))).map(h => ({
          ...this.toPassage(byId.get(String(h.id)), version), semanticScore: h.score,
        }));
      })().catch(() => { degraded = true; channels.semantic = 'error'; return [] as RagPassage[]; }),
      (async () => {
        if (!terms.length) return [] as RagPassage[];
        // Only placeholders are interpolated. All query text and IDs are bound values.
        const sql = 'SELECT id, MATCH(content) AGAINST (? IN BOOLEAN MODE) AS relevance FROM knowledge_chunks ' +
          'WHERE indexVersionId = ? AND documentId IN (' + ids.map(() => '?').join(',') + ') ' +
          (chapters ? 'AND chapter IN (' + chapters.map(() => '?').join(',') + ') ' : '') +
          'AND MATCH(content) AGAINST (? IN BOOLEAN MODE) > 0 ORDER BY relevance DESC, id ASC LIMIT 30';
        const hits = await this.prisma.$queryRawUnsafe<Array<{ id: string; relevance: number }>>(
          sql, lexicalQuery, index.id, ...ids, ...(chapters || []), lexicalQuery);
        const chunks = await this.prisma.knowledgeChunk.findMany({
          where: { id: { in: hits.map(h => h.id) }, indexVersionId: index.id,
            document: this.documentWhere(kb, user) }, include: { document: true },
        });
        const byId = new Map(chunks.map(c => [c.id, c]));
        return hits.filter(h => byId.has(h.id)).map(h => ({
          ...this.toPassage(byId.get(h.id), version), lexicalScore: Number(h.relevance),
        }));
      })().catch(() => { degraded = true; channels.lexical = 'error'; return [] as RagPassage[]; }),
      (async () => {
        if (!graphEnabled) return [] as RagPassage[];
        const hits = await this.graph.candidates(index.id, query, this.documentWhere(kb, user), chapters);
        const chunks = await this.prisma.knowledgeChunk.findMany({ where: { id: { in: hits }, indexVersionId: index.id,
          document: this.documentWhere(kb, user) }, include: { document: true } });
        const byId = new Map(chunks.map(c => [c.id, c]));
        return hits.filter(h => byId.has(h)).map((h, i) => ({ ...this.toPassage(byId.get(h), version), graphScore: 1 / (i + 1) }));
      })().catch(() => { degraded = true; channels.graph = 'error'; return [] as RagPassage[]; }),
    ]);
    const sourceQuestion = options.scopeQuery ?? query;
    const allowedSource = (p: RagPassage) => novelSourceAllowed(p.citation.chapter, sourceQuestion);
    const fused = fusePassages(semantic.filter(allowedSource), lexical.filter(allowedSource),
      Math.min(20, Math.max(1, topK)), graphHits.filter(allowedSource), options.strategy);
    const current = await this.authorize(id, who);
    const allowed = await this.prisma.knowledgeChunk.findMany({ where: {
      id: { in: fused.map(p => p.citation.chunkId) }, document: this.documentWhere(current.kb, current.user),
    }, select: { id: true } });
    const allowedIds = new Set(allowed.map(c => c.id));
    const passages = fused.filter(p => allowedIds.has(p.citation.chunkId));
    // Fusion ranks are not probabilities; generation applies evidence sufficiency.
    const confidence = passages.length ? Math.max(0, Math.min(1, passages[0].semanticScore || 0)) : 0;
    return { passages, confidence, needsExpertReview: !passages.length, indexVersion: version, degraded,
      retrieval: { status: 'complete', channels, counts: { semantic: semantic.length, lexical: lexical.length, graph: graphHits.length } },
      ...(graphEnabled ? { graph: { version: NOVEL_GRAPH_VERSION } } : {}) };
  }

  async buildGraph(id: number, version: number, who: RagPrincipal) {
    await this.authorize(id, who, 'ADMIN');
    const index = await this.prisma.ragIndexVersion.findUnique({ where: { knowledgeBaseId_version: { knowledgeBaseId: id, version } } });
    if (!index) throw new NotFoundException();
    return this.graph.buildMentions(index.id);
  }

  async graphView(id: number, who: RagPrincipal) {
    const { kb, user } = await this.authorize(id, who);
    const version = routeIndex(kb, user.id);
    const index = version ? await this.prisma.ragIndexVersion.findUnique({ where: { knowledgeBaseId_version: { knowledgeBaseId: id, version } } }) : null;
    if (!index?.graphVersion) return { version: null, entities: [], facts: [], note: '尚未建立实体提及索引' };
    const chunk = { indexVersionId: index.id, document: this.documentWhere(kb, user) };
    const mentions = await this.prisma.novelEntityMention.groupBy({ by: ['entityKey'], where: { chunk,
      graphVersion: NOVEL_GRAPH_VERSION }, _count: { entityKey: true } });
    const facts = await this.prisma.novelGraphFact.findMany({ where: { chunk, scene: { status: 'READY', graphVersion: NOVEL_GRAPH_VERSION } },
      include: { chunk: { include: { document: true } } }, orderBy: { chunk: { chunkIndex: 'asc' } }, take: 100 });
    return { version: index.graphVersion, indexVersion: version,
      entities: mentions.map(m => ({ key: m.entityKey, name: NOVEL_ENTITIES.find(e => e.key === m.entityKey)?.name || m.entityKey, mentions: m._count.entityKey })),
      facts: facts.map(f => ({ subject: NOVEL_ENTITIES.find(e => e.key === f.subjectKey)?.name || f.subjectKey,
        predicate: f.predicate, target: NOVEL_ENTITIES.find(e => e.key === f.targetKey)?.name || null,
        text: f.objectText, chapter: f.chapter, quote: f.quote, citation: this.toPassage(f.chunk, version).citation })),
      note: '关系按场景渐进抽取，最多展示100条；模型校验不是人工真值。提及数量不是关系强度，卷章不等于持续有效时间。' };
  }

  async graphEvidence(id: number, decision: RagSearchDecision, who: RagPrincipal, usage: RagUsage,
    options: { extractFacts?: boolean } = {}) {
    if (!decision.graph || !decision.passages.length) return [];
    const { kb, user } = await this.authorize(id, who);
    const index = await this.prisma.ragIndexVersion.findUnique({ where: { knowledgeBaseId_version: { knowledgeBaseId: id, version: decision.indexVersion } } });
    if (!index || index.graphVersion !== NOVEL_GRAPH_VERSION) return [];
    // Adjacent context must stay in the same source document, version and chapter.
    const windows = decision.passages.slice(0, 4).filter(p => !!p.citation.chapter).map(p => ({
      documentId: p.citation.documentId, documentVersion: p.citation.documentVersion, chapter: p.citation.chapter,
      chunkIndex: { gte: Math.max(0, p.citation.chunkIndex - 1), lte: p.citation.chunkIndex + 1 },
    }));
    const adjacent = windows.length ? await this.prisma.knowledgeChunk.findMany({ where: { indexVersionId: index.id,
      document: this.documentWhere(kb, user), OR: windows }, include: { document: true }, orderBy: { chunkIndex: 'asc' }, take: 12 }) : [];
    const seen = new Set(decision.passages.map(p => p.citation.chunkId));
    decision.passages.push(...adjacent.filter(c => !seen.has(c.id)).slice(0, Math.max(0, 12 - seen.size)).map(c => this.toPassage(c, decision.indexVersion)));
    // Sort for reading, while preserving the source IDs later used by the answer generator.
    decision.passages.sort((a, b) => a.citation.documentId - b.citation.documentId || a.citation.chunkIndex - b.citation.chunkIndex);
    for (const p of decision.passages) await this.citation(id, p.citation.chunkId, who);
    if (options.extractFacts === false) {
      decision.graph = { version: NOVEL_GRAPH_VERSION, contextChunks: adjacent.filter(c => !seen.has(c.id)).length };
      return []; // Use source windows directly; do not spend two extra model calls before sufficiency is known.
    }
    const result = await this.graph.sceneFacts(index.id, decision.passages, usage);
    for (const p of decision.passages) await this.citation(id, p.citation.chunkId, who);
    decision.graph = { version: NOVEL_GRAPH_VERSION, cached: result.cached, failed: result.failed,
      facts: result.facts.length, contextChunks: adjacent.filter(c => !seen.has(c.id)).length };
    const sourceId = new Map(decision.passages.map((p, i) => [p.citation.chunkId, i + 1]));
    return result.facts.filter(f => sourceId.has(f.chunkId)).map(f => ({
      subject: NOVEL_ENTITIES.find(e => e.key === f.subjectKey)?.name, predicate: f.predicate,
      target: NOVEL_ENTITIES.find(e => e.key === f.targetKey)?.name, fact: f.objectText, quote: f.quote,
      sourceId: sourceId.get(f.chunkId), chapter: f.chapter, speaker: NOVEL_ENTITIES.find(e => e.key === f.speakerKey)?.name,
    }));
  }

  private toPassage(chunk: any, version: number): RagPassage {
    return { content: chunk.content, score: 0,
      citation: { chunkId: chunk.id, documentId: chunk.documentId, documentVersion: chunk.documentVersion,
        fileName: chunk.document.fileName, indexVersion: version, chunkIndex: chunk.chunkIndex,
        page: chunk.page ?? undefined, chapter: chunk.chapter ?? undefined,
        url: '/rag/knowledge-bases/' + chunk.knowledgeBaseId + '/citations/' + chunk.id },
      acl: { visibility: chunk.document.visibility, ownerId: chunk.document.ownerId ?? undefined },
    };
  }

  async review(id: number, question: string, who: RagPrincipal, decision: RagSearchDecision, reason: string) {
    const { kb } = await this.authorize(id, who);
    const existing = await this.prisma.ragReviewTask.findFirst({ where: {
      knowledgeBaseId: id, requesterId: who.userId, question, status: { in: ['PENDING', 'IN_REVIEW'] },
    } });
    if (existing) return existing.id;
    const task = await this.prisma.ragReviewTask.create({ data: {
      knowledgeBaseId: id, requesterId: who.userId, assignedToId: kb.ownerId,
      question, confidence: decision.confidence, reason,
      evidence: decision.passages.map(p => ({ chunkId: p.citation.chunkId })) as Prisma.InputJsonValue,
    } });
    return task.id;
  }

  async reviews(id: number, who: RagPrincipal) {
    const { permission } = await this.authorize(id, who);
    return this.prisma.ragReviewTask.findMany({
      where: { knowledgeBaseId: id, ...(hasPermission(permission, 'WRITE') ? {} : { requesterId: who.userId }) },
      select: { id: true, question: true, reason: true, confidence: true, status: true,
        createdAt: true, expertAnswer: true, requesterId: true },
      orderBy: { createdAt: 'desc' }, take: 100,
    });
  }

  async resolveReview(id: number, taskId: number, answer: string, status: 'RESOLVED' | 'REJECTED', who: RagPrincipal) {
    await this.authorize(id, who, 'WRITE');
    const updated = await this.prisma.ragReviewTask.updateMany({
      where: { id: taskId, knowledgeBaseId: id, status: { in: ['PENDING', 'IN_REVIEW'] } },
      data: { expertAnswer: answer, status, assignedToId: who.userId, resolvedAt: new Date() },
    });
    if (!updated.count) throw new ConflictException('复核任务不存在或已处理');
    return { id: taskId, status };
  }
}

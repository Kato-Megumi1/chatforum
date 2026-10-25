import { ConflictException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, RagIndexVersion } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { PrismaService } from '../../common/prisma.service';
import configuration from '../../config/configuration';
import { EpubChunker } from './eval/epub-chunker';
import { MultiFormatDocumentLoader } from './document.loader';
import { QdrantVectorService } from './qdrant-vector.service';
import { RagService } from './rag.service';
import { RagModelService, newRagUsage, embeddingFingerprint } from './rag-model.service';
import { RagPrincipal } from './rag.types';
import { withModelRuntime } from './model-runtime';
import { recordUsageSnapshot, recordUsageStep, UsageOwner } from '../../common/usage-ledger';

interface Manifest { documentIds: number[]; embeddingModel: string; embeddingFingerprint?: string; chunkSize: number; chunkOverlap: number }

@Injectable()
export class RagIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RagIndexService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(private readonly prisma: PrismaService, private readonly rag: RagService,
    private readonly vectors: QdrantVectorService, private readonly models: RagModelService) {}

  onModuleInit() {
    if (process.env.RAG_WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick().catch(e => this.logger.error(e.message)), 5000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async list(id: number, who: RagPrincipal) {
    await this.rag.authorize(id, who, 'WRITE');
    return this.prisma.ragIndexVersion.findMany({
      where: { knowledgeBaseId: id }, orderBy: { version: 'desc' },
      select: { id: true, version: true, status: true, chunkCount: true, metrics: true,
        error: true, manifest: true, createdAt: true, readyAt: true, activatedAt: true },
    });
  }

  async enqueue(id: number, who: RagPrincipal) {
    await this.rag.authorize(id, who, 'WRITE');
    // Lock the KB row to serialize concurrent uploads and version allocation.
    return this.prisma.$transaction(async tx => {
      const kb = await tx.knowledgeBase.update({ where: { id }, data: { revision: { increment: 1 } } });
      if (await tx.ragIndexVersion.count({ where: { knowledgeBaseId: id, status: 'BUILDING' } }))
        throw new ConflictException('已有构建任务，请等待完成或失败后重试');
      const documents = await tx.knowledgeBaseDocument.findMany({
        where: { knowledgeBaseId: id, isCurrent: true, isDeleted: false }, select: { id: true },
      });
      if (!documents.length) throw new ConflictException('请先上传小说原文');
      const latest = await tx.ragIndexVersion.aggregate({ where: { knowledgeBaseId: id }, _max: { version: true } });
      const version = (latest._max.version || 0) + 1;
      return tx.ragIndexVersion.create({ data: {
        knowledgeBaseId: id, version, collectionName: 'novel_' + id + '_v' + version + '_' + randomUUID().slice(0, 8),
        manifest: { documentIds: documents.map(d => d.id), chunkSize: kb.chunkSize, chunkOverlap: kb.chunkOverlap,
          requestedBy: who.userId, embeddingModel: configuration().embedding.defaultModel,
          embeddingFingerprint: embeddingFingerprint(configuration().embedding.defaultModel),
          chunkerVersion: 'novel-contiguous-v2', retrievalVersion: 'ngram-alias-rrf-v2' },
      }, select: { id: true, version: true, status: true } });
    });
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Abandoned builds are failed, never silently resumed into partially written collections.
      await this.prisma.ragIndexVersion.updateMany({
        where: { status: 'BUILDING', workerToken: { not: null }, leaseUntil: { lt: new Date() } },
        data: { status: 'FAILED', error: '构建进程中断，请重新构建；线上索引未改变' },
      });
      const job = await this.prisma.ragIndexVersion.findFirst({
        where: { status: 'BUILDING', workerToken: null }, orderBy: { createdAt: 'asc' },
      });
      if (!job) return;
      const token = randomUUID();
      const claimed = await this.prisma.ragIndexVersion.updateMany({
        where: { id: job.id, status: 'BUILDING', workerToken: null },
        data: { workerToken: token, leaseUntil: new Date(Date.now() + 180000) },
      });
      if (claimed.count) {
        const owner: UsageOwner = { scope: 'INDEX', sourceId: String(job.id),
          userId: Number.isInteger((job.manifest as any)?.requestedBy) ? (job.manifest as any).requestedBy : null, createdAt: job.createdAt };
        await withModelRuntime(new AbortController().signal, () => this.build(job, token),
          async runtime => { try { await recordUsageSnapshot(this.prisma, owner, runtime); } catch { this.logger.error('Index usage ledger persistence failed'); } },
          (step, index) => recordUsageStep(this.prisma, owner, step, index));
      }
    } finally { this.busy = false; }
  }

  private async heartbeat(id: number, token: string) {
    const result = await this.prisma.ragIndexVersion.updateMany({
      where: { id, status: 'BUILDING', workerToken: token, leaseUntil: { gt: new Date() } },
      data: { leaseUntil: new Date(Date.now() + 180000) },
    });
    if (!result.count) throw new Error('Index build lease lost');
  }

  private async build(job: RagIndexVersion, token: string) {
    const started = Date.now();
    const usage = newRagUsage();
    try {
      const manifest = job.manifest as unknown as Manifest;
      if (!manifest?.documentIds?.length) throw new Error('Missing build manifest');
      if (manifest.embeddingFingerprint && manifest.embeddingFingerprint !== embeddingFingerprint(manifest.embeddingModel))
        throw new Error('Embedding configuration changed; enqueue a new index');
      let count = 0, dimension = 0;
      for (const documentId of manifest.documentIds) {
        await this.heartbeat(job.id, token);
        const doc = await this.prisma.knowledgeBaseDocument.findFirst({
          where: { id: documentId, knowledgeBaseId: job.knowledgeBaseId, isDeleted: false },
        });
        if (!doc) throw new Error('Document was deleted while building');
        const raw = await fs.readFile(doc.filePath);
        if (doc.checksum && createHash('sha256').update(raw).digest('hex') !== doc.checksum)
          throw new Error('Document checksum changed');
        await this.prisma.knowledgeBaseDocument.update({ where: { id: doc.id }, data: { status: 'PROCESSING' } });
        let chunks: Document[];
        if (doc.fileType === 'epub') {
          const chunker = new EpubChunker({ chunkSize: manifest.chunkSize, overlap: manifest.chunkOverlap });
          chunks = chunker.toLangChainDocuments(await chunker.chunk(doc.filePath));
        } else {
          chunks = await new RecursiveCharacterTextSplitter({
            chunkSize: manifest.chunkSize, chunkOverlap: manifest.chunkOverlap,
            separators: ['\n\n', '\n', '。', '！', '？', '；', ' ', ''],
          }).splitDocuments(await MultiFormatDocumentLoader.load(doc.filePath, doc.fileType));
        }
        chunks = chunks.filter(c => c.pageContent.trim().length > 0);
        if (!chunks.length || chunks.length > 50000) throw new Error('Invalid chunk count');
        for (let offset = 0; offset < chunks.length; offset += 16) {
          await this.heartbeat(job.id, token);
          const batch = chunks.slice(offset, offset + 16);
          const embeddings = await this.models.embed(batch.map(c => c.pageContent), manifest.embeddingModel, usage);
          if (!dimension) {
            dimension = embeddings[0].length;
            await this.vectors.ensureCollection(job.collectionName, dimension);
          }
          if (embeddings.some(v => v.length !== dimension)) throw new Error('Embedding dimension mismatch');
          const records = batch.map((chunk, i) => {
            const id = randomUUID();
            const page = Number(chunk.metadata.page);
            const chapter = chunk.metadata.chapterTitle || chunk.metadata.chapter || null;
            return { id, vectorId: id, knowledgeBaseId: job.knowledgeBaseId, indexVersionId: job.id,
              documentId, documentVersion: doc.version, chunkIndex: offset + i, content: chunk.pageContent,
              contentHash: createHash('sha256').update(chunk.pageContent).digest('hex'),
              page: Number.isInteger(page) && page > 0 ? page : null, chapter: chapter ? String(chapter).slice(0, 190) : null,
              metadata: { ...chunk.metadata, source: doc.fileName } as Prisma.InputJsonValue,
            };
          });
          await this.vectors.upsert(job.collectionName, records.map((record, i) => ({
            id: record.id, vector: embeddings[i], payload: {
              knowledgeBaseId: job.knowledgeBaseId, indexVersion: job.version, documentId,
              documentVersion: doc.version, chunkIndex: record.chunkIndex, fileName: doc.fileName,
              content: record.content, page: record.page ?? undefined, chapter: record.chapter ?? undefined,
              visibility: doc.visibility, ownerId: doc.ownerId ?? undefined,
            },
          })));
          await this.prisma.knowledgeChunk.createMany({ data: records });
          count += records.length;
        }
        await this.prisma.knowledgeBaseDocument.update({ where: { id: doc.id },
          data: { status: 'COMPLETED', chunkCount: chunks.length } });
      }
      await this.heartbeat(job.id, token);
      const [vectorCount, dbCount] = await Promise.all([
        this.vectors.count(job.collectionName), this.prisma.knowledgeChunk.count({ where: { indexVersionId: job.id } }),
      ]);
      if (!count || count !== vectorCount || count !== dbCount) throw new Error('Index count validation failed');
      const sample = await this.prisma.knowledgeChunk.findFirst({ where: { indexVersionId: job.id } });
      const [probe] = await this.models.embed([sample.content], manifest.embeddingModel, usage);
      const probeHits = await this.vectors.search(job.collectionName, probe, manifest.documentIds, 5);
      if (!probeHits.length || probeHits[0].score < 0.95) throw new Error('Index retrieval smoke validation failed');
      usage.latencyMs = Date.now() - started;
      const ready = await this.prisma.ragIndexVersion.updateMany({
        where: { id: job.id, status: 'BUILDING', workerToken: token, leaseUntil: { gt: new Date() } },
        data: { status: 'READY', chunkCount: count, readyAt: new Date(),
          metrics: { validated: true, vectorCount, dbCount, dimension, usage: { ...usage } } },
      });
      if (!ready.count) throw new Error('Build lease lost before validation completed');
    } catch (error: any) {
      const ids = (job.manifest as unknown as Manifest)?.documentIds || [];
      await this.prisma.knowledgeBaseDocument.updateMany({ where: { id: { in: ids }, status: 'PROCESSING' }, data: { status: 'FAILED' } });
      this.logger.error('Index ' + job.id + ': ' + error.message);
      await this.prisma.ragIndexVersion.updateMany({
        where: { id: job.id, status: 'BUILDING', workerToken: token },
        data: { status: 'FAILED', error: String(error.message).slice(0, 500), metrics: { usage: { ...usage } } },
      });
    }
  }

  async publish(id: number, version: number, who: RagPrincipal, canaryPercent?: number) {
    await this.rag.authorize(id, who, 'ADMIN');
    if (canaryPercent !== undefined && (!Number.isInteger(canaryPercent) || canaryPercent < 0 || canaryPercent > 100))
      throw new ConflictException('灰度比例必须为 0-100 的整数');
    // Pointer/status changes share one DB transaction. Every request reads that pointer
    // once, and both retrieval branches use the same immutable collection/version.
    return this.prisma.$transaction(async tx => {
      const kb = await tx.knowledgeBase.update({ where: { id }, data: { revision: { increment: 1 } } });
      const index = await tx.ragIndexVersion.findUnique({ where: { knowledgeBaseId_version: { knowledgeBaseId: id, version } } });
      if (!index || !['READY', 'ACTIVE', 'ARCHIVED'].includes(index.status) ||
        !(index.metrics as any)?.validated) throw new ConflictException('只可发布验证通过的索引');
      if (canaryPercent !== undefined) {
        if (!kb.activeIndexVersion || version === kb.activeIndexVersion) throw new ConflictException('先发布基础版本，再灰度新版本');
        return tx.knowledgeBase.update({ where: { id }, data: {
          candidateIndexVersion: canaryPercent > 0 ? version : null, indexCanaryPercent: canaryPercent,
        }, select: { activeIndexVersion: true, candidateIndexVersion: true, indexCanaryPercent: true } });
      }
      await tx.ragIndexVersion.updateMany({ where: { knowledgeBaseId: id, status: 'ACTIVE' }, data: { status: 'ARCHIVED' } });
      await tx.ragIndexVersion.update({ where: { id: index.id }, data: { status: 'ACTIVE', activatedAt: new Date() } });
      return tx.knowledgeBase.update({ where: { id }, data: {
        activeIndexVersion: version, candidateIndexVersion: null, indexCanaryPercent: 0,
      }, select: { activeIndexVersion: true, candidateIndexVersion: true, indexCanaryPercent: true } });
    });
  }
}

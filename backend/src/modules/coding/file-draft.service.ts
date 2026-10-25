import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { codePath, codeText } from './coding.policy';

export const FILE_DRAFT_VERSION = 'file-draft-v1';
export interface FileDraftPointer { draftId: string; revision: number; hash: string; }
export type FileDraftRef = FileDraftPointer;
export interface FileDraftSnapshot extends FileDraftPointer {
  path: string;
  content: string;
  closed: boolean;
  originalQuestion: string;
  conversationEpoch: number;
  reason: string;
}
export type SavedFileDraft = FileDraftSnapshot;
export interface FileDraftScope {
  userId: number;
  conversationId: number;
  runId: string;
  conversationEpoch: number;
  workerToken?: string;
}
type DraftInput = Omit<FileDraftSnapshot, 'conversationEpoch' | 'draftId' | 'revision' | 'hash'>;
export type FileDraftCheckpoint = DraftInput & { baseHash?: string };
interface StoredFileDraft extends DraftInput {
  kind: typeof FILE_DRAFT_VERSION;
  conversationEpoch: number;
  revision: number;
  hash: string;
}

const hashSource = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
function validateSnapshot(value: DraftInput) {
  if (!value || typeof value.path !== 'string' || typeof value.content !== 'string' ||
    typeof value.closed !== 'boolean' || typeof value.originalQuestion !== 'string' || value.originalQuestion.length > 12000 ||
    typeof value.reason !== 'string' || !value.reason || value.reason.length > 80 || /[\x00-\x1f\x7f]/.test(value.reason))
    throw new BadRequestException('文件草稿格式无效');
  codePath(value.path);
  codeText(value.content); // Exact UTF-8 byte limit and credential/NUL checks; never truncate source.
  if (!value.content) throw new BadRequestException('空文件不保存为可继续草稿');
}
function storedDraft(value: unknown): StoredFileDraft | undefined {
  const draft = value as Partial<StoredFileDraft> | null;
  if (!draft || draft.kind !== FILE_DRAFT_VERSION || !Number.isInteger(draft.revision) || draft.revision! < 1 ||
    !Number.isInteger(draft.conversationEpoch) || draft.conversationEpoch! < 0 ||
    typeof draft.hash !== 'string' || !/^[a-f\d]{64}$/.test(draft.hash)) return undefined;
  try { validateSnapshot(draft as DraftInput); } catch { return undefined; }
  if (hashSource(draft.content!) !== draft.hash) return undefined;
  return draft as StoredFileDraft;
}

// Only dedicated model file-channel text enters this service. Reasoning, tool arguments,
// ordinary code examples and source code in public result/metadata are not draft sources.
@Injectable()
export class FileDraftService {
  constructor(private readonly prisma: PrismaService) {}

  private async lockConversation(tx: Prisma.TransactionClient, userId: number, conversationId: number) {
    // Match task admission's lock order. Do not rely on a JOIN optimizer's row-lock order.
    const users = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR UPDATE`;
    if (!users.length) throw new ForbiddenException('文件草稿仅供当前用户的普通AI会话使用');
    const rows = await tx.$queryRaw<Array<{ memoryEpoch: number }>>`
      SELECT memoryEpoch FROM conversations
      WHERE id=${conversationId} AND userId=${userId} AND conversationType='ASSISTANT' FOR UPDATE`;
    if (!rows.length) throw new ForbiddenException('文件草稿仅供当前用户的普通AI会话使用');
    return rows[0].memoryEpoch;
  }

  async checkpoint(scope: FileDraftScope, snapshot: FileDraftCheckpoint): Promise<FileDraftPointer> {
    validateSnapshot(snapshot);
    if (snapshot.baseHash !== undefined && !/^[a-f\d]{64}$/.test(snapshot.baseHash))
      throw new BadRequestException('文件草稿修复版本无效');
    if (!validId(scope.runId) || !Number.isInteger(scope.conversationEpoch) || scope.conversationEpoch < 0)
      throw new BadRequestException('文件草稿来源无效');
    return this.prisma.$transaction(async tx => {
      const epoch = await this.lockConversation(tx, scope.userId, scope.conversationId);
      if (epoch !== scope.conversationEpoch) throw new ConflictException('对话消息已改变，不能保存旧文件草稿');
      const run = await tx.chatRun.findFirst({ where: { id: scope.runId, userId: scope.userId,
        conversationId: scope.conversationId, status: 'RUNNING', leaseUntil: { gt: new Date() },
        ...(scope.workerToken ? { workerToken: scope.workerToken } : {}) }, select: { privateState: true } });
      if (!run) throw new ConflictException('生成任务已结束或租约已失效，未保存草稿');
      const previous = storedDraft(run.privateState);
      if (run.privateState && !previous) throw new ConflictException('文件草稿状态无效，未覆盖原记录');
      const repair = previous && snapshot.closed && snapshot.baseHash === previous.hash;
      if (previous && (previous.conversationEpoch !== epoch || previous.path !== snapshot.path ||
        previous.originalQuestion !== snapshot.originalQuestion ||
        (snapshot.baseHash !== undefined && snapshot.baseHash !== previous.hash) ||
        (previous.closed && !snapshot.closed) || (!snapshot.content.startsWith(previous.content) && !repair)))
        throw new ConflictException('文件草稿已有新版本，未覆盖已保存的内容');
      const hash = hashSource(snapshot.content);
      const revision = previous ? previous.revision + (previous.hash === hash ? 0 : 1) : 1;
      const { baseHash: _repairBase, ...payload } = snapshot;
      const draft: StoredFileDraft = { ...payload, kind: FILE_DRAFT_VERSION, conversationEpoch: epoch, revision, hash };
      const saved = await tx.chatRun.updateMany({ where: { id: scope.runId, userId: scope.userId,
        conversationId: scope.conversationId, status: 'RUNNING', leaseUntil: { gt: new Date() },
        ...(scope.workerToken ? { workerToken: scope.workerToken } : {}) },
      data: { privateState: draft as unknown as Prisma.InputJsonValue } });
      if (!saved.count) throw new ConflictException('生成任务已结束或租约已失效，未保存草稿');
      return { draftId: scope.runId, revision, hash };
    });
  }

  async read(userId: number, conversationId: number, pointer: FileDraftPointer,
    transaction?: Prisma.TransactionClient): Promise<SavedFileDraft> {
    if (!pointer || !validId(pointer.draftId) || !Number.isInteger(pointer.revision) || pointer.revision < 1 ||
      typeof pointer.hash !== 'string' || !/^[a-f\d]{64}$/.test(pointer.hash))
      throw new BadRequestException('文件草稿版本无效');
    const operation = async (tx: Prisma.TransactionClient): Promise<SavedFileDraft> => {
      const epoch = await this.lockConversation(tx, userId, conversationId);
      const run = await tx.chatRun.findFirst({ where: { id: pointer.draftId, userId, conversationId,
        status: { in: ['COMPLETED', 'FAILED', 'CANCELLED'] } }, select: { privateState: true } });
      if (!run) throw new NotFoundException('文件草稿不存在或生成尚未结束');
      const draft = storedDraft(run.privateState);
      if (!draft) throw new NotFoundException('此回答没有可继续的文件草稿');
      if (draft.conversationEpoch !== epoch || draft.revision !== pointer.revision || draft.hash !== pointer.hash)
        throw new ConflictException('文件草稿版本已失效，请刷新后重试');
      const { kind: _privateVersion, ...snapshot } = draft;
      return { ...snapshot, draftId: pointer.draftId };
    };
    // Admission already owns these locks. Reuse its transaction instead of self-deadlocking.
    return transaction ? operation(transaction) : this.prisma.$transaction(operation);
  }
}

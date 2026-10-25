import { BadRequestException, ConflictException, Injectable, NotFoundException, OnModuleDestroy, OnModuleInit, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { ChatRun, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { currentChatModel, resolveChatModel, withChatModel } from './chat-models';
import { AgentExecutorService } from '../agent/agent.executor';
import { NovelAnswerService } from '../agent/novel-answer.service';
import { RagService } from '../agent/rag.service';
import { SkillRegistry } from '../agent/skills';
import { ChatRunDto } from './chat-run.dto';
import { ConversationMemoryService } from '../agent/conversation-memory.service';
import { personaMemoryKey } from '../agent/conversation-memory.policy';
import { positiveSetting, TOKEN_ESTIMATION_VERSION } from '../agent/context-budget';
import { runtimeState, withModelRuntime, performanceSnapshot, markRuntimeFirstToken, setModelStage, PerformanceSnapshot,
  publicPerformanceSnapshot, queuedPerformanceSnapshot, advancePerformanceSnapshot, completedPerformanceSnapshot } from '../agent/model-runtime';
import { assertConversationIdentity } from './conversation-type';
import { recordUsageSnapshot, recordUsageStep, UsageOwner } from '../../common/usage-ledger';
import { ConversationHistoryChangedError, publicRunFailure } from '../agent/model-output.error';
import { CodingService } from '../coding/coding.service';
import { prepareFileTurn } from '../coding/file-turn';
import { responseSkills } from './chat-response-options';
import { FileDraftRef, FileDraftService } from '../coding/file-draft.service';
import { publicFileResume, publicTerminalResult } from './chat-run.events';
import { ToolRunService } from '../tool-runs/tool-run.service';
import { ToolApprovalPendingError } from '../tool-runs/tool-run.policy';

@Injectable()
export class ChatRunService implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly prisma: PrismaService, private readonly novel: NovelAnswerService,
    private readonly rag: RagService, private readonly agent: AgentExecutorService,
    private readonly memory: ConversationMemoryService, private readonly coding: CodingService,
    private readonly fileDrafts?: FileDraftService, @Optional() private readonly toolRuns?: ToolRunService) {}

  onModuleInit() {
    if (process.env.CHAT_WORKER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 1000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.running.values()) controller.abort();
  }

  async create(userId: number, input: ChatRunDto) {
    await this.rag.principal(userId);
    if (!input.question.trim() && !input.attachments?.length && !input.resumeFile) throw new ConflictException('消息或附件不能为空');
    if (input.knowledgeBaseId) {
      const book = await this.rag.getKnowledgeBase(input.knowledgeBaseId, { userId });
      if (!book.chatReady) throw new ConflictException(book.chatUnavailableReason);
    }
    input = { ...input, modelId: resolveChatModel(input.modelId).id };
    if(input.attachments?.length)input.enabledSkills=[...new Set([...(input.enabledSkills||[]),'code_workspace'])];
    return this.prisma.$transaction(async tx => {
      // Short admission lock protects account-wide request ID idempotency across API
      // instances. It is released at enqueue, not held while any model is running.
      await tx.user.update({ where: { id: userId }, data: { updatedAt: new Date() } });
      const existing = await tx.chatRun.findUnique({ where: { userId_requestId: { userId, requestId: input.requestId } } });
      if (existing) {
        if (existing.conversationId !== input.conversationId || !isDeepStrictEqual(existing.input, JSON.parse(JSON.stringify(input))))
          throw new ConflictException('请求编号已用于其他消息');
        return { id: existing.id, status: existing.status };
      }
      await tx.$queryRaw`SELECT id FROM conversations WHERE id=${input.conversationId} AND userId=${userId} FOR UPDATE`;
      const conversation = await tx.conversation.findFirst({ where: { id: input.conversationId, userId } });
      if (!conversation)
        throw new NotFoundException('对话不存在');
      assertConversationIdentity(conversation, input.persona, input.customSystemPrompt);
      if (input.resumeFile) {
        if (conversation.conversationType !== 'ASSISTANT' || input.attachments?.length || input.codingWorkspaceId)
          throw new ConflictException('文件继续仅用于原普通AI会话，不能同时提交新附件');
        if (!this.fileDrafts) throw new ConflictException('文件草稿服务暂不可用');
        await this.fileDrafts.read(userId, input.conversationId, input.resumeFile, tx);
      }
      if (input.codingWorkspaceId) throw new ConflictException('本机目录模式已停用，请刷新页面，通过＋上传文件副本');
      if (input.enabledSkills?.includes('code_workspace') && conversation.conversationType !== 'ASSISTANT')
        throw new ConflictException('附件工具仅供普通AI会话使用');
      if(input.attachments?.length)await this.coding.messageAttachments(tx,input.conversationId,input.attachments);
      // History and attachments are serialized within one conversation. A different
      // conversation/window is independent and may use another worker slot.
      if (await tx.chatRun.count({ where: { userId, conversationId: input.conversationId, status: { in: ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'] } } }))
        throw new ConflictException('本会话已有回答正在生成，请等待或停止');
      return tx.chatRun.create({ data: { userId, conversationId: input.conversationId,
        requestId: input.requestId, input: JSON.parse(JSON.stringify(input)) },
        select: { id: true, status: true } });
    });
  }

  // Discover only current work or the newest recoverable file failure. Never
  // expose the original request/prompt or make recovery create another run.
  async recovery(userId: number, conversationId: number, expectedAuthVersion: number) {
    if (!Number.isSafeInteger(conversationId) || conversationId < 1) throw new BadRequestException('无效的对话编号');
    await this.rag.principal(userId);
    const account = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, authVersion: true } });
    if (!account || account.status !== 'ACTIVE' || account.authVersion !== expectedAuthVersion)
      throw new UnauthorizedException('登录状态已改变，请重新登录');
    const conversation = await this.prisma.conversation.findFirst({ where: { id: conversationId, userId },
      select: { conversationType: true, personaKey: true } });
    if (!conversation) throw new NotFoundException('对话不存在');
    if (!['ASSISTANT', 'ROLEPLAY'].includes(conversation.conversationType)) return [];
    const candidates = await this.prisma.chatRun.findMany({ where: { userId, conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8,
      select: { id: true, status: true, input: true } });
    for (const candidate of candidates) {
      // A newer successful turn supersedes older local failure cards. Completed
      // incomplete-file cards are already part of the real message history.
      if (candidate.status === 'COMPLETED') break;
      try {
        const input = candidate.input as unknown as ChatRunDto;
        assertConversationIdentity(conversation, input.persona, input.customSystemPrompt);
      } catch { continue; }
      const run = await this.get(userId, candidate.id, expectedAuthVersion);
      if (run.status === 'COMPLETED') return [{ id: run.id, status: run.status, createdAt: run.createdAt }];
      if (run.status === 'QUEUED' || run.status === 'RUNNING' || run.status === 'WAITING_APPROVAL')
        return [{ id: run.id, status: run.status, createdAt: run.createdAt }];
      const terminal = publicTerminalResult(run.result);
      if (conversation.conversationType === 'ASSISTANT' && terminal?.ragMetadata?.generation?.resumeFile)
        return [{ id: run.id, status: run.status, result: terminal, progress: run.progress, createdAt: run.createdAt }];
    }
    return [];
  }

  async get(userId: number, id: string, expectedAuthVersion?: number) {
    await this.rag.principal(userId);
    // SSE is long-lived: its original JWT must not remain usable after a password change.
    // Only this reader is closed; the authenticated user's persisted task can finish normally.
    if (expectedAuthVersion !== undefined) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true, authVersion: true } });
      if (!user || user.status !== 'ACTIVE' || user.authVersion !== expectedAuthVersion)
        throw new UnauthorizedException('登录状态已改变，请重新登录');
    }
    const run = await this.prisma.chatRun.findFirst({ where: { id, userId },
      select: { id: true, conversationId: true, status: true, input: true, result: true,
        error: true, usage: true, createdAt: true } });
    if (!run) throw new NotFoundException('生成任务不存在');
    const input = (run.input || {}) as unknown as ChatRunDto;
    let result = run.result as any;
    // Applies to reconnects and polling too; possession of a run ID never bypasses revoked ACL.
    if (input.knowledgeBaseId) {
      await this.rag.authorize(input.knowledgeBaseId, { userId });
      for (const citation of result?.ragMetadata?.citations || [])
        await this.rag.citation(input.knowledgeBaseId, citation.chunkId, { userId });
    }
    if (run.status === 'FAILED' || run.status === 'CANCELLED') {
      result = publicTerminalResult(result);
      // A syntactically valid reference is not authority to read a stale/deleted draft.
      const storedGeneration = result?.ragMetadata?.generation;
      if (storedGeneration) {
        delete storedGeneration.resumeFile;
        if (storedGeneration.fileIncomplete) storedGeneration.canContinue = false;
      }
      // Live SSE polls must not repeatedly load the private source blob. Only a
      // terminal projection needs it, after the status/owner check above.
      const privateRun = this.fileDrafts ? await this.prisma.chatRun.findFirst({ where: {
        id, userId, conversationId: run.conversationId, status: { in: ['FAILED', 'CANCELLED'] } },
      select: { privateState: true } }) : undefined;
      const resumeFile = await this.terminalDraft({ ...run, privateState: privateRun?.privateState }, userId);
      if (resumeFile) result = { ...result, ragMetadata: { generation: { ...storedGeneration,
        truncated: true, fileIncomplete: true, canContinue: true, resumeFile,
        fileFailureReason: run.status === 'CANCELLED' ? 'STOPPED' : storedGeneration?.fileFailureReason || 'WORKER_INTERRUPTED' } } };
    }
    return { id: run.id, status: run.status, result, error: run.error, usage: run.usage, createdAt: run.createdAt,
      progress: run.status === 'QUEUED' ? queuedPerformanceSnapshot(run.createdAt) :
      publicPerformanceSnapshot((run.usage as any)?.progress) };
  }

  private async terminalDraft(run: { id: string; conversationId: number; input: unknown; result: unknown; privateState: unknown }, userId: number) {
    if (!this.fileDrafts) return undefined;
    const state = run.privateState as any, result = run.result as any, input = run.input as any;
    const candidates = [state ? { draftId: run.id, revision: state.revision, hash: state.hash } : undefined,
      result?.ragMetadata?.generation?.resumeFile, input?.resumeFile];
    for (const candidate of candidates) {
      const ref = publicFileResume(candidate);
      if (!ref) continue;
      try {
        const saved = await this.fileDrafts.read(userId, run.conversationId, ref);
        return { draftId: saved.draftId, revision: saved.revision, hash: saved.hash };
      } catch { /* Revoked ownership, changed epoch or invalid source never become a public resume action. */ }
    }
    return undefined;
  }

  async cancel(userId: number, id: string) {
    await this.rag.principal(userId);
    if (!await this.prisma.chatRun.findFirst({ where: { id, userId }, select: { id: true } }))
      throw new NotFoundException('生成任务不存在');
    await this.prisma.chatRun.updateMany({ where: { id, userId, status: { in: ['QUEUED', 'RUNNING', 'WAITING_APPROVAL'] } },
      data: { status: 'CANCELLED', result: { failure: { stage: 'generation', code: 'USER_CANCELLED', message: '回答已停止。' } },
        error: '回答已停止。' } });
    this.running.get(id)?.abort();
    return this.get(userId, id);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.prisma.chatRun.updateMany({ where: { status: 'RUNNING', leaseUntil: { lt: new Date() } },
        data: { status: 'FAILED', result: { failure: { stage: 'generation', code: 'WORKER_INTERRUPTED',
          message: '生成进程中断，请重试。' } }, error: '生成进程中断，请重试。' } });
      await this.toolRuns?.reconcileInterrupted();
      const slots = positiveSetting('CHAT_WORKER_CONCURRENCY', 2, 8) - this.running.size;
      for (let slot = 0; slot < slots; slot++) {
        const run = await this.prisma.chatRun.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } });
        if (!run) break;
        const token = randomUUID();
        const claimed = await this.prisma.chatRun.updateMany({ where: { id: run.id, status: 'QUEUED' },
          data: { status: 'RUNNING', workerToken: token, leaseUntil: new Date(Date.now() + 600000) } });
        if (claimed.count) void this.execute(run, token).catch(() => undefined);
      }
    } finally { this.busy = false; }
  }

  private async execute(run: ChatRun, token: string) {
    const controller = new AbortController();
    let progress: PerformanceSnapshot | undefined;
    let progressAt = Date.now();
    const observe = (value: PerformanceSnapshot) => { progress = value; progressAt = Date.now(); };
    this.running.set(run.id, controller);
    // Cancellation on a different API instance must also stop this worker's provider stream.
    let checking = false;
    const heartbeat = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        const current = await this.prisma.chatRun.findFirst({ where: { id: run.id, status: 'RUNNING',
          workerToken: token, leaseUntil: { gt: new Date() } }, select: { id: true } });
        if (!current) controller.abort();
        else await this.prisma.chatRun.updateMany({ where: { id: run.id, status: 'RUNNING', workerToken: token,
          leaseUntil: { gt: new Date() } }, data: { leaseUntil: new Date(Date.now() + 600000),
            ...(progress ? { usage: { progress: advancePerformanceSnapshot(progress, Date.now() - progressAt) } as unknown as Prisma.InputJsonValue } : {}) } });
      } catch { controller.abort(); } finally { checking = false; }
    }, 1000);
    heartbeat.unref();
    try {
      const request = run.input as unknown as ChatRunDto;
      // The persisted server conversation identity is authoritative, including old queued turns
      // whose clients submitted deepThinking=true for a character or legacy conversation.
      const identity = await this.prisma.conversation.findFirst({ where: { id: run.conversationId, userId: run.userId },
        select: { conversationType: true } });
      const selected = resolveChatModel(request.modelId, { deepThinking: identity?.conversationType === 'ASSISTANT' && request.deepThinking === true,
        webSearch: identity?.conversationType === 'ASSISTANT' && request.webSearch === true });
      // An approval resumes this run but starts new provider calls. Keep accounting
      // append-only per execution attempt, without exposing a worker capability.
      const owner: UsageOwner = { scope: 'CHAT', sourceId: run.id, userId: run.userId, createdAt: run.createdAt, attemptId: randomUUID() };
      await withChatModel(selected, () => withModelRuntime(controller.signal,
        () => this.executeSelected(run, token, runtimeState()!.signal, observe),
        async r => { await this.prisma.chatRun.updateMany({ where: { id: run.id, workerToken: token }, data: {
          usage: JSON.parse(JSON.stringify({ attemptId: owner.attemptId, steps: r.steps, observedTokens: r.observedTokens,
            estimatedUnreportedTokens: r.estimatedUnreportedTokens, estimation: TOKEN_ESTIMATION_VERSION,
            progress: performanceSnapshot(r), latencyMs: Date.now() - r.started })) } });
          try { await recordUsageSnapshot(this.prisma, owner, r); } catch { /* The task snapshot remains repairable. */ }
        }, (step, index) => recordUsageStep(this.prisma, owner, step, index), observe,
        Math.max(0, Date.now() - run.createdAt.getTime())));
    } catch (error) {
      const failure = publicRunFailure(error);
      await this.prisma.chatRun.updateMany({ where: { id: run.id, status: 'RUNNING', workerToken: token },
        data: { status: 'FAILED', result: { failure }, error: failure.message } });
    } finally { clearInterval(heartbeat); controller.abort(); if(this.running.get(run.id)===controller)this.running.delete(run.id); }
  }

  private async executeSelected(run: ChatRun, token: string, signal: AbortSignal, onProgress?: (value: PerformanceSnapshot) => void) {
    let savedDraft: FileDraftRef | undefined;
    try {
      setModelStage('context');
      await this.rag.principal(run.userId);
      const input = { ...run.input as unknown as ChatRunDto };
      const question=input.question.trim() || (input.resumeFile ? '继续完成文件' : '请查看这条消息的附件。');
      const personaSkill = input.persona ? SkillRegistry.getPersonaSkill(input.persona) : undefined;
      const persona = input.persona === 'custom' ? input.customSystemPrompt :
        (personaSkill as any)?.getSystemPrompt?.();
      const personaKey = personaMemoryKey(input.persona, input.customSystemPrompt);
      // Bind file checkpoints to the history epoch BEFORE preparing memory. Reading
      // a newer epoch afterwards must never launder a draft whose source was deleted.
      const draftConversation = this.fileDrafts && personaKey === 'assistant'
        ? await this.prisma.conversation.findFirst({where:{id:run.conversationId,userId:run.userId,
          conversationType:'ASSISTANT'},select:{memoryEpoch:true}}) : undefined;
      const frame = await this.memory.prepare(run.conversationId, run.userId, personaKey,
        persona || '你是 ChatForum 的中文助手，不扮演小说人物。', question);
      if (input.resumeFile) {
        if (!this.fileDrafts || frame.memory.personaKey !== 'assistant') throw new ConflictException('文件草稿不可用于当前会话');
        frame.fileResume = await this.fileDrafts.read(run.userId, run.conversationId, input.resumeFile);
        savedDraft = input.resumeFile;
      }
      if (this.fileDrafts && frame.memory.personaKey === 'assistant') {
        const source = await this.prisma.conversation.findFirst({ where: { id: run.conversationId, userId: run.userId,
          conversationType: 'ASSISTANT' }, select: { memoryEpoch: true } });
        if (!source) throw new ConflictException('文件草稿不可用于当前会话');
        const epoch = frame.fileResume?.conversationEpoch ?? draftConversation?.memoryEpoch;
        if (epoch === undefined || source.memoryEpoch !== epoch || draftConversation?.memoryEpoch !== epoch)
          throw new ConflictException('原对话消息已改变，文件草稿不能沿用旧上下文');
        let checkpointAt = 0;
        frame.saveFileDraft = async (snapshot, force = false) => {
          signal.throwIfAborted();
          if (!force && Date.now() - checkpointAt < 2000) return savedDraft;
          savedDraft = await this.fileDrafts.checkpoint({ userId: run.userId, conversationId: run.conversationId,
            runId: run.id, conversationEpoch: epoch, workerToken: token },
          { ...snapshot, originalQuestion: frame.fileResume?.originalQuestion || question });
          checkpointAt = Date.now();
          return savedDraft;
        };
      }
      input.webSearch = frame.memory.personaKey === 'assistant' && currentChatModel().webSearch === true && input.webSearch === true;
      if (input.codingWorkspaceId) throw new ConflictException('本机目录模式已停用');
      frame.toolScope = { userId: run.userId, conversationId: run.conversationId, runId: run.id, workerToken: token, fileArtifacts: [],
        ...(frame.sourceEpoch !== undefined ? {fileSourceEpoch:frame.sourceEpoch} :
          frame.fileResume ? {fileSourceEpoch:frame.fileResume.conversationEpoch} : {}),
        webSearch: input.webSearch === true, webSources: [], webSearchFailures: [],artifactReviews:[],artifactReviewAttempts:new Map() };
      let skills = responseSkills(input, SkillRegistry.getAllMeta().filter(s => s.enabled && s.isTool !== false).map(s => s.name));
      skills = await prepareFileTurn(frame,this.coding,input.attachments||[],skills,signal);
      if (frame.fileResume) skills = []; // Continue the bound private draft, not a new tool/workspace task.
      let partial = '', flushedAt = 0;
      const onToken = async (text: string) => {
        markRuntimeFirstToken();
        const observed = performanceSnapshot(); if (observed) onProgress?.(observed);
        signal.throwIfAborted(); partial += text;
        if (Date.now() - flushedAt < 120) return;
        await this.rag.principal(run.userId);
        await this.memory.assertCurrentSources(run.userId,run.conversationId,frame);
        if (input.knowledgeBaseId) await this.rag.authorize(input.knowledgeBaseId, { userId: run.userId });
        const saved = await this.prisma.chatRun.updateMany({ where: { id: run.id, status: 'RUNNING',
          workerToken: token, leaseUntil: { gt: new Date() },
          ...(frame.sourceEpoch === undefined ? {} : {conversation:{memoryEpoch:frame.sourceEpoch}}) },
          data: { result: { content: partial } } });
        if (!saved.count) {
          if (frame.sourceEpoch !== undefined && !await this.prisma.conversation.findFirst({where:{id:run.conversationId,
            userId:run.userId,memoryEpoch:frame.sourceEpoch},select:{id:true}})) throw new ConversationHistoryChangedError();
          throw new Error('Run cancelled or lease lost');
        }
        flushedAt = Date.now();
      };
      // A KB supplies optional evidence; it no longer selects a different personality/history engine.
      const answer = await this.novel.answer(input.knowledgeBaseId || 0, question,
        [...frame.history, { role: 'user', content: question }], frame.persona, { userId: run.userId },
        { conversation: frame, delivery: { onToken, signal }, enabledSkills: skills });
      const artifacts = frame.toolScope.fileArtifacts || [];
      // Read-back prevents any client/model forged artifact and rechecks current ownership.
      for (const artifact of artifacts) {
        const change = await this.coding.change(artifact.changeId, frame.toolScope); artifact.path = change.path;
        if(artifact.review?.sourceHash && artifact.review.sourceHash!==createHash('sha256').update(change.after,'utf8').digest('hex'))
          artifact.review={status:'not_reviewed',issues:['文件版本与验收快照不一致，不能使用原验收结论。']};
      }
      setModelStage('delivery');
      const content = answer.content, metadata = { ...answer.metadata, performance: performanceSnapshot(),
        responseOptions: { deepThinking: currentChatModel().deepThinking === true, webSearch: input.webSearch === true },
        ...(input.webSearch === true ? { webSearch: { enabled: true, sources: frame.toolScope.webSources,
          ...(frame.toolScope.webSearchFailures?.length ? { failure: 'SEARCH_UNAVAILABLE' } : {}) } } : {}),
        ...(runtimeState()?.assistantGeneration ? { generation: runtimeState()!.assistantGeneration } : {}),
        ...(artifacts.length ? { fileArtifacts: artifacts } : {}) };
      // Re-check account and citations at delivery, not just at retrieval time.
      signal.throwIfAborted();
      await this.rag.principal(run.userId);
      if (input.knowledgeBaseId && metadata?.citations?.length) {
        for (const citation of metadata.citations)
          await this.rag.citation(input.knowledgeBaseId, citation.chunkId, { userId: run.userId });
      }
      // The completed projection becomes visible atomically with the saved answer, not before.
      metadata.performance = completedPerformanceSnapshot();
      const committed = await this.prisma.$transaction(async tx => {
        await this.memory.assertCurrentSources(run.userId,run.conversationId,frame,tx);
        await tx.conversation.update({ where: { id: run.conversationId }, data: { updatedAt: new Date() } });
        if (frame.sourceEpoch !== undefined && !await tx.conversation.findFirst({where:{id:run.conversationId,
          userId:run.userId,memoryEpoch:frame.sourceEpoch},select:{id:true}})) throw new ConversationHistoryChangedError();
        if (frame.fileResume && !await tx.conversation.findFirst({where:{id:run.conversationId,userId:run.userId,
          conversationType:'ASSISTANT',memoryEpoch:frame.fileResume.conversationEpoch},select:{id:true}}))
          throw new ConflictException('原对话消息已改变，文件草稿不能继续交付');
        if (input.attachments?.length) await this.coding.messageAttachments(tx, run.conversationId, input.attachments);
        if (frame.inlineImages?.length) await this.coding.messageAttachments(tx, run.conversationId, frame.inlineImages.map(f=>({id:f.id,kind:'attachment',revision:f.revision})));
        const done = await tx.chatRun.updateMany({
          where: { id: run.id, status: 'RUNNING', workerToken: token, leaseUntil: { gt: new Date() } },
          data: { status: 'COMPLETED', result: { content, ragMetadata: JSON.parse(JSON.stringify(metadata)) },
            ...(!metadata.generation?.fileIncomplete && artifacts.length ? { privateState: Prisma.DbNull } : {}) },
        });
        if (!done.count) return false; // Cancellation / lost lease must never append an answer.
        await tx.chatMessage.createMany({ data: [
          { conversationId: run.conversationId, role: 'USER', content: input.question || question,
            ...(frame.messageFiles?.current.length || input.resumeFile ? {ragMetadata:JSON.parse(JSON.stringify({
              ...(frame.messageFiles?.current.length?{messageAttachments:frame.messageFiles.current}:{}),
              ...(input.resumeFile?{resumeFile:input.resumeFile}:{})}))} : {}) },
          { conversationId: run.conversationId, role: 'ASSISTANT', content, ragMetadata: JSON.parse(JSON.stringify(metadata)) },
        ] });
        await tx.conversation.update({ where: { id: run.conversationId }, data: { updatedAt: new Date() } });
        return true;
      });
      if (!committed) return;
      setModelStage('completed');
      // Index the completed turn now: a new conversation must not wait for another question
      // in the source conversation before opt-in sharing can see its final reply.
      try { await this.memory.prepare(run.conversationId, run.userId, personaKey, frame.persona, ''); }
      catch { /* Derived cache only. The next preparation repairs it; never retract a saved answer. */ }
    } catch (error) {
      if(error instanceof ToolApprovalPendingError && this.toolRuns && !signal.aborted){
        await this.toolRuns.pause(run.id,token,error.stepId);return;
      }
      const failure = publicRunFailure(error, runtimeState()?.stage);
      await this.prisma.chatRun.updateMany({ where: { id: run.id, status: 'RUNNING', workerToken: token },
        data: { status: 'FAILED', result: JSON.parse(JSON.stringify({ failure, ...(savedDraft ? {ragMetadata:{generation:{
          fileIncomplete:true,truncated:true,canContinue:true,fileFailureReason:'SERVICE_ERROR',resumeFile:savedDraft}}} : {}) })), error:
          signal.aborted ? '回答已停止，请重试' : failure.message } });
    }
  }
}

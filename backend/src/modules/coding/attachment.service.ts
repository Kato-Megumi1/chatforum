import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { RagModelService } from '../agent/rag-model.service';
import { currentChatModel } from '../chat/chat-models';
import { attachmentType, ATTACHMENT_LIMITS, documentPath } from './attachment.policy';
import { parseAttachment } from './attachment-parser';
import { codeText, CODING_LIMITS, replaceExact } from './coding.policy';
import { currentApprovedToolWrite } from '../tool-runs/tool-run.policy';

type Scope = { userId?: number; conversationId?: number; runId?:string; fileSourceEpoch?:number; signal?: AbortSignal; fileQuestionContext?: {question:string;history:Array<{role:string;content:string}>} };
export const isDocumentPath = (path: string) => /\.(pdf|docx|png|jpe?g|webp)$/i.test(path);
const metadata = { id: true, name: true, kind: true, mime: true, bytes: true, pageCount: true, needsVision: true, createdAt: true } as const;

@Injectable()
export class AttachmentService {
  constructor(private readonly prisma: PrismaService, private readonly models: RagModelService) {}
  private async scoped<T>(scope: Scope, fn: (tx: Prisma.TransactionClient, conversationId: number) => Promise<T>): Promise<T> {
    if (!scope.userId || !scope.conversationId) throw new ForbiddenException('需要当前普通 AI 会话');
    return this.prisma.$transaction(async tx => {
      const proof=currentApprovedToolWrite();
      if(proof){
        if(proof.userId!==scope.userId||proof.conversationId!==scope.conversationId)throw new ForbiddenException('工具操作会话已改变');
        await tx.$queryRaw`SELECT id FROM users WHERE id=${scope.userId} FOR UPDATE`;
        if(!await tx.user.findFirst({where:{id:scope.userId,status:'ACTIVE',authVersion:proof.authVersion},select:{id:true}}))
          throw new ForbiddenException('工具操作账号权限已改变');
      }
      const rows = await tx.$queryRaw<Array<{id:number;memoryEpoch:number}>>`SELECT c.id,c.memoryEpoch FROM conversations c JOIN users u ON u.id=c.userId
        WHERE c.id=${scope.conversationId} AND c.userId=${scope.userId} AND c.conversationType='ASSISTANT' AND u.status='ACTIVE' FOR UPDATE`;
      if (!rows.length) throw new ForbiddenException('无权访问此会话附件');
      if(scope.fileSourceEpoch!==undefined&&rows[0].memoryEpoch!==scope.fileSourceEpoch)throw new ConflictException('原对话消息已改变，不能使用旧附件');
      if(proof){
        await tx.$queryRaw`SELECT id FROM chat_runs WHERE id=${proof.runId} AND userId=${scope.userId} FOR UPDATE`;
        if(rows[0].memoryEpoch!==proof.sourceEpoch||!await tx.chatRun.findFirst({where:{id:proof.runId,userId:scope.userId,
          conversationId:scope.conversationId,status:'RUNNING',workerToken:proof.workerToken,leaseUntil:{gt:new Date()}},select:{id:true}}))
          throw new ConflictException('附件工具任务已停止或历史已改变');
      }
      return fn(tx, scope.conversationId!);
    });
  }
  async upload(name: string, data: Buffer, scope: Scope) {
    const type = attachmentType(name, data);
    await this.scoped(scope, async tx => { if (await tx.chatAttachment.findFirst({ where: { conversationId: scope.conversationId, name } })) throw new ConflictException('同名原件已存在，请重命名后上传'); });
    const extracted = await parseAttachment({ operation: 'extract', kind: type.kind, data }, scope.signal);
    scope.signal?.throwIfAborted();
    return this.scoped(scope, async (tx, conversationId) => {
      const totals = await tx.chatAttachment.aggregate({ where: { conversationId }, _count: true, _sum: { bytes: true } });
      if (totals._count >= ATTACHMENT_LIMITS.files || (totals._sum.bytes || 0) + data.length > ATTACHMENT_LIMITS.totalBytes)
        throw new BadRequestException('会话最多20个图片/文档、合计100MB');
      if (await tx.chatAttachment.findFirst({ where: { conversationId, name } })) throw new ConflictException('同名原件已存在');
      return tx.chatAttachment.create({ data: { conversationId, name, ...type, bytes: data.length, data, ...extracted }, select: metadata });
    });
  }
  async original(id: number, scope: Scope) {
    return this.scoped(scope, async (tx, conversationId) => {
      const file = await tx.chatAttachment.findFirst({ where: { id, conversationId }, select: { name: true, data: true, mime: true } });
      if (!file) throw new NotFoundException('附件不存在');
      return { name: file.name, mime: file.mime, data: Buffer.from(file.data) };
    });
  }
  async imageInput(id: number, scope: Scope) {
    if (currentChatModel().id !== 'qwen3.8-max') throw new BadRequestException('当前模型不支持图像输入；未自动切换模型');
    const file = await this.scoped(scope, (tx, conversationId) => tx.chatAttachment.findFirst({where:{id,conversationId,kind:'image'},select:{data:true}}));
    if (!file) throw new NotFoundException('图片已删除或不可访问');
    const rendered = await parseAttachment({operation:'render',kind:'image',data:Buffer.from(file.data)},scope.signal);
    await this.scoped(scope, async (tx, conversationId) => {if(!await tx.chatAttachment.count({where:{id,conversationId,kind:'image'}}))throw new NotFoundException('图片已删除');});
    return `data:image/jpeg;base64,${Buffer.from(rendered.data).toString('base64')}`;
  }
  async read(args: {path:string;page?:number;startLine?:number;query?:string}, scope: Scope) {
    const name = documentPath(args.path);
    const file = await this.scoped(scope, (tx, conversationId) => tx.chatAttachment.findFirst({ where: { conversationId, name }, select: { ...metadata, pages: true } }));
    if (!file) throw new NotFoundException('附件不存在，请先 list');
    const page = args.page || 1, pages = file.pages as Array<{page:number;text:string}>;
    if (page > Math.max(1, file.pageCount)) throw new BadRequestException('页码超出附件范围');
    const text = pages.find(p => p.page === page)?.text || '';
    if (file.kind === 'image' || (file.kind === 'pdf' && text.trim().length < 15)) {
      if (currentChatModel().id !== 'qwen3.8-max') return { path: name, revision: 1, page, needsVision: true, error: 'VISION_MODEL_REQUIRED', selectedModelId:currentChatModel().id, requiredModelId:'qwen3.8-max', note: '当前所选模型不支持图像输入；这是能力限制，不是图片没有文字，不能声称已识别。需用户切换，不自动更换模型。' };
      const original = await this.original(file.id, scope);
      const rendered = await parseAttachment({ operation: 'render', kind: file.kind, data: original.data, page }, scope.signal);
      const question = scope.fileQuestionContext ? JSON.stringify({
        task:'按本轮问题及原有任务理解当前图片；继续/重试承接历史用户要求，不把识图默认改成OCR。历史回复可能读错，依据眼前图片重新判断。',
        file:name,page,...scope.fileQuestionContext,readQuestion:args.query,
      }) : args.query || '描述这张图的主要视觉内容和可辨认对象；有文字时可辅助理解，但没有文字不等于图片无法理解。看不清的部分明确说明。';
      const content = await this.models.vision(Buffer.from(rendered.data), file.kind === 'image' ? 'image/jpeg' : 'image/png', question, scope.signal);
      await this.scoped(scope, async tx => { if (!await tx.chatAttachment.count({where:{id:file.id,conversationId:scope.conversationId}})) throw new NotFoundException('附件已删除'); });
      return { path: name, revision: 1, page, content, source: 'vision', transcription: 'model_interpreted', nextPage: page < file.pageCount ? page + 1 : null };
    }
    const lines = text.split('\n'), start = (args.startLine || 1) - 1;
    let content = '', end = start;
    while (end < lines.length && end < start + 120) { const line = `${end + 1}: ${lines[end]}\n`; if (content.length + line.length > 12000) break; content += line; end++; }
    if (start < lines.length && end === start) return { path: name, revision: 1, page, error: 'LINE_TOO_LONG', note: '单行过长，无法完整读取；请拆分文档。不得声称已读全文' };
    return { path: name, revision: 1, page: file.kind === 'pdf' ? page : null, content, totalLines: lines.length,
      nextLine: end < lines.length ? end + 1 : null, nextPage: page < file.pageCount ? page + 1 : null,
      note: file.kind === 'docx' ? 'Word正文与表格文字提取，不含内嵌图片和排版；page不代表Word实际分页' : 'PDF文字层提取，复杂表格阅读顺序可能不完整' };
  }
  async propose(args: any, scope: Scope) {
    if(scope.runId&&!currentApprovedToolWrite())throw new ForbiddenException('任务文档写入必须通过持久化工具步骤');
    const path = documentPath(args.path);
    if (!/\.(pdf|docx)$/i.test(path)) throw new BadRequestException('图片支持查看和原件下载；当前不支持图片修改生成');
    return this.scoped(scope, async (tx, conversationId) => {
      const file = await tx.chatAttachment.findFirst({ where: { conversationId, name: path }, select: { text: true, needsVision: true } });
      if (args.expectedRevision !== (file ? 1 : 0)) throw new ConflictException('请先读取附件；已有原件版本1，新建文件版本0');
      if (!args.description || (args.content !== undefined && (args.oldText !== undefined || args.newText !== undefined))) throw new BadRequestException('需修改说明，完整内容与片段替换不能混用');
      const before = file?.text || '';
      if (file?.needsVision && args.content === undefined) throw new BadRequestException('扫描PDF没有完整文字层，请逐页读取后提供完整的新文档内容');
      const after = codeText(args.content !== undefined ? args.content : file && args.oldText !== undefined && args.newText !== undefined ? replaceExact(before, args.oldText, args.newText) : (()=>{throw new BadRequestException('需要完整content或唯一oldText/newText');})());
      if (await tx.codingChange.count({ where: { conversationId, status: 'PENDING' } }) >= CODING_LIMITS.pendingChanges) throw new ConflictException('请先处理已有待确认修改');
      const change = await tx.codingChange.create({ data: { conversationId, path, before, after, baseRevision: args.expectedRevision, description: args.description } });
      return { proposalId: change.id, path, applied: false, status: 'PENDING', instruction: '新版本可从回答下载；导出为基础段落排版的真实PDF/DOCX，非原版式原位编辑。原件未变，不含原图片/复杂表格样式。' };
    });
  }
  async downloadChange(id: number, scope: Scope) {
    const change = await this.scoped(scope, (tx, conversationId) => tx.codingChange.findFirst({ where: { id, conversationId } }));
    if (!change) throw new NotFoundException('修改版不存在');
    const kind = /\.pdf$/i.test(change.path) ? 'pdf' : /\.docx$/i.test(change.path) ? 'docx' : 'text';
    const data = kind === 'text' ? Buffer.from(change.after) : Buffer.from((await parseAttachment({ operation: 'export', kind, text: change.after }, scope.signal)).data);
    await this.scoped(scope, async tx => { if (!await tx.codingChange.count({where:{id,conversationId:scope.conversationId}})) throw new NotFoundException('修改版已删除'); });
    return { name: change.path.split('/').pop()!, data, mime: kind === 'pdf' ? 'application/pdf' : kind === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/octet-stream' };
  }
}

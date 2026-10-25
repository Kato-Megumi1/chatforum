import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Script } from 'node:vm';
import { PrismaService } from '../../common/prisma.service';
import { attachmentArgs, codePath, codeText, CODING_LIMITS, importFiles, replaceExact } from './coding.policy';
import { AttachmentService, isDocumentPath } from './attachment.service';
import { fileKey, MessageFile, resolveMessageFiles, savedMessageFiles } from './message-attachments';
import { currentApprovedToolWrite } from '../tool-runs/tool-run.policy';

type Scope = { userId?: number; conversationId?: number; fileSourceEpoch?:number; runId?:string };
@Injectable()
export class CodingService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly attachments?: AttachmentService) {}
  private async scoped<T>(scope: Scope, operation: (tx: Prisma.TransactionClient, cid: number) => Promise<T>): Promise<T> {
    if (!scope.userId || !scope.conversationId) throw new ForbiddenException('编程工具需要当前普通AI会话');
    return this.prisma.$transaction(async tx => {
      const proof=currentApprovedToolWrite();
      if(proof){
        if(proof.userId!==scope.userId||proof.conversationId!==scope.conversationId)throw new ForbiddenException('工具操作会话已改变');
        await tx.$queryRaw`SELECT id FROM users WHERE id=${scope.userId} FOR UPDATE`;
        if(!await tx.user.findFirst({where:{id:scope.userId,status:'ACTIVE',authVersion:proof.authVersion},select:{id:true}}))
          throw new ForbiddenException('工具操作账号权限已改变');
      }
      const rows = await tx.$queryRaw<Array<{ id: number; memoryEpoch:number }>>`SELECT c.id,c.memoryEpoch FROM conversations c JOIN users u ON u.id=c.userId
        WHERE c.id=${scope.conversationId} AND c.userId=${scope.userId} AND c.conversationType='ASSISTANT' AND u.status='ACTIVE' FOR UPDATE`;
      if (!rows.length) throw new ForbiddenException('无权访问此代码工作区，角色会话不能使用编程工具');
      if (scope.fileSourceEpoch !== undefined && rows[0].memoryEpoch !== scope.fileSourceEpoch)
        throw new ConflictException('原对话消息已改变，不能使用旧文件草稿');
      if(proof){
        await tx.$queryRaw`SELECT id FROM chat_runs WHERE id=${proof.runId} AND userId=${scope.userId} FOR UPDATE`;
        if(rows[0].memoryEpoch!==proof.sourceEpoch||!await tx.chatRun.findFirst({where:{id:proof.runId,userId:scope.userId,
          conversationId:scope.conversationId,status:'RUNNING',workerToken:proof.workerToken,leaseUntil:{gt:new Date()}},select:{id:true}}))
          throw new ConflictException('文件工具任务已停止或历史已改变');
      }
      return operation(tx, scope.conversationId!);
    });
  }
  async overview(scope: Scope) {
    return this.scoped(scope, async (tx, conversationId) => ({ conversationId, limits: CODING_LIMITS, execution: 'disabled',
      files: [...await tx.codingFile.findMany({ where: { conversationId }, select: { id: true, path: true, revision: true, bytes: true, updatedAt: true }, orderBy: { path: 'asc' } }),
        ...(await tx.chatAttachment.findMany({ where: { conversationId }, select: { id: true, name: true, kind: true, bytes: true, pageCount: true, needsVision: true }, orderBy: { id: 'asc' } })).map(f => ({ ...f, path: f.name, revision: 1 }))],
      changes: await tx.codingChange.findMany({ where: { conversationId }, select: { id: true, path: true, baseRevision: true, description: true, status: true, createdAt: true }, orderBy: { id: 'desc' }, take: 40 }) }));
  }
  private async catalog(tx:Prisma.TransactionClient, conversationId:number):Promise<MessageFile[]> {
    return [...(await tx.codingFile.findMany({where:{conversationId},select:{id:true,path:true,revision:true,bytes:true},orderBy:{path:'asc'}})).map(f=>({...f,kind:'text'})),
      ...(await tx.chatAttachment.findMany({where:{conversationId},select:{id:true,name:true,kind:true,bytes:true},orderBy:{id:'asc'}})).map(f=>({id:f.id,path:f.name,kind:f.kind,bytes:f.bytes,revision:1}))];
  }
  // Caller holds the authenticated conversation lock in task admission; no nested transaction.
  async messageAttachments(tx:Prisma.TransactionClient, conversationId:number, refs:unknown) {
    return resolveMessageFiles(await this.catalog(tx,conversationId),refs);
  }
  async messageContext(scope:Scope, refs:unknown) {
    return this.scoped(scope,async(tx,conversationId)=>{
      const library=await this.catalog(tx,conversationId);
      const current=resolveMessageFiles(library,refs);
      const previous=await tx.chatMessage.findFirst({where:{conversationId,role:'USER',ragMetadata:{path:'$.messageAttachments',not:Prisma.AnyNull}},
        orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true,content:true,ragMetadata:true}});
      const previousFiles=savedMessageFiles(previous?.ragMetadata).map(f=>({...f,
        available:library.some(item=>fileKey(item)===fileKey(f)&&item.revision===f.revision)}));
      return {current,previous:previousFiles.length?{messageId:previous!.id,question:previous!.content,files:previousFiles}:undefined,library};
    });
  }
  async inlineImages(files:MessageFile[], scope:Scope & {signal?:AbortSignal}) {
    if (!this.attachments) throw new BadRequestException('附件服务不可用');
    const images:Array<{id:number;revision:number;path:string;url:string}>=[];
    // Keep the user's complete selected batch; the request context guard rejects oversize input,
    // rather than silently dropping images or routing the remainder through another model.
    for (const file of files.filter(f=>f.kind==='image')) {
      const image = await this.attachments.imageInput(file.id, scope);
      images.push({id:file.id,revision:file.revision,path:file.path,url:image});
    }
    return images;
  }
  async originalText(id:number,revision:number,scope:Scope) {
    return this.scoped(scope,async(tx,conversationId)=>{
      const file=await tx.codingFile.findFirst({where:{id,conversationId}});
      if(!file)throw new NotFoundException('文件已删除');
      if(file.revision!==revision)throw new ConflictException('文件已更新，请到会话文件中下载当前版本');
      return {name:file.path,mime:'application/octet-stream',data:Buffer.from(file.content)};
    });
  }
  async remove(id: number, kind: 'text' | 'attachment', revision: number, scope: Scope) {
    return this.scoped(scope, async (tx, conversationId) => {
      // Same conversation lock as task admission: another tab cannot remove evidence mid-run.
      if (await tx.chatRun.count({ where: { conversationId, status: { in: ['QUEUED', 'RUNNING'] } } }))
        throw new ConflictException('回答正在生成，请先停止生成再删除文件');
      const file = kind === 'text'
        ? await tx.codingFile.findFirst({ where: { id, conversationId }, select: { path: true, revision: true } })
        : await tx.chatAttachment.findFirst({ where: { id, conversationId }, select: { name: true } }).then(f => f ? { path: f.name, revision: 1 } : null);
      // Immutable IDs prevent a stale second delete from deleting a re-uploaded namesake.
      if (!file) return { deleted: false, removedChanges: 0 };
      if (file.revision !== revision) throw new ConflictException('文件已更新，请刷新后再删除');
      const changes = await tx.codingChange.deleteMany({ where: { conversationId, path: file.path } });
      if (kind === 'text') await tx.codingFile.delete({ where: { id } });
      else await tx.chatAttachment.delete({ where: { id } });
      return { deleted: true, removedChanges: changes.count };
    });
  }
  async upload(input: unknown, scope: Scope) {
    const files = importFiles.parse(input).files.map(f => ({ path: codePath(f.path), content: codeText(f.content) }));
    if (new Set(files.map(f => f.path.toLowerCase())).size !== files.length) throw new BadRequestException('上传文件名重复');
    return this.scoped(scope, async (tx, conversationId) => {
      const existing = await tx.codingFile.findMany({ where: { conversationId }, select: { path: true, bytes: true } });
      if (existing.length + files.length > CODING_LIMITS.files || existing.reduce((n, f) => n + f.bytes, 0) + files.reduce((n,f) => n + Buffer.byteLength(f.content), 0) > CODING_LIMITS.workspaceBytes)
        throw new BadRequestException('工作区最多60个文件、总计1MB，请仅上传本次相关代码');
      for (const f of files) if (await tx.codingFile.findUnique({ where: { conversationId_path: { conversationId, path: f.path } } }))
        throw new ConflictException('文件已存在，请通过变更提案修改，不覆盖原文件');
      await tx.codingFile.createMany({ data: files.map(f => ({ ...f, conversationId, bytes: Buffer.byteLength(f.content) })) });
      const saved=await tx.codingFile.findMany({where:{conversationId,path:{in:files.map(f=>f.path)}},select:{id:true,path:true,revision:true,bytes:true}});
      return { imported: files.length, files:files.map(f=>({...saved.find(s=>s.path===f.path)!,kind:'text'})) };
    });
  }
  async export(scope: Scope) {
    return this.scoped(scope, (tx, conversationId) => tx.codingFile.findMany({ where: { conversationId }, select: { path: true, content: true }, orderBy: { path: 'asc' } }));
  }
  async change(id: number, scope: Scope) {
    return this.scoped(scope, async (tx, conversationId) => {
      const proposal = await tx.codingChange.findFirst({ where: { id, conversationId } });
      if (!proposal) throw new NotFoundException('修改建议不存在');
      return proposal;
    });
  }
  /** Restore an immutable tool receipt only after validating the current source.
   * This is not a second propose/apply and never treats a receipt as permission. */
  async restoreToolProposal(id: number, path: string, scope: Scope) {
    return this.scoped(scope, async (tx, conversationId) => {
      const proposal = await tx.codingChange.findFirst({ where: { id, conversationId, path } });
      if (!proposal || proposal.status === 'REJECTED') throw new NotFoundException('文件提案已不可用');
      const document = isDocumentPath(path);
      const file = document
        ? await tx.chatAttachment.findFirst({where:{conversationId,name:path},select:{text:true}})
          .then(row=>row?{content:row.text,revision:1}:null)
        : await tx.codingFile.findUnique({where:{conversationId_path:{conversationId,path}},select:{content:true,revision:true}});
      const valid = proposal.status === 'APPLIED' && !document
        ? file?.revision === proposal.baseRevision + 1 && file.content === proposal.after
        : (file?.revision || 0) === proposal.baseRevision && (file?.content || '') === proposal.before;
      if (!valid) throw new ConflictException('文件来源已更新，旧提案不能恢复为当前结果');
      return {id:proposal.id,path:proposal.path,after:proposal.after};
    });
  }
  async decide(id: number, decision: 'apply' | 'reject', scope: Scope) {
    return this.scoped(scope, async (tx, conversationId) => {
      const proposal = await tx.codingChange.findFirst({ where: { id, conversationId } });
      if (!proposal) throw new NotFoundException('修改建议不存在');
      const status = decision === 'apply' ? 'APPLIED' : 'REJECTED';
      if (proposal.status === status) return { id, status }; // Idempotent double-click/retry.
      if (proposal.status !== 'PENDING') throw new ConflictException('这项修改已经处理');
      if (decision === 'apply') {
        if (isDocumentPath(proposal.path)) throw new BadRequestException('PDF/Word修改版请独立下载，不能覆盖原件；下载后可标为已处理');
        const file = await tx.codingFile.findUnique({ where: { conversationId_path: { conversationId, path: proposal.path } } });
        if ((file?.revision || 0) !== proposal.baseRevision || (file?.content || '') !== proposal.before)
          throw new ConflictException('文件已更新，旧建议不能覆盖新版本；请重新生成修改');
        const content = codeText(proposal.after), bytes = Buffer.byteLength(content);
        const totals = await tx.codingFile.aggregate({ where: { conversationId }, _sum: { bytes: true }, _count: true });
        if ((totals._sum.bytes || 0) - (file?.bytes || 0) + bytes > CODING_LIMITS.workspaceBytes || (!file && totals._count >= CODING_LIMITS.files))
          throw new BadRequestException('工作区容量已满');
        if (file) await tx.codingFile.update({ where: { id: file.id }, data: { content, bytes, revision: { increment: 1 } } });
        else await tx.codingFile.create({ data: { conversationId, path: codePath(proposal.path), content, bytes } });
      }
      await tx.codingChange.update({ where: { id }, data: { status } });
      return { id, status };
    });
  }
  async tool(input: unknown, scope: Scope & {fileQuestionContext?: {question:string;history:Array<{role:string;content:string}>}}) {
    const args = attachmentArgs.parse(input);
    if(args.action==='propose'&&scope.runId&&!currentApprovedToolWrite())throw new ForbiddenException('任务文件写入必须通过持久化工具步骤');
    if (args.action === 'list') return this.overview(scope);
    if (args.path && isDocumentPath(args.path)) {
      if (!this.attachments) throw new BadRequestException('附件服务不可用');
      if (args.action === 'read') return this.attachments.read({ ...args, path: args.path }, scope);
      if (args.action === 'propose') return this.attachments.propose(args, scope);
      if (args.action === 'check') return { supported: false, executed: false, note: '图片/PDF/Word不支持代码语法检查' };
    }
    return this.scoped(scope, async (tx, conversationId) => {
      if (args.action === 'search') {
        if (!args.query) throw new BadRequestException('搜索需要query');
        const documents = await tx.chatAttachment.findMany({ where: { conversationId }, select: { name: true, text: true, needsVision: true } });
        const files = [...await tx.codingFile.findMany({ where: { conversationId }, orderBy: { path: 'asc' } }), ...documents.map(f => ({ path: f.name, content: f.text, revision: 1 }))];
        const matches: Array<{ path: string; revision: number; line: number; text: string }> = [];
        let count = 0;
        for (const file of files) for (const [index, line] of file.content.split('\n').entries()) if (line.toLowerCase().includes(args.query.toLowerCase())) {
          count++; if (matches.length < 30) matches.push({ path: file.path, revision: file.revision, line: index + 1, text: line.slice(0, 240) });
        }
        return { matches, truncated: count > matches.length, totalMatches: count, notSearchedVisually: documents.filter(f => f.needsVision).map(f => f.name), note: '文字层搜索不含图片/扫描页内容；用read按页视觉读取' };
      }
      if (!args.path) throw new BadRequestException('需要文件path');
      const path = codePath(args.path), file = await tx.codingFile.findUnique({ where: { conversationId_path: { conversationId, path } } });
      if (args.action === 'propose') {
        if (args.expectedRevision === undefined || args.expectedRevision !== (file?.revision || 0)) throw new ConflictException('版本不匹配，请先读取文件；新文件版本为0');
        if (!args.description) throw new BadRequestException('需要说明修改目的');
        if (args.content !== undefined && (args.oldText !== undefined || args.newText !== undefined)) throw new BadRequestException('完整文件和片段替换不能混用');
        const before = file?.content || '';
        const after = codeText(args.content !== undefined ? args.content : file && args.oldText !== undefined && args.newText !== undefined
          ? replaceExact(before, args.oldText, args.newText) : (() => { throw new BadRequestException('请提供content或唯一oldText/newText'); })());
        if (file && before === after) throw new BadRequestException('内容未改变');
        const duplicate = await tx.codingChange.findFirst({ where: { conversationId, path, baseRevision: args.expectedRevision, after, status: 'PENDING' }, select: { id: true } });
        if (duplicate) return { proposalId: duplicate.id, path: file?.path || path, status: 'PENDING', applied: false };
        if (await tx.codingChange.count({ where: { conversationId, status: 'PENDING' } }) >= CODING_LIMITS.pendingChanges)
          throw new ConflictException('待确认修改已达20项，请先处理已有建议');
        const proposal = await tx.codingChange.create({ data: { conversationId, path: file?.path || path, baseRevision: args.expectedRevision, before, after, description: args.description } });
        return { proposalId: proposal.id, path: proposal.path, status: 'PENDING', applied: false, instruction: '修改版已保存，可从回答下方下载；原附件未变，未执行代码或测试' };
      }
      if (!file) throw new NotFoundException('文件不存在，请先list查看工作区');
      if (args.action === 'check') {
        if (!/\.(json|js|cjs)$/i.test(path)) return { supported: false, executed: false, note: '仅支持JSON和JS脚本语法检查；未运行项目或测试' };
        try {
          if (/\.json$/i.test(path)) JSON.parse(file.content); else new Script(file.content, { filename: 'workspace-script.js' });
          return { path: file.path, revision: file.revision, syntaxValid: true, executed: false, note: '仅语法检查通过，未验证运行行为、依赖或测试；JS按脚本解析，不支持ESM导入' };
        } catch { return { path: file.path, revision: file.revision, syntaxValid: false, executed: false, note: '语法检查未通过或包含不支持的ESM语法，未执行任何代码' }; }
      }
      const start = (args.startLine || 1) - 1, lines = file.content.split('\n');
      let content = '', end = start;
      while (end < lines.length && end < start + 120 && content.length < 10000) {
        const line = `${end + 1}: ${lines[end]}\n`;
        if (content.length + line.length > 12000) break;
        content += line; end++;
      }
      if (start < lines.length && end === start) return { path: file.path, revision: file.revision, error: 'LINE_TOO_LONG', note: '此行过长，请在网页读取或上传格式化后的文件' };
      return { path: file.path, revision: file.revision, totalLines: lines.length, content, nextLine: end < lines.length ? end + 1 : null };
    });
  }
}

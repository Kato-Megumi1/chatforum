import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChatToolStep, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { normalizedToolArgs, stableToolJson, ToolApprovalPendingError, toolArgsHash, ToolRunScope,
  ToolStepUncertainError, TOOL_POLICY_VERSION, toolPolicy, withToolWriteApproval } from './tool-run.policy';

const MAX_PRIVATE_TOOL_BYTES = 256 * 1024;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const terminal = new Set(['COMPLETED','FAILED','CANCELLED']);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

@Injectable()
export class ToolRunService {
  private readonly inflight = new Map<string, Promise<string>>();
  constructor(private readonly prisma: PrismaService) {}

  private async owned(tx: Prisma.TransactionClient, scope: ToolRunScope, expectedVersion?: number, lock = false) {
    if (!scope.userId || !scope.conversationId || !uuid(scope.runId)) throw new ForbiddenException('工具步骤需要当前会话任务');
    if (lock) {
      await tx.$queryRaw`SELECT id FROM users WHERE id=${scope.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM conversations WHERE id=${scope.conversationId} AND userId=${scope.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM chat_runs WHERE id=${scope.runId} AND userId=${scope.userId} FOR UPDATE`;
    }
    const user = await tx.user.findUnique({where:{id:scope.userId},select:{status:true,authVersion:true}});
    if (!user || user.status !== 'ACTIVE' || expectedVersion !== undefined && expectedVersion !== user.authVersion)
      throw new UnauthorizedException('登录状态已改变，请重新登录');
    const conversation = await tx.conversation.findFirst({where:{id:scope.conversationId,userId:scope.userId},
      select:{memoryEpoch:true,conversationType:true}});
    if (!conversation || conversation.conversationType === 'LEGACY') throw new ForbiddenException('工具会话不可访问');
    if (scope.fileSourceEpoch !== undefined && scope.fileSourceEpoch !== conversation.memoryEpoch)
      throw new ConflictException('对话历史已改变，工具步骤已失效');
    const run = await tx.chatRun.findFirst({where:{id:scope.runId,userId:scope.userId,conversationId:scope.conversationId},
      select:{status:true,workerToken:true,leaseUntil:true}});
    if (!run) throw new NotFoundException('生成任务不存在');
    return { user, conversation, run };
  }

  async invoke(name: string, rawArgs: Record<string, unknown>, scope: ToolRunScope,
    execute: (args: Record<string, unknown>) => Promise<string>, restore?: (result: string) => Promise<void>): Promise<string> {
    const policy = toolPolicy(name, rawArgs), args = normalizedToolArgs(name, rawArgs), hash = toolArgsHash(name, rawArgs);
    const encoded = stableToolJson(args);
    if (Buffer.byteLength(encoded,'utf8') > MAX_PRIVATE_TOOL_BYTES) throw new ConflictException('工具参数超过容量');
    const key = [scope.userId,scope.conversationId,scope.runId,scope.workerToken,scope.fileSourceEpoch,hash].join(':');
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = this.perform(name, args, hash, policy, scope, execute, restore);
    this.inflight.set(key, pending);
    try { return await pending; } finally { if (this.inflight.get(key) === pending) this.inflight.delete(key); }
  }

  private async perform(name: string, args: Record<string, unknown>, hash: string, policy: ReturnType<typeof toolPolicy>, scope: ToolRunScope,
    execute: (args: Record<string, unknown>) => Promise<string>, restore?: (result: string) => Promise<void>) {
    const selected = await this.prisma.$transaction(async tx => {
      const owner = await this.owned(tx,scope,undefined,true);
      if (owner.run.status !== 'RUNNING' || !scope.workerToken || owner.run.workerToken !== scope.workerToken ||
        !owner.run.leaseUntil || owner.run.leaseUntil <= new Date()) throw new ConflictException('生成任务已停止或租约失效');
      if (policy.effect === 'WRITE' && owner.conversation.conversationType !== 'ASSISTANT') throw new ForbiddenException('角色会话不能写入业务数据');
      let step = await tx.chatToolStep.findUnique({where:{runId_stepKey:{runId:scope.runId!,stepKey:hash}}});
      if (!step) {
        const last = await tx.chatToolStep.findFirst({where:{runId:scope.runId!},orderBy:{sequence:'desc'},select:{sequence:true}});
        step = await tx.chatToolStep.create({data:{runId:scope.runId!,stepKey:hash,sequence:(last?.sequence || 0)+1,
          toolName:name,effect:policy.effect,policyVersion:TOOL_POLICY_VERSION,argsHash:hash,arguments:json(args),
          state:policy.approval?'WAITING_APPROVAL':'APPROVED',sourceEpoch:owner.conversation.memoryEpoch,authVersion:owner.user.authVersion}});
      }
      if (step.sourceEpoch !== owner.conversation.memoryEpoch || step.authVersion !== owner.user.authVersion || step.policyVersion !== TOOL_POLICY_VERSION)
        throw new ConflictException('工具步骤的权限或历史版本已失效');
      if (step.state === 'INVALIDATED') throw new ConflictException('工具步骤已失效，不能重新执行');
      if (step.state === 'WAITING_APPROVAL') return { step, pending: true, reuse: false };
      if (step.state === 'REJECTED') return { step, pending: false, reuse: true };
      if (policy.effect === 'WRITE' && step.state === 'SUCCEEDED') return { step, pending: false, reuse: true };
      if (policy.effect === 'WRITE' && ['RUNNING','UNCERTAIN','FAILED'].includes(step.state)) throw new ToolStepUncertainError();
      const updated = await tx.chatToolStep.updateMany({where:{id:step.id,state:step.state},data:{state:'RUNNING',workerToken:scope.workerToken,
        result:Prisma.DbNull,finishedAt:null}});
      if (!updated.count) throw new ConflictException('工具步骤状态已改变');
      return {step,pending:false,reuse:false};
    });
    if (selected.pending) throw new ToolApprovalPendingError(selected.step.id);
    if (selected.reuse) {
      const text = selected.step.state === 'REJECTED' ? JSON.stringify({success:false,data:{code:'USER_REJECTED',message:'用户拒绝了这项操作，未执行。'}})
        : (selected.step.result as any)?.text;
      if (typeof text !== 'string') throw new ToolStepUncertainError();
      if (selected.step.state === 'SUCCEEDED') await restore?.(text);
      return text;
    }
    try {
      const call = () => execute(name === 'manage_forum_tracking' && policy.effect === 'WRITE' ? {...args,confirmed:true}:args);
      const text = policy.effect==='WRITE' ? await withToolWriteApproval({userId:scope.userId!,conversationId:scope.conversationId!,runId:scope.runId!,
        sourceEpoch:selected.step.sourceEpoch,authVersion:selected.step.authVersion,argsHash:hash,workerToken:scope.workerToken!},call) : await call();
      if (typeof text !== 'string' || Buffer.byteLength(text,'utf8') > MAX_PRIVATE_TOOL_BYTES) throw Error('TOOL_RESULT_CAPACITY');
      await this.prisma.$transaction(async tx => {
        const owner = await this.owned(tx,scope,selected.step.authVersion,true);
        if (owner.run.status !== 'RUNNING' || owner.run.workerToken !== scope.workerToken || !owner.run.leaseUntil || owner.run.leaseUntil <= new Date())
          throw new ConflictException('工具完成时任务已停止');
        const saved = await tx.chatToolStep.updateMany({where:{id:selected.step.id,state:'RUNNING',workerToken:scope.workerToken},
          data:{state:'SUCCEEDED',result:json(policy.effect==='READ'?{readCompleted:true,bytes:Buffer.byteLength(text,'utf8')}:{text}),finishedAt:new Date()}});
        if (!saved.count) throw new ConflictException('工具步骤状态已改变');
      });
      return text;
    } catch(error) {
      await this.prisma.chatToolStep.updateMany({where:{id:selected.step.id,state:'RUNNING',workerToken:scope.workerToken},
        data:{state:policy.effect==='WRITE'?'UNCERTAIN':'FAILED',finishedAt:new Date()}});
      throw error;
    }
  }

  // On resumed planning only durable write receipts are context; old reads are
  // deliberately not reused as current forum/file evidence.
  async receipts(scope: ToolRunScope): Promise<string | undefined> {
    return this.prisma.$transaction(async tx => {
      const owner = await this.owned(tx,scope);
      if (owner.run.status !== 'RUNNING' || owner.run.workerToken !== scope.workerToken) throw new ConflictException('任务已停止');
      const rows = await tx.chatToolStep.findMany({where:{runId:scope.runId!,effect:'WRITE',sourceEpoch:owner.conversation.memoryEpoch,
        authVersion:owner.user.authVersion,state:{in:['SUCCEEDED','REJECTED']}},orderBy:{sequence:'desc'},take:20,
        select:{toolName:true,argsHash:true,state:true,result:true,arguments:true}});
      if (!rows.length) return;
      return JSON.stringify({kind:'server_tool_action_receipts',trust:'untrusted_action_records_not_current_evidence',
        note:'这些是同一任务已经完成或拒绝的操作，勿重复写入；读取资料仍须重新读取及复验。',
        receipts:rows.reverse().map(row=>({tool:row.toolName,arguments:row.toolName==='code_workspace'?{
          action:(row.arguments as any)?.action,path:(row.arguments as any)?.path}:row.arguments,argsHash:row.argsHash,state:row.state,
          result:row.state==='SUCCEEDED'?(row.result as any)?.text:undefined}))});
    });
  }

  async pause(runId: string, workerToken: string, stepId: string) {
    const step = await this.prisma.chatToolStep.findFirst({where:{id:stepId,runId,state:'WAITING_APPROVAL'}});
    if (!step) throw new ConflictException('待确认步骤已改变');
    await this.prisma.chatRun.updateMany({where:{id:runId,status:'RUNNING',workerToken},
      data:{status:'WAITING_APPROVAL',result:{content:''},error:null,leaseUntil:null,workerToken:null}});
  }

  async reconcileInterrupted(runIds?: string[]) {
    if(runIds && !runIds.length)return;
    const scope=runIds?{runId:{in:runIds}}:{};
    // A process can die after the external write but before recording its result.
    // Such writes remain explicit uncertainty, never an automatic retry queue.
    await this.prisma.chatToolStep.updateMany({where:{...scope,state:'RUNNING',effect:'WRITE',run:{status:{in:['FAILED','CANCELLED']}}},
      data:{state:'UNCERTAIN',finishedAt:new Date()}});
    await this.prisma.chatToolStep.updateMany({where:{...scope,state:'RUNNING',effect:'READ',run:{status:{in:['FAILED','CANCELLED']}}},
      data:{state:'FAILED',finishedAt:new Date()}});
    await this.prisma.chatToolStep.updateMany({where:{...scope,state:{in:['WAITING_APPROVAL','APPROVED']},run:{status:{in:['FAILED','CANCELLED']}}},
      data:{state:'INVALIDATED',finishedAt:new Date()}});
    const pending=await this.prisma.chatToolStep.findMany({where:{...scope,state:'WAITING_APPROVAL',run:{status:'WAITING_APPROVAL'}},
      orderBy:{updatedAt:'asc'},take:100,select:{id:true,runId:true,sourceEpoch:true,authVersion:true,policyVersion:true,
        run:{select:{conversation:{select:{userId:true,memoryEpoch:true,conversationType:true,user:{select:{status:true,authVersion:true}}}}}}}});
    for(const step of pending){
      const conversation=step.run.conversation;
      if(step.policyVersion===TOOL_POLICY_VERSION&&conversation.conversationType==='ASSISTANT'&&
        conversation.memoryEpoch===step.sourceEpoch&&conversation.user.status==='ACTIVE'&&conversation.user.authVersion===step.authVersion)continue;
      await this.prisma.$transaction(async tx=>{
        // Recheck the invalidating condition in the write, not just a stale scan.
        const invalid:Prisma.ChatRunWhereInput=step.policyVersion!==TOOL_POLICY_VERSION?{}:{conversation:{OR:[{memoryEpoch:{not:step.sourceEpoch}},
          {conversationType:{not:'ASSISTANT'}},{user:{OR:[{status:{not:'ACTIVE'}},{authVersion:{not:step.authVersion}}]}}]}};
        const changed=await tx.chatRun.updateMany({where:{id:step.runId,status:'WAITING_APPROVAL',...invalid},data:{status:'FAILED',
          error:'操作确认已失效，请基于当前会话重新发送。',result:{failure:{stage:'tools',code:'TOOL_APPROVAL_EXPIRED',message:'操作确认已失效，请基于当前会话重新发送。'}}}});
        if(changed.count)await tx.chatToolStep.updateMany({where:{runId:step.runId,state:'WAITING_APPROVAL'},data:{state:'INVALIDATED',finishedAt:new Date()}});
      });
    }
  }

  private present(step: ChatToolStep, runStatus: string) {
    const args = step.arguments as any;
    const labels = {create:'新增追踪',pause:'暂停追踪',resume:'恢复追踪',remove:'取消追踪',list:'查看追踪'};
    const details = Object.fromEntries(['id','kind','postId','categoryId','hours','rankingBasis','cooldownSeconds'].filter(key=>
      ['string','number'].includes(typeof args?.[key])).map(key=>[key,args[key]]));
    if (typeof args?.query === 'string') details.query=args.query.slice(0,160);
    return {id:step.id,runId:step.runId,sequence:step.sequence,toolName:step.toolName,effect:step.effect,
      state:step.state==='RUNNING' && terminal.has(runStatus) && step.effect==='WRITE'?'UNCERTAIN':step.state,
      argsHash:step.argsHash,policyVersion:step.policyVersion,
      title:step.toolName==='manage_forum_tracking'?labels[args?.action] || '论坛追踪操作':step.toolName==='code_workspace'?'保存文件提案':'读取资料',
      details:step.toolName==='manage_forum_tracking'?details:{},createdAt:step.createdAt,finishedAt:step.finishedAt};
  }

  async steps(userId: number, runId: string, expectedVersion: number) {
    const run=await this.prisma.chatRun.findFirst({where:{id:runId,userId},select:{conversationId:true}});
    if(!run)throw new NotFoundException('生成任务不存在');
    return this.prisma.$transaction(async tx=>{
      const owner=await this.owned(tx,{userId,runId,conversationId:run.conversationId},expectedVersion);
      const rows=await tx.chatToolStep.findMany({where:{runId,sourceEpoch:owner.conversation.memoryEpoch,authVersion:owner.user.authVersion},
        orderBy:{sequence:'asc'},take:100});
      return rows.map(step=>this.present(step,owner.run.status));
    });
  }

  async approvals(userId: number, conversationId: number, expectedVersion: number) {
    if(!Number.isSafeInteger(conversationId)||conversationId<1)throw new NotFoundException('对话不存在');
    const user=await this.prisma.user.findUnique({where:{id:userId},select:{status:true,authVersion:true}});
    if(!user||user.status!=='ACTIVE'||user.authVersion!==expectedVersion)throw new UnauthorizedException('登录状态已改变，请重新登录');
    const conversation=await this.prisma.conversation.findFirst({where:{id:conversationId,userId,conversationType:'ASSISTANT'},select:{memoryEpoch:true}});
    if(!conversation)throw new NotFoundException('对话不存在');
    const rows=await this.prisma.chatToolStep.findMany({where:{state:'WAITING_APPROVAL',sourceEpoch:conversation.memoryEpoch,authVersion:user.authVersion,
      run:{userId,conversationId,status:'WAITING_APPROVAL'}},orderBy:{createdAt:'asc'},take:30});
    return rows.map(step=>this.present(step,'WAITING_APPROVAL'));
  }

  async decide(userId: number, runId: string, stepId: string, approved: boolean, argsHash: string, policyVersion: string, expectedVersion: number) {
    const run=await this.prisma.chatRun.findFirst({where:{id:runId,userId},select:{conversationId:true}});
    if(!run)throw new NotFoundException('生成任务不存在');
    return this.prisma.$transaction(async tx=>{
      const owner=await this.owned(tx,{userId,runId,conversationId:run.conversationId},expectedVersion,true);
      if(owner.conversation.conversationType!=='ASSISTANT')throw new ForbiddenException('角色会话不能确认业务操作');
      const step=await tx.chatToolStep.findFirst({where:{id:stepId,runId}});
      if(!step||step.sourceEpoch!==owner.conversation.memoryEpoch||step.authVersion!==owner.user.authVersion||
        step.argsHash!==argsHash||step.policyVersion!==policyVersion||policyVersion!==TOOL_POLICY_VERSION)
        throw new ConflictException('待确认操作的版本或权限已变化');
      const desired=approved?'APPROVED':'REJECTED';
      if(step.state===desired)return{runId,status:owner.run.status,stepId,state:desired};
      if(owner.run.status!=='WAITING_APPROVAL'||step.state!=='WAITING_APPROVAL')throw new ConflictException('操作已处理或任务已结束');
      await tx.chatToolStep.update({where:{id:stepId},data:{state:desired,approvedAt:approved?new Date():null}});
      const waiting=await tx.chatToolStep.count({where:{runId,state:'WAITING_APPROVAL'}});
      if(!waiting)await tx.chatRun.updateMany({where:{id:runId,status:'WAITING_APPROVAL'},data:{status:'QUEUED',result:Prisma.DbNull,error:null}});
      return{runId,status:waiting?'WAITING_APPROVAL':'QUEUED',stepId,state:desired};
    });
  }
}

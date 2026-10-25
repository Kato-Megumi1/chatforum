import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { ForumEventsService } from './forum-events.service';
import { CreateForumReportDto } from './forum-reports.dto';

const choices=['垃圾广告','人身攻击','隐私泄露','违法违规','其他'];
const positive=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const note=(value:unknown,max=2000)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\0]/.test(value))throw new BadRequestException('请填写有效说明');
  return value.trim();
};
const ownFields={id:true,type:true,targetId:true,commentId:true,reason:true,status:true,revision:true,decision:true,
  decisionReason:true,createdAt:true,decidedAt:true,post:{select:{id:true,title:true}}} as const;
const targetFields={id:true,type:true,targetId:true,commentId:true,status:true,revision:true,decision:true,
  decisionReason:true,createdAt:true,decidedAt:true,post:{select:{id:true,title:true}},
  appeal:{select:{id:true,status:true,reason:true,decisionReason:true,revision:true,createdAt:true,decidedAt:true}}} as const;

@Injectable()
export class ForumReportsService {
  constructor(private readonly db:PrismaService,@Optional() private readonly events?:ForumEventsService){}

  private async actor(db:any,id:number,version:number,admin=false,lock=false){
    if(!positive(id)||!Number.isSafeInteger(version)||version<0)throw new UnauthorizedException('登录状态无效');
    if(lock)await db.$queryRaw`SELECT id FROM users WHERE id=${id} FOR UPDATE`;
    const user=await db.user.findUnique({where:{id},select:{id:true,status:true,role:true,authVersion:true}});
    if(!user||user.status!=='ACTIVE'||user.authVersion!==version)throw new UnauthorizedException('登录状态已改变');
    if(admin&&user.role!=='ADMIN')throw new ForbiddenException('需要管理员权限');
    return user;
  }
  private page(query:any){
    const cursor=query?.before===undefined?undefined:Number(query.before),take=query?.limit===undefined?20:Number(query.limit);
    if(cursor!==undefined&&!positive(cursor)||!positive(take)||take>50)throw new BadRequestException('分页参数无效');
    return{cursor,take};
  }
  async create(userId:number,version:number,input:CreateForumReportDto){
    if(!input||!['POST','COMMENT'].includes(input.type)||!positive(input.targetId)||!choices.includes(input.reason)||
      typeof input.requestId!=='string'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(input.requestId))
      throw new BadRequestException('举报参数无效');
    if(typeof input.detail!=='string'||input.detail.length>1800||/[\0]/.test(input.detail))throw new BadRequestException('举报说明无效');
    const detail=input.detail.trim();
    if(input.reason==='其他'&&!detail)throw new BadRequestException('请补充举报原因');
    const reason=input.reason+(detail?'\n'+detail:'');
    return this.db.$transaction(async tx=>{
      await this.actor(tx,userId,version,false,true);
      const prior=await tx.report.findUnique({where:{reporterId_clientRequestId:{reporterId:userId,clientRequestId:input.requestId}},select:{...ownFields}});
      if(prior){if(prior.type!==input.type||(prior.commentId||prior.targetId)!==input.targetId||prior.reason!==reason)
        throw new ConflictException('请求编号已用于其他举报');return prior;}
      let postId=input.targetId,comment:any;
      if(input.type==='COMMENT'){
        comment=await tx.comment.findFirst({where:{id:input.targetId,status:'ACTIVE'},select:{id:true,postId:true,userId:true,updatedAt:true}});
        if(!comment)throw new NotFoundException('评论不可举报');postId=comment.postId;
      }
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${postId} FOR UPDATE`;
      const post=await tx.post.findFirst({where:{id:postId,status:'APPROVED'},select:{id:true,userId:true,revision:true}});
      if(!post)throw new NotFoundException('帖子不可举报');
      if(comment){comment=await tx.comment.findFirst({where:{id:input.targetId,postId,status:'ACTIVE'},select:{id:true,userId:true,updatedAt:true}});
        if(!comment)throw new ConflictException('评论已改变，请刷新');}
      const author=comment?.userId??post.userId;
      if(author===userId)throw new BadRequestException('不能举报自己的内容');
      const pending=await tx.report.findFirst({where:{reporterId:userId,type:input.type,targetId:postId,
        commentId:comment?.id??null,status:'PENDING'},select:ownFields});
      if(pending)return pending;
      const recent=await tx.report.count({where:{reporterId:userId,createdAt:{gte:new Date(Date.now()-86400000)}}});
      if(recent>=20)throw new BadRequestException('今日举报较多，请等待已有举报处理');
      return tx.report.create({data:{reporterId:userId,clientRequestId:input.requestId,type:input.type,targetId:postId,postId,
        commentId:comment?.id??null,targetUserId:author,targetRevision:post.revision,targetUpdatedAt:comment?.updatedAt??null,reason},select:ownFields});
    });
  }

  async mine(userId:number,version:number,query:any={}){
    await this.actor(this.db,userId,version);const{cursor,take}=this.page(query);
    const rows=await this.db.report.findMany({where:{reporterId:userId,...(cursor?{id:{lt:cursor}}:{})},
      orderBy:{id:'desc'},take:take+1,select:ownFields});
    const hasMore=rows.length>take;return{rows:rows.slice(0,take),nextCursor:hasMore?rows[take-1].id:null};
  }
  async decisions(userId:number,version:number,query:any={}){
    await this.actor(this.db,userId,version);const{cursor,take}=this.page(query);
    // Deliberately omit reporterId, reporter, original reason and request ID.
    const rows=await this.db.report.findMany({where:{targetUserId:userId,decision:{in:['HIDE','RESTORED']},
      ...(cursor?{id:{lt:cursor}}:{})},orderBy:{id:'desc'},take:take+1,select:targetFields});
    const hasMore=rows.length>take;return{rows:rows.slice(0,take),nextCursor:hasMore?rows[take-1].id:null};
  }
  async appeal(userId:number,version:number,id:number,input:{expectedRevision:number;reason:string}){
    if(!positive(id)||!positive(input?.expectedRevision))throw new BadRequestException('申诉参数无效');
    const reason=note(input.reason);
    return this.db.$transaction(async tx=>{
      await this.actor(tx,userId,version,false,true);
      await tx.$queryRaw`SELECT id FROM reports WHERE id=${id} FOR UPDATE`;
      const report=await tx.report.findFirst({where:{id,targetUserId:userId},include:{appeal:true}});
      if(!report)throw new NotFoundException('处理记录不存在');
      if(report.appeal){if(report.appeal.appellantId===userId&&report.appeal.reason===reason)return{ok:true};
        throw new ConflictException('该处理已有申诉');}
      if(report.status!=='RESOLVED'||report.decision!=='HIDE'||report.revision!==input.expectedRevision)
        throw new ConflictException('处理状态已改变，请刷新后申诉');
      await tx.reportAppeal.create({data:{reportId:id,appellantId:userId,reason}});
      await tx.report.update({where:{id},data:{revision:{increment:1}}});
      return{ok:true};
    });
  }

  async adminList(actor:number,version:number,kind:'reports'|'appeals',query:any={}){
    await this.actor(this.db,actor,version,true);
    const page=query.page===undefined?1:Number(query.page),take=25;
    if(!positive(page)||page>1000)throw new BadRequestException('页码无效');
    const status=query.status===undefined||query.status===''?'':String(query.status);
    const allowed=kind==='reports'?['PENDING','RESOLVED','REJECTED']:['PENDING','ACCEPTED','REJECTED'];
    if(status&&!allowed.includes(status))throw new BadRequestException('状态无效');
    const where=status?{status}:{};
    if(kind==='reports'){
      const[rows,total]=await Promise.all([this.db.report.findMany({where:where as any,orderBy:{id:'desc'},take,skip:(page-1)*take,
        select:{...ownFields,targetUserId:true,targetRevision:true,targetUpdatedAt:true,reporter:{select:{id:true,username:true}},
          appeal:{select:{status:true}},post:{select:{id:true,title:true,status:true,revision:true}}}}),this.db.report.count({where:where as any})]);
      return{page,take,total,rows};
    }
    const[rows,total]=await Promise.all([this.db.reportAppeal.findMany({where,orderBy:{id:'desc'},take,skip:(page-1)*take,
      select:{id:true,reportId:true,appellantId:true,reason:true,status:true,revision:true,createdAt:true,decisionReason:true,
        report:{select:{id:true,type:true,targetId:true,commentId:true,decision:true,decisionReason:true,revision:true,post:{select:{id:true,title:true}}}}}}),this.db.reportAppeal.count({where})]);
    return{page,take,total,rows};
  }
  private async audit(tx:any,actor:number,action:string,details:object,ip?:string){
    await tx.operationLog.create({data:{userId:actor,module:'FORUM_REPORTS',action,details:JSON.stringify(details),ip:ip?.slice(0,64)}});
  }
  async context(actor:number,version:number,id:number){
    await this.actor(this.db,actor,version,true);
    const report=await this.db.report.findUnique({where:{id},select:{id:true,type:true,targetId:true,commentId:true}});
    if(!report)throw new NotFoundException('举报不存在');
    const post=await this.db.post.findUnique({where:{id:report.targetId},select:{id:true,title:true,content:true,status:true,revision:true}});
    if(!post)throw new NotFoundException('内容已不存在');
    if(report.type==='POST')return{type:'POST',targetId:post.id,title:post.title,content:post.content.slice(0,4000),status:post.status};
    if(report.type==='COMMENT'&&report.commentId){
      const comment=await this.db.comment.findFirst({where:{id:report.commentId,postId:post.id},select:{id:true,content:true,status:true}});
      if(comment)return{type:'COMMENT',targetId:comment.id,title:post.title,content:comment.content.slice(0,4000),status:comment.status};
    }
    throw new NotFoundException('旧举报目标不明确，不能猜测内容');
  }
  private async notify(tx:any,userId:number,title:string,reportId:number){
    await tx.notification.create({data:{userId,type:'SYSTEM',title,content:'请在“举报与申诉”查看处理结果。',relatedReportId:reportId}});
  }
  async decide(actor:number,version:number,id:number,input:any,ip?:string){
    if(!positive(id)||!positive(input?.expectedRevision)||!['HIDE','DISMISS'].includes(input?.action)||input?.confirmation!==String(id))
      throw new BadRequestException('处理参数或确认编号无效');
    const explanation=note(input.reason);
    return this.db.$transaction(async tx=>{
      await this.actor(tx,actor,version,true,true);
      const hint=await tx.report.findUnique({where:{id},select:{targetId:true}});
      if(!hint)throw new NotFoundException('举报不存在');
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${hint.targetId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM reports WHERE id=${id} FOR UPDATE`;
      const report=await tx.report.findUnique({where:{id}});
      if(!report)throw new NotFoundException('举报不存在');
      if(report.status!=='PENDING'){
        if(report.decision===input.action&&report.decisionReason===explanation)return{ok:true};
        throw new ConflictException('举报已处理');
      }
      if(report.revision!==input.expectedRevision)throw new ConflictException('举报已有新版本');
      const data:any={status:input.action==='HIDE'?'RESOLVED':'REJECTED',decision:input.action,
        decisionReason:explanation,decidedById:actor,decidedAt:new Date(),revision:{increment:1}};
      if(input.action==='HIDE'){
        if(!this.events)throw new ConflictException('论坛事件服务尚未就绪');
        const post=await tx.post.findUnique({where:{id:report.targetId}});
        if(!post||post.status!=='APPROVED'||report.type==='POST'&&post.revision!==report.targetRevision)
          throw new ConflictException('被举报内容已改变，不能处理旧版本；请不予处理并说明原因');
        if(report.type==='POST'){
          const changed=await tx.post.updateMany({where:{id:post.id,status:'APPROVED',revision:report.targetRevision},
            data:{status:'REJECTED',revision:{increment:1}}});
          if(!changed.count)throw new ConflictException('帖子已改变');data.targetRevision=post.revision+1;
          await this.events.append(tx,{kind:'POST_HIDDEN',postId:post.id,postRevision:post.revision+1,actorId:actor,
            payload:{status:'REJECTED',previousStatus:'APPROVED',reportId:id}});
        }else if(report.type==='COMMENT'&&report.commentId){
          const comment=await tx.comment.findFirst({where:{id:report.commentId,postId:post.id,status:'ACTIVE',updatedAt:report.targetUpdatedAt}});
          if(!comment)throw new ConflictException('评论已改变');
          const changed=await tx.comment.updateMany({where:{id:comment.id,status:'ACTIVE',updatedAt:report.targetUpdatedAt},data:{status:'DELETED'}});
          if(!changed.count)throw new ConflictException('评论已改变');
          const hidden=await tx.comment.findUnique({where:{id:comment.id},select:{updatedAt:true}});data.targetUpdatedAt=hidden.updatedAt;
          await tx.post.update({where:{id:post.id},data:{commentCount:{decrement:1}}});
          await this.events.append(tx,{kind:'COMMENT_DELETED',postId:post.id,postRevision:post.revision,actorId:actor,
            payload:{commentId:comment.id,delta:{comments:-1},reportId:id}});
        }else throw new BadRequestException('旧举报目标无法安全处理，请驳回并重新举报');
      }
      await tx.report.update({where:{id},data});
      await this.audit(tx,actor,'REPORT_DECIDED',{reportId:id,action:input.action,reason:explanation},ip);
      await this.notify(tx,report.reporterId,'举报已有处理结果',id);
      if(input.action==='HIDE'&&report.targetUserId)await this.notify(tx,report.targetUserId,'你的论坛内容已处理',id);
      return{ok:true};
    });
  }
  async decideAppeal(actor:number,version:number,id:number,input:any,ip?:string){
    if(!positive(id)||!positive(input?.expectedRevision)||!['ACCEPT','REJECT'].includes(input?.action)||input?.confirmation!==String(id))
      throw new BadRequestException('申诉处理参数或确认编号无效');
    const explanation=note(input.reason);
    return this.db.$transaction(async tx=>{
      await this.actor(tx,actor,version,true,true);
      const hint=await tx.reportAppeal.findUnique({where:{id},select:{report:{select:{targetId:true,id:true}}}});
      if(!hint)throw new NotFoundException('申诉不存在');
      await tx.$queryRaw`SELECT id FROM posts WHERE id=${hint.report.targetId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM reports WHERE id=${hint.report.id} FOR UPDATE`;
      const appeal=await tx.reportAppeal.findUnique({where:{id},include:{report:true}});
      if(!appeal)throw new NotFoundException('申诉不存在');
      if(appeal.status!=='PENDING'){
        if(appeal.status===(input.action==='ACCEPT'?'ACCEPTED':'REJECTED')&&appeal.decisionReason===explanation)return{ok:true};
        throw new ConflictException('申诉已处理');
      }
      if(appeal.revision!==input.expectedRevision)throw new ConflictException('申诉已有新版本');
      const report=appeal.report;
      if(report.status!=='RESOLVED'||report.decision!=='HIDE')throw new ConflictException('原处理状态已改变');
      if(input.action==='ACCEPT'){
        if(!this.events)throw new ConflictException('论坛事件服务尚未就绪');
        const post=await tx.post.findUnique({where:{id:report.targetId}});
        if(!post||report.type==='POST'&&post.revision!==report.targetRevision)throw new ConflictException('内容已有其他修改，不能恢复旧版本');
        if(report.type==='POST'){
          const changed=await tx.post.updateMany({where:{id:post.id,status:'REJECTED',revision:report.targetRevision},data:{status:'APPROVED',revision:{increment:1}}});
          if(!changed.count)throw new ConflictException('帖子状态已改变');
          await this.events.append(tx,{kind:'POST_APPROVED',postId:post.id,postRevision:post.revision+1,actorId:actor,
            payload:{status:'APPROVED',previousStatus:'REJECTED',reportId:report.id}});
        }else if(report.type==='COMMENT'&&report.commentId&&post.status==='APPROVED'){
          const changed=await tx.comment.updateMany({where:{id:report.commentId,postId:post.id,status:'DELETED',updatedAt:report.targetUpdatedAt},data:{status:'ACTIVE'}});
          if(!changed.count)throw new ConflictException('评论已有其他处理，不能恢复旧版本');
          await tx.post.update({where:{id:post.id},data:{commentCount:{increment:1}}});
          await this.events.append(tx,{kind:'COMMENT_RESTORED',postId:post.id,postRevision:post.revision,actorId:actor,
            payload:{commentId:report.commentId,delta:{comments:1},reportId:report.id}});
        }else throw new ConflictException('内容已不可恢复');
        await tx.report.update({where:{id:report.id},data:{decision:'RESTORED',decisionReason:explanation,revision:{increment:1}}});
      }
      await tx.reportAppeal.update({where:{id},data:{status:input.action==='ACCEPT'?'ACCEPTED':'REJECTED',
        decisionReason:explanation,decidedById:actor,decidedAt:new Date(),revision:{increment:1}}});
      await this.audit(tx,actor,'REPORT_APPEAL_DECIDED',{appealId:id,reportId:report.id,action:input.action,reason:explanation},ip);
      await this.notify(tx,appeal.appellantId,'论坛申诉已有处理结果',report.id);
      return{ok:true};
    });
  }
}

import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma.service';
import { ConversationFrame, MemoryMessage, MEMORY_REBUILD_NOTICE, SUMMARY_CHAR_BUDGET, turnExcerpt } from './conversation-memory.policy';
import { storedRagMessage } from './rag-history';
import { ConversationHistoryChangedError } from './model-output.error';

type Db = PrismaService | Prisma.TransactionClient;
type SourceRow = { id:number; role:string; content:string; ragMetadata?:unknown; createdAt:Date };
type ConversationScope = {id:number;userId:number;personaKey:string|null;conversationType:string;memoryEpoch:number;title:string;personaLabel:string|null;sharedMemory:boolean};
export type MemoryEntryAction = { kind:'episode'|'pin'; id:number; version:string };
const MAX_PINS = 12, PAGE_SIZE = 20;
const digest = (value:unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const memorySourceIds = (value:unknown):number[] => Array.isArray(value) && value.length>0 && value.length<=8 &&
  value.every(id=>Number.isSafeInteger(id)&&Number(id)>0) ? [...new Set(value as number[])] : [];
export const memorySourceHash = (rows:SourceRow[]) => digest(rows.map(row=>({id:row.id,role:row.role,content:row.content})));
const sourceSelect = {id:true,role:true,content:true,ragMetadata:true,createdAt:true} as const;
function stateSourceIds(value:unknown):number[] {
  if(!value||typeof value!=='object')return [];
  const record=value as any;
  return [...new Set([...(Number.isSafeInteger(record.messageId)&&record.messageId>0?[record.messageId]:[]),
    ...Object.values(record).flatMap(item=>stateSourceIds(item))])];
}
function filteredState(state:ConversationFrame['memory']['state'],excluded:Set<number>) {
  const removed=(value:unknown)=>stateSourceIds(value).some(id=>excluded.has(id));
  return {...state,
    ...(removed(state.name)?{name:undefined}:{}),...(removed(state.address)?{address:undefined}:{}),
    preferences:state.preferences.filter(preference=>!removed(preference)),
    ...(removed(state.invitation)?{invitation:undefined}:{}),...(removed(state.affection)?{affection:undefined}:{}),
    ...(removed(state.characterAffection)?{characterAffection:undefined}:{}),
    ...(removed(state.familiaritySources)?{familiarity:'not_established' as const,familiaritySources:[]}:{}),
    ...(removed(state.relationship)?{relationship:{status:'not_established' as const,sources:[]}}:{}),
  };
}

@Injectable()
export class MemoryControlsService {
  constructor(private readonly prisma:PrismaService) {}

  private async principal(db:Db,userId:number) {
    const user=await db.user.findUnique({where:{id:userId},select:{status:true}});
    if(!user||user.status!=='ACTIVE')throw new ForbiddenException('账号不可用');
  }
  private async owned(db:Db,userId:number,conversationId:number):Promise<ConversationScope> {
    if(!Number.isSafeInteger(conversationId)||conversationId<1)throw new BadRequestException('无效的对话编号');
    await this.principal(db,userId);
    const row=await db.conversation.findFirst({where:{id:conversationId,userId},select:{id:true,userId:true,personaKey:true,
      conversationType:true,memoryEpoch:true,title:true,personaLabel:true,sharedMemory:true}});
    if(!row)throw new NotFoundException('对话不可访问');
    if(row.conversationType==='LEGACY'||!row.personaKey)throw new ConflictException('旧历史不参与当前记忆');
    return row;
  }
  private async lock(tx:Prisma.TransactionClient,userId:number,conversationId:number) {
    // Same account -> conversation lock order as task admission and draft writes.
    const account=await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR UPDATE`;
    if(!account.length)throw new ForbiddenException('账号不可用');
    await tx.$queryRaw`SELECT id FROM conversations WHERE id=${conversationId} AND userId=${userId} FOR UPDATE`;
    return this.owned(tx,userId,conversationId);
  }
  async conversations(userId:number,before?:number) {
    await this.principal(this.prisma,userId);
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new BadRequestException('无效的分页');
    const rows=await this.prisma.conversation.findMany({where:{userId,conversationType:{in:['ASSISTANT','ROLEPLAY']},
      ...(before?{id:{lt:before}}:{})},orderBy:{id:'desc'},take:51,
      select:{id:true,title:true,conversationType:true,personaLabel:true}});
    return {items:rows.slice(0,50),nextBefore:rows.length>50?rows[49].id:null};
  }
  private async validSources(db:Db,scope:ConversationScope,ids:number[]):Promise<SourceRow[]|undefined> {
    if(!ids.length)return;
    const [rows,suppressed]=await Promise.all([
      db.chatMessage.findMany({where:{conversationId:scope.id,id:{in:ids}},orderBy:[{createdAt:'asc'},{id:'asc'}],select:sourceSelect}),
      db.conversationMemorySuppression.count({where:{conversationId:scope.id,userId:scope.userId,messageId:{in:ids}}}),
    ]);
    if(rows.length!==ids.length||suppressed)return;
    if(rows.some(row=>row.role==='ASSISTANT'&&(row.ragMetadata as any)?.personaKey&&
      (row.ragMetadata as any).personaKey!==scope.personaKey))return;
    return rows;
  }
  private version(scope:ConversationScope,kind:string,id:number,sourceHash:string,revision=1) {
    return digest({conversationId:scope.id,epoch:scope.memoryEpoch,kind,id,sourceHash,revision});
  }
  private text(rows:SourceRow[]) { return turnExcerpt(rows.map(storedRagMessage) as MemoryMessage[]).slice(0,1200); }

  async entries(userId:number,conversationId:number,before?:number) {
    const scope=await this.owned(this.prisma,userId,conversationId);
    if(before!==undefined&&(!Number.isSafeInteger(before)||before<1))throw new BadRequestException('无效的分页');
    const [episodes,pins,job]=await Promise.all([
      this.prisma.conversationEpisode.findMany({where:{conversationId,personaKey:scope.personaKey,
        ...(before?{lastMessageId:{lt:before}}:{})},orderBy:{lastMessageId:'desc'},take:PAGE_SIZE+1}),
      this.prisma.conversationMemoryPin.findMany({where:{userId,conversationId,personaKey:scope.personaKey},orderBy:{id:'desc'},take:MAX_PINS}),
      this.prisma.memoryRebuildJob.findUnique({where:{conversationId},select:{status:true,epoch:true}}),
    ]);
    const ids=[...new Set([...pins.flatMap(pin=>memorySourceIds(pin.sourceIds)),
      ...episodes.slice(0,PAGE_SIZE).flatMap(episode=>memorySourceIds(episode.sourceIds))])];
    const [sourceRows,suppressed]=await Promise.all([
      ids.length?this.prisma.chatMessage.findMany({where:{conversationId,id:{in:ids}},orderBy:[{createdAt:'asc'},{id:'asc'}],select:sourceSelect}):[],
      ids.length?this.prisma.conversationMemorySuppression.findMany({where:{userId,conversationId,messageId:{in:ids}},select:{messageId:true}}):[],
    ]);
    const excluded=new Set(suppressed.map(row=>row.messageId));
    const groupSources=(sourceIds:number[])=>{
      const rows=sourceRows.filter(row=>sourceIds.includes(row.id));
      return sourceIds.length&&rows.length===sourceIds.length&&!sourceIds.some(id=>excluded.has(id))&&
        !rows.some(row=>row.role==='ASSISTANT'&&(row.ragMetadata as any)?.personaKey&&(row.ragMetadata as any).personaKey!==scope.personaKey)?rows:undefined;
    };
    const items:any[]=[];
    for(const pin of before?[]:pins) {
      const ids=memorySourceIds(pin.sourceIds),sources=groupSources(ids);
      if(!sources||memorySourceHash(sources)!==pin.sourceHash)continue;
      items.push({kind:'pin',id:pin.id,text:pin.text,sourceIds:ids,pinned:true,
        version:this.version(scope,'pin',pin.id,pin.sourceHash,pin.revision)});
    }
    for(const episode of episodes.slice(0,PAGE_SIZE)) {
      const ids=memorySourceIds(episode.sourceIds),sources=groupSources(ids);
      if(!sources)continue;
      const hash=memorySourceHash(sources);
      if(pins.some(pin=>pin.sourceHash===hash))continue; // A pinned item has one card, not a duplicate excerpt.
      items.push({kind:'episode',id:episode.lastMessageId,text:this.text(sources),sourceIds:ids,
        pinned:pins.some(pin=>pin.sourceHash===hash),version:this.version(scope,'episode',episode.lastMessageId,hash)});
    }
    // Opening memory can schedule an initial bounded derived rebuild, never a model request.
    if(!job||job.epoch!==scope.memoryEpoch)await this.prisma.$transaction(async tx=>{
      const current=await this.lock(tx,userId,conversationId);
      const latest=await tx.memoryRebuildJob.findUnique({where:{conversationId}});
      if(!latest||latest.epoch!==current.memoryEpoch)await tx.memoryRebuildJob.upsert({where:{conversationId},
        create:{conversationId,userId,personaKey:current.personaKey!,epoch:current.memoryEpoch},
        update:{epoch:current.memoryEpoch,personaKey:current.personaKey!,status:'QUEUED',workerToken:null,leaseUntil:null,nextAttemptAt:new Date()}});
    });
    return {conversation:{id:scope.id,title:scope.title,personaLabel:scope.personaLabel,conversationType:scope.conversationType},
      items,nextBefore:episodes.length>PAGE_SIZE?episodes[PAGE_SIZE-1].lastMessageId:null,
      rebuildStatus:!job||job.epoch!==scope.memoryEpoch?'QUEUED':job.status};
  }
  private async resolve(db:Db,scope:ConversationScope,action:MemoryEntryAction) {
    if(!action||!['episode','pin'].includes(action.kind)||!Number.isSafeInteger(action.id)||action.id<1||
      typeof action.version!=='string'||!/^[a-f\d]{64}$/.test(action.version))throw new BadRequestException('无效的记忆版本');
    const row=action.kind==='episode' ? await db.conversationEpisode.findUnique({where:{conversationId_personaKey_lastMessageId:{
      conversationId:scope.id,personaKey:scope.personaKey!,lastMessageId:action.id}}}) :
      await db.conversationMemoryPin.findFirst({where:{id:action.id,userId:scope.userId,conversationId:scope.id,personaKey:scope.personaKey}});
    if(!row)throw new NotFoundException('记忆已改变，请刷新');
    const ids=memorySourceIds(row.sourceIds),sources=await this.validSources(db,scope,ids);
    if(!sources)throw new ConflictException('记忆来源已删除或已排除，请刷新');
    const hash=memorySourceHash(sources),revision=action.kind==='pin'?(row as any).revision:1;
    if(action.kind==='pin'&&hash!==(row as any).sourceHash||this.version(scope,action.kind,action.id,hash,revision)!==action.version)
      throw new ConflictException('记忆版本已改变，请刷新');
    return {ids,sources,hash};
  }
  async sources(userId:number,conversationId:number,action:MemoryEntryAction) {
    const scope=await this.owned(this.prisma,userId,conversationId),{sources}=await this.resolve(this.prisma,scope,action);
    return {conversationId,messages:sources.map(source=>({id:source.id,role:source.role.toLowerCase(),
      content:source.content.slice(0,12000),truncated:source.content.length>12000,createdAt:source.createdAt}))};
  }
  async pin(userId:number,conversationId:number,action:MemoryEntryAction) {
    return this.prisma.$transaction(async tx=>{
      const scope=await this.lock(tx,userId,conversationId),{ids,sources,hash}=await this.resolve(tx,scope,action);
      const existing=await tx.conversationMemoryPin.findUnique({where:{conversationId_sourceHash:{conversationId,sourceHash:hash}}});
      if(existing)return {id:existing.id,pinned:true};
      if(await tx.conversationMemoryPin.count({where:{userId,conversationId}})>=MAX_PINS)
        throw new ConflictException('本会话最多固定12段记忆，请先取消部分固定');
      const row=await tx.conversationMemoryPin.create({data:{userId,conversationId,personaKey:scope.personaKey!,sourceIds:ids,
        sourceHash:hash,text:this.text(sources)}});
      return {id:row.id,pinned:true};
    });
  }
  async unpin(userId:number,conversationId:number,action:MemoryEntryAction) {
    if(action.kind!=='pin')throw new BadRequestException('请选择已固定的记忆');
    return this.prisma.$transaction(async tx=>{
      const scope=await this.lock(tx,userId,conversationId);await this.resolve(tx,scope,action);
      await tx.conversationMemoryPin.delete({where:{id:action.id}});return {pinned:false};
    });
  }
  async forget(userId:number,conversationId:number,action:MemoryEntryAction) {
    return this.prisma.$transaction(async tx=>{
      const scope=await this.lock(tx,userId,conversationId),{ids}=await this.resolve(tx,scope,action);
      await tx.conversationMemorySuppression.createMany({data:ids.map(messageId=>({userId,conversationId,messageId})),skipDuplicates:true});
      const pins=await tx.conversationMemoryPin.findMany({where:{userId,conversationId},select:{id:true,sourceIds:true}});
      const remove=pins.filter(pin=>memorySourceIds(pin.sourceIds).some(id=>ids.includes(id))).map(pin=>pin.id);
      if(remove.length)await tx.conversationMemoryPin.deleteMany({where:{conversationId,id:{in:remove}}});
      await tx.conversation.update({where:{id:conversationId},data:{memoryEpoch:{increment:1}}});
      await tx.conversationMemory.deleteMany({where:{conversationId}});
      await tx.conversationEpisode.deleteMany({where:{conversationId}});
      await tx.forumQueryCheckpoint.deleteMany({where:{conversationId}});
      await tx.memoryRebuildJob.upsert({where:{conversationId},create:{conversationId,userId,personaKey:scope.personaKey!,epoch:scope.memoryEpoch+1},
        update:{epoch:scope.memoryEpoch+1,status:'QUEUED',workerToken:null,leaseUntil:null,attempts:0,nextAttemptAt:new Date(),errorCode:null}});
      return {forgotten:true};
    });
  }

  async filterMessages<T extends {messageId?:number}>(userId:number,conversationId:number,messages:T[]):Promise<T[]> {
    const ids=messages.map(message=>message.messageId).filter((id):id is number=>Number.isSafeInteger(id)&&Number(id)>0);
    if(!ids.length)return messages;
    const rows=await this.prisma.conversationMemorySuppression.findMany({where:{userId,conversationId,messageId:{in:ids}},select:{messageId:true}});
    const excluded=new Set(rows.map(row=>row.messageId));
    return messages.filter(message=>!excluded.has(message.messageId!));
  }
  async applyToFrame(userId:number,conversationId:number,frame:ConversationFrame):Promise<ConversationFrame> {
    const scope=await this.owned(this.prisma,userId,conversationId);
    if(scope.personaKey!==frame.memory.personaKey||scope.memoryEpoch!==frame.sourceEpoch)throw new ConversationHistoryChangedError();
    const pins=await this.prisma.conversationMemoryPin.findMany({where:{userId,conversationId,personaKey:scope.personaKey},orderBy:{id:'desc'},take:MAX_PINS});
    const pinIds=[...new Set(pins.flatMap(pin=>memorySourceIds(pin.sourceIds)))];
    const topicIds=[...new Set(frame.memory.summary.topics.flatMap(topic=>memorySourceIds(topic.sourceIds)))];
    const allIds=[...new Set([...pinIds,...topicIds,...stateSourceIds(frame.memory.state)])];
    const [pinSources,topicSources,suppressions]=await Promise.all([
      pinIds.length?this.prisma.chatMessage.findMany({where:{conversationId,id:{in:pinIds}},orderBy:[{createdAt:'asc'},{id:'asc'}],select:sourceSelect}):[],
      topicIds.length?this.prisma.chatMessage.findMany({where:{id:{in:topicIds},conversation:{userId,
        conversationType:scope.conversationType,personaKey:scope.personaKey,OR:[{id:conversationId},...(scope.sharedMemory?[{sharedMemory:true}]:[])]}},
        select:{id:true,conversationId:true}}):[],
      allIds.length?this.prisma.conversationMemorySuppression.findMany({where:{userId,messageId:{in:allIds}},select:{messageId:true}}):[],
    ]);
    const excluded=new Set(suppressions.map(row=>row.messageId)),visible=new Set(topicSources.map(row=>row.id));
    const pinned:Array<{text:string;sourceIds:number[]}>=[];let used=0;
    // Share the reserved space among all pins instead of silently starving the
    // older ones when several long source excerpts are fixed by the user.
    const perPin=Math.floor(2500/Math.max(1,pins.length));
    for(const pin of pins) {
      const ids=memorySourceIds(pin.sourceIds),sources=pinSources.filter(row=>ids.includes(row.id));
      if(!ids.length||sources.length!==ids.length||ids.some(id=>excluded.has(id))||memorySourceHash(sources)!==pin.sourceHash||
        sources.some(row=>row.role==='ASSISTANT'&&(row.ragMetadata as any)?.personaKey&&
          (row.ragMetadata as any).personaKey!==scope.personaKey))continue;
      const heading='【用户固定的历史摘录，非正史依据】\n',omission='\n【摘录有省略，来源保留】';
      const body=heading.length+pin.text.length<=perPin?pin.text:
        pin.text.slice(0,Math.max(0,perPin-heading.length-omission.length)).replace(/[\uD800-\uDBFF]$/,'')+omission;
      const text=heading+body;
      if(used+text.length>2500)continue;
      pinned.push({text,sourceIds:ids});used+=text.length;
    }
    const topics=[...pinned];
    for(const topic of frame.memory.summary.topics) {
      if(used+topic.text.length>SUMMARY_CHAR_BUDGET)continue;
      if(topic.text===MEMORY_REBUILD_NOTICE&&!topic.sourceIds.length){topics.push(topic);used+=topic.text.length;continue;}
      // Shared excerpts keep their own source conversation. Validate each source
      // through the current owner's rows, not only the selected conversation's IDs.
      const ids=memorySourceIds(topic.sourceIds);
      if(!ids.length)continue;
      if(ids.some(id=>!visible.has(id)||excluded.has(id)))continue;
      topics.push(topic);used+=topic.text.length;
    }
    return {...frame,history:await this.filterMessages(userId,conversationId,frame.history),
      evidenceHistory:frame.evidenceHistory?await this.filterMessages(userId,conversationId,frame.evidenceHistory):undefined,
      memory:{...frame.memory,state:filteredState(frame.memory.state,excluded),
        summary:{...frame.memory.summary,topics,text:topics.map(topic=>topic.text).join('\n'),sourceIds:topics.flatMap(topic=>topic.sourceIds)}}};
  }
}

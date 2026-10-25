import { ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConversationEpisode, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { buildConversationMemory, ConversationFrame, interactionState, MemoryMessage, MEMORY_REBUILD_NOTICE, SUMMARY_CHAR_BUDGET } from './conversation-memory.policy';
import { afterMemoryCursor, asMemoryMessages, emptyMemoryCache, memoryCache, personaMemoryMessages, reduceMemoryBatch } from './conversation-memory.reducer';
import { MemoryControlsService } from './memory-controls.service';
import { ConversationHistoryChangedError } from './model-output.error';

const MESSAGE_SELECT={id:true,createdAt:true,role:true,content:true,ragMetadata:true} as const;
const BATCH_SIZE=200;
@Injectable()
export class ConversationMemoryService implements OnModuleInit,OnModuleDestroy {
  private timer?:NodeJS.Timeout;private busy=false;
  constructor(private readonly prisma:PrismaService,@Optional() private readonly controls?:MemoryControlsService){}
  onModuleInit(){
    if(process.env.MEMORY_WORKER_ENABLED==='false'||process.env.CHAT_WORKER_ENABLED==='false')return;
    this.timer=setInterval(()=>void this.tickRebuild().catch(()=>undefined),1000);this.timer.unref();
  }
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}

  // Bounded hot path: cold history reduction happens in the durable worker, not
  // while holding a conversation lock or waiting for model/network calls.
  async prepare(conversationId:number,userId:number,personaKey:string,persona:string,question:string):Promise<ConversationFrame>{
    const conversation=await this.prisma.conversation.findFirst({where:{id:conversationId,userId,user:{status:'ACTIVE'}},
      select:{id:true,memoryEpoch:true,conversationType:true,personaKey:true,sharedMemory:true}});
    if(!conversation)throw new ForbiddenException('对话不可访问');
    if(conversation.conversationType==='LEGACY')throw new ForbiddenException('旧会话身份未明确，不参与新记忆');
    if(conversation.personaKey&&conversation.personaKey!==personaKey)throw new ForbiddenException('记忆与会话身份不匹配');
    const epoch=conversation.memoryEpoch;
    const [saved,latest]=await Promise.all([
      this.prisma.conversationMemory.findUnique({where:{conversationId_personaKey:{conversationId,personaKey}}}),
      this.prisma.chatMessage.findMany({where:{conversationId},orderBy:[{createdAt:'desc'},{id:'desc'}],take:62,select:MESSAGE_SELECT}),
    ]);
    const raw=latest.reverse(),cached=memoryCache(saved?.snapshot,epoch);
    let incoming=asMemoryMessages(raw);
    if(this.controls)incoming=await this.controls.filterMessages(userId,conversationId,incoming);
    incoming=personaMemoryMessages(incoming,personaKey);
    const {history,snapshot}=buildConversationMemory(incoming,personaKey);
    const latestSource=raw[raw.length-1],needsBuild=!cached||!!latestSource&&afterMemoryCursor(latestSource,cached.cursor);
    if(needsBuild)await this.enqueue(conversationId,userId,personaKey,epoch);
    const job=await this.prisma.memoryRebuildJob.findUnique({where:{conversationId},select:{status:true,epoch:true}});
    const rebuilding=needsBuild||job?.epoch===epoch&&job.status!=='READY';
    if(cached){
      const delta=incoming.filter(message=>{const source=raw.find(row=>row.id===message.messageId);return source&&afterMemoryCursor(source,cached.cursor);});
      const ephemeral=structuredClone(cached);
      // A lagging checkpoint and the latest window may have an unseen gap. Do
      // not attach its old pending question to an unrelated newest assistant.
      if(cached.cursor&&!raw.some(row=>row.id===cached.cursor!.id)){
        ephemeral.pending=[];ephemeral.reducer={};
      }
      reduceMemoryBatch(ephemeral,delta,personaKey);snapshot.state=ephemeral.state;
    }
    const before=history[0]?.messageId??2147483647;
    const terms=memoryTerms(question);
    const recent=cached?await this.prisma.conversationEpisode.findMany({where:{conversationId,personaKey,lastMessageId:{lt:before}},
      orderBy:{lastMessageId:'desc'},take:6}):[];
    const related=cached&&terms.length?await this.relatedEpisodes(userId,conversationId,personaKey,epoch,before,terms.join(' '),false):[];
    const episodes=[...new Map([...related,...recent].map(episode=>[episode.lastMessageId,episode])).values()];
    episodes.sort((a,b)=>terms.filter(term=>b.text.includes(term)).length-terms.filter(term=>a.text.includes(term)).length||b.lastMessageId-a.lastMessageId);
    const topics:Array<{text:string;sourceIds:number[]}>=[],sharedMemorySources:NonNullable<ConversationFrame['sharedMemorySources']>=[];let characters=0;
    for(const episode of episodes.slice(0,18))if(characters+episode.text.length+2<=SUMMARY_CHAR_BUDGET){
      topics.push({text:episode.text,sourceIds:episode.sourceIds as number[]});characters+=episode.text.length+2;
    }
    if(conversation.sharedMemory&&terms.length){
      const shared=await this.relatedEpisodes(userId,conversationId,personaKey,epoch,before,terms.join(' '),true,conversation.conversationType);
      shared.sort((a,b)=>terms.filter(term=>b.text.includes(term)).length-terms.filter(term=>a.text.includes(term)).length||b.lastMessageId-a.lastMessageId);
      for(const episode of shared.filter(episode=>terms.some(term=>episode.text.includes(term))).slice(0,4)){
        const text=`[同模式同身份的另一会话 #${episode.conversationId}；旧摘录不覆盖本会话的新约定]\n${episode.text}`;
        if(characters+text.length+2<=SUMMARY_CHAR_BUDGET){
          const sourceIds=episode.sourceIds as number[];
          topics.push({text,sourceIds});characters+=text.length+2;
          sharedMemorySources.push({conversationId:episode.conversationId,memoryEpoch:episode.sourceEpoch,
            personaKey:episode.personaKey,conversationType:episode.sourceType,sourceIds});
        }
      }
    }
    if(rebuilding&&(raw.length>=62||(cached?.totalTurns||0)>snapshot.window.recentTurns))
      topics.push({text:MEMORY_REBUILD_NOTICE,sourceIds:[]});
    snapshot.summary={kind:'extractive_not_canon',text:topics.map(topic=>topic.text).join('\n'),topics,
      sourceIds:topics.flatMap(topic=>topic.sourceIds),omittedTurns:Math.max(0,(cached?.totalTurns||snapshot.window.recentTurns)-snapshot.window.recentTurns)};
    const evidenceHistory=episodes.filter(episode=>episode.evidence).slice(0,3).map(episode=>episode.evidence as unknown as MemoryMessage);
    const frame:ConversationFrame={history,evidenceHistory,persona,question,sourceEpoch:epoch,sharedMemorySources,memory:{...snapshot,
      state:interactionState([{role:'user',content:question}],snapshot.state,{...(cached?.reducer||{})})}};
    if(!await this.prisma.conversation.findFirst({where:{id:conversationId,userId,memoryEpoch:epoch,user:{status:'ACTIVE'}},select:{id:true}}))
      throw new ForbiddenException('对话历史已改变，请重试');
    const finalFrame=this.controls?await this.controls.applyToFrame(userId,conversationId,frame):frame;
    const kept=new Set(finalFrame.memory.summary.topics.flatMap(topic=>topic.sourceIds));
    finalFrame.sharedMemorySources=sharedMemorySources.map(source=>({...source,sourceIds:source.sourceIds.filter(id=>kept.has(id))}))
      .filter(source=>source.sourceIds.length>0);
    await this.assertCurrentSources(userId,conversationId,finalFrame);
    return finalFrame;
  }

  async assertCurrentSources(userId:number,conversationId:number,frame:ConversationFrame,db:PrismaService|Prisma.TransactionClient=this.prisma){
    if(frame.sourceEpoch===undefined&&!frame.sharedMemorySources?.length)return; // Old test-only frames have no persisted provenance.
    const sources=frame.sharedMemorySources||[],ids=[...new Set([conversationId,...sources.map(source=>source.conversationId)])].sort((a,b)=>a-b);
    if(sources.length>4)throw new ConversationHistoryChangedError();
    if(db!==this.prisma){
      // Account -> sorted conversations is the same lock order for overlapping
      // shared frames, forget/delete and explicit sharing changes.
      const account=await db.$queryRaw<Array<{id:number}>>`SELECT id FROM users WHERE id=${userId} AND status='ACTIVE' FOR UPDATE`;
      if(!account.length)throw new ConversationHistoryChangedError();
      await db.$queryRaw`SELECT id FROM conversations WHERE userId=${userId} AND id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
    }
    const rows=await db.conversation.findMany({where:{id:{in:ids},userId,user:{status:'ACTIVE'}},
      select:{id:true,memoryEpoch:true,sharedMemory:true,personaKey:true,conversationType:true}});
    const target=rows.find(row=>row.id===conversationId);
    if(!target||target.memoryEpoch!==frame.sourceEpoch||target.personaKey!==frame.memory.personaKey)
      throw new ConversationHistoryChangedError();
    for(const source of sources){
      const row=rows.find(row=>row.id===source.conversationId);
      if(!target.sharedMemory||!row?.sharedMemory||row.memoryEpoch!==source.memoryEpoch||row.personaKey!==source.personaKey||
        row.conversationType!==source.conversationType||row.personaKey!==target.personaKey||row.conversationType!==target.conversationType||
        !source.sourceIds.length||source.sourceIds.length>8)throw new ConversationHistoryChangedError();
    }
    if(sources.length){
      // This check runs at each published stream flush. Batch all adopted
      // sources instead of issuing two extra queries per source conversation.
      const sourceIds=[...new Set(sources.flatMap(source=>source.sourceIds))];
      const [messages,suppressed]=await Promise.all([
        db.chatMessage.findMany({where:{conversationId:{in:sources.map(source=>source.conversationId)},id:{in:sourceIds}},
          select:{id:true,conversationId:true}}),
        db.conversationMemorySuppression.count({where:{userId,messageId:{in:sourceIds}}}),
      ]);
      if(suppressed||sources.some(source=>messages.filter(row=>row.conversationId===source.conversationId&&
        source.sourceIds.includes(row.id)).length!==source.sourceIds.length))throw new ConversationHistoryChangedError();
    }
  }

  private async relatedEpisodes(userId:number,conversationId:number,personaKey:string,epoch:number,before:number,query:string,shared:boolean,type?:string):Promise<Array<ConversationEpisode&{sourceEpoch?:number;sourceType?:string}>>{
    try {
      if(shared)return await this.prisma.$queryRaw<Array<ConversationEpisode&{sourceEpoch:number;sourceType:string}>>`
        SELECT e.*,c.memoryEpoch AS sourceEpoch,c.conversationType AS sourceType FROM conversation_episodes e JOIN conversations c ON c.id=e.conversationId JOIN users u ON u.id=c.userId
        JOIN conversation_memories m ON m.conversationId=c.id AND m.personaKey=e.personaKey
        WHERE u.id=${userId} AND u.status='ACTIVE' AND c.id<>${conversationId} AND c.conversationType=${type}
          AND c.personaKey=${personaKey} AND c.sharedMemory=true AND e.personaKey=${personaKey}
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(m.snapshot,'$.cache.epoch')) AS UNSIGNED)=c.memoryEpoch
          AND MATCH(e.text) AGAINST(${query} IN NATURAL LANGUAGE MODE)
        ORDER BY MATCH(e.text) AGAINST(${query} IN NATURAL LANGUAGE MODE) DESC,e.lastMessageId DESC LIMIT 4`;
      return await this.prisma.$queryRaw<ConversationEpisode[]>`
        SELECT e.* FROM conversation_episodes e JOIN conversations c ON c.id=e.conversationId JOIN users u ON u.id=c.userId
        WHERE u.id=${userId} AND u.status='ACTIVE' AND c.id=${conversationId} AND c.memoryEpoch=${epoch}
          AND c.personaKey=${personaKey} AND e.personaKey=${personaKey} AND e.lastMessageId<${before}
          AND MATCH(e.text) AGAINST(${query} IN NATURAL LANGUAGE MODE)
        ORDER BY MATCH(e.text) AGAINST(${query} IN NATURAL LANGUAGE MODE) DESC,e.lastMessageId DESC LIMIT 12`;
    } catch {throw new ServiceUnavailableException('历史记忆检索暂不可用，请稍后重试');}
  }

  async enqueue(conversationId:number,userId:number,personaKey:string,epoch:number){
    await this.prisma.memoryRebuildJob.upsert({where:{conversationId},create:{conversationId,userId,personaKey,epoch},update:{}});
    // An older request cannot reset a newer job's monotonic source epoch.
    await this.prisma.memoryRebuildJob.updateMany({where:{conversationId,userId,epoch:{lt:epoch}},data:{epoch,personaKey,status:'QUEUED',
      workerToken:null,leaseUntil:null,nextAttemptAt:new Date(),attempts:0,errorCode:null}});
    await this.prisma.memoryRebuildJob.updateMany({where:{conversationId,userId,epoch,status:{in:['READY','STALE']}},data:{status:'QUEUED',nextAttemptAt:new Date()}});
  }

  async tickRebuild(){
    if(this.busy)return;this.busy=true;
    try{for(let slot=0;slot<2;slot++){
      const now=new Date(),job=await this.prisma.memoryRebuildJob.findFirst({where:{OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},
        {status:'RUNNING',leaseUntil:{lt:now}}]},orderBy:[{nextAttemptAt:'asc'},{conversationId:'asc'}]});
      if(!job)break;
      const token=randomUUID(),claimed=await this.prisma.memoryRebuildJob.updateMany({where:{conversationId:job.conversationId,epoch:job.epoch,
        OR:[{status:'QUEUED',nextAttemptAt:{lte:now}},{status:'RUNNING',leaseUntil:{lt:now}}]},data:{status:'RUNNING',workerToken:token,leaseUntil:new Date(Date.now()+30000)}});
      if(!claimed.count)continue;
      try{await this.rebuildBatch(job,token);}catch{
        await this.prisma.memoryRebuildJob.updateMany({where:{conversationId:job.conversationId,epoch:job.epoch,workerToken:token,status:'RUNNING'},
          data:{status:'QUEUED',workerToken:null,leaseUntil:null,attempts:{increment:1},errorCode:'MEMORY_REBUILD_RETRY',
            nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**Math.min(job.attempts,6)))}});
      }
    }}finally{this.busy=false;}
  }

  private async rebuildBatch(job:{conversationId:number;userId:number;personaKey:string;epoch:number},token:string){
    const conversation=await this.prisma.conversation.findFirst({where:{id:job.conversationId,userId:job.userId,memoryEpoch:job.epoch,
      personaKey:job.personaKey,user:{status:'ACTIVE'},conversationType:{in:['ASSISTANT','ROLEPLAY']}},select:{id:true}});
    if(!conversation){await this.prisma.memoryRebuildJob.updateMany({where:{conversationId:job.conversationId,workerToken:token},
      data:{status:'STALE',workerToken:null,leaseUntil:null}});return;}
    const saved=await this.prisma.conversationMemory.findUnique({where:{conversationId_personaKey:{conversationId:job.conversationId,personaKey:job.personaKey}}});
    const old=memoryCache(saved?.snapshot,job.epoch),cache=structuredClone(old||emptyMemoryCache(job.epoch));
    const batch=await this.prisma.chatMessage.findMany({where:{conversationId:job.conversationId,...(cache.cursor?{OR:[
      {createdAt:{gt:new Date(cache.cursor.createdAt)}},{createdAt:new Date(cache.cursor.createdAt),id:{gt:cache.cursor.id}}]}:{})},
      orderBy:[{createdAt:'asc'},{id:'asc'}],take:BATCH_SIZE,select:MESSAGE_SELECT});
    let incoming=asMemoryMessages(batch);if(this.controls)incoming=await this.controls.filterMessages(job.userId,job.conversationId,incoming);
    const episodes=reduceMemoryBatch(cache,incoming,job.personaKey);
    // Advance the raw cursor even when all source rows were suppressed.
    const last=batch[batch.length-1];if(last)cache.cursor={id:last.id,createdAt:last.createdAt.toISOString()};
    const {snapshot}=buildConversationMemory(cache.working,job.personaKey);snapshot.state=cache.state;
    await this.prisma.$transaction(async tx=>{
      const locked=await tx.$queryRaw<Array<{memoryEpoch:number;personaKey:string;conversationType:string}>>`
        SELECT memoryEpoch,personaKey,conversationType FROM conversations WHERE id=${job.conversationId} AND userId=${job.userId} FOR UPDATE`;
      if(!locked.length||locked[0].memoryEpoch!==job.epoch||locked[0].personaKey!==job.personaKey||locked[0].conversationType==='LEGACY')return;
      const updated=await tx.memoryRebuildJob.updateMany({where:{conversationId:job.conversationId,epoch:job.epoch,workerToken:token,
        status:'RUNNING',leaseUntil:{gt:new Date()}},data:{status:batch.length<BATCH_SIZE?'READY':'QUEUED',workerToken:null,leaseUntil:null,
          nextAttemptAt:new Date(),attempts:0,errorCode:null}});
      if(!updated.count)return;
      if(!old)await tx.conversationEpisode.deleteMany({where:{conversationId:job.conversationId,personaKey:job.personaKey}});
      if(episodes.length)await tx.conversationEpisode.createMany({data:episodes.map(episode=>({...episode,conversationId:job.conversationId})),skipDuplicates:true});
      const data={revision:snapshot.revision,snapshot:JSON.parse(JSON.stringify({...snapshot,cache}))};
      await tx.conversationMemory.upsert({where:{conversationId_personaKey:{conversationId:job.conversationId,personaKey:job.personaKey}},
        create:{conversationId:job.conversationId,personaKey:job.personaKey,...data},update:data});
    },{timeout:5000});
  }
}

export function memoryTerms(question:string):string[]{
  const clean=question.replace(/还记得|我们|你们|什么|怎么|那个|这个|之前|时候|可以|一下/g,' ');
  const words=clean.match(/[a-zA-Z0-9_-]{2,24}|[\u3400-\u9fff]{2,}/g)||[];
  return[...new Set(words.flatMap(word=>/^[\u3400-\u9fff]+$/.test(word)&&word.length>3?
    Array.from({length:word.length-1},(_,index)=>word.slice(index,index+2)):[word]))].slice(0,12);
}

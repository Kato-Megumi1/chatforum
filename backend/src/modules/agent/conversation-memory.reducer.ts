import { storedRagMessage } from './rag-history';
import { buildConversationMemory, conversationTurns, interactionState, InteractionCursor, InteractionState, MemoryMessage, MEMORY_VERSION, turnExcerpt } from './conversation-memory.policy';

export interface MemoryCache {
  version:string;epoch:number;cursor?:{id:number;createdAt:string};working:MemoryMessage[];pending:MemoryMessage[];
  state:InteractionState;reducer:InteractionCursor;totalTurns:number;unpaired:number;
}
export const emptyMemoryCache=(epoch:number):MemoryCache=>({version:MEMORY_VERSION,epoch,working:[],pending:[],
  state:interactionState([]),reducer:{},totalTurns:0,unpaired:0});
export const memoryCache=(snapshot:any,epoch:number):MemoryCache|undefined=>{
  const cached=snapshot?.cache;
  return cached?.version===MEMORY_VERSION&&cached.epoch===epoch&&Array.isArray(cached.working)&&Array.isArray(cached.pending)?cached:undefined;
};
export const afterMemoryCursor=(row:{id:number;createdAt:Date},cursor?:MemoryCache['cursor'])=>!cursor||
  row.createdAt.getTime()>new Date(cursor.createdAt).getTime()||row.createdAt.getTime()===new Date(cursor.createdAt).getTime()&&row.id>cursor.id;
export function personaMemoryMessages(incoming:MemoryMessage[],personaKey:string){
  const units=conversationTurns(incoming),allowed=new Set(units.turns.filter(turn=>!turn.some(message=>message.role==='assistant'&&
    (message.ragMetadata as any)?.personaKey&&(message.ragMetadata as any).personaKey!==personaKey)).flat());
  for(const orphan of units.orphans)if(orphan.role==='user')allowed.add(orphan);
  return incoming.filter(message=>allowed.has(message));
}
export function reduceMemoryBatch(cache:MemoryCache,incoming:MemoryMessage[],personaKey:string) {
  const units=conversationTurns([...cache.pending,...incoming]),tail=incoming[incoming.length-1]||cache.pending[cache.pending.length-1];
  cache.pending=tail?.role==='user'?[tail]:[];
  cache.unpaired+=units.orphans.filter(message=>message.messageId!==cache.pending[0]?.messageId).length;
  const relevant=units.turns.filter(turn=>!turn.some(message=>message.role==='assistant'&&
    (message.ragMetadata as any)?.personaKey&&(message.ragMetadata as any).personaKey!==personaKey));
  cache.state=interactionState(relevant.flat(),cache.state,cache.reducer);cache.totalTurns+=relevant.length;
  // The cache is bounded by characters too: thirty large source answers must
  // not turn a hot read into megabytes of otherwise unused historical code.
  cache.working=buildConversationMemory([...cache.working,...relevant.flat()],personaKey).history;
  return relevant.map(turn=>{
    const last=turn[turn.length-1],raw=last.ragMetadata as any;
    const evidence=raw?.state==='grounded'&&Array.isArray(raw.sceneEvents)&&raw.sceneEvents.length?{
      messageId:last.messageId,role:'assistant',content:last.content.slice(0,1200),ragMetadata:{state:raw.state,
        knowledgeBaseId:raw.knowledgeBaseId,indexVersion:raw.indexVersion,sceneEvents:raw.sceneEvents.slice(0,3),citations:raw.citations?.slice(0,6)}}:undefined;
    return {personaKey,lastMessageId:last.messageId,text:turnExcerpt(turn),sourceIds:turn.map(message=>message.messageId),
      ...(evidence?{evidence:JSON.parse(JSON.stringify(evidence))}:{})};
  });
}
export const asMemoryMessages=(rows:Array<{id:number;role:string;content:string;ragMetadata?:unknown}>)=>
  rows.map(row=>({...storedRagMessage(row),content:row.content})) as MemoryMessage[];

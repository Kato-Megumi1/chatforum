import { ConversationMemoryService } from './conversation-memory.service';
import { emptyMemoryCache,reduceMemoryBatch } from './conversation-memory.reducer';
import { buildConversationMemory } from './conversation-memory.policy';

describe('bounded durable derived memory rebuild',()=>{
  const rows=Array.from({length:200},(_,i)=>({id:i+1,role:i%2?'ASSISTANT':'USER',content:i%2?'回应'+i:'问题'+i,
    createdAt:new Date(1000),ragMetadata:{personaKey:'assistant'}}));
  const make=(epoch=2)=>{
    const tx={conversationEpisode:{deleteMany:jest.fn(),createMany:jest.fn()},conversationMemory:{upsert:jest.fn()},
      memoryRebuildJob:{updateMany:jest.fn().mockResolvedValue({count:1})},
      $queryRaw:jest.fn().mockResolvedValue([{memoryEpoch:epoch,personaKey:'assistant',conversationType:'ASSISTANT'}])};
    const db={conversation:{findFirst:jest.fn().mockResolvedValue({id:4,memoryEpoch:2,conversationType:'ASSISTANT',personaKey:'assistant',sharedMemory:false}),
      findMany:jest.fn().mockResolvedValue([{id:4,memoryEpoch:2,conversationType:'ASSISTANT',personaKey:'assistant',sharedMemory:false}])},
      conversationMemory:{findUnique:jest.fn().mockResolvedValue(null)},chatMessage:{findMany:jest.fn().mockResolvedValue(rows)},
      conversationEpisode:{findMany:jest.fn().mockResolvedValue([])},memoryRebuildJob:{upsert:jest.fn(),updateMany:jest.fn().mockResolvedValue({count:1}),
        findUnique:jest.fn().mockResolvedValue({epoch:2,status:'QUEUED'}),findFirst:jest.fn().mockResolvedValue(null)},
      $transaction:jest.fn(async(callback:any)=>callback(tx)),$queryRaw:jest.fn().mockResolvedValue([])};
    return{db,tx,service:new ConversationMemoryService(db as any)};
  };
  const job={conversationId:4,userId:3,personaKey:'assistant',epoch:2};
  test('cold prepare reads a bounded newest window without any transaction or full scan',async()=>{
    const f=make();f.db.chatMessage.findMany.mockResolvedValue(rows.slice(-62).reverse());
    const frame=await f.service.prepare(4,3,'assistant','fixture','你好');
    expect(frame.history).toHaveLength(60);expect(frame.sourceEpoch).toBe(2);
    expect(f.db.chatMessage.findMany).toHaveBeenCalledTimes(1);
    expect(f.db.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({take:62,orderBy:[{createdAt:'desc'},{id:'desc'}]}));
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.memoryRebuildJob.upsert).toHaveBeenCalled();
    expect(frame.memory.summary.text).toContain('后台恢复');
  });
  test('each background batch reads at most 200 then commits behind short epoch/token/lease checks',async()=>{
    const f=make();await (f.service as any).rebuildBatch(job,'worker');
    expect(f.db.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({take:200}));
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function),{timeout:5000});
    expect(f.tx.memoryRebuildJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({epoch:2,workerToken:'worker',status:'RUNNING'}),
      data:expect.objectContaining({status:'QUEUED'})}));
    const cache=f.tx.conversationMemory.upsert.mock.calls[0][0].update.snapshot.cache;
    expect(cache.cursor.id).toBe(200);expect(cache.totalTurns).toBe(100);expect(cache.working).toHaveLength(60);
  });
  test('deletion/forget racing a read cannot publish an old-epoch derived snapshot',async()=>{
    const f=make(3);await (f.service as any).rebuildBatch(job,'worker');
    expect(f.tx.conversationMemory.upsert).not.toHaveBeenCalled();expect(f.tx.conversationEpisode.createMany).not.toHaveBeenCalled();
    expect(f.tx.memoryRebuildJob.updateMany).not.toHaveBeenCalled();
  });
  test('a lost worker lease does not write episodes or cache',async()=>{
    const f=make();f.tx.memoryRebuildJob.updateMany.mockResolvedValue({count:0});
    await (f.service as any).rebuildBatch(job,'worker');
    expect(f.tx.conversationMemory.upsert).not.toHaveBeenCalled();expect(f.tx.conversationEpisode.createMany).not.toHaveBeenCalled();
  });
  test('suppressed raw rows still advance the checkpoint and never become relationship state',async()=>{
    const f=make(),controls={filterMessages:jest.fn().mockResolvedValue([])};
    const service=new ConversationMemoryService(f.db as any,controls as any);
    await (service as any).rebuildBatch(job,'worker');
    const cache=f.tx.conversationMemory.upsert.mock.calls[0][0].update.snapshot.cache;
    expect(cache.cursor.id).toBe(200);expect(cache.totalTurns).toBe(0);expect(cache.working).toEqual([]);
    expect(f.tx.conversationEpisode.createMany).not.toHaveBeenCalled();
  });
  test('background checkpoints preserve pending user pairing across exact batch boundaries',()=>{
    const cache=emptyMemoryCache(2);
    reduceMemoryBatch(cache,[{role:'user',content:'我叫小舟',messageId:1}],'assistant');
    const episode=reduceMemoryBatch(cache,[{role:'assistant',content:'你好',messageId:2}],'assistant');
    expect(episode[0].sourceIds).toEqual([1,2]);expect(cache.totalTurns).toBe(1);
    expect(buildConversationMemory(cache.working,'assistant').history).toHaveLength(2);
  });
  test('an empty final checkpoint cannot discard an unmatched user before a later assistant reply',()=>{
    const cache=emptyMemoryCache(2);
    reduceMemoryBatch(cache,[{role:'user',content:'我叫小舟',messageId:1}],'assistant');
    reduceMemoryBatch(cache,[],'assistant');
    const episodes=reduceMemoryBatch(cache,[{role:'assistant',content:'你好',messageId:2}],'assistant');
    expect(episodes[0].sourceIds).toEqual([1,2]);expect(cache.totalTurns).toBe(1);
  });
  test('a lagging cache cannot join its old pending confession to a newest orphan answer across a gap',async()=>{
    const f=make(),cache=emptyMemoryCache(2);
    reduceMemoryBatch(cache,[{role:'user',content:'我们交往吧',messageId:1}],'assistant');cache.cursor={id:1,createdAt:new Date(0).toISOString()};
    f.db.conversationMemory.findUnique.mockResolvedValue({snapshot:{cache}} as any);
    const recent=[{...rows[1],id:1000,content:'我们交往吧'}];
    f.db.chatMessage.findMany.mockResolvedValue(recent);
    const frame=await f.service.prepare(4,3,'assistant','fixture','你好');
    expect(frame.memory.state.relationship.status).toBe('not_established');
    expect(frame.history).toEqual([]);expect(f.db.memoryRebuildJob.upsert).toHaveBeenCalled();
  });
  test('derived working history honors the character budget even with thirty huge answers',()=>{
    const cache=emptyMemoryCache(2);
    reduceMemoryBatch(cache,Array.from({length:60},(_,i)=>({role:i%2?'assistant':'user',content:'源代码'.repeat(20000),messageId:i+1})),'assistant');
    expect(cache.working.reduce((sum,row)=>sum+row.content.length,0)).toBeLessThanOrEqual(24000);
    expect(cache.working.some(row=>row.historyExcerpt)).toBe(true);expect(cache.totalTurns).toBe(30);
  });
  test('claims are CAS-scoped and the timer processes only two batches per tick',async()=>{
    const f=make();f.db.memoryRebuildJob.findFirst.mockResolvedValue({...job,attempts:0,status:'QUEUED'} as any);
    const batch=jest.spyOn(f.service as any,'rebuildBatch').mockResolvedValue(undefined);
    await f.service.tickRebuild();expect(batch).toHaveBeenCalledTimes(2);expect(f.db.memoryRebuildJob.findFirst).toHaveBeenCalledTimes(2);
  });
});

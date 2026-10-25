import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.service';
import { ChatService } from '../chat/chat.service';
import { ConversationMemoryService } from './conversation-memory.service';
import { MemoryControlsService } from './memory-controls.service';

const run=process.env.RUN_MEMORY_HISTORY_INTEGRATION==='1'?describe:describe.skip;
run('isolated MySQL bounded history and source-epoch memory rebuild',()=>{
  let db:PrismaService,chats:ChatService,memory:ConversationMemoryService,owner:number,other:number;
  const oldSecret=process.env.JWT_ACCESS_SECRET,ids:number[]=[];
  beforeAll(async()=>{
    if(process.env.DATABASE_URL!=='mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test')
      throw Error('Refusing non-fixture DB');
    process.env.JWT_ACCESS_SECRET='fixture-memory-history-hmac-secret-32';
    db=new PrismaService();await db.$connect();memory=new ConversationMemoryService(db,new MemoryControlsService(db));chats=new ChatService(db,memory);
    for(let i=0;i<2;i++){
      const key=randomUUID(),user=await db.user.create({data:{username:key,email:key+'@example.test',password:'disabled-fixture'}});
      ids.push(user.id);if(i)other=user.id;else owner=user.id;
    }
  });
  afterAll(async()=>{
    try{if(ids.length)await db.user.deleteMany({where:{id:{in:ids}}});}finally{await db?.$disconnect();}
    if(oldSecret===undefined)delete process.env.JWT_ACCESS_SECRET;else process.env.JWT_ACCESS_SECRET=oldSecret;
  });
  const create=async(userId=owner,personaKey='assistant',sharedMemory=false)=>db.conversation.create({data:{title:'synthetic-history',userId,
    conversationType:personaKey==='assistant'?'ASSISTANT':'ROLEPLAY',personaKey,sharedMemory}});
  const append=async(cid:number,count:number,prefix='日常',personaKey='assistant')=>{
    const createdAt=new Date('2026-01-01T00:00:00.000Z');
    await db.chatMessage.createMany({data:Array.from({length:count},(_,i)=>({conversationId:cid,createdAt,
      role:i%2?'ASSISTANT':'USER',content:i%2?`${prefix}回答${i}`:`${prefix}问题${i}`,ragMetadata:{personaKey}})) as any});
    return db.chatMessage.findMany({where:{conversationId:cid},orderBy:{id:'asc'}});
  };
  // Deliberately claim only this test's own job. Never consume another fixture's queue.
  const batch=async(cid:number,service=memory)=>{
    const job=await db.memoryRebuildJob.findUniqueOrThrow({where:{conversationId:cid}}),token=randomUUID();
    await db.memoryRebuildJob.update({where:{conversationId:cid},data:{status:'RUNNING',workerToken:token,leaseUntil:new Date(Date.now()+30000)}});
    await (service as any).rebuildBatch(job,token);
    return db.memoryRebuildJob.findUniqueOrThrow({where:{conversationId:cid}});
  };
  test('stable signed seek pages remain bounded through ties, inserts, deleted anchors and owner changes',async()=>{
    const c=await create(),rows=await append(c.id,122);
    const page=await chats.getMessagePage(c.id,owner);
    expect(page.items.map(row=>row.id)).toEqual(rows.slice(-40).map(row=>row.id));expect(page.hasMore).toBe(true);
    await db.chatMessage.create({data:{conversationId:c.id,role:'USER',content:'later fixture row'}});
    // The signed tuple still works after its anchor itself is deleted.
    await db.chatMessage.delete({where:{id:page.items[0].id}});
    const previous=await chats.getMessagePage(c.id,owner,{before:page.olderCursor!});
    expect(previous.items.map(row=>row.id)).toEqual(rows.slice(42,82).map(row=>row.id));
    expect(previous.items.some(row=>page.items.some(latest=>row.id===latest.id))).toBe(false);
    const around=await chats.getMessagePage(c.id,owner,{around:String(rows[31].id)});
    expect(around.items).toHaveLength(40);expect(around.items.some(row=>row.id===rows[31].id)).toBe(true);
    await expect(chats.getMessagePage(c.id,other,{before:page.olderCursor!})).rejects.toThrow('对话不可访问');
    const second=await create();await expect(chats.getMessagePage(second.id,owner,{before:page.olderCursor!})).rejects.toThrow('会话游标无效');
    await db.user.update({where:{id:owner},data:{status:'INACTIVE'}});
    try{await expect(chats.getMessagePage(c.id,owner)).rejects.toThrow('对话不可访问');}
    finally{await db.user.update({where:{id:owner},data:{status:'ACTIVE'}});}
  });
  test('cold preparation returns recent complete turns while 481 source rows rebuild in three bounded commits',async()=>{
    const c=await create(),rows=await append(c.id,481,'蓝海');
    const frame=await memory.prepare(c.id,owner,'assistant','fixture','蓝海问题');
    expect(frame.history).toHaveLength(60);expect(frame.memory.window.characterCount).toBeLessThanOrEqual(24000);
    expect(await db.conversationEpisode.count({where:{conversationId:c.id}})).toBe(0);
    expect((await batch(c.id)).status).toBe('QUEUED');
    let cache=(await db.conversationMemory.findUniqueOrThrow({where:{conversationId_personaKey:{conversationId:c.id,personaKey:'assistant'}}})).snapshot as any;
    expect(cache.cache.cursor.id).toBe(rows[199].id);expect(cache.cache.totalTurns).toBe(100);
    expect((await batch(c.id)).status).toBe('QUEUED');expect((await batch(c.id)).status).toBe('READY');
    cache=(await db.conversationMemory.findUniqueOrThrow({where:{conversationId_personaKey:{conversationId:c.id,personaKey:'assistant'}}})).snapshot as any;
    expect(cache.cache.cursor.id).toBe(rows[480].id);expect(cache.cache.pending[0].messageId).toBe(rows[480].id);
    expect(await db.conversationEpisode.count({where:{conversationId:c.id}})).toBe(240);
    const hot=await memory.prepare(c.id,owner,'assistant','fixture','蓝海问题');
    expect(hot.history).toHaveLength(60);expect(hot.memory.summary.sourceIds.length).toBeGreaterThan(0);
    expect(hot.memory.summary.text).not.toContain('后台恢复');
  },15000);
  test('suppression excludes both sources yet advances the raw cursor rather than retrying the same batch',async()=>{
    const c=await create(),rows=await append(c.id,204,'排除记忆');
    await db.conversationMemorySuppression.createMany({data:rows.slice(0,200).map(row=>({userId:owner,conversationId:c.id,messageId:row.id}))});
    await memory.prepare(c.id,owner,'assistant','fixture','你好');await batch(c.id);
    const cache=(await db.conversationMemory.findUniqueOrThrow({where:{conversationId_personaKey:{conversationId:c.id,personaKey:'assistant'}}})).snapshot as any;
    expect(cache.cache.cursor.id).toBe(rows[199].id);expect(cache.cache.totalTurns).toBe(0);
    await batch(c.id);expect(await db.conversationEpisode.count({where:{conversationId:c.id}})).toBe(2);
    const frame=await memory.prepare(c.id,owner,'assistant','fixture','你好');
    expect(frame.history.map(row=>row.messageId)).toEqual(rows.slice(200).map(row=>row.id));
  });
  test.each(['epoch','lease'])('a %s change between batch read and commit cannot publish stale derived data',async kind=>{
    const c=await create();await append(c.id,202);await memory.prepare(c.id,owner,'assistant','fixture','你好');
    const original=db.chatMessage.findMany.bind(db.chatMessage);let changed=false;
    const spy=jest.spyOn(db.chatMessage,'findMany').mockImplementation((async(args:any)=>{
      const rows=await original(args);
      if(!changed&&args?.where?.conversationId===c.id){changed=true;
        if(kind==='epoch')await db.conversation.update({where:{id:c.id},data:{memoryEpoch:{increment:1}}});
        else await db.memoryRebuildJob.update({where:{conversationId:c.id},data:{workerToken:randomUUID()}});
      }
      return rows;
    }) as any);
    try{await batch(c.id);}finally{spy.mockRestore();}
    expect(changed).toBe(true);expect(await db.conversationMemory.count({where:{conversationId:c.id}})).toBe(0);
    expect(await db.conversationEpisode.count({where:{conversationId:c.id}})).toBe(0);
  });
  test('ngram recall shares only the same current owner, mode, persona and explicit opt-in',async()=>{
    const cases=[await create(owner,'assistant',true),await create(owner,'assistant',false),
      await create(other,'assistant',true),await create(owner,'kato_megumi_persona',true)];
    const words=['蓝海允许摘录','蓝海未授权摘录','蓝海他人摘录','蓝海角色摘录'];
    for(let i=0;i<cases.length;i++){
      const c=cases[i];await append(c.id,2,words[i],c.personaKey!);
      await memory.prepare(c.id,c.userId,c.personaKey!,'fixture','你好');await batch(c.id);
    }
    const destination=await create(owner,'assistant',true),frame=await memory.prepare(destination.id,owner,'assistant','fixture','蓝海');
    expect(frame.memory.summary.text).toContain(words[0]);
    for(const word of words.slice(1))expect(frame.memory.summary.text).not.toContain(word);
    await db.conversation.update({where:{id:cases[0].id},data:{memoryEpoch:{increment:1}}});
    expect((await memory.prepare(destination.id,owner,'assistant','fixture','蓝海')).memory.summary.text).not.toContain(words[0]);
  });
  test.each(['source-revoke','source-forget','target-revoke','source-suppress'])('prepared shared provenance rejects %s before streaming or a final transaction',async action=>{
    const source=await create(owner,'assistant',true),destination=await create(owner,'assistant',true);
    const rows=await append(source.id,2,'蓝海在途共享');
    await memory.prepare(source.id,owner,'assistant','fixture','你好');await batch(source.id);
    const frame=await memory.prepare(destination.id,owner,'assistant','fixture','蓝海在途');
    expect(frame.sharedMemorySources).toEqual(expect.arrayContaining([expect.objectContaining({conversationId:source.id,memoryEpoch:0,sourceIds:rows.map(row=>row.id)})]));
    expect(frame.sharedMemorySources!.length).toBeLessThanOrEqual(4);
    await memory.assertCurrentSources(owner,destination.id,frame);
    await db.$transaction(tx=>memory.assertCurrentSources(owner,destination.id,frame,tx));
    if(action==='source-revoke')await chats.updateConversation(source.id,owner,{sharedMemory:false});
    if(action==='target-revoke')await chats.updateConversation(destination.id,owner,{sharedMemory:false});
    if(action==='source-forget'){
      const controls=new MemoryControlsService(db),entries=await controls.entries(owner,source.id);
      await controls.forget(owner,source.id,entries.items[0]);
    }
    if(action==='source-suppress')await db.conversationMemorySuppression.create({data:{userId:owner,conversationId:source.id,messageId:rows[0].id}});
    await expect(memory.assertCurrentSources(owner,destination.id,frame)).rejects.toThrow();
    await expect(db.$transaction(tx=>memory.assertCurrentSources(owner,destination.id,frame,tx))).rejects.toThrow();
    if(action!=='source-suppress'){
      const changedId=action==='target-revoke'?destination.id:source.id;
      expect((await db.conversation.findUniqueOrThrow({where:{id:changedId}})).memoryEpoch).toBe(1);
      expect((await db.memoryRebuildJob.findUniqueOrThrow({where:{conversationId:changedId}})).status).toBe('QUEUED');
      expect(await db.conversationMemory.count({where:{conversationId:changedId}})).toBe(0);
    }
  });
  test('a same-value sharing request rechecks inside its lock and cannot overwrite a concurrent change without an epoch',async()=>{
    const c=await create();let release!:()=>void,locked!:()=>void,read!:()=>void;
    const released=new Promise<void>(resolve=>{release=resolve;}),hasLock=new Promise<void>(resolve=>{locked=resolve;}),hasRead=new Promise<void>(resolve=>{read=resolve;});
    const original=db.conversation.findUnique.bind(db.conversation),spy=jest.spyOn(db.conversation,'findUnique').mockImplementation((async(args:any)=>{
      const result=await original(args);if(args?.where?.id===c.id)read();return result;
    }) as any);
    const concurrent=db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM users WHERE id=${owner} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM conversations WHERE id=${c.id} FOR UPDATE`;
      locked();await released;
      await tx.conversation.update({where:{id:c.id},data:{sharedMemory:true,memoryEpoch:{increment:1}}});
    },{timeout:10000});
    let request:Promise<any>|undefined;
    try{
      await hasLock;request=chats.updateConversation(c.id,owner,{sharedMemory:false});await hasRead;release();
      await concurrent;const changed=await request;
      expect(changed.sharedMemory).toBe(false);expect(changed.memoryEpoch).toBe(2);
      expect((await db.memoryRebuildJob.findUniqueOrThrow({where:{conversationId:c.id}})).epoch).toBe(2);
    }finally{release();await concurrent;await request;spy.mockRestore();}
  },15000);
});

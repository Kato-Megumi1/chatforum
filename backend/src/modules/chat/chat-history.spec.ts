import { ChatService } from './chat.service';
import { decodeMessageCursor, encodeMessageCursor } from './chat-history.cursor';

describe('owned bounded chat message seek pages',()=>{
  const oldSecret=process.env.JWT_ACCESS_SECRET;
  beforeAll(()=>{process.env.JWT_ACCESS_SECRET='fixture-chat-history-secret-at-least-32';});
  afterAll(()=>{if(oldSecret===undefined)delete process.env.JWT_ACCESS_SECRET;else process.env.JWT_ACCESS_SECRET=oldSecret;});
  const row=(id:number)=>({id,createdAt:new Date(1000),conversationId:4,role:'ASSISTANT',content:'message'+id});
  const make=(rows:any[]=[])=>{
    const db={conversation:{findFirst:jest.fn().mockResolvedValue({id:4})},chatMessage:{findMany:jest.fn().mockResolvedValue(rows),findFirst:jest.fn()}};
    return{db,service:new ChatService(db as any,{} as any)};
  };
  test('newest page is queried in descending stable order, sent chronologically with an owned next cursor',async()=>{
    const f=make([row(5),row(4),row(3)]),page=await f.service.getMessagePage(4,3,{limit:'2'});
    expect(page.items.map(message=>message.id)).toEqual([4,5]);expect(page.hasMore).toBe(true);
    expect(decodeMessageCursor(page.olderCursor!,3,4)).toEqual({id:4,createdAt:new Date(1000)});
    expect(f.db.chatMessage.findMany).toHaveBeenCalledWith(expect.objectContaining({take:3,orderBy:[{createdAt:'desc'},{id:'desc'}]}));
    expect(f.db.chatMessage.findMany.mock.calls[0][0].select).not.toHaveProperty('reasoningContent');
    expect(f.db.conversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:4,userId:3,user:{status:'ACTIVE'}}}));
  });
  test('same-timestamp older pages seek by id, without OFFSET or full-history COUNT',async()=>{
    const f=make([row(3),row(2)]),cursor=encodeMessageCursor(3,4,row(4));
    await f.service.getMessagePage(4,3,{before:cursor});
    expect(f.db.chatMessage.findMany.mock.calls[0][0]).toMatchObject({take:41,where:{conversationId:4,
      OR:[{createdAt:{lt:new Date(1000)}},{createdAt:new Date(1000),id:{lt:4}}]}});
    expect(f.db.chatMessage.findMany.mock.calls[0][0]).not.toHaveProperty('skip');
  });
  test.each([[8,4],[3,9]])('cursors cannot cross user or conversation %j',async(userId,cid)=>{
    const f=make(),cursor=encodeMessageCursor(3,4,row(4));
    await expect(f.service.getMessagePage(cid,userId,{before:cursor})).rejects.toThrow('会话游标无效');
    expect(f.db.chatMessage.findMany).not.toHaveBeenCalled();
  });
  test('tampered cursors, oversized limits and non-decimal query values fail closed',async()=>{
    const f=make(),cursor=encodeMessageCursor(3,4,row(4));
    await expect(f.service.getMessagePage(4,3,{before:cursor.slice(0,-2)+'xx'})).rejects.toThrow('会话游标无效');
    for(const value of ['81','1e2','-1','0',['10']])await expect(f.service.getMessagePage(4,3,{limit:value})).rejects.toThrow();
  });
  test('source jump is bounded on both sides and rejects foreign/deleted anchors',async()=>{
    const f=make();f.db.chatMessage.findFirst.mockResolvedValue(row(5));
    f.db.chatMessage.findMany.mockResolvedValueOnce([row(5),row(4),row(3)]).mockResolvedValueOnce([row(6),row(7)]);
    const page=await f.service.getMessagePage(4,3,{around:'5',limit:'4'});
    expect(page.items.map(message=>message.id)).toEqual([4,5,6,7]);expect(page.anchorId).toBe(5);expect(page.hasMore).toBe(true);
    expect(f.db.chatMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:5,conversationId:4}}));
    f.db.chatMessage.findFirst.mockResolvedValue(null);
    await expect(f.service.getMessagePage(4,3,{around:'8'})).rejects.toThrow('原消息已删除');
  });
  test('revoked account/conversation ownership is checked before any message reads',async()=>{
    const f=make();f.db.conversation.findFirst.mockResolvedValue(null);
    await expect(f.service.getMessagePage(4,99)).rejects.toThrow('对话不可访问');
    expect(f.db.chatMessage.findMany).not.toHaveBeenCalled();
  });
});

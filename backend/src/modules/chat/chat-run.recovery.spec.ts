import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ChatRunController } from './chat-run.controller';
import { ChatRunService } from './chat-run.service';

describe('owned durable task discovery', () => {
  const id='10000000-0000-4000-8000-000000000001';
  const pointer={draftId:id,revision:2,hash:'a'.repeat(64)};
  const make=()=>{
    const db={user:{findUnique:jest.fn().mockResolvedValue({status:'ACTIVE',authVersion:2})},
      conversation:{findFirst:jest.fn().mockResolvedValue({conversationType:'ASSISTANT',personaKey:'assistant'})},
      chatRun:{findMany:jest.fn().mockResolvedValue([{id,status:'RUNNING',input:{question:'PRIVATE_REQUEST'}}])}};
    const rag={principal:jest.fn().mockResolvedValue({id:3})};
    const service=new ChatRunService(db as any,{} as any,rag as any,{} as any,{} as any,{} as any);
    const get=jest.spyOn(service,'get').mockResolvedValue({id,status:'RUNNING',createdAt:new Date(1000),
      result:{content:'PRIVATE_STREAM'},usage:{steps:['PRIVATE_TOOL']}} as any);
    return{service,db,rag,get};
  };
  test('finds the existing active task ID without exposing input, partial output or usage',async()=>{
    const f=make();expect(await f.service.recovery(3,4,2)).toEqual([{id,status:'RUNNING',createdAt:new Date(1000)}]);
    expect(f.db.chatRun.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{userId:3,conversationId:4},take:8}));
    expect(f.get).toHaveBeenCalledWith(3,id,2);
  });
  test('rechecks current auth version and owner before looking up any task',async()=>{
    const f=make();f.db.user.findUnique.mockResolvedValue({status:'ACTIVE',authVersion:3});
    await expect(f.service.recovery(3,4,2)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.db.chatRun.findMany).not.toHaveBeenCalled();
    f.db.user.findUnique.mockResolvedValue({status:'ACTIVE',authVersion:2});f.db.conversation.findFirst.mockResolvedValue(null as any);
    await expect(f.service.recovery(3,4,2)).rejects.toBeInstanceOf(NotFoundException);
    expect(f.db.chatRun.findMany).not.toHaveBeenCalled();
  });
  test('only validated file failures survive discovery; revoked epoch/no-source errors are not recoverable',async()=>{
    const f=make();f.db.chatRun.findMany.mockResolvedValue([{id,status:'FAILED',input:{question:'PRIVATE_REQUEST'}}]);
    f.get.mockResolvedValue({id,status:'FAILED',result:{failure:{stage:'generation',code:'GENERATION_FAILED',message:'回答未完成'},
      ragMetadata:{generation:{fileIncomplete:true,truncated:true,canContinue:true,resumeFile:pointer,content:'PRIVATE_CODE'}},
      privateState:{content:'PRIVATE_SOURCE'}},createdAt:new Date(1000)} as any);
    const rows=await f.service.recovery(3,4,2);
    expect('result' in rows[0] && rows[0].result?.ragMetadata?.generation?.resumeFile).toEqual(pointer);
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_');
    f.get.mockResolvedValue({id,status:'FAILED',result:{ragMetadata:{generation:{fileIncomplete:true,canContinue:false}}}} as any);
    expect(await f.service.recovery(3,4,2)).toEqual([]);
  });
  test('does not resurrect a failure before a newer successful turn or change a legacy/role identity',async()=>{
    const f=make();f.db.chatRun.findMany.mockResolvedValue([{id,status:'COMPLETED',input:{}},{id:'old',status:'FAILED',input:{}}] as any);
    expect(await f.service.recovery(3,4,2)).toEqual([]);expect(f.get).not.toHaveBeenCalled();
    f.db.conversation.findFirst.mockResolvedValue({conversationType:'LEGACY',personaKey:'assistant'});
    expect(await f.service.recovery(3,4,2)).toEqual([]);
    f.db.conversation.findFirst.mockResolvedValue({conversationType:'ROLEPLAY',personaKey:'kato_megumi_persona'});
    f.db.chatRun.findMany.mockResolvedValue([{id,status:'RUNNING',input:{}}]);
    expect(await f.service.recovery(3,4,2)).toEqual([]);expect(f.get).not.toHaveBeenCalled();
  });
  test('completion racing discovery returns only a refresh hint; never a second generated response',async()=>{
    const f=make();f.get.mockResolvedValue({id,status:'COMPLETED',result:{content:'PRIVATE'},createdAt:new Date(1000)} as any);
    expect(await f.service.recovery(3,4,2)).toEqual([{id,status:'COMPLETED',createdAt:new Date(1000)}]);
  });
  test.each([0,-1,NaN,1.5,Number.MAX_SAFE_INTEGER+1])('invalid conversation %s is rejected',async cid=>{
    const f=make();await expect(f.service.recovery(3,cid,2)).rejects.toThrow('无效的对话编号');
    expect(f.db.chatRun.findMany).not.toHaveBeenCalled();
  });
  test('controller forwards the current authenticated identity and version',async()=>{
    const recovery=jest.fn().mockResolvedValue([]),controller=new ChatRunController({recovery} as any);
    await controller.recovery({sub:3,authVersion:2},4);expect(recovery).toHaveBeenCalledWith(3,4,2);
  });
});

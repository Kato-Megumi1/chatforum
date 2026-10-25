import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ChatRunService } from './chat-run.service';
import { performanceSnapshot, withModelRuntime } from '../agent/model-runtime';
import * as chatModels from './chat-models';

describe('public durable task progress',()=>{
  const createdAt=new Date(1000);
  const create=(data:any)=>{
    const db={chatRun:{findFirst:jest.fn().mockResolvedValue({id:'fixture',input:{},createdAt,...data})},
      user:{findUnique:jest.fn().mockResolvedValue({status:'ACTIVE',authVersion:2})}};
    const rag={principal:jest.fn().mockResolvedValue({id:3}),authorize:jest.fn(),citation:jest.fn()};
    return {service:new ChatRunService(db as any,{} as any,rag as any,{} as any,{} as any,{} as any),db,rag};
  };
  afterEach(()=>jest.restoreAllMocks());
  test('queued jobs expose a real queue clock before a worker is available, without model calls',async()=>{
    jest.spyOn(Date,'now').mockReturnValue(3500);
    const s=create({status:'QUEUED'});const run=await s.service.get(3,'fixture',2);
    expect(run.progress).toMatchObject({phase:'queued',elapsedMs:2500,queueMs:2500,modelCalls:0,activeModelCalls:0});
    expect(run).not.toHaveProperty('input');expect(s.rag.principal).toHaveBeenCalledWith(3);
    expect(s.db.chatRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:{id:'fixture',userId:3}}));
  });
  test('stored running progress is projected through the safe public field and label allowlist',async()=>{
    const s=create({status:'RUNNING',usage:{progress:{stage:'generating',elapsedMs:40,firstTokenMs:null,
      stages:[{stage:'generating',durationMs:20}],phase:'generating',phaseElapsedMs:20,
      modelCalls:2,activeModelCalls:1,reasoning_content:'not a public progress field',toolOutput:'private'}}});
    const run=await s.service.get(3,'fixture');
    expect(run.progress).toEqual({stage:'generating',elapsedMs:40,firstTokenMs:null,
      stages:[{stage:'generating',durationMs:20}],phase:'generating',phaseElapsedMs:20,modelCalls:2,activeModelCalls:1});
  });
  test('stored thinking time remains visible and distinct from the earlier cumulative generation segment',async()=>{
    const s=create({status:'RUNNING',usage:{progress:{stage:'generating',elapsedMs:77600,firstTokenMs:null,
      stages:[{stage:'preparing',durationMs:700},{stage:'generating',durationMs:76900}],phase:'thinking',phaseElapsedMs:74400,
      queueMs:600,modelCalls:1,activeModelCalls:1,activity:'preview_html',
      modelOutput:{thinkingChars:8200,textChars:0,toolChars:0,lastDataElapsedMs:77500,reasoning_content:'private'},
      phases:[{phase:'queued',durationMs:600,modelCalls:0},{phase:'context',durationMs:100,modelCalls:0},
        {phase:'understanding',durationMs:0,modelCalls:0},{phase:'generating',durationMs:2500,modelCalls:1},
        {phase:'thinking',durationMs:74400,modelCalls:0}],reasoning_content:'private chain'}}});
    const run=await s.service.get(3,'fixture');
    expect(run.progress).toEqual({stage:'generating',elapsedMs:77600,firstTokenMs:null,
      stages:[{stage:'preparing',durationMs:700},{stage:'generating',durationMs:76900}],phase:'thinking',phaseElapsedMs:74400,
      queueMs:600,modelCalls:1,activeModelCalls:1,activity:'preview_html',
      modelOutput:{thinkingChars:8200,textChars:0,toolChars:0,lastDataElapsedMs:77500},
      phases:[{phase:'queued',durationMs:600,modelCalls:0},{phase:'context',durationMs:100,modelCalls:0},
        {phase:'understanding',durationMs:0,modelCalls:0},{phase:'generating',durationMs:2500,modelCalls:1},
        {phase:'thinking',durationMs:74400,modelCalls:0}]});
    expect(JSON.stringify(run.progress)).not.toContain('private');
  });
  test('adding progress does not bypass current auth version or KB ACL checks',async()=>{
    const s=create({status:'QUEUED',input:{knowledgeBaseId:7}});
    s.db.user.findUnique.mockResolvedValue({status:'ACTIVE',authVersion:3});
    await expect(s.service.get(3,'fixture',2)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(s.db.chatRun.findFirst).not.toHaveBeenCalled();
    s.rag.authorize.mockRejectedValue(new ForbiddenException());
    await expect(s.service.get(3,'fixture',3)).rejects.toBeInstanceOf(ForbiddenException);
  });
  test.each(['commit','cancel','rollback'])('live completion follows answer transaction %s, never a speculative update',async(outcome)=>{
    const saved:any[]=[];
    const tx={conversation:{update:jest.fn().mockResolvedValue({})},chatRun:{updateMany:jest.fn().mockResolvedValue({count:outcome==='cancel'?0:1})},
      chatMessage:{createMany:jest.fn(async(value:any)=>{saved.push(...value.data);})}};
    const db={$transaction:jest.fn(async(callback:any)=>{
      expect(performanceSnapshot()?.phase).toBe('delivering');
      if(outcome==='rollback')throw Error('synthetic transaction failure');
      return callback(tx);
    }),chatRun:{updateMany:jest.fn().mockResolvedValue({count:1})}};
    const rag={principal:jest.fn().mockResolvedValue({id:3})};
    const memory={prepare:jest.fn().mockResolvedValue({persona:'fixture',history:[],memory:{personaKey:'fixture'}}),assertCurrentSources:jest.fn()};
    const novel={answer:jest.fn().mockResolvedValue({content:'synthetic answer',metadata:{}})};
    const service=new ChatRunService(db as any,novel as any,rag as any,{} as any,memory as any,{} as any);
    await withModelRuntime(new AbortController().signal,async()=>{
      await (service as any).executeSelected({id:'fixture',userId:3,conversationId:4,input:{question:'fixture',mode:'normal'}},'worker',new AbortController().signal);
      expect(performanceSnapshot()?.phase).toBe(outcome==='commit'?'completed':'delivering');
    });
    expect(saved).toHaveLength(outcome==='commit'?2:0);
    if(outcome==='commit')expect(saved[1].ragMetadata.performance).toMatchObject({phase:'completed',stage:'completed'});
    else expect(tx.chatMessage.createMany).not.toHaveBeenCalled();
    if(outcome==='rollback')expect(db.chatRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'FAILED'})}));
  });
  test('turn switches are persisted in the idempotency contract, not global model defaults',async()=>{
    jest.spyOn(chatModels,'resolveChatModel').mockReturnValue({id:'qwen3.8-max'} as any);
    const tx={user:{update:jest.fn().mockResolvedValue({})},$queryRaw:jest.fn().mockResolvedValue([]),
      conversation:{findFirst:jest.fn().mockResolvedValue({conversationType:'ASSISTANT',personaKey:'assistant'})},
      chatRun:{findUnique:jest.fn().mockResolvedValue(null),count:jest.fn().mockResolvedValue(0),
        create:jest.fn().mockResolvedValue({id:'fixture',status:'QUEUED'})}};
    const db={$transaction:jest.fn(async(callback:any)=>callback(tx))};
    const service=new ChatRunService(db as any,{} as any,{principal:jest.fn().mockResolvedValue({id:3})} as any,{} as any,{} as any,{} as any);
    const input={requestId:'01baf51e-37d0-4cd4-a3dd-447d1534d9dc',conversationId:4,question:'fixture',mode:'normal' as const,
      deepThinking:true,webSearch:true};
    await service.create(3,input);
    const stored=tx.chatRun.create.mock.calls[0][0].data.input;
    expect(stored).toMatchObject({deepThinking:true,webSearch:true,modelId:'qwen3.8-max'});
    tx.chatRun.findUnique.mockResolvedValue({id:'fixture',status:'QUEUED',conversationId:4,input:stored} as any);
    await expect(service.create(3,input)).resolves.toEqual({id:'fixture',status:'QUEUED'});
    await expect(service.create(3,{...input,deepThinking:false})).rejects.toThrow('请求编号已用于其他消息');
    expect(tx.chatRun.create).toHaveBeenCalledTimes(1);
  });
  test('admission only blocks an active run in the same owned conversation',async()=>{
    jest.spyOn(chatModels,'resolveChatModel').mockReturnValue({id:'qwen3.8-max'} as any);
    const active=[{userId:3,conversationId:4}];
    const tx={user:{update:jest.fn().mockResolvedValue({})},$queryRaw:jest.fn().mockResolvedValue([]),
      conversation:{findFirst:jest.fn().mockResolvedValue({conversationType:'ASSISTANT',personaKey:'assistant'})},
      chatRun:{findUnique:jest.fn().mockResolvedValue(null),
        count:jest.fn(async({where}:any)=>active.filter(row=>row.userId===where.userId &&
          (where.conversationId===undefined || row.conversationId===where.conversationId)).length),
        create:jest.fn().mockResolvedValue({id:'other-conversation',status:'QUEUED'})}};
    const service=new ChatRunService({$transaction:(callback:any)=>callback(tx)} as any,{} as any,
      {principal:jest.fn()} as any,{} as any,{} as any,{} as any);
    const input={requestId:'01baf51e-37d0-4cd4-a3dd-447d1534d9dc',conversationId:4,question:'fixture',mode:'normal' as const};
    await expect(service.create(3,input)).rejects.toThrow('本会话已有回答正在生成');
    await expect(service.create(3,{...input,conversationId:5})).resolves.toMatchObject({status:'QUEUED'});
    expect(tx.chatRun.count).toHaveBeenLastCalledWith({where:{userId:3,conversationId:5,status:{in:['QUEUED','RUNNING','WAITING_APPROVAL']}}});
    tx.conversation.findFirst.mockResolvedValue(null as any);
    await expect(service.create(3,{...input,conversationId:6})).rejects.toThrow('对话不存在');
    expect(tx.chatRun.create).toHaveBeenCalledTimes(1);
  });
  test('each durable worker applies only its persisted thinking/network switches to its async model scope',async()=>{
    jest.spyOn(chatModels,'resolveChatModel').mockImplementation((_id,options)=>({id:'qwen3.8-max',bodyOptions:{enable_thinking:false},
      deepThinking:options?.deepThinking===true,webSearch:options?.webSearch===true} as any));
    const db={chatRun:{updateMany:jest.fn().mockResolvedValue({count:1})},
      conversation:{findFirst:jest.fn().mockResolvedValue({conversationType:'ASSISTANT'})}};
    const service=new ChatRunService(db as any,{} as any,{} as any,{} as any,{} as any,{} as any);
    const observations:any[]=[];
    jest.spyOn(service as any,'executeSelected').mockImplementation(async(run:any)=>{
      await new Promise(resolve=>setTimeout(resolve,run.input.deepThinking?8:2));
      observations.push({id:run.id,deepThinking:chatModels.currentChatModel().deepThinking,webSearch:chatModels.currentChatModel().webSearch});
    });
    await Promise.all([true,false].map(enabled=>(service as any).execute({id:String(enabled),userId:3,conversationId:4,createdAt:new Date(),
      input:{modelId:'qwen3.8-max',deepThinking:enabled,webSearch:enabled}},'worker')));
    expect(observations).toEqual([{id:'false',deepThinking:false,webSearch:false},{id:'true',deepThinking:true,webSearch:true}]);
    expect(db.conversation.findFirst).toHaveBeenCalledWith({where:{id:4,userId:3},select:{conversationType:true}});
  });
  test.each(['ROLEPLAY','LEGACY',undefined])('worker forces thinking off for current server identity %s despite old/client true payload',async conversationType=>{
    jest.spyOn(chatModels,'resolveChatModel').mockImplementation((_id,options)=>({id:'qwen3.8-max',bodyOptions:{enable_thinking:false},
      deepThinking:options?.deepThinking===true,webSearch:options?.webSearch===true} as any));
    const db={chatRun:{updateMany:jest.fn().mockResolvedValue({count:1})},
      conversation:{findFirst:jest.fn().mockResolvedValue(conversationType?{conversationType}:null)}};
    const service=new ChatRunService(db as any,{} as any,{} as any,{} as any,{} as any,{} as any);
    const execute=jest.spyOn(service as any,'executeSelected').mockImplementation(async()=>{
      expect(chatModels.currentChatModel().deepThinking).toBe(false);
      expect(chatModels.currentChatModel().webSearch).toBe(false);
      expect(chatModels.generationBodyOptions()).toEqual({enable_thinking:false});
    });
    await (service as any).execute({id:'old-queued',userId:3,conversationId:4,createdAt:new Date(),
      input:{modelId:'qwen3.8-max',deepThinking:true,webSearch:true,persona:undefined}},'worker');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('terminal task draft recovery without leaking private state', () => {
  const runId = '10000000-0000-4000-8000-000000000001';
  const parentId = '10000000-0000-4000-8000-000000000002';
  const hash = 'a'.repeat(64), source = '<html>PRIVATE_FILE_SOURCE';
  const ref = { draftId: runId, revision: 2, hash };
  const fixture = (extra: any = {}) => {
    const row: any = { id: runId, userId: 3, conversationId: 4, createdAt: new Date(), status: 'RUNNING',
      input: { question: 'synthetic original task', resumeFile: { ...ref, draftId: parentId } },
      privateState: { kind: 'file-draft-v1', content: source, revision: 2, hash },
      result: { content: source, rawToolArgs: 'PRIVATE_TOOL_ARGS' }, ...extra };
    const db = { chatRun: {
      findFirst: jest.fn(async ({ where }: any) => where.status === 'QUEUED' ? null : { ...row }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.leaseUntil && !(row.leaseUntil < where.leaseUntil.lt)) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(row.status)) return { count: 0 };
        if (typeof where.status === 'string' && where.status !== row.status) return { count: 0 };
        Object.assign(row, data); return { count: 1 };
      }),
    } };
    const fileDrafts = { read: jest.fn(async (_uid: number, _cid: number, pointer: any) => {
      if (!['FAILED', 'CANCELLED'].includes(row.status)) throw Error('Must transition before draft read');
      return { ...pointer, content: source, path: 'private.html', closed: false, originalQuestion: 'PRIVATE_QUESTION' };
    }) };
    const rag = { principal: jest.fn().mockResolvedValue({ id: 3 }) };
    const service = new ChatRunService(db as any, {} as any, rag as any, {} as any, {} as any, {} as any, fileDrafts as any);
    return { row, db, fileDrafts, service };
  };

  test('cancel preserves private recovery state, aborts promptly, and publishes only an ACL-validated pointer', async () => {
    const s = fixture(), controller = new AbortController();
    (s.service as any).running.set(runId, controller);
    const result = await s.service.cancel(3, runId);
    expect(controller.signal.aborted).toBe(true);
    const update = s.db.chatRun.updateMany.mock.calls[0][0].data;
    expect(update).not.toHaveProperty('input'); expect(update).not.toHaveProperty('privateState');
    expect(s.row.input.question).toBe('synthetic original task'); expect(s.row.privateState.content).toBe(source);
    expect(s.fileDrafts.read).toHaveBeenCalledWith(3, 4, ref);
    expect(result.result).toEqual({ failure: { stage: 'generation', code: 'USER_CANCELLED', message: '回答已停止。' },
      ragMetadata: { generation: { truncated: true, fileIncomplete: true, canContinue: true, resumeFile: ref, fileFailureReason: 'STOPPED' } } });
    expect(result).not.toHaveProperty('privateState'); expect(result).not.toHaveProperty('input');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  test('cancel before the first new checkpoint can recover the validated parent reference', async () => {
    const s = fixture({ privateState: null });
    const result = await s.service.cancel(3, runId);
    expect(s.fileDrafts.read).toHaveBeenCalledWith(3, 4, { ...ref, draftId: parentId });
    expect(result.result.ragMetadata.generation.resumeFile).toEqual({ ...ref, draftId: parentId });
  });

  test('RUNNING polling never loads the private source blob or locks draft recovery', async () => {
    const s = fixture();
    await s.service.get(3, runId);
    expect(s.db.chatRun.findFirst).toHaveBeenCalledTimes(1);
    expect(s.db.chatRun.findFirst.mock.calls[0][0].select).not.toHaveProperty('privateState');
    expect(s.fileDrafts.read).not.toHaveBeenCalled();
  });

  test('expired worker lease keeps the private source and recovers it after terminal transition', async () => {
    const s = fixture({ leaseUntil: new Date(Date.now() - 1000) });
    await s.service.tick();
    expect(s.row.status).toBe('FAILED');
    const update = s.db.chatRun.updateMany.mock.calls[0][0].data;
    expect(update).not.toHaveProperty('input'); expect(update).not.toHaveProperty('privateState');
    const result = await s.service.get(3, runId);
    expect(result.result).toMatchObject({ failure: { code: 'WORKER_INTERRUPTED' },
      ragMetadata: { generation: { resumeFile: ref, canContinue: true, fileFailureReason: 'WORKER_INTERRUPTED' } } });
    expect(s.fileDrafts.read).toHaveBeenCalledWith(3, 4, ref);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  test('a stale, revoked or deleted draft never leaves an unvalidated continue action in terminal results', async () => {
    const s = fixture({ status: 'FAILED', result: { failure: { stage: 'generation', code: 'GENERATION_FAILED', message: '回答未完成。' },
      content: source, ragMetadata: { generation: { fileIncomplete: true, canContinue: true, resumeFile: ref,
        content: source, reasoning_content: 'PRIVATE_REASONING' }, fileArtifacts: [{ content: source }] } } });
    s.fileDrafts.read.mockRejectedValue(new ForbiddenException('revoked'));
    const result = await s.service.get(3, runId);
    expect(result.result.ragMetadata.generation).toEqual({ fileIncomplete: true, canContinue: false });
    expect(result.result).not.toHaveProperty('content');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });

  test('completion is not rewritten when a late cancel races the final transaction', async () => {
    const completed = { content: 'already committed', ragMetadata: { fileArtifacts: [{ changeId: 7, path: 'page.html' }] } };
    const s = fixture({ status: 'COMPLETED', result: completed, privateState: null });
    const result = await s.service.cancel(3, runId);
    expect(s.row.status).toBe('COMPLETED'); expect(result.result).toEqual(completed);
    expect(s.fileDrafts.read).not.toHaveBeenCalled();
  });
});

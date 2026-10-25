import { ChatRunService } from './chat-run.service';
import { ConversationHistoryChangedError } from '../agent/model-output.error';

describe('all chat delivery is bound to the prepared history epoch', () => {
  test.each(['assistant', 'kato_megumi_persona'])('deleting source messages rejects stale %s completion before any message insert', async personaKey => {
    const tx={conversation:{update:jest.fn(),findFirst:jest.fn().mockResolvedValue(null)},
      chatRun:{updateMany:jest.fn()},chatMessage:{createMany:jest.fn()}};
    const db={$transaction:jest.fn(async callback=>callback(tx)),chatRun:{updateMany:jest.fn().mockResolvedValue({count:1})}};
    const service=new ChatRunService(db as any,{answer:jest.fn().mockResolvedValue({content:'stale synthetic reply',metadata:{}})} as any,
      {principal:jest.fn()} as any,{} as any,{prepare:jest.fn().mockResolvedValue({sourceEpoch:2,
        persona:'synthetic',question:'fixture',history:[],memory:{personaKey}}),assertCurrentSources:jest.fn()} as any,
      {messageContext:jest.fn().mockResolvedValue({current:[],library:[]})} as any);
    await (service as any).executeSelected({id:'fixture',userId:3,conversationId:4,
      input:{question:'fixture',mode:'normal',...(personaKey==='assistant'?{}:{persona:personaKey})}},'worker',new AbortController().signal);
    expect(tx.chatMessage.createMany).not.toHaveBeenCalled();
    expect(tx.chatRun.updateMany).not.toHaveBeenCalled();
    expect(tx.conversation.findFirst).toHaveBeenCalledWith({where:{id:4,userId:3,memoryEpoch:2},select:{id:true}});
    expect(db.chatRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'FAILED',
      result:expect.objectContaining({failure:expect.objectContaining({code:'CONVERSATION_HISTORY_CHANGED'})})})}));
  });
  test('a rejected epoch-aware stream write does not fall back to an unguarded append', async () => {
    const db={conversation:{findFirst:jest.fn().mockResolvedValue(null)},
      chatRun:{updateMany:jest.fn().mockResolvedValue({count:0})},$transaction:jest.fn()};
    const novel={answer:jest.fn(async (...args:any[])=>{await args[5].delivery.onToken('synthetic public text');})};
    const service=new ChatRunService(db as any,novel as any,{principal:jest.fn()} as any,{} as any,
      {prepare:jest.fn().mockResolvedValue({sourceEpoch:7,persona:'synthetic',history:[],memory:{personaKey:'assistant'}}),assertCurrentSources:jest.fn()} as any,
      {messageContext:jest.fn().mockResolvedValue({current:[],library:[]})} as any);
    await (service as any).executeSelected({id:'fixture',userId:3,conversationId:4,input:{question:'fixture'}},'worker',new AbortController().signal);
    expect(db.chatRun.updateMany.mock.calls[0][0].where).toMatchObject({conversation:{memoryEpoch:7}});
    expect(db.chatRun.updateMany.mock.calls[1][0].data.result.failure.code).toBe('CONVERSATION_HISTORY_CHANGED');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  const deliveryFixture = (rejectAt?: 'stream' | 'commit') => {
    const order: string[] = [], frame = { sourceEpoch: 2, persona: 'fixture', question: 'fixture', history: [], memory: { personaKey: 'assistant' } };
    const tx = { conversation: { update: jest.fn(async () => { order.push('target-update'); }), findFirst: jest.fn().mockResolvedValue({ id: 4 }) },
      chatRun: { updateMany: jest.fn(async () => { order.push('commit-run'); return { count: 1 }; }) },
      chatMessage: { createMany: jest.fn(async () => { order.push('save-messages'); }) } };
    const db = { chatRun: { updateMany: jest.fn(async ({ data }: any) => { order.push(data.status === 'FAILED' ? 'failed' : 'publish-partial'); return { count: 1 }; }) },
      $transaction: jest.fn(async (work: any) => { order.push('transaction'); return work(tx); }) };
    const memory = { prepare: jest.fn().mockResolvedValue(frame),
      assertCurrentSources: jest.fn(async (_uid: number, _cid: number, _frame: any, transaction?: any) => {
        order.push(transaction ? 'guard-commit' : 'guard-stream');
        if (rejectAt === (transaction ? 'commit' : 'stream')) throw new ConversationHistoryChangedError();
      }) };
    const novel = { answer: jest.fn(async (...args: any[]) => {
      await args[5].delivery.onToken('synthetic streamed text');
      return { content: 'synthetic final text', metadata: {} };
    }) };
    const service = new ChatRunService(db as any, novel as any, { principal: jest.fn() } as any, {} as any, memory as any,
      { messageContext: jest.fn().mockResolvedValue({ current: [], library: [] }) } as any);
    return { service, db, tx, memory, frame, order };
  };
  test('shared source guard precedes both public streamed content and final transaction target mutation', async () => {
    const f = deliveryFixture();
    await (f.service as any).executeSelected({ id: 'fixture', userId: 3, conversationId: 4, input: { question: 'fixture' } }, 'worker', new AbortController().signal);
    expect(f.memory.assertCurrentSources).toHaveBeenNthCalledWith(1, 3, 4, f.frame);
    expect(f.memory.assertCurrentSources).toHaveBeenNthCalledWith(2, 3, 4, f.frame, f.tx);
    expect(f.order.indexOf('guard-stream')).toBeLessThan(f.order.indexOf('publish-partial'));
    expect(f.order.indexOf('guard-commit')).toBeLessThan(f.order.indexOf('target-update'));
    expect(f.order.indexOf('guard-commit')).toBeLessThan(f.order.indexOf('save-messages'));
    expect(f.tx.chatMessage.createMany).toHaveBeenCalledTimes(1);
  });
  test.each(['stream', 'commit'] as const)('a revoked source rejected at %s cannot append a final answer', async rejectAt => {
    const f = deliveryFixture(rejectAt);
    await (f.service as any).executeSelected({ id: 'fixture', userId: 3, conversationId: 4, input: { question: 'fixture' } }, 'worker', new AbortController().signal);
    expect(f.tx.chatMessage.createMany).not.toHaveBeenCalled(); expect(f.tx.conversation.update).not.toHaveBeenCalled();
    expect(f.tx.chatRun.updateMany).not.toHaveBeenCalled();
    expect(f.db.chatRun.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: 'FAILED', result: expect.objectContaining({ failure: expect.objectContaining({ code: 'CONVERSATION_HISTORY_CHANGED' }) }) }) }));
    if (rejectAt === 'stream') {
      expect(f.db.$transaction).not.toHaveBeenCalled(); expect(f.order).not.toContain('publish-partial');
    } else {
      expect(f.db.$transaction).toHaveBeenCalledTimes(1); expect(f.order).toContain('publish-partial');
    }
  });
});

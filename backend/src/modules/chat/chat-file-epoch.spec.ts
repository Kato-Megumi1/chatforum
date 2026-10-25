import { ChatRunService } from './chat-run.service';

describe('file continuation history binding', () => {
  test.each([false, true])('a deletion racing memory preparation cannot relabel a %s resumed draft with a newer epoch', async resume => {
    const sourceRef={draftId:'01baf51e-37d0-4cd4-a3dd-447d1534d9dc',revision:1,hash:'a'.repeat(64)};
    const frame:any={persona:'fixture',history:[],memory:{personaKey:'assistant'}};
    const db={conversation:{findFirst:jest.fn().mockResolvedValueOnce({memoryEpoch:4}).mockResolvedValueOnce({memoryEpoch:5})},
      chatRun:{updateMany:jest.fn().mockResolvedValue({count:1})}};
    const novel={answer:jest.fn()};
    const drafts={read:jest.fn().mockResolvedValue({...sourceRef,path:'fixture.html',content:'private source',
      closed:false,originalQuestion:'original request',conversationEpoch:4}),checkpoint:jest.fn()};
    const service=new ChatRunService(db as any,novel as any,{principal:jest.fn()} as any,{} as any,
      {prepare:jest.fn().mockResolvedValue(frame),assertCurrentSources:jest.fn()} as any,{} as any,drafts as any);
    await (service as any).executeSelected({id:'child-run',userId:3,conversationId:4,input:{question:'continue',
      ...(resume?{resumeFile:sourceRef}:{})}},'worker',new AbortController().signal);
    expect(novel.answer).not.toHaveBeenCalled();
    expect(drafts.checkpoint).not.toHaveBeenCalled();
    expect(frame.saveFileDraft).toBeUndefined();
    expect(db.chatRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'FAILED'})}));
  });
});

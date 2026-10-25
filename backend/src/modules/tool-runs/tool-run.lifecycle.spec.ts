import { ChatRunService } from '../chat/chat-run.service';
import { runEvents } from '../chat/chat-run.events';
import { NovelAnswerService } from '../agent/novel-answer.service';
import { ToolApprovalPendingError } from './tool-run.policy';

describe('tool approval task suspension',()=>{
  test('the shared dialogue coordinator preserves suspension rather than masking it as a model failure',async()=>{
    const pending=new ToolApprovalPendingError('step'),character={reply:jest.fn().mockRejectedValue(pending)};
    const novel=new NovelAnswerService({} as any,{} as any,character as any);
    await expect(novel.answer(0,'fixture',[],'fixture',{userId:3},{conversation:{persona:'fixture',question:'fixture',history:[],
      memory:{personaKey:'assistant'} as any}})).rejects.toBe(pending);
  });
  test('waiting releases the task worker and is not committed as a failed or successful assistant answer',async()=>{
    const pending=new ToolApprovalPendingError('step'),db={chatRun:{updateMany:jest.fn()},$transaction:jest.fn()};
    const tools={pause:jest.fn().mockResolvedValue(undefined)};
    const service=new ChatRunService(db as any,{answer:jest.fn().mockRejectedValue(pending)} as any,{principal:jest.fn()} as any,{} as any,
      {prepare:jest.fn().mockResolvedValue({persona:'fixture',history:[],memory:{personaKey:'assistant'}})} as any,
      {messageContext:jest.fn().mockResolvedValue({current:[],library:[]})} as any,undefined,tools as any);
    await (service as any).executeSelected({id:'run',userId:3,conversationId:4,input:{question:'fixture'}},'worker',new AbortController().signal);
    expect(tools.pause).toHaveBeenCalledWith('run','worker','step');expect(db.chatRun.updateMany).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  test('waiting SSE ends with a safe suspension status without output, arguments or another model task',async()=>{
    const events=[];for await(const event of runEvents(async()=>({status:'WAITING_APPROVAL',result:{content:'PRIVATE',arguments:'PRIVATE'}}),0,new AbortController().signal))events.push(event);
    expect(events).toEqual([{event:'terminal',data:{status:'WAITING_APPROVAL'}}]);
  });
});

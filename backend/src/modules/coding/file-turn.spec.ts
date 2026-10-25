import { focusedFiles, prepareFileTurn } from './file-turn';
import { withChatModel, ServerChatModel } from '../chat/chat-models';
import { CharacterDialogueService } from '../agent/character-dialogue.service';
import { buildConversationMemory } from '../agent/conversation-memory.policy';

const image={id:1,kind:'image',path:'one.png',revision:1,bytes:100};
const older={...image,id:2,path:'older.png'};
const files={current:[],previous:{messageId:3,question:'是什么形状？',files:[{...image,available:true}]},library:[image,older]};
const config=(id:string):ServerChatModel=>({id,label:id,defaultModel:id,defaultApiBase:'https://invalid.test',defaultApiKey:'fixture',bodyOptions:{},pricingPrefix:'TEST'});
const frame=()=>{const result=buildConversationMemory([{messageId:3,role:'user',content:'是什么形状？'},
  {messageId:4,role:'assistant',content:'没有可见文字，请切换Qwen'}],'assistant');
  return {persona:'',question:'继续识别任务',history:result.history,memory:result.snapshot,toolScope:{userId:1,conversationId:1}} as any;};

describe('direct image context and model changes',()=>{
  test('new batch wins; no upload inherits the ordered prior batch, not all library files',()=>{
    expect(focusedFiles(files)).toEqual([{...image,available:true}]);
    expect(focusedFiles({...files,current:[older]})).toEqual([older]);
    expect(focusedFiles({...files,library:[{...image,id:99}]})).toEqual([]);
    expect(focusedFiles({...files,previous:{...files.previous,files:[{...image,available:false}]}})).toEqual([]);
  });
  test('switch to Qwen actually attaches original images; previous current stays empty',async()=>{
    const coding={messageContext:jest.fn().mockResolvedValue(files),inlineImages:jest.fn().mockResolvedValue([{...image,url:'data:image/jpeg;base64,fixture'}])};
    const first=frame();await withChatModel(config('deepseek-v4-pro'),()=>prepareFileTurn(first,coding as any,[],[],new AbortController().signal));
    expect(coding.inlineImages).not.toHaveBeenCalled();expect(first.inlineImages).toBeUndefined();
    const next=frame();await withChatModel(config('qwen3.8-max'),()=>prepareFileTurn(next,coding as any,[],[],new AbortController().signal));
    expect(coding.inlineImages).toHaveBeenCalledTimes(1);expect(next.inlineImages).toHaveLength(1);
    expect(next.messageFiles.current).toEqual([]);expect(next.toolScope.fileQuestionContext.history[0].content).toBe('是什么形状？');
    const agent={executeWithTools:jest.fn().mockResolvedValue({content:'合成回答'})};
    await withChatModel(config('qwen3.8-max'),()=>new CharacterDialogueService(agent as any,{} as any).reply(next,[],{} as any));
    const args=agent.executeWithTools.mock.calls[0];expect(args[3]).toBe('qwen3.8-max');
    expect(args[0].at(-2).images).toHaveLength(1);expect(args[0].at(-1).content).toBe('继续识别任务');
    expect(args[7]).toContain('本轮实际模型：qwen3.8-max');
  });
  test('roleplay does not read ordinary AI attachments',async()=>{
    const coding={messageContext:jest.fn()},value=frame();value.memory.personaKey='kato_megumi_persona';
    await prepareFileTurn(value,coding as any,[],[],new AbortController().signal);
    expect(coding.messageContext).not.toHaveBeenCalled();
  });
  test('file output context does not implicitly enable a workspace or image reads for ordinary chat', async () => {
    const coding = { messageContext: jest.fn().mockResolvedValue({ current: [], library: [] }), inlineImages: jest.fn() };
    const value = frame();
    expect(await prepareFileTurn(value, coding as any, [], [], new AbortController().signal)).toEqual([]);
    expect(value.messageFiles).toBeUndefined(); expect(coding.inlineImages).not.toHaveBeenCalled();
    expect(value.toolScope.fileQuestionContext.question).toBe('继续识别任务');
  });
});

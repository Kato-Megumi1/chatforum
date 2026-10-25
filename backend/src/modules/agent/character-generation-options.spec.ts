import { CharacterDialogueService } from './character-dialogue.service';
import { buildConversationMemory } from './conversation-memory.policy';
import { newRagUsage, RagModelService } from './rag-model.service';
import { NovelAnswerService } from './novel-answer.service';
import { withChatModel } from '../chat/chat-models';
import { setModelStage, withModelRuntime } from './model-runtime';
import { AgentToolLoopIncompleteError, ConversationHistoryChangedError, ModelRequestTimeoutError, publicRunFailure } from './model-output.error';

describe('final character/assistant generation switches',()=>{
  const originalFetch=global.fetch;
  afterEach(()=>{global.fetch=originalFetch;jest.restoreAllMocks();});
  const model=(deepThinking:boolean)=>({id:'qwen3.8-max',label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-only',
    defaultApiBase:'https://invalid.test',bodyOptions:{enable_thinking:false},pricingPrefix:'TEST',deepThinking});
  const frame=(personaKey:string)=>({persona:'fixture role',question:'fixture',history:[],memory:buildConversationMemory([],personaKey).snapshot});
  test.each([new AgentToolLoopIncompleteError(),new ConversationHistoryChangedError()])(
    'ordinary runtime control error keeps its code through the shared novel coordinator: %s', async error => {
      const character={reply:jest.fn().mockRejectedValue(error)},rag={review:jest.fn()};
      const novel=new NovelAnswerService(rag as any,{} as any,character as any),current=frame('assistant');
      await expect(novel.answer(0,current.question,[],current.persona,{userId:3},{conversation:current})).rejects.toBe(error);
      expect(publicRunFailure(error).code).toBe(error.code);
      expect(rag.review).not.toHaveBeenCalled();
    });
  test('ordinary chat preserves the transport timeout instead of masking it as an unspecified generation failure', async () => {
    const timeout = new ModelRequestTimeoutError();
    const character = { reply: jest.fn().mockRejectedValue(timeout) };
    const novel = new NovelAnswerService({} as any, {} as any, character as any);
    const current = frame('assistant');
    const error = await withChatModel(model(true), () => withModelRuntime(new AbortController().signal,
      () => novel.answer(0, current.question, [], current.persona, { userId: 2 }, { conversation: current }))).catch(value => value);
    expect(error).toBe(timeout); expect(publicRunFailure(error).code).toBe('MODEL_REQUEST_TIMEOUT');
  });
  test.each(['assistant','kato_megumi_persona'])('final %s generation permits deep only for ordinary assistant identity',async personaKey=>{
    for(const enabled of [false,true]){
      const agent={executeWithTools:jest.fn().mockResolvedValue({content:'你好。'})};
      const service=new CharacterDialogueService(agent as any,{} as any);
      await withChatModel(model(enabled),()=>service.reply(frame(personaKey),[],newRagUsage()));
      const args=(agent.executeWithTools.mock.calls[0] as any[]);
      expect(args[9]).toEqual({enable_thinking:personaKey==='assistant'&&enabled});
      expect(args[5]).toBe(personaKey==='assistant'?32768:1000);
      expect(JSON.stringify(args[0])).not.toContain('reasoning_content');
    }
  });
  test('the independent checker retains its existing small structured generation contract',async()=>{
    const json=jest.fn().mockResolvedValue({ok:true});
    const service=new CharacterDialogueService({} as any,{json} as any);
    await withChatModel(model(true),()=>withModelRuntime(new AbortController().signal,async()=>{
      setModelStage('verification');
      await service.json('CHECK',{},newRagUsage(),{maxTokens:700},frame('kato_megumi_persona'),[]);
      expect(json.mock.calls[0][3]).toEqual({maxTokens:700});
    }));
  });
  test('canonical role response keeps all stages non-thinking even when an old scope carries deep=true',async()=>{
    const quote='阿青把蓝色雨伞交给小舟';
    const citation={chunkId:'fixture',documentId:1,documentVersion:2,indexVersion:3,chunkIndex:0,fileName:'fixture.txt',chapter:'第一章',url:'/fixture'};
    const responses=[{intent:'canon',query:'阿青是否送过小舟礼物'},{scores:[{sourceId:1,score:5}]},
      {sufficient:true,claims:[{text:'阿青给小舟蓝色雨伞。',sourceId:1,quote}]},
      {claims:[{factId:1,text:'你说那把蓝色雨伞啊，是我给小舟的。'}]},
      {supported:[true],neutralSupported:[true],answersQuestion:true,neutralAnswersQuestion:true,
        questionAlignment:'direct',neutralQuestionAlignment:'direct',inCharacter:true,injection:false}];
    const seen:any[]=[];
    global.fetch=jest.fn(async(_url,init)=>{
      seen.push(JSON.parse(init.body as string));
      if(!responses.length)throw Error('Unexpected synthetic provider request');
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(responses.shift()),
        reasoning_content:'private-fixture-reasoning'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20}})};
    }) as any;
    const rag={authorize:jest.fn().mockResolvedValue({kb:{minConfidence:.55}}),
      search:jest.fn().mockResolvedValue({passages:[{content:quote+'，随后独自回家。',citation,score:1}],confidence:1,indexVersion:3}),
      citation:jest.fn().mockResolvedValue(citation),review:jest.fn()};
    const actualModel=new RagModelService();
    const character=new CharacterDialogueService({} as any,actualModel);
    const novel=new NovelAnswerService(rag as any,actualModel,character);
    const current={...frame('fixture'),persona:'阿青',question:'我记得你送过小舟礼物？'};
    const answer=await withChatModel(model(true),()=>withModelRuntime(new AbortController().signal,()=>novel.answer(1,current.question,
      [{role:'user',content:current.question}],current.persona,{userId:2},{conversation:current,maxSearchAttempts:1})));
    expect(answer.metadata.state).toBe('grounded');expect(answer.content).toContain('蓝色雨伞');
    expect(seen).toHaveLength(5);
    expect(seen.map(body=>body.enable_thinking)).toEqual([false,false,false,false,false]);
    expect(seen[3].max_tokens).toBe(700);expect(seen[4].max_tokens).toBe(2500);
    expect(seen.every(body=>body.response_format.type==='json_object')).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('private-fixture-reasoning');
    expect(rag.citation).toHaveBeenCalled();expect(rag.review).not.toHaveBeenCalled();
  });
  test('uncertain role continuation and independent check stay non-thinking with their existing short-output allowance',async()=>{
    const responses=[{reply:'这处我还不能肯定，你想继续聊哪一点？',factIds:[]},
      {unsupportedClaims:[],continuity:true,bounded:true,citationsValid:true,inCharacter:true,injection:false}];
    const seen:any[]=[];
    global.fetch=jest.fn(async(_url,init)=>{seen.push(JSON.parse(init.body as string));return {ok:true,json:async()=>({choices:[{
      message:{content:JSON.stringify(responses.shift()),reasoning_content:'private-fixture-reasoning'},finish_reason:'stop'}],
      usage:{prompt_tokens:10,completion_tokens:20}})};}) as any;
    const service=new CharacterDialogueService({} as any,new RagModelService());
    const result=await withChatModel(model(true),()=>withModelRuntime(new AbortController().signal,
      ()=>service.uncertainReply(frame('fixture'),[],newRagUsage())));
    expect(result.guard.status).toBe('passed');expect(seen.map(body=>body.enable_thinking)).toEqual([false,false]);
    expect(seen.map(body=>body.max_tokens)).toEqual([700,700]);
    expect(JSON.stringify(result)).not.toContain('private-fixture-reasoning');
  });
});

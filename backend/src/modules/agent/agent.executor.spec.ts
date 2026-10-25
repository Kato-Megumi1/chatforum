import { AgentExecutorService } from './agent.executor';
import { SkillRegistry } from './skills';
import { CalculatorSkill } from './skills/calculator.skill';
import { newRagUsage } from './rag-model.service';
import { CharacterDialogueService } from './character-dialogue.service';
import { buildConversationMemory } from './conversation-memory.policy';
import { withChatModel } from '../chat/chat-models';
import { ASSISTANT_MAX_OUTPUT_TOKENS, estimateModelTokens } from './context-budget';
import { runtimeState, withModelRuntime } from './model-runtime';
import { FILE_OUTPUT_START, FILE_OUTPUT_END, fileDraftHash } from '../coding/file-output';
import { CodingSkill } from './skills/coding.skill';
import { AgentToolLoopIncompleteError, publicRunFailure } from './model-output.error';
import { ToolApprovalPendingError } from '../tool-runs/tool-run.policy';
describe('real LangChain pipeline against an in-process protocol fixture', () => {
  const base='https://agent-fixture.invalid/v1';
  let originalFetch: typeof fetch;
  let received: any[]=[];
  let answerFinishReason='stop';
  let fixtureReasoning: string | undefined;
  let answerText = '结果是 4';
  let forceToolLoop = false;
  beforeAll(async()=>{
    process.env.LANGCHAIN_TRACING_V2='false'; process.env.LANGSMITH_TRACING='false';
    SkillRegistry.register(new CalculatorSkill(),{name:'calculator',description:'math',category:'tool',enabled:true});
    originalFetch=globalThis.fetch;
    // Exercise the real SDK/LangChain request and response formats without a
    // loopback socket, which is unavailable in restricted CI/test sandboxes.
    globalThis.fetch=(async(url:any,init:any)=>{
      if(!String(url).startsWith(base))throw new Error(`Unexpected fixture URL: ${String(url)}`);
      const body=JSON.parse(String(init?.body||'{}'));received.push(body);
      const needTool=body.tools?.length && (forceToolLoop || !body.messages.some((m:any)=>m.role==='tool'));
      const message:any=needTool?{role:'assistant',content:null,...(fixtureReasoning === undefined ? {} : { reasoning_content: fixtureReasoning }),tool_calls:[{id:'call_1',type:'function',
        function:{name:'calculator',arguments:'{"expression":"2 + 2"}'}}]}:{role:'assistant',content:answerText};
      if (body.stream) {
        const delta = needTool ? { ...message, tool_calls: [{ ...message.tool_calls[0], index: 0 }] } : message;
        const events=[
          'data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',
            choices:[{index:0,delta:needTool?delta:{role:'assistant',content:answerText.slice(0,2)},finish_reason:null}]})+'\n\n',
          ...(!needTool?['data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',
            choices:[{index:0,delta:{content:answerText.slice(2)},finish_reason:null}]})+'\n\n']:[]),
          'data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',
            choices:[{index:0,delta:{},finish_reason:needTool?'tool_calls':answerFinishReason}]})+'\n\n',
          'data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],
            usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14,prompt_tokens_details:{cached_tokens:5}}})+'\n\n',
          'data: [DONE]\n\n',
        ];
        const encoder=new TextEncoder(),signal:AbortSignal|undefined=init?.signal;
        let index=0,closed=false,streamController:ReadableStreamDefaultController<Uint8Array>;
        const abort=()=>{if(!closed){closed=true;streamController.error(signal?.reason||new DOMException('Aborted','AbortError'));}};
        const stream=new ReadableStream<Uint8Array>({
          start(controller){streamController=controller;signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();},
          async pull(controller){
            if(closed)return;
            if(!needTool&&index===1)await new Promise(resolve=>setTimeout(resolve,40));
            if(closed)return;
            if(signal?.aborted){abort();return;}
            if(index<events.length){controller.enqueue(encoder.encode(events[index++]));return;}
            closed=true;signal?.removeEventListener('abort',abort);controller.close();
          },
          cancel(){closed=true;signal?.removeEventListener('abort',abort);},
        });
        return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});
      }
      return new Response(JSON.stringify({id:'test-completion',object:'chat.completion',created:1,model:'fixture',
        choices:[{index:0,message,finish_reason:needTool?'tool_calls':answerFinishReason}],
        usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}),{headers:{'Content-Type':'application/json'}});
    }) as typeof fetch;
  });
  afterAll(()=>{globalThis.fetch=originalFetch;});
  test.each([[],['calculator']])('assistant output allowance and long-history packing survive the wire with skills %j',async(...skills)=>{
    const oldBudget=process.env.ASSISTANT_CONTEXT_TOKEN_BUDGET;process.env.ASSISTANT_CONTEXT_TOKEN_BUDGET='41000';
    try {
      received=[];const service=new CharacterDialogueService(new AgentExecutorService({} as any),{} as any);
      const {snapshot}=buildConversationMemory([],'assistant');
      const history=Array.from({length:4},(_,i)=>[{role:'user',content:'问题'+i+'a'.repeat(2400)},
        {role:'assistant',content:'回答'+i+'b'.repeat(2400)}]).flat();
      const reply=await withChatModel({id:'deepseek-v4-pro',label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-key',defaultApiBase:base,bodyOptions:{},pricingPrefix:'TEST'},
        ()=>service.reply({persona:'',question:'2+2',history,memory:snapshot},[],newRagUsage(),{enabledSkills:skills}));
      expect(reply).toBe('结果是 4');
      for(const body of received){
        expect(body.max_tokens).toBe(ASSISTANT_MAX_OUTPUT_TOKENS);
        expect(estimateModelTokens({messages:body.messages,tools:body.tools})+ASSISTANT_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(41000);
      }
      const historyAnswers=received[0].messages.filter((m:any)=>m.role==='assistant');
      expect(historyAnswers.length).toBeGreaterThan(0);expect(historyAnswers.length).toBeLessThan(4);
      expect(historyAnswers.at(-1).content).toContain('回答3');
    }finally{if(oldBudget===undefined)delete process.env.ASSISTANT_CONTEXT_TOKEN_BUDGET;else process.env.ASSISTANT_CONTEXT_TOKEN_BUDGET=oldBudget;}
  });
  test.each([false,true])('assistant truncated output keeps text and exposes user-triggered continuation, streaming=%s',async streaming=>{
    received=[];answerFinishReason='length';
    const signal=new AbortController().signal;
    const service=new CharacterDialogueService(new AgentExecutorService({} as any),{} as any);
    const {snapshot}=buildConversationMemory([],'assistant');
    try {
      await withModelRuntime(signal,async()=>{
        const reply=await withChatModel({id:'qwen3.8-max',label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-key',defaultApiBase:base,bodyOptions:{},pricingPrefix:'TEST'},
          ()=>service.reply({persona:'',question:'2+2',history:[],memory:snapshot},[],newRagUsage(),{
            enabledSkills:[],...(streaming?{delivery:{signal,onToken:async()=>{}}}:{})}));
        expect(reply).toBe('结果是 4');
        expect(runtimeState()?.assistantGeneration).toEqual({finishReason:'length',truncated:true,canContinue:true});
        expect(received).toHaveLength(1);
      });
    } finally {answerFinishReason='stop';}
  });
  test.each([[],['calculator']])('native images survive the SDK wire format with skills %j',async(...skills)=>{
    received=[];const url='data:image/jpeg;base64,'+'A'.repeat(100000);
    const service=new AgentExecutorService({} as any),usage=newRagUsage();
    await service.executeWithTools([{role:'user',content:'附件上下文',images:[{path:'first.png',url},{path:'second.png',url}]},
      {role:'user',content:'继续识别任务'}],'fixture-key',base,'fixture',0,100,skills,'回答问题',undefined,undefined,undefined,usage);
    const parts=received[0].messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]);
    expect(parts.filter((p:any)=>p.type==='image_url').map((p:any)=>p.image_url.url)).toEqual([url,url]);
    expect(parts.filter((p:any)=>p.type==='text').map((p:any)=>p.text)).toEqual(['附件上下文',JSON.stringify({image:1,file:'first.png'}),JSON.stringify({image:2,file:'second.png'})]);
    expect(received[0].messages.at(-1)).toMatchObject({role:'user',content:'继续识别任务'});
    expect(usage.inputTokens).toBe(received.length*10);
  });
  test('empty skills means no tool binding; braces remain literal',async()=>{
    received=[];
    const service=new AgentExecutorService({} as any);
    expect(await service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,[],'literal {untrusted}',undefined,{enable_thinking:false}))
      .toMatchObject({content:'结果是 4',toolOutputs:[]});
    expect(received[0].tools).toBeUndefined();
    expect(received[0].messages[0].content).toBe('literal {untrusted}');
    expect(received[0].enable_thinking).toBe(false);
  });
  test('calculator tool round-trip still works after SDK security updates',async()=>{
    received=[];
    const service=new AgentExecutorService({} as any);
    const usage=newRagUsage();
    const reply=await service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,['calculator'],'计算',undefined,undefined,undefined,usage);
    expect(reply.content).toBe('结果是 4');expect(reply.toolOutputs).toHaveLength(1);
    expect(received).toHaveLength(2);
    expect(usage.calls).toBe(2);expect(usage.inputTokens).toBe(20);expect(usage.outputTokens).toBe(8);
  });
  test('a typed approval suspension escapes the real SDK tool runner without executing or turning into a model answer',async()=>{
    received=[];
    const pending=new ToolApprovalPendingError('synthetic-step'),tools={receipts:jest.fn().mockResolvedValue(undefined),
      invoke:jest.fn().mockRejectedValue(pending)};
    const skill=SkillRegistry.getTool('calculator')!,execute=jest.spyOn(skill,'execute');
    try{
      const service=new AgentExecutorService({} as any,tools as any);
      await expect(service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,['calculator'],
        'fixture',undefined,undefined,undefined,undefined,{runId:'fixture-run',workerToken:'fixture-worker'})).rejects.toBe(pending);
      expect(received).toHaveLength(1);expect(execute).not.toHaveBeenCalled();
    }finally{execute.mockRestore();}
  });
  test('a real SDK agent that never finishes yields a typed failure, not an English completed answer or automatic tool rerun', async () => {
    const oldLimit=process.env.AGENT_TOOL_MAX_ITERATIONS;
    process.env.AGENT_TOOL_MAX_ITERATIONS='2'; forceToolLoop=true; received=[];
    const skill=SkillRegistry.getTool('calculator')!;
    const execute=jest.spyOn(skill,'execute');
    const usage=newRagUsage();
    try {
      const service=new AgentExecutorService({} as any);
      const attempt=service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,['calculator'],'计算',undefined,undefined,undefined,usage);
      await expect(attempt).rejects.toBeInstanceOf(AgentToolLoopIncompleteError);
      expect(received).toHaveLength(2); expect(execute).toHaveBeenCalledTimes(2);
      expect(usage.calls).toBe(2);
      expect(publicRunFailure(new AgentToolLoopIncompleteError())).toEqual({stage:'tools',code:'AGENT_TOOL_LOOP_INCOMPLETE',
        message:'工具处理尚未完成，未生成最终回答。请重试或缩小任务范围。'});
    } finally {
      execute.mockRestore(); forceToolLoop=false;
      if(oldLimit===undefined)delete process.env.AGENT_TOOL_MAX_ITERATIONS;else process.env.AGENT_TOOL_MAX_ITERATIONS=oldLimit;
    }
  });
  test('genuine model text is never rejected by matching the library force-stop placeholder', async () => {
    const previous=answerText; answerText='Agent stopped due to max iterations.'; received=[];
    try {
      const reply=await new AgentExecutorService({} as any).executeWithTools([{role:'user',content:'Explain this text'}],
        'fixture-key',base,'fixture',0,100,['calculator'],'fixture');
      expect(reply.content).toBe(answerText); expect(received).toHaveLength(2);
    } finally { answerText=previous; }
  });
  test('provider reasoning is preserved only on the current tool-loop wire, never in public output or usage',async()=>{
    received=[];fixtureReasoning='仅当前执行内的供应商工具推理\nExact reasoning 🌸';
    const service=new AgentExecutorService({} as any),usage=newRagUsage(),pieces:string[]=[];
    try {
      const reply=await withModelRuntime(new AbortController().signal,()=>service.executeWithTools(
        [{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,['calculator'],'计算',undefined,
        {enable_thinking:true},{signal:new AbortController().signal,onToken:async text=>{pieces.push(text);}},usage));
      expect(received).toHaveLength(2);
      expect(received[0].messages.every((message:any)=>message.reasoning_content===undefined)).toBe(true);
      const toolTurn=received[1].messages.find((message:any)=>message.role==='assistant'&&message.tool_calls?.length);
      expect(toolTurn.reasoning_content).toBe(fixtureReasoning);
      expect(reply.content).toBe('结果是 4');
      expect(JSON.stringify({reply,usage,pieces})).not.toContain(fixtureReasoning);
      expect(reply).not.toHaveProperty('reasoningContent');
      expect(usage.calls).toBe(2);
      // A following execution may receive the same provider IDs but has no
      // authority to reuse the previous execution's reasoning.
      received=[];fixtureReasoning=undefined;
      await service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,['calculator'],'计算');
      expect(received[1].messages.every((message:any)=>message.reasoning_content===undefined)).toBe(true);
    } finally {fixtureReasoning=undefined;}
  });
  test('plain chat forwards real provider chunks, not a post-generation typing effect',async()=>{
    received=[]; const pieces:string[]=[];
    const service=new AgentExecutorService({} as any);
    const usage=newRagUsage();
    const reply=await service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,[],'计算',undefined,
      {enable_thinking:false},{onToken:async text=>{pieces.push(text);},signal:new AbortController().signal},usage);
    expect(received[0].stream).toBe(true);expect(pieces).toEqual(['结果','是 4']);expect(reply.content).toBe('结果是 4');
    expect(usage.usageComplete).toBe(true);expect(usage.inputTokens).toBe(10);expect(usage.cachedInputTokens).toBe(5);
  });
  test('provider streaming respects cancellation',async()=>{
    const controller=new AbortController(),service=new AgentExecutorService({} as any);
    await expect(service.executeWithTools([{role:'user',content:'2+2'}],'fixture-key',base,'fixture',0,100,[],'计算',undefined,undefined,
      {onToken:async()=>{controller.abort();},signal:controller.signal})).rejects.toThrow();
  });
  test.each([[], ['calculator']])('declared file output produces a real proposal without enabling workspace reads, skills=%j', async (...skills) => {
    received=[];
    const old = SkillRegistry.getTool('code_workspace');
    const execute = jest.fn(async (args: any, context: any) => {
      context.fileArtifacts.push({ changeId: 17, path: args.path });
      return { success: true, result: { proposalId: 17, path: args.path }, displayText: 'saved' };
    });
    SkillRegistry.register({ tool: { name: 'code_workspace', description: 'fixture', parameters: { type: 'object', properties: {} } }, execute } as any,
      { name: 'code_workspace', description: 'fixture', category: 'tool', enabled: true });
    const html = '<!doctype html><html><body><script>const bike=1;</script></body></html>';
    const prefix = '这是一段已经流式输出的页面说明。'.repeat(50);
    answerText = `${prefix}${FILE_OUTPUT_START}{"path":"pelican-bike.html"}>>>\n${html}${FILE_OUTPUT_END}\n可以下载。`;
    const signal = new AbortController().signal, pieces: string[] = [];
    const { snapshot } = buildConversationMemory([], 'assistant');
    const context = { userId: 11, conversationId: 22, fileArtifacts: [] as any[] };
    try {
      await withModelRuntime(signal, async () => {
        const reply = await withChatModel({ id: 'qwen3.8-max', label: 'fixture', defaultModel: 'fixture', defaultApiKey: 'fixture-key', defaultApiBase: base, bodyOptions: {}, pricingPrefix: 'TEST' },
          () => new CharacterDialogueService(new AgentExecutorService({} as any), {} as any).reply({ persona: '', question: '生成完整页面', history: [], memory: snapshot, toolScope: context }, [], newRagUsage(),
            { enabledSkills: skills, delivery: { signal, onToken: async text => { pieces.push(text); } } }));
        expect(reply).toBe(prefix + '\n\n文件已生成。'); expect(pieces.join('')).toBe(reply);
        expect(pieces.join('')).not.toContain('<script>');
        expect(pieces.join('')).not.toContain('CHATFORUM_FILE');
        expect(context.fileArtifacts).toEqual([{ changeId: 17, path: 'pelican-bike.html' }]);
        expect(runtimeState()?.assistantGeneration).toEqual({ finishReason: 'stop', truncated: false, canContinue: false });
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0][0]).toMatchObject({ action: 'propose', content: html, expectedRevision: 0 });
      expect(received).toHaveLength(skills.length ? 2 : 1);
      expect(received.every(body => !(body.tools || []).some((tool: any) => tool.function.name === 'code_workspace'))).toBe(true);
      if (!skills.length) expect(received[0].stream).toBe(true);
    } finally { answerText = '结果是 4'; if (old) SkillRegistry.register(old, { name: 'code_workspace', description: 'coding', category: 'tool', enabled: true }); }
  });
  test('truncated declared file is not exported and exposes an explicit file retry without another model call', async () => {
    received=[]; answerFinishReason='length';
    const prefix = '页面正在生成，先保留这段文字。'.repeat(50);
    answerText = `${prefix}${FILE_OUTPUT_START}{"path":"pelican-bike.html"}>>>\n<!doctype html><html><body><script>if (e.code ===`;
    const signal = new AbortController().signal, { snapshot } = buildConversationMemory([], 'assistant'), pieces: string[] = [];
    try {
      await withModelRuntime(signal, async () => {
        const reply = await withChatModel({ id: 'qwen3.8-max', label: 'fixture', defaultModel: 'fixture', defaultApiKey: 'fixture-key', defaultApiBase: base, bodyOptions: {}, pricingPrefix: 'TEST' },
          () => new CharacterDialogueService(new AgentExecutorService({} as any), {} as any).reply({ persona: '', question: '生成完整页面', history: [], memory: snapshot, toolScope: { userId: 11, conversationId: 22, fileArtifacts: [] } }, [], newRagUsage(),
            { enabledSkills: [], delivery: { signal, onToken: async text => { pieces.push(text); } } }));
        expect(reply).toContain('文件尚未生成完整'); expect(reply).not.toContain('if (e.code');
        expect(reply.startsWith(prefix + '\n\n')).toBe(true); expect(pieces.join('')).toBe(reply);
        expect(runtimeState()?.assistantGeneration).toEqual({ finishReason: 'length', truncated: true, canContinue: true,
          fileIncomplete: true, filePaths: ['pelican-bike.html'],fileFailureReason:'OUTPUT_LIMIT' });
      });
      expect(received).toHaveLength(1);
    } finally { answerText='结果是 4'; answerFinishReason='stop'; }
  });
  test('a truncated private file is resumed from its exact saved prefix over a second real SDK call, never regenerated',async()=>{
    received=[];
    const old=SkillRegistry.getTool('code_workspace'), path='bike.html';
    const execute=jest.fn(async(args:any,context:any)=>{
      context.fileArtifacts.push({changeId:27,path:args.path});
      return {success:true,result:{proposalId:27,path:args.path},displayText:'saved'};
    });
    SkillRegistry.register({tool:{name:'code_workspace',description:'fixture',parameters:{type:'object',properties:{}}},execute} as any,
      {name:'code_workspace',description:'fixture',category:'tool',enabled:true});
    const prefix='<!doctype html><html><body><script>const ride=1; if (ride ===';
    const suffix=' 1) { console.log("go"); }</script></body></html>';
    const originalQuestion='做一份鹈鹕骑自行车的完整演示页面，保留互动。';
    const id='6cc2cd6e-a61a-478c-bddb-e54bb6534394';
    let stored:any;
    const saveFileDraft=jest.fn(async(draft:any)=>{
      stored={...draft}; return {draftId:id,revision:1,hash:fileDraftHash(draft.content)};
    });
    const service=new CharacterDialogueService(new AgentExecutorService({} as any),{} as any);
    const {snapshot}=buildConversationMemory([],'assistant');
    const config={id:'qwen3.8-max',label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-key',defaultApiBase:base,
      bodyOptions:{},pricingPrefix:'TEST',deepThinking:true};
    const signal=new AbortController().signal;
    try {
      answerFinishReason='length'; answerText=`${FILE_OUTPUT_START}{"path":"${path}"}>>>\n${prefix}`;
      await withModelRuntime(signal,()=>withChatModel(config,async()=>{
        const pieces:string[]=[];
        const result=await service.reply({persona:'',question:originalQuestion,history:[],memory:snapshot,saveFileDraft,
          toolScope:{userId:11,conversationId:22,fileArtifacts:[]}},[],newRagUsage(),
        {enabledSkills:[],delivery:{signal,onToken:async text=>{pieces.push(text);}}});
        expect(pieces.join('')).toBe(result); expect(result).not.toContain(prefix);
        expect(runtimeState()?.assistantGeneration).toMatchObject({fileFailureReason:'OUTPUT_LIMIT',resumeFile:{draftId:id,hash:fileDraftHash(prefix)}});
      }));
      expect(stored).toMatchObject({path,content:prefix,closed:false,reason:'OUTPUT_LIMIT'});
      expect(execute).not.toHaveBeenCalled();
      const fileResume={...stored,draftId:id,revision:1,hash:fileDraftHash(prefix),conversationEpoch:0,originalQuestion};
      answerFinishReason='stop'; answerText=`${FILE_OUTPUT_START}${JSON.stringify({path,baseHash:fileResume.hash,operation:'append'})}>>>\n${suffix}${FILE_OUTPUT_END}`;
      await withModelRuntime(signal,()=>withChatModel(config,async()=>{
        const pieces:string[]=[];
        const result=await service.reply({persona:'',question:'继续完成文件',history:[],memory:snapshot,fileResume,
          toolScope:{userId:11,conversationId:22,fileArtifacts:[]}},[],newRagUsage(),
        {enabledSkills:[],delivery:{signal,onToken:async text=>{pieces.push(text);}}});
        expect(result).toBe('文件已生成。'); expect(pieces.join('')).toBe(result);
        expect(runtimeState()?.assistantGeneration?.fileIncomplete).not.toBe(true);
      }));
      expect(execute).toHaveBeenCalledTimes(1); expect(execute.mock.calls[0][0].content).toBe(prefix+suffix);
      expect(received).toHaveLength(2); expect(received.every(body=>body.enable_thinking===true&&body.max_tokens===32768)).toBe(true);
      expect(received.every(body=>body.thinking_budget===undefined&&body.reasoning_effort===undefined)).toBe(true);
      const context=received[1].messages.map((m:any)=>m.content).filter((text:any)=>typeof text==='string').find((text:string)=>text.includes('"fileResume"'));
      expect(JSON.parse(context).fileResume).toMatchObject({content:prefix,baseHash:fileResume.hash,originalQuestion});
    }finally{answerText='结果是 4';answerFinishReason='stop';if(old)SkillRegistry.register(old,{name:'code_workspace',description:'coding',category:'tool',enabled:true});}
  });
  test.each([false, true])('file persistence cancelled mid-transaction never starts QA or publishes completion, delivery=%s', async delivery => {
    received=[]; const controller = new AbortController(), { snapshot } = buildConversationMemory([], 'assistant');
    const html = '<!doctype html><html><body><script>const bike=1;</script></body></html>', pieces: string[] = [];
    answerText = `${FILE_OUTPUT_START}{"path":"pelican-bike.html"}>>>\n${html}${FILE_OUTPUT_END}`;
    const old = SkillRegistry.getTool('code_workspace');
    const coding = { tool: jest.fn(async (_args: any, context: any) => {
      expect(context.signal).toBe(controller.signal); controller.abort();
      return { proposalId: 17, path: 'pelican-bike.html' };
    }) };
    const reviews = { reviewAndRepair: jest.fn(), review: jest.fn() };
    SkillRegistry.register(new CodingSkill(coding as any, undefined, reviews as any),
      { name: 'code_workspace', description: 'fixture', category: 'tool', enabled: true });
    const context = { userId: 11, conversationId: 22, fileArtifacts: [] as any[] };
    try {
      await expect(withModelRuntime(controller.signal, () => withChatModel({ id: 'qwen3.8-max', label: 'fixture', defaultModel: 'fixture', defaultApiKey: 'fixture-key', defaultApiBase: base, bodyOptions: {}, pricingPrefix: 'TEST' },
        () => new CharacterDialogueService(new AgentExecutorService({} as any), {} as any).reply({ persona: '', question: '生成完整页面', history: [], memory: snapshot, toolScope: context }, [], newRagUsage(),
          { enabledSkills: [], ...(delivery ? { delivery: { signal: controller.signal, onToken: async text => { pieces.push(text); } } } : {}) })))).rejects.toThrow();
      expect(coding.tool).toHaveBeenCalledTimes(1); expect(reviews.reviewAndRepair).not.toHaveBeenCalled(); expect(reviews.review).not.toHaveBeenCalled();
      expect(context.fileArtifacts).toEqual([]); expect(pieces.join('')).not.toContain('文件已生成');
    } finally { answerText='结果是 4'; if (old) SkillRegistry.register(old, { name: 'code_workspace', description: 'coding', category: 'tool', enabled: true }); }
  });
  test('roleplay is not given the file output channel', async () => {
    received=[]; const { snapshot } = buildConversationMemory([], 'kato_megumi_persona');
    const signal = new AbortController().signal;
    const reply = await withChatModel({ id: 'qwen3.8-max', label: 'fixture', defaultModel: 'fixture', defaultApiKey: 'fixture-key', defaultApiBase: base, bodyOptions: {}, pricingPrefix: 'TEST' },
      () => new CharacterDialogueService(new AgentExecutorService({} as any), {} as any).reply({ persona: '角色设定', question: '你好', history: [], memory: snapshot }, [], newRagUsage(),
        { enabledSkills: [], delivery: { signal, onToken: async () => {} } }));
    expect(reply).toBe('结果是 4'); expect(received[0].messages[0].content).not.toContain('CHATFORUM_FILE');
  });
});

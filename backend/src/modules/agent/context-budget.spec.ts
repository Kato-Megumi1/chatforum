import { assertContext, compactMemory, estimateTokens, estimateModelTokens, IMAGE_TOKEN_RESERVE, selectHistory, stagePayload } from './context-budget';
import { beginModelCall, runtimeState, withModelRuntime, setModelStage } from './model-runtime';
import { newRagUsage } from './rag-model.service';

describe('targeted context packing and execution observations',()=>{
  const env={...process.env};
  afterEach(()=>{process.env={...env};});
  test('native images reserve visual tokens without counting base64 as text or altering the payload',()=>{
    const input=(size:number)=>({messages:[{role:'user',content:[{type:'text',text:'看图片'},
      {type:'image_url',image_url:{url:'data:image/jpeg;base64,'+'A'.repeat(size)}}]}]});
    expect(estimateModelTokens(input(1000000))).toBe(estimateModelTokens(input(10)));
    expect(estimateModelTokens(input(10))).toBeGreaterThan(IMAGE_TOKEN_RESERVE);
    const value=input(1000000);expect(()=>assertContext(value,4096)).not.toThrow();
    expect(value.messages[0].content[1].image_url.url.length).toBeGreaterThan(1000000);
    expect(()=>assertContext({messages:[{content:'A'.repeat(1000000)}]},4096)).toThrow();
  });
  test('whole-turn selection and stage input preserve current question and evidence verbatim',()=>{
    const history=Array.from({length:40},(_,i)=>[{role:'user',content:'问题'+i},{role:'assistant',content:'回答'+i}]).flat();
    const selected=selectHistory(history,180);
    expect(selected.length%2).toBe(0);expect(selected.at(-1)?.content).toBe('回答39');
    const payload=stagePayload({question:'为什么送眼镜',history,passages:[{text:'逐字原文'}]},'routing') as any;
    expect(payload.question).toBe('为什么送眼镜');expect(payload.passages).toEqual([{text:'逐字原文'}]);
    expect(compactMemory({revision:'private-hash',state:{},summary:{text:'旧对话'}})).not.toHaveProperty('revision');
    process.env.MODEL_CONTEXT_TOKEN_BUDGET='100';expect(()=>assertContext('中'.repeat(100),10)).toThrow();
    expect(estimateTokens('中'.repeat(20))).toBeGreaterThan(estimateTokens('a'.repeat(20)));
  });

  test('token packing retains an oversized server-sourced pair with explicit excerpts rather than empty history',()=>{
    const history=[{messageId:1,role:'user',content:'任务开始。'+'长'.repeat(17000)+'原问题结尾。'},
      {messageId:2,role:'assistant',content:'回答开头。'+'长'.repeat(27000)+'最后结论。',ragMetadata:{state:'roleplay',personaKey:'fixture'}}];
    const original=structuredClone(history), chosen=selectHistory(history,4000);
    expect(chosen.map(m=>m.messageId)).toEqual([1,2]);
    expect(chosen[0].content).toContain('历史消息 #1 的有源摘录，非全文');
    expect(chosen[1].content).toContain('旧回复不是事实背书');
    expect(chosen[1].content).toContain('最后结论');
    expect(chosen[1].ragMetadata).toEqual(history[1].ragMetadata);
    expect(estimateTokens(chosen)).toBeLessThanOrEqual(4000);
    expect(history).toEqual(original);
    const payload=stagePayload({question:'本轮完整问题',history,passages:[{text:'本轮逐字原文'}]},'routing') as any;
    expect(payload.question).toBe('本轮完整问题');expect(payload.passages).toEqual([{text:'本轮逐字原文'}]);
    expect(payload.history).toHaveLength(2);
    expect(selectHistory(history.map(({messageId:_source,...m})=>m),4000)).toEqual([]);
  });
  test('Unicode capacity estimate avoids byte-for-token counting while keeping mixed code and emoji headroom',()=>{
    const chinese='这是用于讨论和长对话的普通中文正文。'.repeat(100);
    const english='An ordinary conversation with several words. '.repeat(100);
    const code='const answer = { count: 123456, value: [1, 2, 3] };\n'.repeat(100);
    for(const text of [chinese,english,code]) {
      expect(estimateTokens(text)).toBeLessThan(Buffer.byteLength(text,'utf8'));
      expect(estimateTokens(text)).toBeGreaterThan(text.length/4);
    }
    expect(estimateTokens('😀'.repeat(20))).toBeGreaterThan(estimateTokens('a'.repeat(20)));
    expect(estimateTokens({text:chinese})).toBe(estimateTokens(JSON.stringify({text:chinese})));
    expect(estimateTokens(undefined)).toBe(16);
    const history=Array.from({length:40},(_,i)=>[{role:'user',content:chinese+i},{role:'assistant',content:english+i}]).flat();
    const chosen=selectHistory(history,12000);
    expect(chosen.length%2).toBe(0);expect(chosen.at(-1)).toEqual(history.at(-1));
    expect(chosen.reduce((sum,_,i)=>i%2?sum:sum+estimateTokens(chosen.slice(i,i+2)),0)).toBeLessThanOrEqual(12000);
  });
  test('usage is observation only: obsolete task limits cannot block calls; unknown usage stays separate',async()=>{
    process.env.AGENT_TASK_TOKEN_BUDGET='1';process.env.AGENT_TASK_MAX_CALLS='1';process.env.AGENT_TASK_TIMEOUT_MS='1';
    await withModelRuntime(new AbortController().signal,async()=>{
      const usage=newRagUsage();
      setModelStage('query_rewrite');const call=beginModelCall('chat','fixture',300,100,usage);
      setModelStage('verification');call.finish({prompt_tokens:20,completion_tokens:10});
      expect(usage.steps[0].stage).toBe('query_rewrite');
      expect(runtimeState()?.observedTokens).toBe(30);
      await new Promise(resolve=>setTimeout(resolve,10));
      beginModelCall('chat','fixture',300,100,usage).finish(undefined,true);
      expect(runtimeState()?.observedTokens).toBe(30);expect(runtimeState()?.estimatedUnreportedTokens).toBe(400);
      expect(usage.usageComplete).toBe(false);
      expect(()=>beginModelCall('chat','fixture',1000000,10000,usage).finish(undefined)).not.toThrow();
    });
  });
  test('concurrent tasks isolate metering and cancellation; unknown prices never interrupt dialogue',async()=>{
    process.env.AGENT_TASK_COST_CNY='1';delete process.env.RAG_INPUT_CNY_PER_MILLION;
    await withModelRuntime(new AbortController().signal,async()=>{
      expect(()=>beginModelCall('chat','fixture',100,10).finish({prompt_tokens:100,completion_tokens:10})).not.toThrow();
    });
    delete process.env.AGENT_TASK_COST_CNY;
    await Promise.all([1,2].map(async n=>withModelRuntime(new AbortController().signal,async()=>{
      for(let i=0;i<n;i++) beginModelCall('chat','fixture',10,10).finish({prompt_tokens:2,completion_tokens:1});
      await Promise.resolve();expect(runtimeState()?.calls).toBe(n);
    })));
    const cancel=new AbortController();cancel.abort();
    await withModelRuntime(cancel.signal,async()=>expect(()=>beginModelCall('chat','fixture',10,10)).toThrow());
  });
  test('cache and reasoning accounting never double-counts reasoning output',()=>{
    process.env.RAG_INPUT_CNY_PER_MILLION='10';process.env.RAG_CACHED_INPUT_CNY_PER_MILLION='1';process.env.RAG_OUTPUT_CNY_PER_MILLION='20';
    const u=newRagUsage();beginModelCall('chat','fixture',100,30,u).finish({prompt_tokens:100,completion_tokens:30,
      prompt_cache_hit_tokens:80,completion_tokens_details:{reasoning_tokens:20}});
    expect(u.inputTokens).toBe(100);expect(u.outputTokens).toBe(30);expect(u.reasoningTokens).toBe(20);
    expect(u.cachedInputTokens).toBe(80);expect(u.costCny).toBeCloseTo(.00088);
  });
});

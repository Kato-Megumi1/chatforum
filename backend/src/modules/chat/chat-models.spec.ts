import { currentChatModel, publicChatModels, resolveChatModel, withChatModel, generationBodyOptions, internalBodyOptions } from './chat-models';
import { RagModelService, newRagUsage } from '../agent/rag-model.service';

describe('server-owned model allowlist and per-request isolation', () => {
  const originalEnv = { ...process.env }, originalFetch = global.fetch;
  beforeEach(() => {
    process.env.DEFAULT_MODEL_API_BASE = 'https://api.deepseek.com';
    process.env.DEFAULT_MODEL_API_KEY = 'fixture-deepseek';
    process.env.DEFAULT_MODEL_NAME = 'legacy-fixture';
    process.env.DASHSCOPE_API_KEY = 'fixture-qwen';
    delete process.env.CHAT_DEFAULT_MODEL; delete process.env.DEEPSEEK_CHAT_ENABLED;
    delete process.env.DEEPSEEK_API_KEY; delete process.env.QWEN_API_KEY;
  });
  test('Qwen is the default without an implicit DeepSeek fallback', () => {
    expect(publicChatModels().defaultModelId).toBe('qwen3.8-max');
    expect(resolveChatModel().id).toBe('qwen3.8-max');
    delete process.env.DASHSCOPE_API_KEY;
    expect(publicChatModels()).toMatchObject({ defaultModelId: 'qwen3.8-max', configured: false });
    expect(() => resolveChatModel()).toThrow('尚未配置');
  });
  test('deployment can disable DeepSeek without deleting its credentials or switching explicit requests', () => {
    process.env.DEEPSEEK_CHAT_ENABLED = 'false';
    expect(publicChatModels().models[0]).toMatchObject({ available: false, unavailableReason: '管理员已停用此模型' });
    expect(() => resolveChatModel('deepseek-v4-pro')).toThrow('已停用');
    expect(resolveChatModel().id).toBe('qwen3.8-max');
    expect(process.env.DEFAULT_MODEL_API_KEY).toBe('fixture-deepseek');
  });
  afterEach(() => { process.env = { ...originalEnv }; global.fetch = originalFetch; jest.restoreAllMocks(); });
  test('public menu contains no credential, endpoint or arbitrary client model', () => {
    const menu = publicChatModels();
    expect(menu.models.map(m => m.id)).toEqual(['deepseek-v4-pro', 'qwen3.8-max']);
    expect(JSON.stringify(menu)).not.toMatch(/fixture-|apiKey|ApiKey|ApiBase|https:/);
    expect(() => resolveChatModel('anything-from-client')).toThrow('请选择');
    expect(resolveChatModel('qwen3.8-max').defaultModel).toBe('qwen3.8-max-0902');
  });
  test('unconfigured selection rejects instead of falling back or reusing a different provider key', () => {
    delete process.env.DASHSCOPE_API_KEY;
    expect(publicChatModels().models[1].available).toBe(false);
    expect(() => resolveChatModel('qwen3.8-max')).toThrow('尚未配置');
    process.env.DEFAULT_MODEL_API_BASE = 'https://different-provider.invalid';
    expect(publicChatModels().models[0].available).toBe(false);
  });
  test('overlapping requests and nested scopes do not leak model/credentials', async () => {
    const deepseek = resolveChatModel('deepseek-v4-pro'), qwen = resolveChatModel('qwen3.8-max');
    const values = await Promise.all([deepseek, qwen].map(m => withChatModel(m, async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(currentChatModel()).toBe(m);
      await withChatModel(m.id === deepseek.id ? qwen : deepseek, async () => {});
      return currentChatModel().id;
    })));
    expect(values).toEqual([deepseek.id, qwen.id]);
    expect(currentChatModel().id).toBe('legacy-fixture');
  });
  test('RAG JSON calls use selected endpoint, model, credential and thinking switch', async () => {
    const seen: any[] = [];
    global.fetch = jest.fn(async (url, options) => {
      seen.push({ url, body: JSON.parse(options.body as string), headers: options.headers });
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    }) as any;
    await withChatModel(resolveChatModel('deepseek-v4-pro'), () => new RagModelService().json('JSON', {}, newRagUsage()));
    await withChatModel(resolveChatModel('qwen3.8-max'), () => new RagModelService().json('JSON', {}, newRagUsage()));
    expect(seen[0]).toMatchObject({ body: { model: 'deepseek-v4-pro', thinking: { type: 'disabled' } }, headers: { Authorization: 'Bearer fixture-deepseek' } });
    expect(seen[1]).toMatchObject({ url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', body: { model: 'qwen3.8-max-0902', enable_thinking: false }, headers: { Authorization: 'Bearer fixture-qwen' } });
    expect(seen[1].body.thinking).toBeUndefined();
    expect(seen[0].body).toMatchObject({temperature:0,max_tokens:2500});
    await withChatModel(resolveChatModel('deepseek-v4-pro'), () => new RagModelService().json('JSON', {}, newRagUsage(), {temperature:.65,maxTokens:450}));
    expect(seen[2].body).toMatchObject({temperature:.65,max_tokens:450});
  });
  test.each(['qwen3.8-max','deepseek-v4-pro'])('request deep flag for %s applies to final chat but never structured RAG JSON',async id=>{
    const model=resolveChatModel(id,{deepThinking:true,webSearch:true});
    await withChatModel(model,async()=>{
      const timeouts=jest.spyOn(AbortSignal,'timeout');
      const enabled=id==='qwen3.8-max'?{enable_thinking:true}:{thinking:{type:'enabled'}};
      const disabled=id==='qwen3.8-max'?{enable_thinking:false}:{thinking:{type:'disabled'}};
      expect(generationBodyOptions()).toMatchObject(enabled);
      expect(internalBodyOptions()).toMatchObject(disabled);
      expect(currentChatModel()).toMatchObject({deepThinking:true,webSearch:true});
      expect(model.bodyOptions).toEqual(disabled);
      const seen:any[]=[];
      global.fetch=jest.fn(async(_url,init)=>{seen.push(JSON.parse(init.body as string));return {
        ok:true,json:async()=>({choices:[{message:{content:'{"ok":true}'}}],usage:{prompt_tokens:1,completion_tokens:1}})};}) as any;
      const service=new RagModelService();
      await service.json('JSON',{},newRagUsage());
      await service.json('JSON character expression',{},newRagUsage(),{maxTokens:700});
      expect(seen[0]).toMatchObject(disabled);expect(seen[0].max_tokens).toBe(2500);
      expect(seen[1]).toMatchObject(disabled);expect(seen[1].max_tokens).toBe(700);
      expect(timeouts.mock.calls.map(call=>call[0])).toEqual([60000,60000]);
    });
    expect(resolveChatModel(id)).toMatchObject({deepThinking:false,webSearch:false});
    await withChatModel(resolveChatModel(id),async()=>expect(generationBodyOptions()).toEqual(internalBodyOptions()));
  });
  test('parallel users with opposite deep/network choices and nested internal calls remain isolated',async()=>{
    const choices=await Promise.all([true,false].map(enabled=>withChatModel(resolveChatModel('qwen3.8-max',
      {deepThinking:enabled,webSearch:enabled}),async()=>{
      await new Promise(resolve=>setTimeout(resolve,enabled?8:2));
      expect(generationBodyOptions()).toMatchObject({enable_thinking:enabled});
      await withChatModel(resolveChatModel('deepseek-v4-pro',{deepThinking:!enabled}),async()=>{
        expect(generationBodyOptions()).toMatchObject({thinking:{type:enabled?'disabled':'enabled'}});
      });
      return [currentChatModel().deepThinking,currentChatModel().webSearch,generationBodyOptions().enable_thinking];
    })));
    expect(choices).toEqual([[true,true,true],[false,false,false]]);
    expect((resolveChatModel('qwen3.8-max',{deepThinking:'true',webSearch:'true'} as any))).toMatchObject({deepThinking:false,webSearch:false});
  });
  test('Qwen deep thinking stays enabled without an extra reasoning budget or effort downgrade',async()=>{
    await withChatModel(resolveChatModel('qwen3.8-max',{deepThinking:true}),async()=>{
      expect(generationBodyOptions()).toEqual({enable_thinking:true});
      for(const key of ['thinking_budget','reasoning_effort','max_completion_tokens'])
        expect(generationBodyOptions()).not.toHaveProperty(key);
    });
  });
  test('structured JSON and its existing format retry ignore a stray deep flag even inside an enabled chat scope',async()=>{
    const seen:any[]=[];let responses=['{"ok":true}','not-json','{"ok":true}'];
    global.fetch=jest.fn(async(_url,init)=>{seen.push(JSON.parse(init.body as string));return {
      ok:true,json:async()=>({choices:[{message:{content:responses.shift(),reasoning_content:'private-fixture-reasoning'}}],
        usage:{prompt_tokens:1,completion_tokens:1}})};}) as any;
    const service=new RagModelService();
    await withChatModel(resolveChatModel('qwen3.8-max',{deepThinking:false}),
      ()=>service.json('JSON final expression',{},newRagUsage(),{deepThinking:true,maxTokens:700} as any));
    const result=await withChatModel(resolveChatModel('qwen3.8-max',{deepThinking:true}),
      ()=>service.json('JSON final expression',{},newRagUsage(),{deepThinking:true,maxTokens:700} as any));
    expect(result).toEqual({ok:true});expect(JSON.stringify(result)).not.toContain('private-fixture-reasoning');
    expect(seen[0]).toMatchObject({enable_thinking:false});
    expect(seen.every(body=>body.enable_thinking===false&&body.response_format.type==='json_object')).toBe(true);
    expect(seen.map(body=>body.max_tokens)).toEqual([700,700,1400]);
    expect(seen).toHaveLength(3); // One existing, bounded format repair, not an automatic task loop.
  });
});

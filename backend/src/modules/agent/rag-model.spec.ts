import { RagModelService, newRagUsage } from './rag-model.service';
import { withChatModel } from '../chat/chat-models';
import { publicRunFailure, AnswerStageError } from './model-output.error';
describe('provider validation and truthful cost accounting', () => {
  const original = global.fetch;
  beforeEach(() => { process.env.EMBEDDING_API_KEY = 'test-only'; });
  afterEach(() => { global.fetch = original; });
  test('all-zero vectors cannot enter the vector store', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0, 0] }], usage: { total_tokens: 1 } }) })) as any;
    await expect(new RagModelService().embed(['test'], 'fixture')).rejects.toThrow('嵌入结果不完整');
  });
  test('missing token usage is unknown, not free', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 0] }] }) })) as any;
    const usage = newRagUsage();
    await new RagModelService().embed(['test'], 'fixture', usage);
    expect(usage.calls).toBe(1); expect(usage.usageComplete).toBe(false); expect(usage.costCny).toBeNull();
  });
  test('failed attempted requests invalidate estimated cost', async () => {
    global.fetch = jest.fn(async () => { throw Error('fixture'); }) as any;
    const usage = newRagUsage();
    await expect(new RagModelService().embed(['test'], 'fixture', usage)).rejects.toThrow();
    expect(usage.calls).toBe(1); expect(usage.usageComplete).toBe(false);
  });
});

describe('structured transport regression: voice prose is not a retrieval miss', () => {
  const original = global.fetch;
  const fixture = { id:'fixture',label:'fixture',defaultModel:'fixture',defaultApiBase:'https://example.test',defaultApiKey:'fixture-only',bodyOptions:{},pricingPrefix:'FIXTURE' };
  const response = (content:string, finish_reason='stop', refusal?:string) => ({ok:true,json:async()=>({choices:[{message:{content,refusal},finish_reason}],usage:{prompt_tokens:12,completion_tokens:5}})});
  const call = (usage = newRagUsage()) => withChatModel(fixture, () => new RagModelService().json('输出 JSON {"claims":[]}', {facts:[]},usage,{},[{role:'assistant',content:'上轮自然对话'}]));
  afterEach(() => { global.fetch = original; });
  test('ordinary prose is retried in place once; both calls charged, first marked failed', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response('这是一句未按格式返回的话')).mockResolvedValueOnce(response('{"claims":[{"factId":1,"text":"自然回答"}]}'));
    const usage = newRagUsage();expect(await call(usage)).toMatchObject({claims:[{factId:1}]});
    expect(usage.calls).toBe(2);expect(usage.inputTokens).toBe(24);expect(usage.steps.map(s=>s.status)).toEqual(['error','ok']);
    const sent = JSON.parse((global.fetch as jest.Mock).mock.calls[1][1].body);
    expect(sent.messages.at(-2).role).toBe('system');expect(sent.messages.at(-2).content).toContain('上一轮');
    expect(sent.messages[1]).toEqual({role:'assistant',content:'上轮自然对话'});
  });
  test('second malformed result has safe explicit code and is never delivered as dialogue', async () => {
    global.fetch = jest.fn().mockResolvedValue(response('不是 JSON'));
    await expect(call()).rejects.toMatchObject({code:'MODEL_OUTPUT_FORMAT'});expect(global.fetch).toHaveBeenCalledTimes(2);
    const failure=publicRunFailure(new AnswerStageError('voice','MODEL_OUTPUT_FORMAT'));
    expect(failure.message).toContain('角色表达');expect(failure.message).not.toContain('权限');
  });
  test('a 10k artifact format retry retains its requested output reserve on the wire', async () => {
    global.fetch=jest.fn().mockResolvedValueOnce(response('malformed fixture')).mockResolvedValueOnce(response('{"content":"<h1>fixed</h1>"}'));
    await expect(withChatModel(fixture,()=>new RagModelService().json('Output JSON',{html:'synthetic fixture'},newRagUsage(),{maxTokens:10000})))
      .resolves.toEqual({content:'<h1>fixed</h1>'});
    expect((global.fetch as jest.Mock).mock.calls.map(([,init])=>JSON.parse(init.body).max_tokens)).toEqual([10000,10000]);
  });
  test('whole JSON fences are accepted, prose fragments are not extracted', async () => {
    global.fetch = jest.fn().mockResolvedValue(response('```json\n{"claims":[]}\n```'));
    expect(await call()).toEqual({claims:[]});expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test.each(['null','[]','前缀 {"claims":[]}'])('invalid top-level value %s is rejected', async content => {
    global.fetch = jest.fn().mockResolvedValue(response(content));await expect(call()).rejects.toMatchObject({code:'MODEL_OUTPUT_FORMAT'});
  });
  test('provider safety stop is not retried or transformed into a character line', async () => {
    global.fetch = jest.fn().mockResolvedValue(response('', 'content_filter'));
    await expect(call()).rejects.toMatchObject({code:'MODEL_SAFETY_BLOCKED'});expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  test('network failure is not silently retried or blamed on lack of evidence', async () => {
    global.fetch = jest.fn().mockRejectedValue(Error('fixture-network'));
    await expect(call()).rejects.toThrow('模型请求失败或超时');expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

import { ChatRunService } from './chat-run.service';
import { withModelRuntime } from '../agent/model-runtime';
import { SkillRegistry } from '../agent/skills';
import { withChatModel } from './chat-models';
describe('durable web permission and real source delivery', () => {
  afterEach(() => jest.restoreAllMocks());
  test('roleplay cannot execute web search or save its metadata even with stale true payload and model scope', async () => {
    const creates: any[] = [], frame: any = { persona: '合成角色', question: '你好', history: [], memory: { personaKey: 'kato_megumi_persona' } };
    const tx: any = { conversation: { update: jest.fn() }, chatRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      chatMessage: { createMany: jest.fn(async value => { creates.push(value); }) } };
    const db: any = { $transaction: (work: any) => work(tx), chatRun: { updateMany: jest.fn() } };
    const novel: any = { answer: jest.fn(async (_id, _question, _history, _persona, _who, options) => {
      expect(options.enabledSkills).not.toContain('web_search'); expect(frame.toolScope.webSearch).toBe(false);
      return { content: '嗯，今天想聊什么？', metadata: { state: 'roleplay' } };
    }) };
    jest.spyOn(SkillRegistry, 'getAllMeta').mockReturnValue([]);
    const service = new ChatRunService(db, novel, { principal: jest.fn().mockResolvedValue({ id: 3 }) } as any,
      {} as any, { prepare: jest.fn().mockResolvedValue(frame), assertCurrentSources: jest.fn() } as any,
      { messageContext: jest.fn().mockResolvedValue({ current: [], library: [] }) } as any);
    const signal = new AbortController().signal;
    await withChatModel({ id:'qwen3.8-max',label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-only',defaultApiBase:'https://fixture.invalid',
      bodyOptions:{enable_thinking:false},pricingPrefix:'TEST',deepThinking:false,webSearch:true }, () => withModelRuntime(signal, () =>
        (service as any).executeSelected({ id:'role',userId:3,conversationId:7,
          input:{question:'你好',mode:'agent',enabledSkills:['web_search'],webSearch:true} }, 'lease', signal)));
    const answer = creates[0].data[1]; expect(answer.ragMetadata.responseOptions.webSearch).toBe(false);
    expect(answer.ragMetadata).not.toHaveProperty('webSearch');
  });
  test.each(['normal', 'agent'] as const)('only actual tool observations become message metadata in %s mode', async mode => {
    for (const enabled of [false, true]) {
      const creates: any[] = [], frame: any = { persona: '', question: '公开问题', history: [], memory: { personaKey: 'assistant' } };
      const source = { title: '公开页面', url: 'https://example.org/source', snippet: '搜索摘要', engine: 'Bing', retrievedAt: '2026-10-19T01:00:00Z' };
      const tx: any = { conversation: { update: jest.fn() }, chatRun: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
        chatMessage: { createMany: jest.fn(async value => { creates.push(value); }) } };
      const db: any = { $transaction: (work: any) => work(tx), chatRun: { updateMany: jest.fn() } };
      const rag: any = { principal: jest.fn().mockResolvedValue({ id: 3 }) };
      const memory: any = { prepare: jest.fn().mockResolvedValue(frame), assertCurrentSources: jest.fn() };
      const novel: any = { answer: jest.fn(async (_id, _question, _history, _persona, _who, options) => {
        expect(options.enabledSkills.includes('web_search')).toBe(enabled);
        expect(options.enabledSkills.includes('calculator')).toBe(mode === 'agent');
        expect(frame.toolScope.webSearch).toBe(enabled);
        if (enabled) frame.toolScope.webSources.push(source);
        return { content: '自然的回答', metadata: { state: 'general' } };
      }) };
      const coding: any = { messageContext: jest.fn().mockResolvedValue({ current: [], library: [] }) };
      jest.spyOn(SkillRegistry, 'getAllMeta').mockReturnValue([]);
      const service = new ChatRunService(db, novel, rag, {} as any, memory, coding);
      const signal = new AbortController().signal;
      await withChatModel({ id:'qwen3.8-max',label:'fixture',defaultModel:'fixture',defaultApiKey:'fixture-only',defaultApiBase:'https://fixture.invalid',
        bodyOptions:{enable_thinking:false},pricingPrefix:'TEST',deepThinking:true,webSearch:enabled }, () => withModelRuntime(signal, () =>
          (service as any).executeSelected({ id: 'fixture', userId: 3, conversationId: 7,
            input: { question: '公开问题', mode, enabledSkills: ['web_search', 'calculator'], deepThinking: true, webSearch: enabled } }, 'lease', signal)));
      expect(creates).toHaveLength(1);
      const answer = creates[0].data[1];
      expect(answer.ragMetadata.responseOptions).toEqual({ deepThinking: true, webSearch: enabled });
      if (enabled) expect(answer.ragMetadata.webSearch.sources).toEqual([source]);
      else expect(answer.ragMetadata).not.toHaveProperty('webSearch');
      expect(answer.ragMetadata).not.toHaveProperty('reasoning_content');
    }
  });
});

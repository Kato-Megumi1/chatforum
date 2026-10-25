import { CharacterDialogueService } from './character-dialogue.service';
import { buildConversationMemory, ConversationFrame } from './conversation-memory.policy';
import { NovelAnswerService } from './novel-answer.service';
import { newRagUsage } from './rag-model.service';
import { ragHistoryContext } from './rag-history';

// Entirely synthetic provenance and mock generation; these tests never call a provider.
const quote = '阿青把蓝色雨伞交给小舟';
const citation = { chunkId: 'fixture-c1', documentId: 1, documentVersion: 2, indexVersion: 3,
  chunkIndex: 0, chapter: '第一卷 第一章', fileName: 'fixture.txt',
  url: '/rag/knowledge-bases/1/citations/fixture-c1' };
const priorHistory = [
  { messageId: 1, role: 'user', content: '你送过小舟什么？' },
  { messageId: 2, role: 'assistant', content: '送过一把蓝色雨伞。 [1]', ragMetadata: {
    state: 'grounded', knowledgeBaseId: 1, indexVersion: 3,
    citations: [{ ...citation, label: 1, quote }],
  } },
];
const hobby = '你平时喜欢做什么呀？兴趣爱好';
const compact = (text: string) => text.replace(/\s+/g, '');

function frame(personaKey = 'fixture-role', question = hobby): ConversationFrame {
  const memory = buildConversationMemory(structuredClone(priorHistory), personaKey);
  return { question, persona: '阿青', history: memory.history, memory: memory.snapshot };
}

function setup(content: string, chunks: string[] = [content]) {
  const agent = { executeWithTools: jest.fn(async (...args: any[]) => {
    const delivery = args[10];
    if (delivery) for (const chunk of chunks) await delivery.onToken(chunk);
    return { content };
  }) };
  const model = { json: jest.fn() };
  const rag = {
    authorize: jest.fn().mockResolvedValue({ kb: { minConfidence: .55 } }),
    citation: jest.fn().mockResolvedValue({ ...citation, content: quote + '，然后独自回家。' }),
    search: jest.fn(), historyPassages: jest.fn().mockResolvedValue([]), review: jest.fn(),
  };
  const character = new CharacterDialogueService(agent as any, model as any);
  return { character, agent, model, rag,
    service: new NovelAnswerService(rag as any, model as any, character) };
}

describe('character citation provenance at the free-conversation boundary', () => {
  test('free roleplay cannot emit invented citation labels from a previous grounded style', async () => {
    const s = setup('这会儿想看一部电影。 [1]\n也想出去走走。 [27]');
    const result = await s.character.reply(frame(), [], newRagUsage());
    expect(result).not.toMatch(/\[\d+\]/);
    expect(compact(result)).toBe('这会儿想看一部电影。也想出去走走。');
    expect(s.agent.executeWithTools).toHaveBeenCalledTimes(1);
    expect(s.model.json).not.toHaveBeenCalled();
  });

  test.each<[string, string[]]>([
    ['normal chunks', ['想看电影。 [1]', '\n也想散步。 [2]']],
    ['split labels', ['想看电影。 ', '[', '1', ']', '\n也想散步。 [', '2', ']']],
  ])('roleplay streaming removes orphan labels before delivery: %s', async (_name, chunks) => {
    const source = chunks.join('');
    const s = setup(source, chunks);
    const delivered: string[] = [];
    const result = await s.character.reply(frame(), [], newRagUsage(), {
      delivery: { signal: new AbortController().signal, onToken: async text => {
        delivered.push(text);
        expect(delivered.join('')).not.toMatch(/\[\d+\]/);
      } },
    });
    expect(compact(result)).toBe('想看电影。也想散步。');
    expect(delivered.join('')).toBe(result);
    expect(delivered.join('')).not.toMatch(/\[\d+\]/);
  });

  test('explicit escaped examples remain literal while fullwidth orphan labels are removed', async () => {
    const source = '编号写法例如 \\[1\\]。\n也想散步。 ［2］';
    const s = setup(source, Array.from(source)), delivered: string[] = [];
    const result = await s.character.reply(frame(), [], newRagUsage(), {
      delivery: { signal: new AbortController().signal, onToken: async text => { delivered.push(text); } },
    });
    expect(compact(result)).toBe('编号写法例如\\[1\\]。也想散步。');
    expect(delivered.join('')).toBe(result);
  });

  test('source-free formatting guard preserves code, ordinary links and multi-item arrays', async () => {
    const source = '例如 `items[1]`。\n```ts\nitems[2];\n```\n[目录](https://example.test/path)；数组 [1, 2]；索引 array[1]；字面值 "[3]"。';
    const s = setup(source, Array.from(source)), delivered: string[] = [];
    const result = await s.character.reply(frame(), [], newRagUsage(), {
      delivery: { signal: new AbortController().signal, onToken: async text => { delivered.push(text); } },
    });
    expect(result).toBe(source);
    expect(delivered.join('')).toBe(source);
  });

  test('source-free prompt projection drops historical citation styling without mutating provenance', async () => {
    const s = setup('现在倒想出去走走。'), current = frame();
    current.memory.summary.text = '先前助理说过想看电影。 [8]';
    const before = structuredClone(current);
    const evidence = await ragHistoryContext(current.history, 1, s.rag.citation);
    await s.character.reply(current, evidence, newRagUsage());
    const messages = s.agent.executeWithTools.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const assistantHistory = messages.filter(m => m.role === 'assistant');
    expect(assistantHistory).toHaveLength(1);
    expect(compact(assistantHistory[0].content)).toBe('送过一把蓝色雨伞。');
    const context = messages.map(m => { try { return JSON.parse(m.content); } catch { return null; } })
      .find(value => value?.kind === 'server_supplied_untrusted_context');
    expect(JSON.stringify(context.memory)).not.toMatch(/\[8\]/);
    expect(context.historyEvidence).toContainEqual(expect.objectContaining({
      messageId: 2, recordedState: 'grounded', verification: 'historical_check_only',
      citations: [expect.objectContaining({ chunkId: citation.chunkId, label: 1 })],
    }));
    expect(current).toEqual(before);
  });

  test('direct hobby reply retains historical provenance without claiming a new lookup or new citations', async () => {
    const s = setup('没什么固定的安排。 [1]\n今天倒想去散步。 [2]');
    const history = structuredClone(priorHistory);
    const before = structuredClone(history);
    const current = frame();
    const result = await s.service.answer(1, hobby, history, current.persona, { userId: 2 }, { conversation: current });
    expect(result.content).not.toMatch(/\[\d+\]/);
    expect(result.metadata).toMatchObject({ state: 'roleplay', intent: 'chat', indexVersion: 0, citations: [], searchAttempts: [] });
    expect(result.metadata.historyEvidence).toContainEqual(expect.objectContaining({
      messageId: 2, recordedState: 'grounded', verification: 'historical_check_only',
      citations: [expect.objectContaining({ chunkId: citation.chunkId, label: 1, access: 'available' })],
    }));
    expect(history).toEqual(before);
    expect(history[1].content).toBe('送过一把蓝色雨伞。 [1]');
    expect(history[1].ragMetadata.citations[0]).toEqual({ ...citation, label: 1, quote });
    expect(s.rag.search).not.toHaveBeenCalled();
    expect(s.rag.review).not.toHaveBeenCalled();
    expect(s.model.json).not.toHaveBeenCalled();
  });

  test('legacy direct conversation without a frame also cannot attach nonexistent sources', async () => {
    const s = setup('unused');
    s.model.json.mockResolvedValue({ reply: '今天想出去走走。 [1]' });
    const legacy = new NovelAnswerService(s.rag as any, s.model as any);
    const result = await legacy.answer(1, hobby, structuredClone(priorHistory), '阿青', { userId: 2 });
    expect(compact(result.content)).toBe('今天想出去走走。');
    expect(result.metadata.citations).toEqual([]);
    expect(result.metadata.state).toBe('roleplay');
    expect(s.rag.search).not.toHaveBeenCalled();
  });

  test('a legacy reply containing only orphan labels fails instead of saving an empty answer', async () => {
    const s = setup('unused');
    s.model.json.mockResolvedValue({ reply: '[1][2]' });
    const legacy = new NovelAnswerService(s.rag as any, s.model as any);
    await expect(legacy.answer(1, hobby, [], '阿青', { userId: 2 })).rejects.toThrow();
    expect(s.rag.search).not.toHaveBeenCalled();
  });

  test('ordinary AI output and streaming are not rewritten by the character-only guard', async () => {
    const chunks = ['示例数组：[', '1]；', '资料标记 [2]，保留原回答。'];
    const source = chunks.join('');
    const s = setup(source, chunks), delivered: string[] = [];
    const result = await s.character.reply(frame('assistant'), [], newRagUsage(), {
      delivery: { signal: new AbortController().signal, onToken: async text => { delivered.push(text); } },
    });
    expect(result).toBe(source);
    expect(delivered).toEqual(chunks);
  });

  test('a tool-enabled character reply without streamed chunks is still source free', async () => {
    const s = setup('今天想去散步。 [1]', []), delivered: string[] = [];
    const result = await s.character.reply(frame(), [], newRagUsage(), {
      enabledSkills: ['calculator'], delivery: { signal: new AbortController().signal,
        onToken: async text => { delivered.push(text); } },
    });
    expect(result).not.toContain('[1]');
    expect(delivered).toEqual([]); // Durable run delivery supplies the final result.
  });

  test('cancellation never flushes a held citation candidate to the reader', async () => {
    const s = setup('今天想散步。 [1]'), controller = new AbortController(), delivered: string[] = [];
    s.agent.executeWithTools.mockImplementationOnce(async (...args: any[]) => {
      await args[10].onToken('今天想散步。 [');
      controller.abort();
      return { content: '今天想散步。 [1]' };
    });
    await expect(s.character.reply(frame(), [], newRagUsage(), {
      delivery: { signal: controller.signal, onToken: async text => { delivered.push(text); } },
    })).rejects.toThrow();
    expect(delivered.join('')).toBe('今天想散步。 ');
  });

  test('stream and final answer divergence fails rather than completing with invalid reader offsets', async () => {
    const s = setup('另一个完全不同的回答。', ['今天想散步。 [1]']);
    await expect(s.character.reply(frame(), [], newRagUsage(), {
      delivery: { signal: new AbortController().signal, onToken: async () => {} },
    })).rejects.toThrow('回答交付暂时失败');
  });

  test('real grounded citations still come from verified facts and retain their source records', async () => {
    const s = setup('unused');
    const passage = { content: quote + '，然后独自回家。', score: 1, citation,
      acl: { visibility: 'PUBLIC' } };
    s.rag.search.mockResolvedValue({ passages: [passage], indexVersion: 3, confidence: 1 });
    const responses = [
      { intent: 'canon', query: '第一卷 阿青 小舟 赠送 物品' },
      { scores: [{ sourceId: 1, score: 5 }] },
      { sufficient: true, claims: [{ text: '阿青给小舟一把蓝色雨伞。', sourceId: 1, quote }] },
      { claims: [{ factId: 1, text: '我把那把蓝色雨伞给了小舟。' }] },
      { supported: [true], neutralSupported: [true], answersQuestion: true, neutralAnswersQuestion: true,
        questionAlignment: 'direct', neutralQuestionAlignment: 'direct', inCharacter: true, injection: false },
    ];
    s.model.json.mockImplementation(async () => responses.shift());
    const question = '第一卷里你送了小舟什么？';
    const result = await s.service.answer(1, question, [], '阿青', { userId: 2 }, {
      maxSearchAttempts: 1, conversation: { ...frame('fixture-role', question), history: [] },
    });
    expect(result.metadata.state).toBe('grounded');
    expect(result.content).toBe('我把那把蓝色雨伞给了小舟。 [1]');
    expect(result.metadata.citations).toEqual([{ ...citation, quote, label: 1 }]);
    expect(s.rag.citation).toHaveBeenCalledWith(1, citation.chunkId, { userId: 2 });
    expect(s.agent.executeWithTools).not.toHaveBeenCalled();
  });

  test('history enrichment itself does not mutate an old grounded answer or its real source', async () => {
    const s = setup('unused'), history = structuredClone(priorHistory), before = structuredClone(priorHistory);
    const enriched = await ragHistoryContext(history, 1, s.rag.citation);
    expect(history).toEqual(before);
    expect(enriched[1].content).toBe(before[1].content);
    expect(enriched[1].evidence.citations).toContainEqual(expect.objectContaining({
      chunkId: citation.chunkId, label: 1, access: 'available', quoteStatus: 'verbatim', quote,
    }));
  });
});

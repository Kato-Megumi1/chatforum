import { ForbiddenException } from '@nestjs/common';
import { NovelAnswerService } from './novel-answer.service';
import {
  isOpenPreference,
  requiresCanon,
  isCharacterInterpretation,
  answerFocus,
  directConversation,
  relationshipSearchQueries,
} from './novel-dialogue.policy';
import { novelSourceAllowed, fusePassages } from './rag-policy';

const p = (id = 'a') => ({
  content: '阿青把蓝色雨伞交给小舟，然后独自回家。',
  score: 1,
  citation: { chunkId: id, documentId: 1, documentVersion: 1, indexVersion: 5, chunkIndex: 0, fileName: 'test.txt' },
  acl: { visibility: 'INHERIT' },
});
function setup(responses: any[]) {
  const rag = {
    authorize: jest.fn().mockResolvedValue({ kb: { minConfidence: 0.55 } }),
    search: jest.fn().mockImplementation(async () => ({ passages: [p()], confidence: 0.9, indexVersion: 5 })),
    citation: jest.fn().mockResolvedValue({}),
    review: jest.fn().mockResolvedValue(10),
  };
  const model = { json: jest.fn(async (...args: any[]) => {
    if (args[0].includes('CONTINUATION_CHECK_V2')) return { unsupportedClaims: [], continuity: true, bounded: true,
      citationsValid: true, inCharacter: true, injection: false };
    const response = responses.shift();
    return args[0].includes('CONTINUATION_DRAFT_V2') ? { ...response, factIds: [] } : response;
  }) };
  return { rag, model, service: new NovelAnswerService(rag as any, model as any) };
}
const facts = {
  sufficient: true,
  claims: [{ text: '阿青给小舟蓝色雨伞。', sourceId: 1, quote: '阿青把蓝色雨伞交给小舟' }],
};
const voice = { claims: [{ factId: 1, text: '我把蓝色雨伞给了小舟。' }] };
const check = { supported: [true], answersQuestion: true, injection: false, questionAlignment: 'direct', inCharacter: true };

describe('conversation vs canon and adaptive retrieval', () => {
  test('identity introduction stays in character, even after a legacy disclaimer', async () => {
    const s = setup([{ reply: '加藤惠。叫我惠就可以了。' }]);
    const result = await s.service.answer(
      1,
      '你叫啥？',
      [{ role: 'assistant', content: '我是加藤惠。不过，现在是在角色模拟里，所以不是现实中的某个人哦。' }],
      '加藤惠',
      { userId: 2 },
    );
    expect(result.metadata.dialogueAct).toBe('introduction');
    expect(result.content).not.toMatch(/模拟|AI|现实|扮演/);
    expect(s.rag.search).not.toHaveBeenCalled();
    expect(s.model.json).toHaveBeenCalledTimes(1);
    expect(directConversation('怎么称呼你', []).act).toBe('introduction');
    expect(directConversation('你是谁？', []).act).toBe('introduction');
  });
  test('identity challenges stay in the fictional scene; unrelated AI topics are not identity questions', () => {
    expect(directConversation('你是现实中的真人，还是AI？', []).act).toBe('identity_challenge');
    expect(directConversation('你觉得AI画画怎么样？', []).act).not.toBe('identity_challenge');
    expect(directConversation('原作里你是机器人吗？', []).act).toBe('source_question');
    expect(directConversation('你叫啥，第一卷你第一次在哪里见到伦也？', []).direct).toBe(false);
  });
  test('short repair anchors the previous assistant, never a dictionary entry or a fabricated memory', async () => {
    const previous = '你好，今天也来聊天了吗？';
    const s = setup([{ reply: '就是打个招呼啦。刚才那句话有点多余了呢。' }]);
    const result = await s.service.answer(
      1,
      '何意味',
      [
        { role: 'USER', content: '你好惠' },
        { role: 'ASSISTANT', content: previous },
        { role: 'USER', content: '何意味' },
      ],
      '加藤惠',
      { userId: 2 },
    );
    expect(result.metadata.dialogueAct).toBe('repair');
    expect(result.metadata.state).toBe('roleplay');
    expect(s.model.json.mock.calls[0][1].dialogue.lastAssistant).toBe(previous);
    expect(s.model.json.mock.calls[0][3]).toEqual({ temperature: 0.65, maxTokens: 450 });
    expect(s.rag.search).not.toHaveBeenCalled();
    expect(s.rag.review).not.toHaveBeenCalled();
  });
  test('greeting is lightweight; context-free ambiguity and explicit source questions still need routing', () => {
    expect(directConversation('你好惠', [])).toMatchObject({ act: 'greeting', direct: true });
    expect(directConversation('何意味', []).direct).toBe(false);
    expect(directConversation('原作里这句什么意思', [{ role: 'assistant', content: '一句话' }]).direct).toBe(false);
    expect(directConversation('你好惠，第一卷初次相遇在哪', []).direct).toBe(false);
  });
  test('relationship retries search interactions under canonical entity names, not a repeated why query', () => {
    const queries = relationshipSearchQueries('惠，你为什么会喜欢伦也这个家伙啊！');
    expect(queries).toHaveLength(2);
    expect(queries.every((q) => q.includes('加藤惠') && q.includes('安艺伦也'))).toBe(true);
    expect(queries[0]).not.toContain('喜欢的原因');
  });
  test('open hobbies are a conversation; explicit novel and relationship facts stay canon', () => {
    expect(isOpenPreference('嗯哼~惠，可以问一下你的兴趣爱好嘛？')).toBe(true);
    expect(isOpenPreference('原作中惠的兴趣爱好是什么？')).toBe(false);
    expect(requiresCanon('惠，你为什么会喜欢伦也这个家伙啊！！！')).toBe(true);
    expect(isCharacterInterpretation('第一卷的具体台词是什么')).toBe(false);
    expect(isCharacterInterpretation('惠，为什么喜欢下雨呢？')).toBe(false);
    expect(isCharacterInterpretation('惠，为什么你会喜欢我呢？')).toBe(false);
    expect(isCharacterInterpretation('你为什么会喜欢伦也呢？')).toBe(true);
    expect(directConversation('嗯', [{ role: 'assistant', content: '一起想想吧。' }]).direct).toBe(false);
  });
  test('the reported hobby question answers naturally without a search or a review ticket', async () => {
    const s = setup([{ reply: '现在让我选的话，倒是想出去走走。总坐着也有点闷呢。' }]);
    const answer = await s.service.answer(1, '嗯哼~惠，可以问一下你的兴趣爱好嘛？', [], '加藤惠', { userId: 2 });
    expect(answer.metadata.state).toBe('roleplay');
    expect(answer.metadata.searchAttempts).toEqual([]);
    expect(s.rag.search).not.toHaveBeenCalled();
    expect(s.rag.review).not.toHaveBeenCalled();
    expect(s.model.json).toHaveBeenCalledTimes(1);
  });
  test('a failed first search changes wording and fusion strategy but preserves the original scope and index', async () => {
    const s = setup([
      { intent: 'canon', query: '阿青雨伞' },
      { queries: ['小舟收到的物品', '阿青 小舟 交给 雨伞'] },
      { scores: [{ sourceId: 1, score: 5 }] },
      facts,
      voice,
      check,
    ]);
    s.rag.search.mockResolvedValueOnce({ passages: [], confidence: 0, indexVersion: 5 });
    const q = '第一卷里，阿青给了小舟什么？';
    const answer = await s.service.answer(1, q, [], '阿青', { userId: 2 });
    expect(answer.metadata.state).toBe('grounded');
    expect(s.rag.search).toHaveBeenCalledTimes(2);
    expect(s.rag.search.mock.calls[1][1]).toBe('小舟收到的物品');
    expect(s.rag.search.mock.calls[1][5]).toMatchObject({ strategy: 'semantic', scopeQuery: q, indexVersion: 5 });
    expect(answer.metadata.searchAttempts.map((a) => a.outcome)).toEqual(['no_hits', 'grounded']);
    expect(s.rag.review).not.toHaveBeenCalled();
  });
  test('three failed strategies stop and continue the conversation without reciting a work order', async () => {
    const s = setup([
      { intent: 'canon', query: '阿青未知情节' },
      { scores: [{ sourceId: 1, score: 2 }] },
      { queries: ['阿青的约定', '阿青 约定'] },
      { scores: [{ sourceId: 1, score: 2 }] },
      { scores: [{ sourceId: 1, score: 1 }] },
      { reply: '那一点我还不太确定。你是更在意她当时怎么想的吗？' },
    ]);
    const answer = await s.service.answer(1, '未知情节', [], '阿青', { userId: 2 });
    expect(s.rag.search).toHaveBeenCalledTimes(3);
    expect(s.rag.review).toHaveBeenCalledTimes(1);
    expect(answer.metadata.searchAttempts.map((a) => a.strategy)).toEqual(['balanced', 'semantic', 'lexical']);
    expect(answer.metadata.state).toBe('needs_review');
    expect(answer.content).not.toMatch(/复核|检索|原文依据|#10/);
    expect(answer.content).toContain('当时怎么想');
    expect(s.rag.review.mock.calls[0][3].passages).toHaveLength(1);
  });
  test('relationship interpretation can use complementary scenes, never silently present an analysis as canon', async () => {
    const s = setup([
      { intent: 'chat' },
      {
        scores: [
          { sourceId: 1, score: 3 },
          { sourceId: 2, score: 3 },
        ],
      },
      facts,
      { claims: [{ factId: 1, text: '我想，那种被认真对待的感觉会让我在意吧。' }] },
      check,
    ]);
    s.rag.search.mockResolvedValueOnce({ passages: [p(), p('b')], confidence: 0.5, indexVersion: 5 });
    const answer = await s.service.answer(1, '惠，你为什么会喜欢伦也这个家伙啊！！！', [], '加藤惠', { userId: 2 });
    expect(answer.metadata.intent).toBe('canon');
    expect(answer.metadata.interpretation).toBe(true);
    expect(answer.metadata.state).toBe('grounded');
    expect(answer.metadata.confidence).toBe(0.5);
    expect(s.model.json.mock.calls.at(-1)[0]).toContain('不得添新事件');
  });
  test('partial clues alone cannot pass a concrete fact question', async () => {
    const s = setup([
      { intent: 'canon' },
      {
        scores: [
          { sourceId: 1, score: 3 },
          { sourceId: 2, score: 3 },
        ],
      },
      { reply: '那一点还不能确定。' },
    ]);
    s.rag.search.mockResolvedValueOnce({ passages: [p(), p('b')], confidence: 0.5, indexVersion: 5 });
    const answer = await s.service.answer(
      1,
      '第一卷里具体给了什么？',
      [],
      '阿青',
      { userId: 2 },
      { maxSearchAttempts: 1 },
    );
    expect(answer.metadata.state).toBe('needs_review');
    expect(s.model.json.mock.calls.some((c) => c[0].includes('先提取回答问题必需的'))).toBe(false);
  });
  test('revoked access propagates instead of triggering another search or a chat bypass', async () => {
    const s = setup([{ intent: 'canon' }]);
    s.rag.search.mockRejectedValueOnce(new ForbiddenException());
    await expect(s.service.answer(1, '第一卷的事件', [], '惠', { userId: 2 })).rejects.toThrow(ForbiddenException);
    expect(s.rag.search).toHaveBeenCalledTimes(1);
    expect(s.rag.review).not.toHaveBeenCalled();
  });
  test('author interviews are not character memories unless the question explicitly asks for them', () => {
    expect(novelSourceAllowed('短篇集 作者专访', '惠为什么喜欢伦也')).toBe(false);
    expect(novelSourceAllowed('第八卷 后记', '作者在后记说了什么')).toBe(true);
    expect(novelSourceAllowed(undefined, '普通TXT小说')).toBe(true);
  });
  test('retry genuinely changes fusion weights, not just the query label', () => {
    const semantic = [p('s')],
      lexical = [p('l')];
    expect(fusePassages(semantic as any, lexical as any, 2, [], 'semantic')[0].citation.chunkId).toBe('s');
    expect(fusePassages(semantic as any, lexical as any, 2, [], 'lexical')[0].citation.chunkId).toBe('l');
  });
  test('an exact but overlong quote gets one in-place repair, not another retrieval or a weakened check', async () => {
    const long = '阿青把蓝色雨伞交给小舟，然后独自回家。'.repeat(10);
    const s = setup([
      { intent: 'canon' },
      { scores: [{ sourceId: 1, score: 5 }] },
      { sufficient: true, claims: [{ ...facts.claims[0], quote: long }] },
      { quotes: [{ factId: 1, quote: facts.claims[0].quote }] },
      voice,
      check,
    ]);
    s.rag.search.mockResolvedValueOnce({ passages: [{ ...p(), content: long }], confidence: 0.9, indexVersion: 5 });
    const result = await s.service.answer(1, '第一卷里给了什么？', [], '阿青', { userId: 2 });
    expect(result.metadata.state).toBe('grounded');
    expect(result.metadata.evidenceRepairs).toBe(1);
    expect(s.rag.search).toHaveBeenCalledTimes(1);
    expect(result.metadata.citations[0]).toMatchObject({ quote: facts.claims[0].quote });
  });
  test('a fabricated shortened quote still fails verbatim validation', async () => {
    const long = '阿青把蓝色雨伞交给小舟，然后独自回家。'.repeat(10);
    const s = setup([
      { intent: 'canon' },
      { scores: [{ sourceId: 1, score: 5 }] },
      { sufficient: true, claims: [{ ...facts.claims[0], quote: long }] },
      { quotes: [{ factId: 1, quote: '从来没有存在过的伪造引用' }] },
      { reply: '那一点我还不太确定。' },
    ]);
    s.rag.search.mockResolvedValueOnce({ passages: [{ ...p(), content: long }], confidence: 0.9, indexVersion: 5 });
    const result = await s.service.answer(1, '第一卷里给了什么？', [], '阿青', { userId: 2 }, { maxSearchAttempts: 1 });
    expect(result.metadata.state).toBe('needs_review');
    expect(result.metadata.searchAttempts[0].outcome).toBe('invalid_evidence_format');
    expect(result.metadata.citations).toEqual([]);
  });
  test('question focus guides semantic checking rather than vetoing answer vocabulary', () => {
    expect(answerFocus('在哪里见面？')).toBe('location');
    expect(answerFocus('为什么送礼？')).toBe('reason');
    expect(answerFocus('送了什么？')).toBe('other');
  });
});

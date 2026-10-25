import { ForbiddenException } from '@nestjs/common';
import { NovelAnswerService } from './novel-answer.service';
import { CharacterDialogueService } from './character-dialogue.service';
import { RagService } from './rag.service';
import { buildConversationMemory } from './conversation-memory.policy';
import { ragHistoryContext, reusableHistorySources } from './rag-history';
import { groundedSearchQuery, isCharacterInterpretation } from './novel-dialogue.policy';

const quote = '阿青把蓝色雨伞交给小舟';
const citation = { chunkId: 'c1', documentId: 1, documentVersion: 2, indexVersion: 3, chunkIndex: 5,
  chapter: '第十二卷 第三章', fileName: 'fixture', url: '/rag/knowledge-bases/1/citations/c1' };
const passage = { content: quote + '，小舟收下了雨伞。', citation, score: 0, acl: { visibility: 'PUBLIC' } };
const history = [
  { messageId: 1, role: 'user', content: '你送过小舟什么？' },
  { messageId: 2, role: 'assistant', content: '送过一把伞。[1]', ragMetadata:
    { state: 'grounded', knowledgeBaseId: 1, indexVersion: 3, citations: [{ ...citation, quote }] } },
];
const question = '为什么你当时送他伞？';
const verified = { supported: [true], neutralSupported: [true], answersQuestion: true, neutralAnswersQuestion: true,
  questionAlignment: 'direct', neutralQuestionAlignment: 'direct', inCharacter: true, injection: false };

describe('targeted evidence-memory follow-up regression', () => {
  test('a mistaken chat plan cannot bypass evidence for a bounded character-perspective follow-up', async () => {
    const question = '你对他的看法有什么变化嘛？';
    const source = '加藤惠与安艺伦也讨论了社团游戏的分工';
    const previous = [
      { messageId: 1, role: 'user', content: '惠，可以讲讲你和伦也的经历嘛？' },
      { messageId: 2, role: 'assistant', content: '我和伦也讨论过社团游戏。 [1]', ragMetadata: {
        state: 'grounded', knowledgeBaseId: 1, indexVersion: 3, citations: [{ ...citation, quote: source, label: 1 }],
      } },
    ];
    const rag = { authorize: jest.fn().mockResolvedValue({ kb: { minConfidence: .55 } }),
      citation: jest.fn().mockResolvedValue({ ...citation, content: source }),
      search: jest.fn().mockResolvedValue({ passages: [{ ...passage, content: source }], indexVersion: 3, confidence: 1 }),
      historyPassages: jest.fn().mockResolvedValue([]), review: jest.fn() };
    const responses = [
      { intent: 'chat', query: '' }, // The narrow context hint requires canonical checking despite this classifier mistake.
      { scores: [{ sourceId: 1, score: 5 }] },
      { sufficient: true, claims: [{ text: '加藤惠和安艺伦也讨论过分工。', sourceId: 1, quote: source }] },
      { claims: [{ factId: 1, text: '一起讨论分工以后，我想，我也更愿意和他好好沟通了。' }] }, verified,
    ];
    const model = { json: jest.fn(async (..._args: any[]) => responses.shift()) };
    const agent = { executeWithTools: jest.fn() }, character = new CharacterDialogueService(agent as any, model as any);
    const memory = buildConversationMemory(previous, 'kato_megumi_persona');
    const result = await new NovelAnswerService(rag as any, model as any, character).answer(1, question,
      [...previous, { role: 'user', content: question }], '加藤惠', { userId: 2 }, {
        maxSearchAttempts: 1, conversation: { question, persona: '加藤惠', history: memory.history, memory: memory.snapshot },
      });
    expect(result.metadata).toMatchObject({ intent: 'canon', state: 'grounded', interpretation: true,
      dialogueAct: 'canonical_followup', canonicalFollowup: {
        entity: { key: 'tomoya' }, verification: 'reference_only_not_evidence', contextMessageIds: [1, 2],
      } });
    expect(agent.executeWithTools).not.toHaveBeenCalled();
    expect(rag.search.mock.calls[0][1]).toMatch(/加藤惠.*安艺伦也/);
    expect(rag.search.mock.calls[0][1]).not.toContain('第十二卷');
    expect(rag.search.mock.calls[0][5]).toMatchObject({ scopeQuery: question });
    const rerank = model.json.mock.calls[1] as any[];
    expect(rerank[1].questionTarget).toMatchObject({ originalQuestion: question,
      canonicalFollowup: { resolvedQuestion: '你对安艺伦也的看法有什么变化嘛？' } });
    expect(result.metadata.citations).toHaveLength(1);
    expect(rag.citation).toHaveBeenCalledTimes(2);
  });

  test('no new hits reuses a historical source, rechecks it and accepts a semantic reason without keyword templates', async () => {
    const rag = { authorize: jest.fn().mockResolvedValue({ kb: { minConfidence: .55 } }),
      citation: jest.fn().mockResolvedValue({ ...citation, content: passage.content }),
      search: jest.fn().mockResolvedValue({ passages: [], indexVersion: 3, confidence: 0 }),
      historyPassages: jest.fn().mockResolvedValue([passage]), review: jest.fn() };
    const answers = [{ intent: 'canon', query: '第十二卷 阿青送小舟雨伞的原因' },
      { scores: [{ sourceId: 1, score: 5 }] },
      { sufficient: true, claims: [{ text: '阿青送小舟一把伞。', sourceId: 1, quote }] },
      { claims: [{ factId: 1, text: '那把伞啊。我想，实用的礼物就很合适。' }] }, verified];
    const model = { json: jest.fn(async (..._args: any[]) => answers.shift()) };
    const character = new CharacterDialogueService(undefined, model as any);
    const memory = buildConversationMemory(history, 'fixture');
    const result = await new NovelAnswerService(rag as any, model as any, character).answer(1, question, history,
      '阿青', { userId: 2 }, { conversation: { question, persona: '阿青', history: memory.history, memory: memory.snapshot } });
    expect(result.metadata).toMatchObject({ state: 'grounded', interpretation: true, answerPipelineVersion: 'character-conversation-v7.2' });
    expect(result.content).toBe('那把伞啊。我想，实用的礼物就很合适。 [1]');
    expect(result.metadata.searchAttempts[0].historyReuse).toMatchObject({ available: 1, added: 1, chunkIds: ['c1'] });
    expect(rag.historyPassages).toHaveBeenCalledWith(1, expect.any(Array), { userId: 2 }, 3, question);
    expect(rag.search.mock.calls[0][1]).not.toContain('第十二卷');
    expect(model.json.mock.calls[1][1].passages[0].text).toBe(passage.content);
    expect(rag.citation).toHaveBeenCalledTimes(2); // history read + final delivery
    expect(rag.review).not.toHaveBeenCalled();
  });

  test('unproven/denied/cross-KB historical prose is never promoted to source candidates', async () => {
    const lookup = jest.fn().mockResolvedValue({ ...citation, content: passage.content });
    const untrusted = { ...history[1], messageId: undefined };
    expect(reusableHistorySources(await ragHistoryContext([untrusted], 1, lookup))).toEqual([]);
    expect(reusableHistorySources(await ragHistoryContext(history, 2, lookup))).toEqual([]);
    lookup.mockRejectedValue(new ForbiddenException());
    expect(reusableHistorySources(await ragHistoryContext(history, 1, lookup))).toEqual([]);
  });

  test('action-motive retry changes the query instead of reusing an empty relationship plan', async () => {
    const rag = { authorize: jest.fn().mockResolvedValue({ kb: { minConfidence: .55 } }),
      citation: jest.fn().mockResolvedValue({ ...citation, content: passage.content }),
      search: jest.fn(async () => ({ passages: [], indexVersion: 3, confidence: 0 })),
      historyPassages: jest.fn().mockResolvedValue([passage]), review: jest.fn() };
    const responses = [{ intent: 'canon', query: '阿青送小舟伞的原因' }, { scores: [{ sourceId: 1, score: 2 }] },
      { queries: ['阿青 小舟 赠送 雨伞 心意', '阿青 小舟 礼物 背景'] }, { scores: [{ sourceId: 1, score: 5 }] },
      { sufficient: true, claims: [{ text: '阿青送小舟雨伞。', sourceId: 1, quote }] },
      { claims: [{ factId: 1, text: '我想，能用上的礼物就很合适。' }] }, verified];
    const model = { json: jest.fn(async () => responses.shift()) };
    const result = await new NovelAnswerService(rag as any, model as any).answer(1, question, history, '阿青', { userId: 2 });
    expect(result.metadata.state).toBe('grounded');
    const searches = rag.search.mock.calls as unknown as any[][];
    expect(searches[1][1]).toBe('阿青 小舟 赠送 雨伞 心意');
    expect(searches[1][5]).toMatchObject({ scopeQuery: question, indexVersion: 3, strategy: 'semantic' });
  });

  test('historical source lookup binds current document ACL, original scope and exact snapshot versions', async () => {
    const db = { knowledgeChunk: { findMany: jest.fn().mockResolvedValue([
      { id: 'c1', documentId: 1, documentVersion: 2, chapter: '第十二卷 第三章', chunkIndex: 5,
        document: { fileName: 'fixture', visibility: 'PUBLIC' }, content: quote },
    ]) } };
    const rag = new RagService(db as any, undefined, undefined, undefined);
    jest.spyOn(rag, 'authorize').mockResolvedValue({ kb: { id: 1, ownerId: 8 }, user: { id: 2, role: 'USER' }, permission: 'READ' } as any);
    expect(await rag.historyPassages(1, [citation], { userId: 2 }, 4, question)).toEqual([]);
    expect(db.knowledgeChunk.findMany).not.toHaveBeenCalled();
    expect(await rag.historyPassages(1, [citation], { userId: 2 }, 3, '第一卷发生了什么')).toEqual([]);
    const args = db.knowledgeChunk.findMany.mock.calls[0][0] as any;
    expect(args.where).toMatchObject({ knowledgeBaseId: 1, indexVersion: { version: 3 },
      OR: [{ id: 'c1', documentId: 1, documentVersion: 2 }], document: { isDeleted: false, knowledgeBaseId: 1 } });
    expect(args.where.document.OR).toContainEqual({ acls: { some: { userId: 2 } } });
    db.knowledgeChunk.findMany.mockResolvedValue([]);
    expect(await rag.historyPassages(1, [citation], { userId: 2 }, 3, question)).toEqual([]);
  });

  test('a conversational motive differs from an explicit canon cause or a personal invitation', () => {
    expect(isCharacterInterpretation(question, true)).toBe(true);
    expect(isCharacterInterpretation('原文明说为什么你送他伞吗？', true)).toBe(false);
    expect(isCharacterInterpretation('为什么你答应和我看电影？')).toBe(false);
    expect(groundedSearchQuery('第十二卷 送礼原因', '为什么送礼')).toBe('送礼原因');
    expect(groundedSearchQuery('第十二卷 送礼原因', '第十二卷为什么送礼')).toContain('第十二卷');
  });
});

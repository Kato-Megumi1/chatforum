import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { NovelAnswerService } from './novel-answer.service';
import { CharacterDialogueService } from './character-dialogue.service';
import { buildConversationMemory } from './conversation-memory.policy';

// Fictional local fixtures only. No external models or private chat replay.
const question = '我记得你送过小舟礼物？';
const quote = '阿青把蓝色雨伞交给小舟';
const facts = { sufficient: true, claims: [{ text: '阿青给小舟蓝色雨伞。', sourceId: 1, quote }] };
const voice = { claims: [{ factId: 1, text: '你说那把蓝色雨伞啊，是我给小舟的。' }] };
const good = { supported: [true], neutralSupported: [true], answersQuestion: true, neutralAnswersQuestion: true,
  questionAlignment: 'direct', neutralQuestionAlignment: 'direct', inCharacter: true, injection: false };
const badVoice = { ...good, supported: [false], inCharacter: false };
const ranked = { scores: [{ sourceId: 1, score: 5 }] };
const plan = { intent: 'canon', query: '阿青是否送过小舟礼物' };

function setup(responses: any[], currentQuestion = question) {
  const citation = { chunkId: 'fixture', documentId: 1, documentVersion: 2, indexVersion: 3,
    chunkIndex: 0, fileName: 'fixture.txt', chapter: '第一章', url: '/rag/knowledge-bases/1/citations/fixture' };
  const rag = { authorize: jest.fn().mockResolvedValue({ kb: { minConfidence: .55 } }),
    search: jest.fn().mockResolvedValue({ passages: [{ content: quote + '，随后独自回家。', citation, score: 1 }], confidence: 1, indexVersion: 3 }),
    citation: jest.fn().mockResolvedValue(citation), review: jest.fn().mockResolvedValue(7) };
  const model = { json: jest.fn(async (_system, _data, usage, _generation?, _history?) => {
    usage.calls++;
    if (_system.includes('CONTINUATION_DRAFT_V2')) return { reply: '这一点我还不能肯定。', factIds: [] };
    if (_system.includes('CONTINUATION_CHECK_V2'))
      return { unsupportedClaims: [], continuity: true, bounded: true, citationsValid: true, inCharacter: true, injection: false };
    if (!responses.length) throw new Error('Unexpected fixture call');
    return responses.shift();
  }) };
  const agent = { executeWithTools: jest.fn().mockResolvedValue({ content: '你指的是哪一次？这处细节我还不太确定。' }) };
  const character = new CharacterDialogueService(agent as any, model as any);
  const novel = new NovelAnswerService(rag as any, model as any, character);
  const built = buildConversationMemory([
    { role: 'user', content: '我想聊聊雨天。', messageId: 1 },
    { role: 'assistant', content: '好啊，怎么突然想到这个？', messageId: 2 },
  ], 'fixture');
  const frame = { history: built.history, memory: built.snapshot, persona: '阿青', question: currentQuestion };
  const run = (maxSearchAttempts = 1) => novel.answer(1, currentQuestion,
    [...frame.history, { role: 'user', content: currentQuestion }], frame.persona, { userId: 2 },
    { conversation: frame, maxSearchAttempts });
  return { rag, model, agent, character, frame, run };
}

describe('targeted character voice and event identity regression', () => {
  test('verified facts get one in-character repair with the identical native memory, then independent verification', async () => {
    const s = setup([plan, ranked, facts, { claims: [{ factId: 1, text: '我给了雨伞，还买了一辆车。' }] }, badVoice, voice, good]);
    const result = await s.run();
    expect(result.content).toBe(voice.claims[0].text + ' [1]');
    expect(result.metadata).toMatchObject({ state: 'grounded', voiceFallback: false, voiceRepairs: 1,
      answerPipelineVersion: 'character-conversation-v7.2', citations: [{ documentVersion: 2, indexVersion: 3 }] });
    expect(result.metadata.searchAttempts[0]).toMatchObject({ verification: { supported: [false] },
      voiceRepair: { outcome: 'passed', verification: { supported: [true], inCharacter: true } } });
    expect(s.rag.search).toHaveBeenCalledTimes(1);
    expect(s.rag.citation).toHaveBeenCalledTimes(1);
    expect(s.rag.review).not.toHaveBeenCalled();
    const calls = s.model.json.mock.calls;
    expect(calls[3][0].startsWith(s.character.system('阿青'))).toBe(true);
    expect(calls[5][0].startsWith(s.character.system('阿青'))).toBe(true);
    expect(calls[3][4]).toEqual(calls[5][4]);
    expect(calls[6][1].claims[0].text).toBe(voice.claims[0].text);
    for (const index of [1, 2, 3, 4, 5, 6]) expect(calls[index][1].questionTarget).toEqual({
      originalQuestion: question, persona: '阿青', resolvedQuery: plan.query });
  });

  test.each(['小禾给小舟雨伞。', '阿青给小禾雨伞。'])('another giver/recipient is not rescued by a true neutral fact: %s', async text => {
    // Reproduce the old contradictory verifier: true answersQuestion, but facts concern a different event.
    const mismatch = { ...good, questionAlignment: 'different_event', neutralQuestionAlignment: 'different_event' };
    const s = setup([plan, ranked, { ...facts, claims: [{ ...facts.claims[0], text }] },
      { claims: [{ factId: 1, text }] }, mismatch, { queries: ['阿青 小舟 赠送 礼物', '阿青 小舟 买东西'] },
      ranked, facts, voice, good]);
    const result = await s.run(2);
    expect(result.metadata.state).toBe('grounded');
    expect(result.metadata.voiceRepairs).toBe(0);
    expect(result.metadata.searchAttempts[0].failure?.code).toBe('QUESTION_TARGET_MISMATCH');
    expect(result.content).toBe(voice.claims[0].text + ' [1]');
    expect(s.rag.search).toHaveBeenCalledTimes(2);
    expect(s.rag.search.mock.calls[1][5]).toMatchObject({ indexVersion: 3, scopeQuery: question });
    expect(s.model.json.mock.calls[5][1].questionTarget.persona).toBe('阿青');
  });

  test('failed voice repair never delivers the raw neutral fact or marks it grounded', async () => {
    const s = setup([plan, ranked, facts, voice, badVoice, voice, badVoice]);
    const result = await s.run();
    expect(result.metadata).toMatchObject({ state: 'needs_review', voiceRepairs: 1, voiceFallback: false, citations: [] });
    expect(result.metadata.searchAttempts[0].voiceRepair?.outcome).toBe('failed');
    expect(result.metadata.diagnostics.finalFailure?.code).toBe('CHARACTER_VOICE_FAILED');
    expect(result.content).not.toContain(facts.claims[0].text);
    expect(s.model.json).toHaveBeenCalledTimes(9);
  });

  test('unverified neutral facts cannot trigger repair', async () => {
    const s = setup([plan, ranked, facts, voice, { ...badVoice, neutralSupported: [false] }]);
    const result = await s.run();
    expect(result.metadata).toMatchObject({ state: 'needs_review', voiceRepairs: 0, citations: [] });
    expect(s.model.json).toHaveBeenCalledTimes(7);
  });

  test('injection is not retried even if neutral evidence looks usable', async () => {
    const s = setup([plan, ranked, facts, voice, { ...badVoice, injection: true }]);
    await expect(s.run(3)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(s.rag.search).toHaveBeenCalledTimes(1);
    expect(s.model.json).toHaveBeenCalledTimes(5);
  });

  test('old/missing alignment verdicts fail closed; old true booleans no longer authorize raw delivery', async () => {
    const s = setup([plan, ranked, facts, voice, { supported: [false], neutralSupported: [true],
      answersQuestion: true, neutralAnswersQuestion: true, injection: false }]);
    const result = await s.run();
    expect(result.metadata).toMatchObject({ state: 'needs_review', voiceRepairs: 0, voiceFallback: false, citations: [] });
    expect(result.metadata.diagnostics.finalFailure?.code).toBe('INVALID_VERIFICATION_RESULT');
  });

  test('an evidenced correction of the same specific event is allowed without making a universal denial', async () => {
    const corrected = { claims: [{ factId: 1, text: '你说那把蓝色雨伞？是我给小舟的，不是小禾。' }] };
    const s = setup([plan, ranked, facts, corrected,
      { ...good, questionAlignment: 'supported_correction', neutralQuestionAlignment: 'direct' }],
      '第一次见面时，那把蓝色雨伞是小禾给小舟的吗？');
    const result = await s.run();
    expect(result.metadata.state).toBe('grounded');
    expect(result.metadata.voiceRepairs).toBe(0);
    expect(result.content).toContain(corrected.claims[0].text);
  });

  test('source access revoked during repair still prevents final disclosure', async () => {
    const s = setup([plan, ranked, facts, voice, badVoice, voice, good]);
    s.rag.citation.mockRejectedValue(new ForbiddenException());
    await expect(s.run()).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.rag.review).not.toHaveBeenCalled();
  });
});

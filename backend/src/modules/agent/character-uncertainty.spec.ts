import { ServiceUnavailableException } from '@nestjs/common';
import { CharacterDialogueService } from './character-dialogue.service';
import { buildConversationMemory } from './conversation-memory.policy';
import { newRagUsage } from './rag-model.service';

// Synthetic fixtures, not real user chat. No provider calls.
const good = { unsupportedClaims: [], continuity: true, bounded: true, citationsValid: true, inCharacter: true, injection: false };
const { snapshot, history } = buildConversationMemory([
  { messageId: 1, role: 'user', content: '送过什么？' },
  { messageId: 2, role: 'assistant', content: '送过一把伞。' },
], 'fixture');
const frame = { persona: '阿青', question: '为什么送他伞？', history, memory: snapshot };
const fact = { text: '阿青送小舟一把伞。', quote: '阿青把蓝色雨伞交给小舟', source: '阿青把蓝色雨伞交给小舟，然后回家。',
  citation: { chunkId: 'c1', documentId: 1, documentVersion: 1, indexVersion: 1, chunkIndex: 0, fileName: 'fixture', url: '/citation/c1' } };
function setup(responses: unknown[]) {
  const agent = { executeWithTools: jest.fn() };
  const model = { json: jest.fn(async (..._args: any[]) => { const r = responses.shift(); if (r instanceof Error) throw r; return r; }) };
  return { service: new CharacterDialogueService(agent as any, model as any), model, agent };
}
describe('contextual continuation without canned persona lines', () => {
  test('keeps known event, allows qualified interpretation and attaches only used evidence', async () => {
    const s = setup([{ reply: '那把伞啊。现在想来，能派上用场的礼物就挺好的。', factIds: [1] }, good]);
    const result = await s.service.uncertainReply(frame, [], newRagUsage(), [fact], true);
    expect(result.content).toBe('那把伞啊。现在想来，能派上用场的礼物就挺好的。 [1]');
    expect(result.guard).toMatchObject({ version: 'character-continuation-v2', status: 'passed', availableFacts: 1 });
    expect(result.citations[0].chunkId).toBe('c1');
    expect(s.agent.executeWithTools).not.toHaveBeenCalled();
    const calls = s.model.json.mock.calls;
    expect(calls[1][1].facts[0].source).toBe(fact.source);
    expect(calls[0][4]).toEqual(calls[1][4]);
    expect(calls[0][4]).toContainEqual({ role: 'assistant', content: '送过一把伞。' });
  });
  test('repairs an invented event using verifier feedback instead of returning a fixed line', async () => {
    const s = setup([{ reply: '还送过一辆车。', factIds: [] }, { ...good, unsupportedClaims: ['送车'] },
      { reply: '先说刚才那把伞吧，我觉得你更想问的是送礼的心意？', factIds: [1] }, good]);
    const result = await s.service.uncertainReply(frame, [], newRagUsage(), [fact], true);
    expect(result.guard.attempts).toBe(2);
    expect(result.content).not.toContain('车');
    expect(s.model.json.mock.calls[2][1].feedback.verdict.unsupportedClaims).toEqual(['送车']);
  });
  test('no evidence still produces a model-written conversational response, not universal denial', async () => {
    const s = setup([{ reply: '你这么在意礼物，是想聊送礼时的心情吗？', factIds: [] }, good]);
    const result = await s.service.uncertainReply({ ...frame, history: [], question: '你送过东西吗？' }, [], newRagUsage());
    expect(result.content).toBe('你这么在意礼物，是想聊送礼时的心情吗？');
    expect(result.citations).toEqual([]);
  });
  test.each(['rejected', 'outage'])('%s never masquerades as a character forgetting', async failure => {
    const draft = { reply: '我送过一辆车。', factIds: [] };
    const s = setup(failure === 'outage' ? [draft, new Error('offline')] :
      [draft, { ...good, unsupportedClaims: ['送车'] }, draft, { ...good, continuity: false }]);
    await expect(s.service.uncertainReply(frame, [], newRagUsage())).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(s.model.json.mock.calls.length).toBeLessThanOrEqual(4);
  });
});

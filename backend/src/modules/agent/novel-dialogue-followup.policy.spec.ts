import { isCharacterInterpretation, requiresCanon, resolveCanonicalFollowup } from './novel-dialogue.policy';

const canonicalHistory = (question = '惠，可以讲讲你和伦也的经历嘛？', answer = '我被伦也拉进了社团。 [1]') => [
  { messageId: 1, role: 'USER', content: question },
  { messageId: 2, role: 'ASSISTANT', content: answer,
    evidence: { recordedState: 'grounded', citations: [{ access: 'available', quoteStatus: 'verbatim' }] } },
];
const reported = '你对他的看法有什么变化嘛？';

describe('bounded canonical relationship follow-up hints', () => {
  test('the reported pronoun question inherits the preceding novel topic, not its truth or chapter', () => {
    const history = canonicalHistory();
    const before = JSON.stringify(history);
    expect(resolveCanonicalFollowup(reported, history)).toEqual({
      kind: 'canonical_followup', interpretation: true,
      resolvedQuestion: '你对安艺伦也的看法有什么变化嘛？',
      entity: { key: 'tomoya', name: '安艺伦也' }, contextMessageIds: [1, 2],
      verification: 'reference_only_not_evidence',
    });
    expect(JSON.stringify(history)).toBe(before);
    expect(requiresCanon(reported)).toBe(false); // Existing context-free API remains conservative.
    expect(isCharacterInterpretation(reported)).toBe(false);
  });

  test.each(['你对他的印象后来变了吗？', '后来你怎么看他？', '你现在还喜欢他吗？'])('recognizes varied bounded perspective wording: %s', question => {
    expect(resolveCanonicalFollowup(question, canonicalHistory())).toMatchObject({
      kind: 'canonical_followup', interpretation: true, entity: { key: 'tomoya' },
    });
  });

  test('an explicit source request stays factual rather than subjective interpretation', () => {
    expect(resolveCanonicalFollowup('原作里你对他的看法有什么变化？', canonicalHistory())).toMatchObject({
      kind: 'canonical_followup', interpretation: false, entity: { key: 'tomoya' },
    });
  });

  test('the other character’s perspective requires evidence, not an invented private feeling', () => {
    expect(resolveCanonicalFollowup('他对你的看法有什么变化？', canonicalHistory())).toMatchObject({
      kind: 'canonical_followup', interpretation: false,
    });
  });

  test('canonical user topic remains a subject hint even if the old assistant was unverified', () => {
    const history = [{ messageId: 1, role: 'user', content: '原作中你和伦也有哪些经历？' },
      { messageId: 2, role: 'assistant', content: '旧回答无法作为证据。', evidence: { recordedState: 'legacy_unverified', citations: [] } }];
    expect(resolveCanonicalFollowup(reported, history)).toMatchObject({
      entity: { key: 'tomoya' }, verification: 'reference_only_not_evidence',
    });
  });

  test('multiple possible people still request canonical routing but do not fabricate a referent', () => {
    const result = resolveCanonicalFollowup(reported, canonicalHistory('原作中伦也和伊织发生过什么？', '伦也和伊织有过争执。 [1]'));
    expect(result).toMatchObject({ kind: 'canonical_followup', interpretation: true });
    expect(result?.entity).toBeUndefined();
    expect(result?.resolvedQuestion).toBeUndefined();
  });

  test('a known addressed persona can be excluded without assuming a gender or relationship', () => {
    expect(resolveCanonicalFollowup(reported, canonicalHistory('加藤惠和安艺伦也是怎么相遇的？'), 'megumi'))
      .toMatchObject({ entity: { key: 'tomoya' } });
  });

  test('an explicitly named new target is not overwritten with the previous topic’s person', () => {
    expect(resolveCanonicalFollowup('惠，你对伊织的看法有什么变化？', canonicalHistory())).toMatchObject({
      entity: { key: 'iori' }, resolvedQuestion: '惠，你对伊织的看法有什么变化？',
    });
  });

  test.each(['你对他们的看法有什么变化？', '你对他的看法和她比呢？'])('ambiguous references never select one person: %s', question => {
    const result = resolveCanonicalFollowup(question, canonicalHistory());
    expect(result?.kind).toBe('canonical_followup');
    expect(result?.entity).toBeUndefined();
  });

  test('the latest hobby turn is a topic boundary, even if its answer incorrectly retained a grounded flag', () => {
    const history = [...canonicalHistory(), ...canonicalHistory('你平时喜欢做什么呀惠？兴趣爱好', '空闲时会看看电影。 [1]')];
    expect(resolveCanonicalFollowup(reported, history)).toBeUndefined();
  });

  test.each(['你好惠', '你是谁？', '你是现实中的真人，还是AI？'])('a newer direct chat turn ends implicit canon carry-over: %s', topic => {
    expect(resolveCanonicalFollowup(reported, [...canonicalHistory(), ...canonicalHistory(topic, '伦也只是刚才的话题。 [1]')]))
      .toBeUndefined();
  });

  test.each([
    ['你对我有什么看法？', canonicalHistory()],
    ['你觉得今天天气怎么样？', canonicalHistory()],
    ['你平时有什么兴趣爱好？', canonicalHistory()],
    [reported, [{ role: 'user', content: '我朋友小明和我吵架了。' }, { role: 'assistant', content: '先冷静聊聊吧。' }]],
    [reported, [{ role: 'user', content: '我朋友也叫伦也，你觉得他人怎么样？' }, { role: 'assistant', content: '还不熟悉他。' }]],
    [reported, [{ role: 'user', content: '我叫伦也。' }, { role: 'assistant', content: '你好。' }]],
    ['换个话题，你对他的看法呢？', canonicalHistory()],
    ['你对我朋友他的看法是什么？', canonicalHistory()],
    [reported, []],
  ])('does not turn ordinary or context-free conversation into a canon query: %s', (question, history) => {
    expect(resolveCanonicalFollowup(question, history)).toBeUndefined();
  });

  test('an unpaired newer question prevents falling back across the topic boundary', () => {
    expect(resolveCanonicalFollowup(reported, [...canonicalHistory(), { role: 'user', content: '先聊聊电影吧' }])).toBeUndefined();
  });

  test('a transient copy of the current user question is ignored when selecting the previous pair', () => {
    expect(resolveCanonicalFollowup(reported, [...canonicalHistory(), { role: 'user', content: reported }]))
      .toMatchObject({ entity: { key: 'tomoya' }, contextMessageIds: [1, 2] });
  });

  test('source chapter labels are not copied into a search scope', () => {
    const result = resolveCanonicalFollowup(reported, canonicalHistory('惠，可以讲讲你和伦也的经历嘛？', '伦也拉我进入社团。 [1] 第七卷 序章'));
    expect(result?.resolvedQuestion).toBe('你对安艺伦也的看法有什么变化嘛？');
    expect(JSON.stringify(result)).not.toMatch(/第七卷|序章/);
  });
});

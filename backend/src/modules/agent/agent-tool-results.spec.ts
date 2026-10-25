import { extractToolOutputs } from './agent-tool-results';

describe('typed tool observation projection', () => {
  const step = (tool: string, observation: unknown) => ({ action: { tool }, observation });
  test.each(['web_search', 'code_workspace', 'manage_forum_tracking', 'search_forum_posts', 'custom_fixture'])
  ('preserves the outer failure and model payload for %s', tool => {
    const data = { error: 'fixture failure', nextCursor: 'opaque', version: 'custom-v1' };
    const observation = JSON.stringify({ success: false, data });
    expect(extractToolOutputs([step(tool, observation)]))
      .toEqual([{ success: false, result: data, modelData: data, displayText: observation }]);
  });
  test.each([null, false, 0, '', [], { version: 'forum-discovery-v3', posts: [], nextCursor: 'opaque' }])
  ('retains successful payload exactly, including falsy data %j', data => {
    const observation = JSON.stringify({ success: true, data });
    expect(extractToolOutputs([step('fixture', observation)]))
      .toEqual([{ success: true, result: data, modelData: data, displayText: observation }]);
  });
  test('does not infer status from untrusted nested payload fields', () => {
    const data = { success: false, content: 'Error: part of a document', posts: [] };
    expect(extractToolOutputs([step('fixture', JSON.stringify({ success: true, data }))])[0])
      .toMatchObject({ success: true, result: data, modelData: data });
  });
  test.each(['plain result', '{"success":"false","data":null}', '[{"success":false}]', 'null', '{bad json'])
  ('non-envelope text is not misclassified as a structured failure: %s', observation => {
    expect(extractToolOutputs([step('fixture', observation)]))
      .toEqual([{ success: true, result: observation, displayText: observation }]);
  });
  test('keeps structured failure without data and recognizes legacy errors', () => {
    const value = { success: false, error: 'fixture' }, text = JSON.stringify(value);
    expect(extractToolOutputs([step('fixture', text)])[0]).toEqual({ success: false, result: value, modelData: value, displayText: text });
    expect(extractToolOutputs([step('fixture', '  Error: invalid expression')])[0].success).toBe(false);
    expect(extractToolOutputs([{}, { action: {} }, { action: { tool: 4 } }])).toEqual([]);
  });
});

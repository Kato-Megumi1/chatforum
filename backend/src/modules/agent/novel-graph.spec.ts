import { mentionedEntities, validateGraphFacts } from './novel-graph.policy';

describe('evidence graph policy', () => {
  test('resolves aliases without seeding invented relationships', () => {
    expect(mentionedEntities('加藤与安艺一起遇见霞诗子。')).toEqual(['megumi', 'tomoya', 'utaha']);
    expect(mentionedEntities('优惠套餐很好。')).not.toContain('megumi');
    expect(mentionedEntities('惠，你觉得呢？')).toContain('megumi');
  });
  test('accepts exact evidence; rejects invented subjects, edges and quote text', () => {
    const passages = [{ content: '加藤惠是社团副代表，安艺伦也是社团代表。' }];
    const f = { subject:'megumi', predicate:'ROLE', target:null, object:'加藤惠是副代表', sourceId:1, quote:'加藤惠是社团副代表' };
    expect(validateGraphFacts([f], passages)).toHaveLength(1);
    expect(validateGraphFacts([{...f,subject:'unknown'}], passages)).toHaveLength(0);
    expect(validateGraphFacts([{...f,target:'eriri'}], passages)).toHaveLength(0);
    expect(validateGraphFacts([{...f,quote:'加藤惠是社团代表'}], passages)).toHaveLength(0);
    expect(validateGraphFacts([{...f,sourceId:2}], passages)).toHaveLength(0);
    expect(validateGraphFacts([{...f,predicate:'EXECUTE_TOOL'}], passages)).toHaveLength(0);
  });
});

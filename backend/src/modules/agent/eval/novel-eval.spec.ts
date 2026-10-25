import { summarizeNovelEval, validateDataset, NovelEvalCase } from './novel-eval';
const c:NovelEvalCase={id:'1',family:'f1',question:'伞是什么颜色',split:'dev',type:'fact',annotation:'verified',expectedState:'grounded',relevantEvidence:['a','b']};
test('metrics use ranked evidence labels, not word overlap',()=>{
  const m=summarizeNovelEval([c],[{id:'1',state:'grounded',retrieved:['a','a','wrong','b'],latencyMs:20,costCny:null,
    adjudication:{supportedClaims:1,totalClaims:2,correctCitations:1,totalCitations:1,answerCorrect:false}}]);
  expect(m.precisionAtK).toBeCloseTo(2/3); expect(m.groundedness).toBe(.5);
  expect(m.answerAccuracy).toBe(0);expect(m.totalCostCny).toBeNull();
});
test('pending annotations never become a perfect score',()=>{
  expect(summarizeNovelEval([{...c,annotation:'pending'}],[{id:'1',state:'grounded',retrieved:['a'],latencyMs:1,costCny:null}]).answerAccuracy).toBeNull();
});
test('reject development/blind family leakage',()=>expect(()=>validateDataset([c,{...c,id:'2',question:'雨伞颜色',split:'blind'}])).toThrow());

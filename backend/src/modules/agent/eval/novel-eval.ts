export interface NovelEvalCase {
  id: string; family: string; split: 'dev' | 'blind'; type: string;
  question: string; history?: Array<{role:string;content:string}>;
  expectedState: 'grounded' | 'needs_review' | 'roleplay';
  annotation: 'pending' | 'verified';
  // Stable evidence label: document checksum + document version + chunk index.
  // Re-annotate whenever the chunking recipe / source checksum changes.
  relevantEvidence?: string[];
}
export interface NovelEvalObservation {
  id: string; state: string; retrieved: string[]; latencyMs: number; costCny: number | null;
  // Human adjudication; a model's self-check is NOT the ground-truth score.
  adjudication?: { supportedClaims: number; totalClaims: number;
    correctCitations: number; totalCitations: number; answerCorrect: boolean };
}
const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
export function validateDataset(cases: NovelEvalCase[]) {
  const ids = new Set<string>(), groups = new Map<string,string>(), questions = new Map<string,string>();
  for (const c of cases) {
    if (!c.id || !c.family || !c.question?.trim() || !['dev','blind'].includes(c.split) ||
      !['pending','verified'].includes(c.annotation) || !['grounded','needs_review','roleplay'].includes(c.expectedState) || ids.has(c.id))
      throw new Error('Invalid or duplicate eval case: ' + c.id);
    ids.add(c.id);
    const q = c.question.replace(/\s+/g,'').toLowerCase();
    if (groups.has(c.family) && groups.get(c.family)!==c.split ||
      questions.has(q) && questions.get(q)!==c.split) throw new Error('Development/blind leakage: ' + c.id);
    groups.set(c.family,c.split); questions.set(q,c.split);
    if(c.annotation==='verified' && c.expectedState==='grounded' && !c.relevantEvidence?.length)
      throw new Error('Verified factual case needs evidence labels: '+c.id);
  }
}
export function summarizeNovelEval(cases: NovelEvalCase[], observed: NovelEvalObservation[], k=3) {
  validateDataset(cases);
  let precision=0,ndcg=0,hit=0,retrievalN=0,refusalN=0,refusalOK=0;
  let shouldRefuse=0, didRefuse=0, correctRefusals=0, answerable=0, falseRefusals=0;
  let supported=0,claims=0,correctCitations=0,citations=0,answerN=0,answerOK=0,missing=0;
  const selected=observed.filter(o=>cases.some(c=>c.id===o.id));
  for(const c of cases) {
    const o=selected.find(r=>r.id===c.id);
    if(!o){missing++;continue;}
    if(c.annotation!=='verified') continue;
    refusalN++; if((o.state==='needs_review')===(c.expectedState==='needs_review'))refusalOK++;
    if(c.expectedState==='needs_review')shouldRefuse++; else answerable++;
    if(o.state==='needs_review') { didRefuse++; if(c.expectedState==='needs_review')correctRefusals++; else falseRefusals++; }
    if(c.relevantEvidence?.length && c.expectedState==='grounded'){
      const relevant=new Set(c.relevantEvidence),top=[...new Set(o.retrieved)].slice(0,k);
      const gains=top.map(id=>relevant.has(id)?1:0),found=gains.reduce((a,b)=>a+b,0);
      precision+=found/k; hit+=found?1:0;
      const dcg=gains.reduce((a,g,i)=>a+g/Math.log2(i+2),0);
      const ideal=Array.from({length:Math.min(k,relevant.size)},(_,i)=>1/Math.log2(i+2)).reduce((a,b)=>a+b,0);
      ndcg+=dcg/ideal; retrievalN++;
    }
    const a=o.adjudication;
    if(a){
      if(!Number.isInteger(a.totalClaims)||!Number.isInteger(a.supportedClaims)||a.supportedClaims<0||a.totalClaims<a.supportedClaims||
        !Number.isInteger(a.totalCitations)||!Number.isInteger(a.correctCitations)||a.correctCitations<0||a.totalCitations<a.correctCitations||
        typeof a.answerCorrect!=='boolean') throw new Error('Invalid adjudication: '+c.id);
      supported+=a.supportedClaims; claims+=a.totalClaims;
      correctCitations+=a.correctCitations; citations+=a.totalCitations;
      answerN++; if(a.answerCorrect)answerOK++;
    }
  }
  const times=selected.map(o=>o.latencyMs).sort((a,b)=>a-b);
  const percentile=(p:number)=>times.length?times[Math.min(times.length-1,Math.ceil(times.length*p)-1)]:null;
  return { k, cases:cases.length, observed:selected.length, missing, verified:cases.filter(c=>c.annotation==='verified').length,
    retrievalCases:retrievalN, precisionAtK:rate(precision,retrievalN), hitAtK:rate(hit,retrievalN), ndcgAtK:rate(ndcg,retrievalN),
    groundedness:rate(supported,claims), supportedClaims:supported, totalClaims:claims,
    citationCorrectness:rate(correctCitations,citations), citationCount:citations,
    refusalCorrectness:rate(refusalOK,refusalN), refusalCases:refusalN,
    refusalPrecision:rate(correctRefusals,didRefuse), refusalRecall:rate(correctRefusals,shouldRefuse),
    answerableFalseRefusalRate:rate(falseRefusals,answerable),
    answerAccuracy:rate(answerOK,answerN), adjudicatedAnswers:answerN,
    latencyP50Ms:percentile(.5),latencyP95Ms:percentile(.95),
    totalCostCny:selected.length && selected.every(o=>o.costCny!==null)?selected.reduce((s,o)=>s+o.costCny!,0):null,
    note:'模型自评、词语重合、固定样本测试均不等于真实答案准确率；未标注的质量指标为 null。' };
}

// No Nest application or model imports: score saved answers offline without re-generation.
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { NovelEvalCase, NovelEvalObservation, summarizeNovelEval } from './novel-eval';
async function main() {
  const [datasetPath, reportPath, humanPath, outputPath, extra] = process.argv.slice(2);
  if (!datasetPath || !reportPath || !humanPath || !outputPath || extra)
    throw new Error('Usage: npm run eval:score -- dataset.json saved-run.json human.json scored-run.json');
  const cases: NovelEvalCase[] = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const human = JSON.parse(await fs.readFile(humanPath, 'utf8'));
  for (const output of report.outputs) {
    const c = cases.find(c => c.id === output.id && c.split === report.split);
    if (!c || c.question !== output.question) throw new Error('Dataset question changed after generation: ' + output.id);
  }
  for (const id of Object.keys(human)) {
    const output = report.outputs.find(o => o.id === id);
    if (!output) throw new Error('Unknown answer: ' + id);
    const hash = createHash('sha256').update(output.content + JSON.stringify(output.metadata.citations)).digest('hex');
    if (human[id].answerSha256 !== hash) throw new Error('Adjudication refers to a different answer: ' + id);
  }
  const observations: NovelEvalObservation[] = report.observations.map(o => ({ ...o,
    adjudication: human[o.id] ? {
      supportedClaims: human[o.id].supportedClaims, totalClaims: human[o.id].totalClaims,
      correctCitations: human[o.id].correctCitations, totalCitations: human[o.id].totalCitations,
      answerCorrect: human[o.id].answerCorrect,
    } : undefined,
  }));
  const metrics = summarizeNovelEval(cases.filter(c => c.split === report.split), observations);
  await fs.writeFile(outputPath, JSON.stringify({ ...report, observations, metrics, adjudicatedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  console.log('Saved offline adjudication; no model requests made.');
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });

import { NestFactory } from '@nestjs/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { AppModule } from '../../../app.module';
import { PrismaService } from '../../../common/prisma.service';
import { RagService } from '../rag.service';
import { NovelAnswerService } from '../novel-answer.service';
import { newRagUsage } from '../rag-model.service';
import { KatoMegumiSkill, MEGUMI_PERSONA_VERSION } from '../skills/kato-megumi.skill';
import { NovelEvalCase, NovelEvalObservation, summarizeNovelEval, validateDataset } from './novel-eval';

// Explicit CLI use only. Calls billable model APIs; never invoked on server startup.
async function main() {
  const [datasetPath, split, kbArg, userArg, outputPath, extra] = process.argv.slice(2);
  if(!datasetPath || !['dev','blind'].includes(split) || !Number.isInteger(Number(kbArg)) ||
    !Number.isInteger(Number(userArg)) || !outputPath || extra)
    throw new Error('Usage: npm run eval:novel -- dataset.json dev|blind kbId userId output.json');
  const cases: NovelEvalCase[]=JSON.parse(await fs.readFile(datasetPath,'utf8'));
  validateDataset(cases);
  const selected=cases.filter(c=>c.split===split);
  if(!selected.length)throw new Error('Empty split');
  try { await fs.access(outputPath); throw new Error('Report already exists; choose a new path before paid evaluation'); }
  catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  process.env.RAG_WORKER_ENABLED='false'; process.env.CHAT_WORKER_ENABLED='false';
  const app=await NestFactory.createApplicationContext(AppModule,{logger:['error']});
  try{
    const rag=app.get(RagService),novel=app.get(NovelAnswerService),db=app.get(PrismaService);
    const who={userId:Number(userArg)},kbId=Number(kbArg);
    await rag.authorize(kbId,who,'WRITE');
    const baseline=await db.knowledgeBase.findUnique({where:{id:kbId}});
    if(baseline.candidateIndexVersion || !baseline.activeIndexVersion) throw new Error('Evaluation requires one active index and no canary');
    const index=await db.ragIndexVersion.findUnique({where:{knowledgeBaseId_version:{knowledgeBaseId:kbId,version:baseline.activeIndexVersion}}});
    const persona=new KatoMegumiSkill().getSystemPrompt();
    const observations:NovelEvalObservation[]=[],outputs:any[]=[];
    for(const c of selected){
      const started=Date.now(),usage=newRagUsage();
      // Raw hybrid metric is intentionally separate from end-to-end answer assessment.
      const retrieval=await rag.search(kbId,c.question,who,10,usage);
      const chunkIds=retrieval.passages.map(p=>p.citation.chunkId);
      const chunks=await db.knowledgeChunk.findMany({where:{id:{in:chunkIds}},include:{document:true}});
      const labels=new Map(chunks.map(ch=>[ch.id,ch.document.checksum+':'+ch.documentVersion+':'+ch.chunkIndex]));
      const result=await novel.answer(kbId,c.question,c.history||[],persona,who);
      const current=await db.knowledgeBase.findUnique({where:{id:kbId}});
      if(current.revision!==baseline.revision || retrieval.indexVersion!==baseline.activeIndexVersion ||
        (result.metadata.indexVersion && result.metadata.indexVersion!==baseline.activeIndexVersion))
        throw new Error('Index/configuration changed during evaluation; do not compare this run');
      observations.push({id:c.id,state:result.metadata.state,retrieved:chunkIds.map(id=>labels.get(id)!),
        latencyMs:Date.now()-started,costCny:result.metadata.usage.costCny===null||usage.costCny===null?null:
          result.metadata.usage.costCny+usage.costCny});
      const answerSha256=createHash('sha256').update(result.content+JSON.stringify(result.metadata.citations)).digest('hex');
      outputs.push({id:c.id,question:c.question,content:result.content,metadata:result.metadata,answerSha256});
    }
    await fs.mkdir(path.dirname(path.resolve(outputPath)),{recursive:true});
    await fs.writeFile(outputPath,JSON.stringify({split,createdAt:new Date().toISOString(),
      knowledgeBaseId:kbId,indexVersion:index.version,manifest:index.manifest,personaVersion:MEGUMI_PERSONA_VERSION,
      metrics:summarizeNovelEval(selected,observations),observations,outputs},null,2),{flag:'wx'});
    console.log('Saved report; pending annotations are not counted as production quality.');
  } finally {await app.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});

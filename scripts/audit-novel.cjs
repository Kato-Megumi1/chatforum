// Offline only: the novel and legacy vectors never leave this computer.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {createRequire}=require('node:module');
const backend=path.resolve(__dirname,'../backend'),req=createRequire(backend+'/package.json');
const file=process.argv[2]&&path.resolve(process.argv[2]);
if(!file){console.error('Usage: node scripts/audit-novel.cjs novel.epub [legacy-vector-directory]');process.exit(1);}
req('ts-node').register({project:backend+'/tsconfig.json',transpileOnly:true});
const {EpubChunker}=req('./src/modules/agent/eval/epub-chunker.ts');
(async()=>{
 const chunker=new EpubChunker({chunkSize:500,overlap:50}),chapters=chunker.extractChapters(file),chunks=await chunker.chunk(file);
 let exact=0,covered=0,total=0;
 for(const chapter of chapters){
  const mask=new Uint8Array(chapter.content.length);
  for(const c of chunks.filter(c=>c.metadata.chapterIndex===chapter.index)){
   const {offsetInChapter:start,endOffsetInChapter:end}=c.metadata;
   if(chapter.content.slice(start,end)===c.content){exact++;mask.fill(1,start,end);}
  }
  for(let i=0;i<mask.length;i++)if(!/\s/.test(chapter.content[i])){total++;covered+=mask[i];}
 }
 const report={sourceSha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),recipe:'novel-contiguous-v2',
  chapters:chapters.length,chunks:chunks.length,maxChunkChars:Math.max(...chunks.map(c=>c.content.length)),exactOffsetChunks:exact,
  retainedStoryNonWhitespaceCoverage:covered/total,legacy:[]};
 if(process.argv[3])for(const name of fs.readdirSync(process.argv[3]).filter(n=>n.endsWith('.json'))){
  const a=JSON.parse(fs.readFileSync(path.join(process.argv[3],name),'utf8'));if(!Array.isArray(a))continue;
  report.legacy.push({file:name,chunks:a.length,uniqueContent:new Set(a.map(c=>createHash('sha256').update(c.content||'').digest('hex'))).size,
   zeroVectors:a.filter(c=>Array.isArray(c.embedding)&&c.embedding.every(v=>v===0)).length});
 }
 console.log(JSON.stringify(report,null,2));
 if(exact!==chunks.length||covered!==total)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});

/**
 * RAG Evaluation Runner
 *
 * Orchestrates the full evaluation pipeline:
 *   EPUB → Chunk → QA Generate → Retrieve → Evaluate → Visualize
 *
 * Usage:
 *   npx ts-node src/modules/agent/eval/eval-runner.ts \
 *     --epub ./storage/documents/1/novel.epub \
 *     --kbId 4 \
 *     --qaCount 60
 */

import { EpubChunker, StructuredChunk } from './epub-chunker';
import { QAGenerator, QAPair } from './qa-generator';
import { RetrievalEvaluator, EvalReport } from './retrieval-eval';
import * as fs from 'fs';
import * as path from 'path';

// ============ Configuration ============

interface EvalConfig {
  /** Path to EPUB file */
  epubPath: string;
  /** Knowledge base ID for retrieval */
  kbId: number;
  /** Number of QA pairs to generate (default 60) */
  qaCount: number;
  /** Chunking parameters */
  chunkSize: number;
  chunkOverlap: number;
  /** K values for evaluation */
  ks: number[];
  /** Output directory */
  outputDir: string;
  /** LLM config for QA generation */
  llmApiKey: string;
  llmApiBase: string;
  llmModel: string;
}

// ============ Main Pipeline ============

async function runEval(config: EvalConfig) {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   RAG Retrieval Evaluation Pipeline ║');
  console.log('╚══════════════════════════════════════╝\n');

  fs.mkdirSync(config.outputDir, { recursive: true });

  // ── Step 1: EPUB Structured Chunking ──
  console.log('━━━ Step 1: EPUB Chunking ━━━');
  const chunker = new EpubChunker({
    chunkSize: config.chunkSize,
    overlap: config.chunkOverlap,
  });
  const chunks = await chunker.chunk(config.epubPath);
  console.log(`  Total chunks: ${chunks.length}`);
  console.log(`  Avg chunk size: ${Math.round(chunks.reduce((s, c) => s + c.content.length, 0) / chunks.length)} chars`);

  // Save chunks
  fs.writeFileSync(
    path.join(config.outputDir, 'chunks.json'),
    JSON.stringify(chunks, null, 2),
    'utf-8',
  );
  console.log(`  Chunks saved to chunks.json\n`);

  // ── Step 2: Auto QA Generation ──
  console.log('━━━ Step 2: QA Generation ━━━');
  const qaGen = new QAGenerator({
    apiKey: config.llmApiKey,
    apiBase: config.llmApiBase,
    model: config.llmModel,
  });

  // Group chunks by chapter for QA generation
  const chapterMap = new Map<string, { title: string; content: string; index: number }>();
  for (const chunk of chunks) {
    const key = chunk.metadata.chapterTitle;
    if (!chapterMap.has(key)) {
      chapterMap.set(key, {
        title: key,
        content: chunk.content,
        index: chapterMap.size,
      });
    } else {
      chapterMap.get(key)!.content += '\n' + chunk.content;
    }
  }
  const chapters = [...chapterMap.values()];

  const qaPairs = await qaGen.generate(chapters, { count: config.qaCount });

  // Associate QAs with chunk IDs
  const associatedQAs = QAGenerator.associateChunks(
    qaPairs,
    chunks.map(c => ({ content: c.content, metadata: c.metadata })),
  );

  QAGenerator.save(associatedQAs, path.join(config.outputDir, 'qa_pairs.json'));
  console.log(`  Question type distribution:`);
  const typeCount: Record<string, number> = {};
  associatedQAs.forEach(q => (typeCount[q.questionType] = (typeCount[q.questionType] || 0) + 1));
  Object.entries(typeCount).forEach(([t, c]) => console.log(`    ${t}: ${c}`));
  console.log('');

  // ── Step 3: Retrieval Evaluation ──
  console.log('━━━ Step 3: Retrieval Evaluation ━━━');

  // Build retrieval function using the knowledge base's vector store
  const retrieveFn = buildRetrieveFn(chunks, config);

  const evaluator = new RetrievalEvaluator(retrieveFn);
  const report = await evaluator.evaluate(
    associatedQAs,
    chunks.map(c => ({ content: c.content, metadata: c.metadata })),
    config.ks,
  );

  // Print summary
  console.log('\n  ┌─ Evaluation Summary ───────────────────────┐');
  for (const k of config.ks) {
    console.log(`  │ K=${k}: P=${report.summary.avgPrecision[k].toFixed(3)}  R=${report.summary.avgRecall[k].toFixed(3)}  Hit=${report.summary.avgHitRate[k].toFixed(3)}  NDCG=${report.summary.avgNDCG[k].toFixed(3)} │`);
  }
  console.log('  └────────────────────────────────────────────┘\n');

  // Save report
  RetrievalEvaluator.saveReport(
    report,
    path.join(config.outputDir, 'eval_summary.csv'),
    path.join(config.outputDir, 'eval_details.json'),
  );

  // Also save in the format expected by visualize.py
  fs.writeFileSync(
    path.join(config.outputDir, 'eval_results.json'),
    JSON.stringify(report, null, 2),
    'utf-8',
  );
  console.log(`  Full results saved to ${config.outputDir}/\n`);

  // ── Step 4: Visualization hint ──
  console.log('━━━ Step 4: Visualization ━━━');
  console.log(`  Run: python visualize.py --input ${config.outputDir}/eval_results.json --output ${config.outputDir}/charts/`);
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('  Evaluation pipeline complete!');
  console.log('═══════════════════════════════════════');
}

/**
 * Build a retrieval function that searches the chunks using simple keyword + overlap matching.
 * In production, this would use the actual RAG pipeline with embeddings.
 */
function buildRetrieveFn(
  chunks: StructuredChunk[],
  config: EvalConfig,
): (query: string, topK: number) => Promise<string[]> {
  return async (query: string, topK: number): Promise<string[]> => {
    // Simple TF-based scoring (no embedding needed for evaluation)
    const keywords = query.split(/[，。！？、\s]+/).filter(w => w.length >= 2);

    const scored = chunks.map(chunk => {
      let score = 0;
      for (const kw of keywords) {
        const regex = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        const matches = chunk.content.match(regex);
        if (matches) score += matches.length;
      }
      return { content: chunk.content, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => s.content);
  };
}

// ============ CLI Entry ============

if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 ? args[idx + 1] : def;
  };

  const config: EvalConfig = {
    epubPath: getArg('epub', './storage/documents/1/novel.epub'),
    kbId: parseInt(getArg('kbId', '4')),
    qaCount: parseInt(getArg('qaCount', '60')),
    chunkSize: parseInt(getArg('chunkSize', '500')),
    chunkOverlap: parseInt(getArg('overlap', '50')),
    ks: [1, 3, 5, 10],
    outputDir: getArg('output', './eval-output'),
    llmApiKey: process.env.DEFAULT_MODEL_API_KEY || '',
    llmApiBase: process.env.DEFAULT_MODEL_API_BASE || 'https://api.deepseek.com',
    llmModel: process.env.DEFAULT_MODEL_NAME || 'deepseek-chat',
  };

  runEval(config).catch(console.error);
}

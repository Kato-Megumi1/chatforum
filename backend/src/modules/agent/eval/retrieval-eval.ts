/**
 * Retrieval Evaluation Metrics
 *
 * Computes Precision@K, Recall@K, NDCG against ground truth QA pairs.
 * Generates detailed per-question reports and summary tables.
 *
 * Usage:
 *   const evaluator = new RetrievalEvaluator(ragService, kbId);
 *   const report = await evaluator.evaluate(qaPairs, embeddings, [1, 3, 5, 10]);
 *   RetrievalEvaluator.saveReport(report, 'eval-results.csv');
 */

import * as fs from 'fs';
import { QAPair } from './qa-generator';

export interface EvalResult {
  question: string;
  expectedChunkId: string;
  retrievedRanks: number[]; // ranks at which relevant chunks were found
  hitAtK: Record<number, boolean>;
  precisionAtK: Record<number, number>;
  recallAtK: Record<number, number>;
  ndcgAtK: Record<number, number>;
}

export interface EvalReport {
  config: { ks: number[]; totalQuestions: number };
  summary: {
    avgPrecision: Record<number, number>;
    avgRecall: Record<number, number>;
    avgHitRate: Record<number, number>;
    avgNDCG: Record<number, number>;
  };
  details: EvalResult[];
}

export class RetrievalEvaluator {
  private retrieveFn: (query: string, topK: number) => Promise<string[]>;

  /**
   * @param retrieveFn - Function that takes a query and topK, returns array of chunk contents
   */
  constructor(retrieveFn: (query: string, topK: number) => Promise<string[]>) {
    this.retrieveFn = retrieveFn;
  }

  /**
   * Run full evaluation against QA test set
   */
  async evaluate(
    qaPairs: QAPair[],
    chunks: Array<{ content: string; metadata: any }>,
    ks: number[] = [1, 3, 5, 10],
  ): Promise<EvalReport> {
    const results: EvalResult[] = [];
    const maxK = Math.max(...ks);

    for (const qa of qaPairs) {
      const retrieved = await this.retrieveFn(qa.question, maxK);

      // Find which retrieved chunks are relevant (contain the answer text)
      const answerKey = qa.answer.slice(0, 50);
      const relevantRanks: number[] = [];
      const relevanceScores: number[] = [];

      for (let i = 0; i < retrieved.length; i++) {
        // Check if this retrieved chunk is relevant
        const isRelevant = this.isRelevant(retrieved[i], answerKey, qa.answer);
        if (isRelevant) {
          relevantRanks.push(i + 1); // 1-indexed rank
          relevanceScores.push(this.computeRelevance(retrieved[i], qa.answer));
        } else if (relevanceScores.length <= i) {
          relevanceScores.push(0);
        }
      }

      // Compute metrics for each K
      const hitAtK: Record<number, boolean> = {};
      const precisionAtK: Record<number, number> = {};
      const recallAtK: Record<number, number> = {};
      const ndcgAtK: Record<number, number> = {};

      const totalRelevant = qa.chunkId ? 1 : Math.max(1, relevantRanks.length || (retrieved.some(r => this.isRelevant(r, answerKey, qa.answer)) ? 1 : 0));

      for (const k of ks) {
        const topK = retrieved.slice(0, k);
        const relevantInTopK = topK.filter(r => this.isRelevant(r, answerKey, qa.answer)).length;

        hitAtK[k] = relevantInTopK > 0;
        precisionAtK[k] = relevantInTopK / k;
        recallAtK[k] = relevantInTopK / totalRelevant;
        ndcgAtK[k] = this.computeNDCG(retrieved.slice(0, k), answerKey, qa.answer);
      }

      results.push({
        question: qa.question,
        expectedChunkId: qa.chunkId || `answer: ${answerKey}`,
        retrievedRanks: relevantRanks,
        hitAtK,
        precisionAtK,
        recallAtK,
        ndcgAtK,
      });
    }

    // Compute summary averages
    const summary = this.computeSummary(results, ks);

    return {
      config: { ks, totalQuestions: qaPairs.length },
      summary,
      details: results,
    };
  }

  /**
   * Check if a retrieved passage is relevant to the ground truth answer
   */
  private isRelevant(retrievedText: string, answerKey: string, fullAnswer: string): boolean {
    // Exact substring match
    if (retrievedText.includes(answerKey)) return true;
    // Fuzzy: >50% word overlap with the full answer
    const answerWords = new Set(fullAnswer.slice(0, 100).split(/[，。！？、\s]+/).filter(w => w.length >= 2));
    const retrievedWords = new Set(retrievedText.slice(0, 500).split(/[，。！？、\s]+/).filter(w => w.length >= 2));
    const intersection = [...answerWords].filter(w => retrievedWords.has(w)).length;
    return intersection >= Math.min(3, answerWords.size * 0.3);
  }

  /**
   * Compute relevance score (0-3 scale)
   */
  private computeRelevance(retrievedText: string, answer: string): number {
    if (retrievedText.includes(answer.slice(0, 100))) return 3; // Exact match
    const rw = new Set(retrievedText.split(/[，。！？、\s]+/).filter(w => w.length >= 2));
    const aw = new Set(answer.split(/[，。！？、\s]+/).filter(w => w.length >= 2));
    const intersection = [...aw].filter(w => rw.has(w)).length;
    if (intersection >= aw.size * 0.5) return 2; // High overlap
    if (intersection >= aw.size * 0.25) return 1; // Partial overlap
    return 0;
  }

  /**
   * Compute NDCG@K
   */
  private computeNDCG(retrieved: string[], answerKey: string, fullAnswer: string): number {
    const relevance = retrieved.map(r => this.computeRelevance(r, fullAnswer));
    const ideal = [...relevance].sort((a, b) => b - a);

    let dcg = 0;
    let idcg = 0;
    for (let i = 0; i < relevance.length; i++) {
      const discount = Math.log2(i + 2);
      dcg += (Math.pow(2, relevance[i]) - 1) / discount;
      idcg += (Math.pow(2, (ideal[i] || 0)) - 1) / discount;
    }
    return idcg === 0 ? 0 : dcg / idcg;
  }

  /**
   * Compute summary statistics
   */
  private computeSummary(results: EvalResult[], ks: number[]) {
    const avgPrecision: Record<number, number> = {};
    const avgRecall: Record<number, number> = {};
    const avgHitRate: Record<number, number> = {};
    const avgNDCG: Record<number, number> = {};

    for (const k of ks) {
      avgPrecision[k] = results.reduce((s, r) => s + (r.precisionAtK[k] || 0), 0) / results.length;
      avgRecall[k] = results.reduce((s, r) => s + (r.recallAtK[k] || 0), 0) / results.length;
      avgHitRate[k] = results.filter(r => r.hitAtK[k]).length / results.length;
      avgNDCG[k] = results.reduce((s, r) => s + (r.ndcgAtK[k] || 0), 0) / results.length;
    }

    return { avgPrecision, avgRecall, avgHitRate, avgNDCG };
  }

  /**
   * Save evaluation report to CSV
   */
  static saveReport(report: EvalReport, csvPath: string, detailPath?: string): void {
    const ks = report.config.ks;

    // Summary CSV
    let csv = 'Metric,' + ks.map(k => `K=${k}`).join(',') + '\n';
    csv += 'Precision,' + ks.map(k => report.summary.avgPrecision[k].toFixed(4)).join(',') + '\n';
    csv += 'Recall,' + ks.map(k => report.summary.avgRecall[k].toFixed(4)).join(',') + '\n';
    csv += 'HitRate,' + ks.map(k => report.summary.avgHitRate[k].toFixed(4)).join(',') + '\n';
    csv += 'NDCG,' + ks.map(k => report.summary.avgNDCG[k].toFixed(4)).join(',') + '\n';
    fs.writeFileSync(csvPath, csv, 'utf-8');
    console.log(`Summary saved to ${csvPath}`);

    // Detail JSON (optional)
    if (detailPath) {
      fs.writeFileSync(detailPath, JSON.stringify(report.details, null, 2), 'utf-8');
      console.log(`Details saved to ${detailPath}`);
    }
  }
}

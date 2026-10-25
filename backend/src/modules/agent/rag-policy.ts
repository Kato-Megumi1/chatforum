import { createHash } from 'crypto';
import { RagPassage } from './rag.types';

export const NOVEL_RETRIEVAL_VERSION = 'novel-adaptive-retrieval-v6';

// EPUB extras are retained for explicit questions about them, but are not character memories.
export function novelSourceAllowed(chapter: string | undefined, question: string): boolean {
  return /后记|访谈|专访|作者|插画师|制作花絮|版权|目录/.test(question) ||
    !/后记|访谈|专访|译后|版权|目录/.test(chapter || '');
}

const normalizeOrdinals = (text: string) => text.normalize('NFKC').replace(/\s+/g, '').replace(
  /第([零〇一二两三四五六七八九十百\d]+)(卷|章)/g, (_match, n: string, unit: string) => {
    if (/^\d+$/.test(n)) return '第' + Number(n) + unit;
    const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let sum = 0, digit = 0;
    for (const c of n) {
      if (c === '十' || c === '百') { sum += (digit || 1) * (c === '十' ? 10 : 100); digit = 0; }
      else digit = digits[c];
    }
    return '第' + (sum + digit) + unit;
  });

// Only unambiguous explicit scopes are hard filters. Cross-volume comparisons
// must not silently lose all but the first named volume. Titles come from the DB.
export function novelChapterScope(query: string): ((chapter: string) => boolean) | undefined {
  const text = normalizeOrdinals(query);
  const volumes = [...new Set(text.match(/第\d+卷/g) || [])];
  const chapters = [...new Set(text.match(/第\d+章|终章[一二三四五六七八九\d]*|序章/g) || [])];
  const bd = [...new Set([...text.matchAll(/BD([1-9]\d?)(?!\d)/gi)].map(m => Number(m[1])))];
  if (volumes.length > 1 || bd.length > 1 || (volumes.length && bd.length)) return undefined;
  if (volumes.length === 1) return title => {
    const normalized = normalizeOrdinals(title);
    if (!normalized.startsWith(volumes[0])) return false;
    const suffix = normalized.slice(volumes[0].length);
    if (chapters.length !== 1) return true;
    const target = chapters[0];
    if (!suffix.startsWith(target)) return false;
    return !/^终章/.test(target) || !/^[一二三四五六七八九\d]/.test(suffix.slice(target.length));
  };
  if (bd.length === 1) return title => [...normalizeOrdinals(title).matchAll(/BD([1-9]\d?)(?!\d)/gi)]
    .some(m => Number(m[1]) === bd[0]);
  return undefined;
}

// Missing scores stay unranked. Duplicates/unknown IDs invalidate the batch;
// never pad or shift a positional model array onto different passages.
export function validatedRerankScores(value: unknown, passageCount: number): Map<number, number> {
  if (!Array.isArray(value) || !value.length || value.length > passageCount) throw new Error('Invalid relevance scores');
  const scores = new Map<number, number>();
  for (const item of value) {
    if (!item || !Number.isInteger(item.sourceId) || item.sourceId < 1 || item.sourceId > passageCount ||
      scores.has(item.sourceId) || !Number.isInteger(item.score) || item.score < 1 || item.score > 5)
      throw new Error('Invalid relevance score identity');
    scores.set(item.sourceId, item.score);
  }
  return scores;
}

// These are retrieval terms, never executable instructions. Keep Chinese bigrams
// for names and dialogue that whitespace tokenization would otherwise miss.
export function novelKeywords(query: string): string[] {
  query = query.normalize('NFKC');
  for (const aliases of [['加藤惠', '加藤', '惠'], ['安艺伦也', '安艺', '伦也'],
    ['英梨梨', '柏木英理'], ['霞之丘诗羽', '诗羽', '霞诗子']]) {
    if (aliases.some(name => name.length > 1 ? query.includes(name) : /(?:^|[，。！？\s])惠[，。！？\s]/.test(query)))
      query += ' ' + aliases.filter(name => name.length > 1).join(' ');
  }
  const terms = new Set<string>();
  for (const word of query.toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]+/g) || []) {
    if (word.length <= 12) terms.add(word);
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i < word.length - 1; i++) terms.add(word.slice(i, i + 2));
    }
  }
  return [...terms].slice(0, 64);
}

export function routeIndex(kb: {
  id: number; activeIndexVersion: number | null;
  candidateIndexVersion: number | null; indexCanaryPercent: number;
}, userId: number): number | null {
  const bucket = createHash('sha256').update(kb.id + ':' + userId).digest().readUInt32BE(0) % 100;
  return kb.activeIndexVersion !== null && kb.candidateIndexVersion !== null &&
    bucket < kb.indexCanaryPercent ? kb.candidateIndexVersion : kb.activeIndexVersion;
}

export function fusePassages(semantic: RagPassage[], lexical: RagPassage[], limit: number, graph: RagPassage[] = [],
  strategy: 'balanced' | 'semantic' | 'lexical' = 'balanced'): RagPassage[] {
  const merged = new Map<string, RagPassage>();
  const weights = strategy === 'semantic' ? [3, 1] : strategy === 'lexical' ? [1, 4] : [1, 2];
  for (const [items, weight] of [[semantic, weights[0]], [lexical, weights[1]]] as const) {
    items.forEach((passage, rank) => {
      const key = passage.citation.chunkId;
      const prior = merged.get(key);
      merged.set(key, {
        ...prior, ...passage,
        semanticScore: passage.semanticScore ?? prior?.semanticScore,
        lexicalScore: passage.lexicalScore ?? prior?.lexicalScore,
        graphScore: passage.graphScore ?? prior?.graphScore,
        score: (prior?.score || 0) + weight / (60 + rank + 1),
      });
    });
  }
  const core = [...merged.values()].sort((a, b) => b.score - a.score ||
    a.citation.chunkId.localeCompare(b.citation.chunkId));
  // Co-occurrence is not relevance. Preserve the hybrid top three and its ranking;
  // the graph can add up to three NEW candidates for the evidence reranker.
  const extra = graph.filter(p => !merged.has(p.citation.chunkId));
  for (const p of graph) if (merged.has(p.citation.chunkId)) merged.get(p.citation.chunkId).graphScore = p.graphScore;
  if (!core.length) return extra.slice(0, limit);
  const reserve = Math.min(3, extra.length, Math.max(0, limit - 3));
  const selected = core.slice(0, limit - reserve);
  return [...selected, ...extra.slice(0, Math.min(3, limit - selected.length))];
}

export function hasPermission(permission: string | undefined, needed: string): boolean {
  return ({ READ: 1, WRITE: 2, ADMIN: 3 }[permission || ''] || 0) >=
    ({ READ: 1, WRITE: 2, ADMIN: 3 }[needed] || 99);
}

// Structural and quote validation cannot prove semantic entailment. An independent
// support check is still required before a canonical answer is released.
export function validateClaims(
  claims: Array<{ text: string; sourceId: number; quote: string }>, passages: RagPassage[],
): boolean {
  return claims.length > 0 && claims.length <= 8 && claims.every(claim =>
    typeof claim.text === 'string' && claim.text.trim().length > 0 && claim.text.length <= 1200 &&
    Number.isInteger(claim.sourceId) && claim.sourceId >= 1 && claim.sourceId <= passages.length &&
    typeof claim.quote === 'string' && claim.quote.trim().length >= 8 && claim.quote.length <= 160 &&
    passages[claim.sourceId - 1].content.includes(claim.quote));
}

import { RagPassage, RagSearchDecision } from './rag.types';
import { SearchAttempt } from './novel-dialogue.policy';
import { QuestionAlignment } from './novel-answer.policy';

export type RagStage = 'routing' | 'query_rewrite' | 'retrieval' | 'rerank' | 'context' | 'evidence' | 'quote_repair' | 'voice' | 'verification' | 'delivery';
export interface RagFailure {
  category: 'retrieval' | 'evidence' | 'service' | 'safety';
  stage: RagStage;
  code: string;
}
export interface DiagnosticAttempt extends SearchAttempt {
  stage?: RagStage;
  failure?: RagFailure;
  retrieval?: RagSearchDecision['retrieval'];
  historyReuse?: { eligible: number; available: number; added: number; chunkIds: string[] };
  candidates?: Array<{ chunkId: string; documentId: number; documentVersion: number; indexVersion: number; rerankScore?: number }>;
  evidence?: { sufficient: boolean | null; claimCount: number; issues: Array<{ claim: number; code: string }>;
    sources: Array<{ sourceId: number; chunkId: string; documentVersion: number; indexVersion: number }> };
  quoteRepair?: { originalIssues: Array<{ claim: number; code: string }> };
  verification?: { answersQuestion: boolean | null; neutralAnswersQuestion: boolean | null;
    questionAlignment: QuestionAlignment | null; neutralQuestionAlignment: QuestionAlignment | null; inCharacter: boolean | null;
    supported: Array<boolean | null>; neutralSupported: Array<boolean | null>; injection: boolean | null };
  voiceRepair?: { outcome: 'pending' | 'passed' | 'failed' | 'invalid_mapping'; verification?: DiagnosticAttempt['verification'] };
}

export function failAttempt(attempt: DiagnosticAttempt, category: RagFailure['category'], code: string) {
  attempt.failure = { category, stage: attempt.stage || 'retrieval', code };
}

export function evidenceDiagnostic(draft: any, passages: RagPassage[]): DiagnosticAttempt['evidence'] {
  const issues: Array<{ claim: number; code: string }> = [];
  const claims = Array.isArray(draft?.claims) ? draft.claims : [];
  if (!Array.isArray(draft?.claims)) issues.push({ claim: 0, code: 'CLAIMS_NOT_ARRAY' });
  if (!claims.length) issues.push({ claim: 0, code: 'NO_CLAIMS' });
  if (claims.length > 8) issues.push({ claim: 0, code: 'TOO_MANY_CLAIMS' });
  claims.slice(0, 8).forEach((raw, index) => {
    const c = raw || {}, claim = index + 1;
    if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 1200) issues.push({ claim, code: 'INVALID_CLAIM_TEXT' });
    const validSource = Number.isInteger(c.sourceId) && c.sourceId > 0 && c.sourceId <= passages.length;
    if (!validSource) issues.push({ claim, code: 'INVALID_SOURCE_ID' });
    if (typeof c.quote !== 'string' || c.quote.trim().length < 8) issues.push({ claim, code: 'QUOTE_MISSING_OR_SHORT' });
    else {
      if (c.quote.length > 160) issues.push({ claim, code: 'QUOTE_TOO_LONG' });
      if (validSource && !passages[c.sourceId - 1].content.includes(c.quote)) issues.push({ claim, code: 'QUOTE_NOT_VERBATIM' });
    }
  });
  return { sufficient: typeof draft?.sufficient === 'boolean' ? draft.sufficient : null, claimCount: claims.length, issues,
    sources: passages.slice(0, 26).map((p,i)=>({sourceId:i+1,chunkId:p.citation.chunkId,
      documentVersion:p.citation.documentVersion,indexVersion:p.citation.indexVersion})) };
}

export function verificationDiagnostic(check: any): DiagnosticAttempt['verification'] {
  const boolean = (value: unknown) => typeof value === 'boolean' ? value : null;
  const list = (value: unknown) => Array.isArray(value) ? value.slice(0, 8).map(boolean) : [];
  const alignment = (value: unknown): QuestionAlignment | null =>
    ['direct', 'supported_correction', 'different_event', 'unresolved'].includes(value as string) ? value as QuestionAlignment : null;
  return { answersQuestion: boolean(check?.answersQuestion), neutralAnswersQuestion: boolean(check?.neutralAnswersQuestion),
    questionAlignment: alignment(check?.questionAlignment), neutralQuestionAlignment: alignment(check?.neutralQuestionAlignment),
    inCharacter: boolean(check?.inCharacter),
    supported: list(check?.supported), neutralSupported: list(check?.neutralSupported), injection: boolean(check?.injection) };
}

export function candidateManifest(passages: RagPassage[]): DiagnosticAttempt['candidates'] {
  return passages.slice(0, 26).map(p => ({ chunkId: p.citation.chunkId, documentId: p.citation.documentId,
    documentVersion: p.citation.documentVersion, indexVersion: p.citation.indexVersion, rerankScore: p.rerankScore }));
}

export function failureSummary(attempts: DiagnosticAttempt[], fatal?: RagFailure) {
  const last = attempts.at(-1)?.failure;
  return { finalFailure: fatal || last || null,
    retrievalFailed: attempts.some(a => a.failure?.category === 'retrieval'),
    evidenceFailed: attempts.some(a => a.failure?.category === 'evidence'),
    serviceFailed: fatal?.category === 'service' || attempts.some(a => a.failure?.category === 'service') };
}
